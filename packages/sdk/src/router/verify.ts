/**
 * Calldata verification for a swap transaction handed back by the Router API (audit D M-1, 2026-10-07).
 *
 * `GullyCoreRouterClient.swap` pins `tx.to` to Gully Core's own UniversalRouter or GullyCoreFillRouter, but a
 * transaction to the LEGITIMATE router can still be hostile: a compromised or spoofed API could return
 * calldata that pays the trade's output to somebody else, pulls more than `amountIn` through the user's
 * standing Permit2 allowance, or sets `tx.value` above the amount. So the client decodes the bytes and
 * checks them against the request before any wallet sees them — the same discipline the widget already
 * applies to its routed path (`packages/widgets/src/core/routed.ts`, `verifyBuiltRoutedSwap`).
 *
 * What is accepted:
 *  - GullyCoreFillRouter.fill(p): currencies, amountIn, recipient, minAmountOut, wrap/unwrap flags and
 *    maxFeeBps all equal to the request; nothing else.
 *  - UniversalRouter.execute(commands, inputs, deadline): only the commands Gully Core's own swap path
 *    emits (`INFI_SWAP`, `PAY_PORTION`, `SWEEP`, `WRAP_ETH`, `UNWRAP_WETH`); inside an `INFI_SWAP` plan only
 *    swap actions plus SETTLE/TAKE whose currency, amounts and recipients are bounded by the request:
 *    every SETTLE of the user's funds is `tokenIn` for at most `amountIn`, and every TAKE pays the
 *    caller (MSG_SENDER), the request's recipient, or the router itself followed by a SWEEP to one of
 *    those. `PERMIT2_TRANSFER_FROM`, `TRANSFER`, `PERMIT2_PERMIT_BATCH`, third-party AMM legs, sub-plans
 *    and pool initialisation are refused outright: none of them is a Gully Core pool swap.
 *  - ONE `PERMIT2_PERMIT` (2026-10-11: the swap carries the user's Permit2 signature instead of a separate
 *    `Permit2.approve` transaction), and only as the FIRST command, only for an ERC-20 `tokenIn`, only
 *    granting THE router the transaction is addressed to (`spender == tx.to`), for that token, at least
 *    `amountIn`, with a 64- or 65-byte signature. The signer is not checked here and need not be: the
 *    router passes `msg.sender` to Permit2 as the owner, so a signature by anybody else reverts on chain.
 *  - `tx.value` is `amountIn` when `tokenIn` is the native sentinel and 0 otherwise.
 *
 * The chain's native coin against a pool quoted in its WRAPPED native (2026-10-11), only when the request
 * names `wrappedNative`:
 *  - pay native: `WRAP_ETH` to the router (only for a native `tokenIn`, never more than `amountIn`), then a
 *    ROUTER-paid `SETTLE` of exactly the wrapped native, which counts as paying for the swap only after a
 *    wrap in the same transaction. A refund `SWEEP` of native to the user is allowed.
 *  - receive native: the plan TAKEs the wrapped native to the router and `UNWRAP_WETH` pays the user,
 *    floored at no less than `minAmountOut` (only for a native `tokenOut`).
 * Every TAKE names `tokenOut` (or, to the router, the wrapped native unwrapped into a native output), the
 * SWEEP that pays the output carries a floor no lower than `minAmountOut`, and a plan-level SWEEP never
 * pays a third party.
 *
 * Anything it cannot decode is refused: unknown bytes are not "probably fine".
 */
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAbiItem, hexToBytes, isAddressEqual, toFunctionSelector, type Address, type Hex } from "viem";

export const NATIVE_SENTINEL: Address = "0x0000000000000000000000000000000000000000";
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";

/** UniversalRouter commands (packages/router/src/libraries/Commands.sol). */
const CMD = {
  SWEEP: 0x04,
  PERMIT2_PERMIT: 0x0a,
  PAY_PORTION: 0x06,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  INFI_SWAP: 0x10,
} as const;
const COMMAND_TYPE_MASK = 0x3f;

