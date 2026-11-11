/**
 * `verifySwapCalldata` (audit D M-1, 2026-10-07): a transaction addressed to the LEGITIMATE router can
 * still be hostile. These tests build calldata the way the API would and check that exactly the trade
 * the user saw passes, and that each way of robbing them is refused by name.
 */
import { describe, expect, it } from "vitest";
import { Attribution } from "ox/erc8021";
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import {
  GULLYCORE_FILL_ROUTER_FILL_ABI,
  isErc8021Suffix,
  swapKindFromCalldata,
  UnverifiedSwapCalldata,
  verifySwapCalldata,
  type SwapRequestFacts,
} from "../src/router/index.js";

const USER: Address = "0x1111111111111111111111111111111111111111";
const ATTACKER: Address = "0x2222222222222222222222222222222222222222";
const TOKEN_IN: Address = "0x3333333333333333333333333333333333333333";
const TOKEN_OUT: Address = "0x4444444444444444444444444444444444444444";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
const ROUTER: Address = "0x5555555555555555555555555555555555555555";

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

const req: SwapRequestFacts = {
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountIn: 1_000_000n,
  recipient: USER,
  minAmountOut: 990_000n,
  deadline: 1_900_000_000,
};

const bytesOf = (nums: number[]): Hex => `0x${nums.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
const abi = encodeAbiParameters;

/** A Gully Core pool swap plan: swap, settle the input from the user, take all output to the caller. */
function infiPlan(over: { settleCurrency?: Address; settleMax?: bigint; take?: { recipient: Address; kind?: "take" | "take_all" }; minOut?: bigint } = {}): Hex {
  const actions: number[] = [0x06, 0x0c];
  const params: Hex[] = [
    abi([{ type: "bytes32" }], ["0x" + "ab".repeat(32) as Hex]), // the swap params are opaque to the verifier
    abi([{ type: "address" }, { type: "uint256" }], [over.settleCurrency ?? TOKEN_IN, over.settleMax ?? req.amountIn]),
  ];
  const take = over.take ?? { recipient: MSG_SENDER, kind: "take_all" as const };
  if (take.kind === "take_all" || take.kind === undefined) {
    actions.push(0x0f);
    params.push(abi([{ type: "address" }, { type: "uint256" }], [TOKEN_OUT, over.minOut ?? req.minAmountOut]));
  } else {
    actions.push(0x0e);
    params.push(abi([{ type: "address" }, { type: "address" }, { type: "uint256" }], [TOKEN_OUT, take.recipient, 0n]));
  }
  return abi([{ type: "bytes" }, { type: "bytes[]" }], [bytesOf(actions), params]);
}

function execute(commands: number[], inputs: Hex[], deadline = req.deadline): Hex {
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [bytesOf(commands), inputs, BigInt(deadline)] });
}

function fill(over: Partial<{ currencyIn: Address; currencyOut: Address; amountIn: bigint; minAmountOut: bigint; maxFeeBps: number; wrapInput: boolean; unwrapOutput: boolean; recipient: Address; deadline: bigint }> = {}): Hex {
  return encodeFunctionData({
    abi: GULLYCORE_FILL_ROUTER_FILL_ABI,
    functionName: "fill",
    args: [
      {
        target: ROUTER,
        currencyIn: over.currencyIn ?? TOKEN_IN,
        currencyOut: over.currencyOut ?? TOKEN_OUT,
        amountIn: over.amountIn ?? req.amountIn,
        minAmountOut: over.minAmountOut ?? req.minAmountOut,
        maxFeeBps: over.maxFeeBps ?? 15,
        wrapInput: over.wrapInput ?? false,
        unwrapOutput: over.unwrapOutput ?? false,
        recipient: over.recipient ?? USER,
        deadline: over.deadline ?? BigInt(req.deadline),
        data: "0x",
      },
    ],
  });
}

const refusal = (fn: () => void, fragment: string) => {
  expect(fn).toThrowError(UnverifiedSwapCalldata);
  expect(fn).toThrowError(fragment);
};

describe("swapKindFromCalldata", () => {
  it("tells the two routers apart by selector and refuses anything else", () => {
    expect(swapKindFromCalldata(execute([0x10], [infiPlan()]))).toBe("universal-router");
    expect(swapKindFromCalldata(fill())).toBe("fill-router");
    expect(swapKindFromCalldata("0xdeadbeef00")).toBeNull();
  });
});

describe("verifySwapCalldata · UniversalRouter", () => {
  it("accepts Gully Core's own swap shape: INFI_SWAP with SETTLE_ALL(tokenIn, amountIn) and TAKE_ALL to the caller", () => {
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan()]), value: 0n }, req)).not.toThrow();
  });

  it("accepts a TAKE to the router followed by a SWEEP to the user (the referrer-fee shape)", () => {
    const plan = infiPlan({ take: { recipient: ADDRESS_THIS, kind: "take" } });
    const sweep = abi([{ type: "address" }, { type: "address" }, { type: "uint256" }], [TOKEN_OUT, USER, req.minAmountOut]);
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x04], [plan, sweep]), value: 0n }, req)).not.toThrow();
  });

  it("refuses a SWEEP of the output whose floor is below the minimum shown (a TAKE to the router has none)", () => {
    const plan = infiPlan({ take: { recipient: ADDRESS_THIS, kind: "take" } });
    const sweep = abi([{ type: "address" }, { type: "address" }, { type: "uint256" }], [TOKEN_OUT, USER, 0n]);
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x04], [plan, sweep]), value: 0n }, req), "sweep's floor");
  });

  it("refuses PERMIT2_TRANSFER_FROM — the drain of a standing allowance", () => {
    const xfer = abi([{ type: "address" }, { type: "address" }, { type: "uint160" }], [TOKEN_IN, ATTACKER, 10n ** 24n]);
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x02, 0x10], [xfer, infiPlan()]), value: 0n }, req), "command 0x02");
  });

  it("refuses a plan that may pull more than amountIn from the user", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan({ settleMax: req.amountIn + 1n })]), value: 0n }, req), "more than amountIn");
  });

  it("refuses a plan that settles another currency from the user", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan({ settleCurrency: TOKEN_OUT })]), value: 0n }, req), "other than tokenIn");
  });

  it("refuses output taken to a third party, inside the plan and by SWEEP", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan({ take: { recipient: ATTACKER, kind: "take" } })]), value: 0n }, req), "third party");
    const plan = infiPlan({ take: { recipient: ADDRESS_THIS, kind: "take" } });
    const sweep = abi([{ type: "address" }, { type: "address" }, { type: "uint256" }], [TOKEN_OUT, ATTACKER, 0n]);
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x04], [plan, sweep]), value: 0n }, req), "third party");
  });

  it("refuses output parked in the router with no sweep to the user", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan({ take: { recipient: ADDRESS_THIS, kind: "take" } })]), value: 0n }, req), "never swept");
  });

  it("refuses a floor below the minimum shown, a changed deadline, and a wrong value", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan({ minOut: req.minAmountOut - 1n })]), value: 0n }, req), "below the minimum");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan()], req.deadline + 1), value: 0n }, req), "deadline");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [infiPlan()]), value: 1n }, req), "tx.value");
  });

  it("requires value == amountIn for a native input and 0 otherwise", () => {
    const native = { ...req, tokenIn: NATIVE };
    const plan = infiPlan({ settleCurrency: NATIVE });
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [plan]), value: req.amountIn }, native)).not.toThrow();
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [plan]), value: 0n }, native), "tx.value");
  });

  it("refuses third-party AMM legs, sub-plans and pool initialisation", () => {
    for (const cmd of [0x00, 0x08, 0x21, 0x13, 0x22]) {
      refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([cmd, 0x10], ["0x", infiPlan()]), value: 0n }, req), "not part of a Gully Core pool swap");
    }
  });

  it("refuses bytes that are not execute at all", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: fill(), value: 0n }, req), "not UniversalRouter.execute");
  });
});

describe("verifySwapCalldata · GullyCoreFillRouter", () => {
  const feeReq = { ...req, feeBps: 15 };
  it("accepts exactly the quoted fill", () => {
    expect(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill(), value: 0n }, feeReq)).not.toThrow();
  });
  it("refuses another pair, amount, recipient, floor, fee, deadline or flag", () => {
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ currencyOut: ATTACKER }), value: 0n }, feeReq), "another pair");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ amountIn: req.amountIn + 1n }), value: 0n }, feeReq), "another amount");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ recipient: ATTACKER }), value: 0n }, feeReq), "another recipient");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ minAmountOut: req.minAmountOut - 1n }), value: 0n }, feeReq), "below the minimum");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ maxFeeBps: 50 }), value: 0n }, feeReq), "fee differs");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ deadline: BigInt(req.deadline + 1) }), value: 0n }, feeReq), "deadline");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: fill({ wrapInput: true }), value: 0n }, feeReq), "wrap/unwrap");
  });
});

/* ---- the chain's native coin against a pool quoted in the wrapped native (2026-10-11) ---- */

const WNATIVE: Address = "0x6666666666666666666666666666666666666666";
const CONTRACT_BALANCE = 1n << 255n;
const A2 = [{ type: "address" }, { type: "uint256" }] as const;
const A3 = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;

/** Buy with native: swap, the ROUTER pays the wrapped native it just wrapped, all output to the caller. */
function wrapPlan(over: { settleCurrency?: Address; settleAmount?: bigint; payerIsUser?: boolean } = {}): Hex {
  const actions = [0x06, 0x0b, 0x0f];
  const params: Hex[] = [
    abi([{ type: "bytes32" }], ["0x" + "ab".repeat(32) as Hex]),
    abi([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [over.settleCurrency ?? WNATIVE, over.settleAmount ?? 0n, over.payerIsUser ?? false]),
    abi(A2, [TOKEN_OUT, req.minAmountOut]),
  ];
  return abi([{ type: "bytes" }, { type: "bytes[]" }], [bytesOf(actions), params]);
}

/** Sell into native: swap, settle the token from the user, take the wrapped native to the router. */
function unwrapPlan(over: { takeCurrency?: Address; takeTo?: Address } = {}): Hex {
  const actions = [0x06, 0x0c, 0x0e];
  const params: Hex[] = [
    abi([{ type: "bytes32" }], ["0x" + "ab".repeat(32) as Hex]),
    abi(A2, [TOKEN_IN, req.amountIn]),
    abi(A3, [over.takeCurrency ?? WNATIVE, over.takeTo ?? ADDRESS_THIS, 0n]),
  ];
  return abi([{ type: "bytes" }, { type: "bytes[]" }], [bytesOf(actions), params]);
}

describe("verifySwapCalldata · native coin through a wrapped-native pool", () => {
  const buyNative: SwapRequestFacts = { ...req, tokenIn: NATIVE, wrappedNative: WNATIVE };
  const sellNative: SwapRequestFacts = { ...req, tokenOut: NATIVE, wrappedNative: WNATIVE };
  const wrap = (amount = req.amountIn, to: Address = ADDRESS_THIS) => abi(A2, [to, amount]);
  const refundNative = (to: Address = MSG_SENDER) => abi(A3, [NATIVE, to, 0n]);
  const unwrap = (to: Address = MSG_SENDER, min = req.minAmountOut) => abi(A2, [to, min]);

  it("accepts WRAP_ETH(amountIn) → INFI_SWAP paid by the router in the wrapped native → refund SWEEP", () => {
    const data = execute([0x0b, 0x10, 0x04], [wrap(), wrapPlan(), refundNative()]);
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data, value: req.amountIn }, buyNative)).not.toThrow();
    // CONTRACT_BALANCE is the whole msg.value, which the value check already pins to amountIn.
    const all = execute([0x0b, 0x10], [wrap(CONTRACT_BALANCE), wrapPlan()]);
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: all, value: req.amountIn }, buyNative)).not.toThrow();
  });

  it("refuses the native buy when the value, the wrap or the router-paid settle are off", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(), wrapPlan()]), value: 0n }, buyNative), "tx.value");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(req.amountIn + 1n), wrapPlan()]), value: req.amountIn }, buyNative), "wrap exceeds amountIn");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(req.amountIn, ATTACKER), wrapPlan()]), value: req.amountIn }, buyNative), "wrap pays a third party");
    // No wrap first: a router-paid settle is not the user paying (it would spend whatever the router holds).
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [wrapPlan()]), value: req.amountIn }, buyNative), "never settles");
    // The router pays something other than what was wrapped.
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(), wrapPlan({ settleCurrency: TOKEN_IN })]), value: req.amountIn }, buyNative), "other than the wrapped native");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(), wrapPlan({ settleAmount: req.amountIn + 1n })]), value: req.amountIn }, buyNative), "more than amountIn");
    // Without the wrapped native to check against, nothing router-paid is accepted.
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(), wrapPlan()]), value: req.amountIn }, { ...req, tokenIn: NATIVE }), "other than the wrapped native");
  });

  it("refuses a WRAP_ETH on a trade that does not pay native, and a native refund to a third party", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(), infiPlan()]), value: 0n }, { ...req, wrappedNative: WNATIVE }), "does not pay native");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10, 0x04], [wrap(), wrapPlan(), refundNative(ATTACKER)]), value: req.amountIn }, buyNative), "third party");
  });

  it("refuses a plan-level SWEEP of the router's balance to a third party (the wrapped funds sit there)", () => {
    const actions = [0x14, 0x06, 0x0b, 0x0f];
    const params: Hex[] = [
      abi([{ type: "address" }, { type: "address" }], [WNATIVE, ATTACKER]),
      abi([{ type: "bytes32" }], ["0x" + "ab".repeat(32) as Hex]),
      abi([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [WNATIVE, 0n, false]),
      abi(A2, [TOKEN_OUT, req.minAmountOut]),
    ];
    const plan = abi([{ type: "bytes" }, { type: "bytes[]" }], [bytesOf(actions), params]);
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x0b, 0x10], [wrap(), plan]), value: req.amountIn }, buyNative), "third party");
  });

  it("accepts INFI_SWAP taking the wrapped native to the router → UNWRAP_WETH to the user at the floor", () => {
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan(), unwrap()]), value: 0n }, sellNative)).not.toThrow();
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan(), unwrap(USER)]), value: 0n }, sellNative)).not.toThrow();
  });

  it("refuses the drain: UNWRAP_WETH to a third party", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan(), unwrap(ATTACKER)]), value: 0n }, sellNative), "unwrap pays a third party");
  });

  it("refuses an unwrap below the floor, with no wrapped native, on a non-native trade, or with nothing to unwrap", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan(), unwrap(MSG_SENDER, req.minAmountOut - 1n)]), value: 0n }, sellNative), "floor is below");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan(), unwrap()]), value: 0n }, { ...req, tokenOut: NATIVE }), "plan takes a currency other than the output");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [infiPlan(), unwrap()]), value: 0n }, { ...req, wrappedNative: WNATIVE }), "does not ask for native");
    const takeAllWrapped = abi([{ type: "bytes" }, { type: "bytes[]" }], [
      bytesOf([0x06, 0x0c, 0x0f]),
      [abi([{ type: "bytes32" }], ["0x" + "ab".repeat(32) as Hex]), abi(A2, [TOKEN_IN, req.amountIn]), abi(A2, [WNATIVE, req.minAmountOut])],
    ]);
    // Paying the caller WETH when they asked for native is not the requested swap.
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10], [takeAllWrapped]), value: 0n }, sellNative), "other than the output");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [takeAllWrapped, unwrap()]), value: 0n }, sellNative), "other than the output");
  });

  it("refuses a TAKE of the wrapped native straight to the user or a third party on a native sell", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan({ takeTo: USER }), unwrap()]), value: 0n }, sellNative), "other than the output");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: execute([0x10, 0x0c], [unwrapPlan({ takeTo: ATTACKER }), unwrap()]), value: 0n }, sellNative), "third party");
  });
});

describe("verifySwapCalldata · PERMIT2_PERMIT (the swap carries the Permit2 signature)", () => {
  const PERMIT_INPUT = [
    {
      type: "tuple",
      components: [
        { name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    { type: "bytes" },
  ] as const;
  const MAX160 = (1n << 160n) - 1n;
  const permit = (o: { token?: Address; spender?: Address; amount?: bigint; sigLen?: number } = {}): Hex =>
    abi(PERMIT_INPUT, [
      { details: { token: o.token ?? TOKEN_IN, amount: o.amount ?? MAX160, expiration: 1_900_000_000, nonce: 0 }, spender: o.spender ?? ROUTER, sigDeadline: 1_900_000_000n },
      ("0x" + "11".repeat(o.sigLen ?? 65)) as Hex,
    ]);
  const tx = (cmds: number[], ins: Hex[], value = 0n) => ({ to: ROUTER, data: execute(cmds, ins), value });

  it("accepts one permit for tokenIn to this router, first, for at least amountIn", () => {
    expect(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit(), infiPlan()]), req)).not.toThrow();
    expect(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit({ amount: req.amountIn, sigLen: 64 }), infiPlan()]), req)).not.toThrow();
  });
  it("refuses a permit for another spender (a drain of the standing allowance)", () => {
    refusal(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit({ spender: ATTACKER }), infiPlan()]), req), "spender other than this router");
  });
  it("refuses a permit for another token", () => {
    refusal(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit({ token: TOKEN_OUT }), infiPlan()]), req), "token other than tokenIn");
  });
  it("refuses a permit below amountIn", () => {
    refusal(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit({ amount: req.amountIn - 1n }), infiPlan()]), req), "less than amountIn");
  });
  it("refuses a permit anywhere but first, and a second one", () => {
    refusal(() => verifySwapCalldata("universal-router", tx([0x10, 0x0a], [infiPlan(), permit()]), req), "anywhere but first");
    refusal(() => verifySwapCalldata("universal-router", tx([0x0a, 0x0a, 0x10], [permit(), permit(), infiPlan()]), req), "anywhere but first");
  });
  it("refuses a malformed signature and a permit on a native trade", () => {
    refusal(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit({ sigLen: 66 }), infiPlan()]), req), "64 or 65 bytes");
    const nativeReq = { ...req, tokenIn: NATIVE };
    refusal(() => verifySwapCalldata("universal-router", tx([0x0a, 0x10], [permit({ token: NATIVE }), infiPlan({ settleCurrency: NATIVE })], nativeReq.amountIn), nativeReq), "pays native");
  });
  it("still refuses the batch permit", () => {
    refusal(() => verifySwapCalldata("universal-router", tx([0x03, 0x10], [permit(), infiPlan()]), req), "command 0x03");
  });
});

/* A Base Builder Code (ERC-8021) appended after the call: the Base App appends one to every transaction
   of a registered app, and Gully Core's own site appends its code on Base. The router ignores trailing
   bytes, so the verifier accepts EXACTLY one such suffix, and refuses any other bytes after the call. */
describe("verifySwapCalldata · ERC-8021 attribution suffix", () => {
  const suffix = Attribution.toDataSuffix({ codes: ["bc_b7k3p9da"] });
  const two = Attribution.toDataSuffix({ codes: ["bc_b7k3p9da", "baseapp"] });
  const feeReq = { ...req, feeBps: 15 };
  const plus = (d: Hex, t: Hex) => (d + t.slice(2)) as Hex;

  it("recognises exactly the suffix ox writes, and nothing near it", () => {
    expect(isErc8021Suffix(suffix)).toBe(true);
    expect(isErc8021Suffix(two)).toBe(true);
    expect(isErc8021Suffix("0x")).toBe(false);
    expect(isErc8021Suffix(`0x00${suffix.slice(2)}`)).toBe(false); // a stray byte in front
    expect(isErc8021Suffix(suffix.slice(0, -2) + "22")).toBe(false); // a broken marker
    expect(isErc8021Suffix(Attribution.toDataSuffix({ codes: ["bc x"] }))).toBe(false); // not a code
  });

  it("accepts a swap with one Builder Code suffix, on both routers", () => {
    expect(() => verifySwapCalldata("universal-router", { to: ROUTER, data: plus(execute([0x10], [infiPlan()]), suffix), value: 0n }, req)).not.toThrow();
    expect(() => verifySwapCalldata("fill-router", { to: ROUTER, data: plus(fill(), two), value: 0n }, feeReq)).not.toThrow();
  });

  it("refuses any other trailing bytes: junk, an address, a suffix with a byte in front, two suffixes", () => {
    const junk = "0xdeadbeef" as Hex;
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: plus(execute([0x10], [infiPlan()]), junk), value: 0n }, req), "trailing bytes");
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: plus(execute([0x10], [infiPlan()]), ATTACKER as Hex), value: 0n }, req), "trailing bytes");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: plus(fill(), `0x00${suffix.slice(2)}` as Hex), value: 0n }, feeReq), "trailing bytes");
    refusal(() => verifySwapCalldata("fill-router", { to: ROUTER, data: plus(plus(fill(), suffix), suffix), value: 0n }, feeReq), "trailing bytes");
  });

  it("the decoded call is unchanged by the suffix: a bad swap with a suffix is still refused for what it is", () => {
    refusal(() => verifySwapCalldata("universal-router", { to: ROUTER, data: plus(execute([0x10], [infiPlan({ take: { recipient: ATTACKER, kind: "take" } })]), suffix), value: 0n }, req), "third party");
  });
});