/** Infinity plan actions (packages/widgets/src/callpath/constants.ts mirrors the periphery). */
const ACT = {
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  CL_SWAP_EXACT_IN: 0x07,
  CL_SWAP_EXACT_OUT_SINGLE: 0x08,
  CL_SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
  SWEEP: 0x14,
  BIN_SWAP_EXACT_IN_SINGLE: 0x1c,
  BIN_SWAP_EXACT_IN: 0x1d,
  BIN_SWAP_EXACT_OUT_SINGLE: 0x1e,
  BIN_SWAP_EXACT_OUT: 0x1f,
} as const;
const SWAP_ACTIONS = new Set<number>([
  ACT.CL_SWAP_EXACT_IN_SINGLE, ACT.CL_SWAP_EXACT_IN, ACT.CL_SWAP_EXACT_OUT_SINGLE, ACT.CL_SWAP_EXACT_OUT,
  ACT.BIN_SWAP_EXACT_IN_SINGLE, ACT.BIN_SWAP_EXACT_IN, ACT.BIN_SWAP_EXACT_OUT_SINGLE, ACT.BIN_SWAP_EXACT_OUT,
]);

const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const FILL_ABI = [
  {
    type: "function",
    name: "fill",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "target", type: "address" },
          { name: "currencyIn", type: "address" },
          { name: "currencyOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "wrapInput", type: "bool" },
          { name: "unwrapOutput", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export interface SwapRequestFacts {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly recipient: Address;
  readonly minAmountOut: bigint;
  readonly deadline: number;
  /**
   * The chain's wrapped native (WETH9-style). Needed for a native `tokenIn` / `tokenOut` traded through
   * a pool quoted in the wrapped native: `WRAP_ETH` / `UNWRAP_WETH` around the swap are checked against it.
   */
  readonly wrappedNative?: Address;
  /** The fee the quote showed, for a fill-router transaction. */
  readonly feeBps?: number;
}

export interface SwapTxFacts {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export class UnverifiedSwapCalldata extends Error {
  constructor(readonly reason: string) {
    super(`swap calldata refused: ${reason}`);
    this.name = "UnverifiedSwapCalldata";
  }
}

const same = (a: Address, b: Address) => isAddressEqual(a, b);
const refuse = (reason: string): never => {
  throw new UnverifiedSwapCalldata(reason);
};

// Derived from the ABIs at load, so a struct change can never leave a stale literal behind.
const EXECUTE_SELECTOR = toFunctionSelector(getAbiItem({ abi: EXECUTE_ABI, name: "execute" })).toLowerCase();
const FILL_SELECTOR = toFunctionSelector(getAbiItem({ abi: FILL_ABI, name: "fill" })).toLowerCase();

/** The ERC-8021 marker that ends every attribution suffix (16 bytes, `0x8021` eight times). */
export const ERC8021_MARKER = "80218021802180218021802180218021";

/**
 * True when `tail` (hex, with or without `0x`) is EXACTLY one ERC-8021 schema-0 attribution suffix
 * (Base Builder Codes): `codes ∥ codesLength (1 byte) ∥ schemaId 0x00 ∥ marker`, the codes printable
 * code characters joined by commas, and nothing before them. Any other trailing bytes are not one.
 */
export function isErc8021Suffix(tail: string): boolean {
  const h = tail.replace(/^0x/i, "").toLowerCase();
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) return false;
  const n = h.length / 2;
  if (n < 19 || !h.endsWith(ERC8021_MARKER)) return false;
  const byteAt = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
  if (byteAt(n - 17) !== 0) return false; // schema 0 (canonical registry)
  const len = byteAt(n - 18);
  if (len === 0 || n !== len + 18) return false;
  let codes = "";
  for (let i = 0; i < len; i++) codes += String.fromCharCode(byteAt(i));
  return /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/.test(codes);
}

/**
 * The calldata past the canonical encoding of what was decoded must be empty, or exactly one ERC-8021
 * attribution suffix: a wallet or the Base App may append a Builder Code after the call, and the
 * router ignores trailing bytes. Anything else appended is refused, so the decoded call is the whole
 * of what is signed.
 */
function refuseUnknownTail(data: Hex, canonical: Hex, what: string): void {
  const d = data.toLowerCase();
  const c = canonical.toLowerCase();
  if (!d.startsWith(c)) return refuse(`${what} calldata is not in its canonical encoding`);
  const tail = d.slice(c.length);
  if (tail !== "" && !isErc8021Suffix(tail)) refuse(`${what} calldata carries ${tail.length / 2} unexplained trailing bytes`);
}

/** Which Gully Core router a swap's calldata is for, by selector; `null` for anything else. */
export function swapKindFromCalldata(data: Hex): "universal-router" | "fill-router" | null {
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === EXECUTE_SELECTOR) return "universal-router";
  if (sel === FILL_SELECTOR) return "fill-router";
  return null;
}

/**
 * Throws `UnverifiedSwapCalldata` unless `tx` is exactly the swap `req` describes, addressed to
 * `kind` ("universal-router" | "fill-router").
 */
export function verifySwapCalldata(kind: "universal-router" | "fill-router", tx: SwapTxFacts, req: SwapRequestFacts): void {
  if (!/^0x[0-9a-fA-F]*$/.test(tx.data)) refuse("tx.data is not hex");
  const nativeIn = same(req.tokenIn, NATIVE_SENTINEL);
  const expectedValue = nativeIn ? req.amountIn : 0n;
  if (tx.value !== expectedValue) refuse(`tx.value ${tx.value} is not ${expectedValue}`);
  if (kind === "fill-router") return verifyFill(tx.data, req, nativeIn);
  return verifyExecute(tx.data, req, tx.to);
}

/** `abi.encode(IAllowanceTransfer.PermitSingle, bytes signature)`, the PERMIT2_PERMIT command's input. */
const PERMIT_SINGLE_INPUT = [
  {
    type: "tuple",
    components: [
      {
        name: "details",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
  },
  { type: "bytes" },
] as const;

function verifyFill(data: Hex, req: SwapRequestFacts, nativeIn: boolean): void {
  let p;
  try {
    p = decodeFunctionData({ abi: FILL_ABI, data }).args[0];
  } catch {
    return refuse("calldata is not GullyCoreFillRouter.fill");
  }
  refuseUnknownTail(data, encodeFunctionData({ abi: FILL_ABI, functionName: "fill", args: [p] }), "fill");
  const nativeOut = same(req.tokenOut, NATIVE_SENTINEL);
  if (!same(p.currencyIn, req.tokenIn) || !same(p.currencyOut, req.tokenOut)) refuse("fill trades another pair");
  if (p.wrapInput !== nativeIn || p.unwrapOutput !== nativeOut) refuse("fill wrap/unwrap flags do not match the pair");
  if (p.amountIn !== req.amountIn) refuse("fill spends another amount");
  if (!same(p.recipient, req.recipient)) refuse("fill pays another recipient");
  if (p.minAmountOut < req.minAmountOut) refuse("fill's floor is below the minimum shown");
  if (Number(p.deadline) !== req.deadline) refuse("fill deadline differs from the one shown");
  if (req.feeBps !== undefined && p.maxFeeBps !== req.feeBps) refuse("fill fee differs from the quoted rate");
}

function verifyExecute(data: Hex, req: SwapRequestFacts, router: Address): void {
  let args;
  try {
    args = decodeFunctionData({ abi: EXECUTE_ABI, data }).args;
  } catch {
    return refuse("calldata is not UniversalRouter.execute");
  }
  refuseUnknownTail(data, encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args }), "execute");
  const [commands, inputs, deadline] = args;
  if (Number(deadline) !== req.deadline) refuse("execute deadline differs from the one shown");
  const bytes = hexToBytes(commands);
  if (bytes.length === 0 || bytes.length !== inputs.length) refuse("commands and inputs do not line up");
  const nativeIn = same(req.tokenIn, NATIVE_SENTINEL);
  const nativeOut = same(req.tokenOut, NATIVE_SENTINEL);
  const toUser = (r: Address) => same(r, MSG_SENDER) || same(r, req.recipient);
  let takesToRouter = false;
  let sweptToUser = false;
  let unwrapped = false;
  let wrapped = false;
  const decode2 = (input: Hex) => {
    try {
      return decodeAbiParameters([{ type: "address" }, { type: "uint256" }], input);
    } catch {
      return refuse("command input is not (address, uint256)");
    }
  };
  const decode3 = (input: Hex) => {
    try {
      return decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], input);
    } catch {
      return refuse("command input is not (address, address, uint256)");
    }
  };
  for (let i = 0; i < bytes.length; i++) {
    const cmd = bytes[i]! & COMMAND_TYPE_MASK;
    const input = inputs[i]!;
    switch (cmd) {
      case CMD.INFI_SWAP: {
        const r = verifyInfiPlan(input, req, wrapped);
        takesToRouter ||= r.takesToRouter;
        break;
      }
      case CMD.SWEEP: {
        const [token, recipient, amountMin] = decode3(input);
        if (!toUser(recipient)) refuse("output is paid to a third party");
        if (same(token, req.tokenOut)) {
          if (amountMin < req.minAmountOut) refuse("sweep's floor is below the minimum shown");
          sweptToUser = true;
        } else if (!(same(token, req.tokenIn) || same(token, NATIVE_SENTINEL))) {
          refuse("sweep moves a currency that is neither the output nor a refund of the input");
        }
        break;
      }
      case CMD.PAY_PORTION: {
        const [, recipient] = decode3(input);
        if (!toUser(recipient)) refuse("output is paid to a third party");
        break;
      }
      case CMD.UNWRAP_WETH: {
        const [recipient, amountMin] = decode2(input);
        if (!nativeOut) refuse("unwrap pays native for a trade that does not ask for native");
        if (req.wrappedNative === undefined) refuse("unwrap without the chain's wrapped native to check it against");
        if (!toUser(recipient)) refuse("unwrap pays a third party");
        if (amountMin < req.minAmountOut) refuse("unwrap's floor is below the minimum shown");
        sweptToUser = true;
        unwrapped = true;
        break;
      }
      case CMD.WRAP_ETH: {
        const [recipient, amount] = decode2(input);
        if (!nativeIn) refuse("wrap for a trade that does not pay native");
        if (!same(recipient, ADDRESS_THIS)) refuse("wrap pays a third party");
        if (amount > req.amountIn && amount !== CONTRACT_BALANCE) refuse("wrap exceeds amountIn");
        wrapped = true;
        break;
      }
      case CMD.PERMIT2_PERMIT: {
        if (i !== 0) refuse("a Permit2 permit comes anywhere but first");
        if (nativeIn) refuse("a Permit2 permit on a trade that pays native");
        let permit, signature: Hex;
        try {
          [permit, signature] = decodeAbiParameters(PERMIT_SINGLE_INPUT, input);
        } catch {
          return refuse("PERMIT2_PERMIT input is not (PermitSingle, bytes)");
        }
        if (!same(permit.details.token, req.tokenIn)) refuse("the permit grants a token other than tokenIn");
        if (!same(permit.spender, router)) refuse("the permit grants a spender other than this router");
        if (permit.details.amount < req.amountIn) refuse("the permit grants less than amountIn");
        const sigBytes = (signature.length - 2) / 2;
        if (sigBytes !== 64 && sigBytes !== 65) refuse("the permit's signature is not 64 or 65 bytes");
        break;
      }
      default:
        refuse(`command 0x${cmd.toString(16).padStart(2, "0")} is not part of a Gully Core pool swap`);
    }
  }
  if (takesToRouter && !sweptToUser) refuse("output taken to the router is never swept to the user");
  if (unwrapped && !takesToRouter) refuse("unwrap with nothing taken to the router");
}

const CONTRACT_BALANCE = 1n << 255n;

function verifyInfiPlan(input: Hex, req: SwapRequestFacts, wrapped: boolean): { takesToRouter: boolean } {
  let actions: Hex, params: readonly Hex[];
  try {
    [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);
  } catch {
    return refuse("INFI_SWAP plan is not (actions, params)");
  }
  const acts = hexToBytes(actions);
  if (acts.length === 0 || acts.length !== params.length) refuse("plan actions and params do not line up");
  let takesToRouter = false;
  let settled = false;
  const nativeOut = same(req.tokenOut, NATIVE_SENTINEL);
  const okRecipient = (r: Address) => same(r, MSG_SENDER) || same(r, req.recipient) || same(r, ADDRESS_THIS);
  /* What a TAKE may move: the output, or (to the router only) the wrapped native unwrapped into a native output. */
  const okTakeCurrency = (c: Address, recipient: Address | null) => {
    if (same(c, req.tokenOut)) return true;
    return nativeOut && req.wrappedNative !== undefined && same(c, req.wrappedNative) && recipient !== null && same(recipient, ADDRESS_THIS);
  };
  const dec2 = (p: Hex) => {
    try {
      return decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p);
    } catch {
      return refuse("plan action params do not decode");
    }
  };
  const dec3 = (p: Hex) => {
    try {
      return decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], p);
    } catch {
      return refuse("plan action params do not decode");
    }
  };
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]!;
    const p = params[i]!;
    if (SWAP_ACTIONS.has(a)) continue; // the pool swap itself; its floors are the TAKEs' and minAmountOut's business
    switch (a) {
      case ACT.SETTLE_ALL: {
        const [currency, maxAmount] = dec2(p);
        if (!same(currency, req.tokenIn)) refuse("plan settles a currency other than tokenIn from the user");
        if (maxAmount > req.amountIn) refuse("plan may pull more than amountIn from the user");
        settled = true;
        break;
      }
      case ACT.SETTLE: {
        let decoded;
        try {
          decoded = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], p);
        } catch {
          return refuse("plan action params do not decode");
        }
        const [currency, amount, payerIsUser] = decoded;
        if (payerIsUser) {
          if (!same(currency, req.tokenIn)) refuse("plan settles a currency other than tokenIn from the user");
          if (amount > req.amountIn) refuse("plan may pull more than amountIn from the user");
          settled = true;
        } else if (wrapped) {
          /* Paid by the router out of what this transaction wrapped: the wrapped native, never more than amountIn. */
          if (req.wrappedNative === undefined || !same(currency, req.wrappedNative)) refuse("router pays a currency other than the wrapped native it wrapped");
          if (amount > req.amountIn && amount !== CONTRACT_BALANCE) refuse("router settles more than amountIn");
          settled = true;
        }
        break;
      }
      case ACT.SETTLE_PAIR:
        refuse("plan settles a pair from the user (not a swap)");
        break;
      case ACT.TAKE:
      case ACT.TAKE_PORTION: {
        const [currency, recipient] = dec3(p);
        if (!okRecipient(recipient)) refuse("plan takes output to a third party");
        if (!okTakeCurrency(currency, recipient)) refuse("plan takes a currency other than the output");
        if (same(recipient, ADDRESS_THIS)) takesToRouter = true;
        break;
      }
      case ACT.TAKE_PAIR: {
        let decoded;
        try {
          decoded = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], p);
        } catch {
          return refuse("plan action params do not decode");
        }
        const recipient = decoded[2];
        if (!okRecipient(recipient)) refuse("plan takes output to a third party");
        if (same(recipient, ADDRESS_THIS)) takesToRouter = true;
        break;
      }
      case ACT.TAKE_ALL: {
        const [currency, minAmount] = dec2(p);
        if (!okTakeCurrency(currency, null)) refuse("plan takes a currency other than the output");
        if (minAmount < req.minAmountOut) refuse("plan's floor is below the minimum shown");
        break; // pays msg.sender by construction
      }
      case ACT.SWEEP: {
        let decoded;
        try {
          decoded = decodeAbiParameters([{ type: "address" }, { type: "address" }], p);
        } catch {
          return refuse("plan action params do not decode");
        }
        if (!okRecipient(decoded[1])) refuse("plan sweeps the router's balance to a third party");
        break;
      }
      case ACT.CLOSE_CURRENCY:
      case ACT.CLEAR_OR_TAKE:
        break; // settle-or-take of the plan's own residue with the caller; neither pulls from the user nor pays a third party
      default:
        refuse(`plan action 0x${a.toString(16).padStart(2, "0")} is not part of a swap`);
    }
  }
  if (!settled) refuse("plan never settles the input (not a swap the user pays for)");
  return { takesToRouter };
}
