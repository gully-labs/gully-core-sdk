// SPDX-License-Identifier: MIT
/**
 * `gullycore swap quote|exec`: exact-input swaps.
 *
 * Two paths, one review.
 *
 *   Router (default)   the Gully Core Router API through the SDK's `GullyCoreRouterClient`, which checks the
 *                      target and decodes the bytes against the address book before returning them.
 *   --pool <id>        one named pool, quoted on chain by the quoter and encoded here. Needs no API.
 *
 * The guards run in both: slippage, price impact, a floor no looser than the slippage asked for, the minimum
 * shown before anything is signed, exact-amount approvals built locally, and a simulation of the exact bytes.
 */

import { approvalsOf, verifySwapCalldata, type RouterApproval, type RouterQuote } from "@gullylabs/core-sdk/router";
import { UNIVERSAL_ROUTER_ABI, applySlippage, quoteBinExactInputSingle, quoteExactInputSingle } from "@gullylabs/core-sdk/trading";
import { buildErc20Approve } from "@gullylabs/core-sdk/lock";
import { erc20Abi, getAddress, isAddress, isAddressEqual, type Abi, type Address } from "viem";

import { API_FLAGS, apiBase, routerClient, routerFailure } from "../lib/api.js";
import { PERMIT2_ABI, encodePermit2Approve, permit2Steps } from "../lib/approvals.js";
import { bpsPercent, formatUnitsTrim, parseUnitsExact, pipsPercent } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { buildPoolSwap } from "../lib/callpath.js";
import { CHAIN_FLAGS, assertLiveChain, requireDeployment, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, requireFlag, type CommandSpec, type ParsedCommand } from "../lib/command.js";
import { loadConfig } from "../lib/config.js";
import { formatProtocolFee } from "../lib/fees.js";
import { assertMayWrite, flowExit, runFlow, type FlowTx } from "../lib/flow.js";
import type { Output } from "../lib/output.js";
import { assertPoolId, findPool, readPoolState, type PoolRecord } from "../lib/pools.js";
import { canPrompt } from "../lib/prompt.js";
import { SLIPPAGE_FLAGS, assertMinOut, assertPriceImpact, slippageBps } from "../lib/slippage.js";
import { balanceOf, resolveToken, type ResolvedToken } from "../lib/tokens.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf, type Signer } from "../lib/tx.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

const TRADE_FLAGS = {
  in: { kind: "string", describe: "the token you pay: native, a symbol from the address book, or an address", placeholder: "<token>" },
  out: { kind: "string", describe: "the token you get", placeholder: "<token>" },
  amount: { kind: "string", describe: "how much you pay, in whole tokens", placeholder: "<n>" },
  pool: { kind: "string", describe: "swap through this one pool, quoted on chain, without the Router API", placeholder: "<poolId>" },
  ...SLIPPAGE_FLAGS,
  ...API_FLAGS,
} as const;

export const SWAP_QUOTE_SPEC: CommandSpec = {
  name: "swap quote",
  summary: "price a swap: expected out, minimum out, fees, price impact",
  usage: "gullycore swap quote --in <token> --out <token> --amount <n> --chain <chain> [--pool <id>]",
  bytes32Flags: ["pool"],
  flags: { ...CHAIN_FLAGS, ...TRADE_FLAGS },
  examples: ["gullycore swap quote --in ETH --out 0x3De9Cbf8E013897c4CAc6C0dc523abf965372358 --amount 0.001 --chain gully-testnet", "gullycore swap quote --in 0xA… --out 0xB… --amount 10 --pool 0x… --chain 485590 --json"],
};

export const SWAP_EXEC_SPEC: CommandSpec = {
  name: "swap exec",
  summary: "swap: shows the fee and the minimum out, simulates, then prints or signs",
  usage: "gullycore swap exec --in <token> --out <token> --amount <n> --chain <chain> [signing]",
  bytes32Flags: ["pool"],
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    ...TRADE_FLAGS,
    recipient: { kind: "string", describe: "who receives the output (default: the sender)", placeholder: "<address>" },
    "min-out": { kind: "string", describe: "a floor of your own, in whole tokens; it must be no looser than --slippage", placeholder: "<n>" },
  },
  examples: [
    "gullycore swap exec --in ETH --out 0x3De9Cbf8E013897c4CAc6C0dc523abf965372358 --amount 0.001 --chain gully-testnet --dry-run --from 0x…",
    "gullycore swap exec --in ETH --out 0x3De9Cbf8E013897c4CAc6C0dc523abf965372358 --amount 0.001 --chain gully-testnet --keystore me.json",
  ],
};

interface Quoted {
  readonly via: "router" | "pool";
  readonly amountOut: bigint;
  readonly minOut: bigint;
  readonly slippageBps: number;
  readonly priceImpactBps: number | null;
  /** Each fee on its own line, for the review and for --json. */
  readonly fees: readonly { readonly label: string; readonly value: string }[];
  readonly route: string;
  readonly router: RouterQuote | null;
}

function assertPairInPool(ctx: ChainContext, pool: PoolRecord, a: ResolvedToken, b: ResolvedToken): void {
  const inPool = (t: ResolvedToken): boolean => isAddressEqual(t.address, pool.key.currency0) || isAddressEqual(t.address, pool.key.currency1);
  if (!inPool(a) || !inPool(b) || isAddressEqual(a.address, b.address)) {
    throw new UserError(`that pool on ${ctx.name} does not trade ${a.symbol} for ${b.symbol}`, `its currencies are ${pool.key.currency0} and ${pool.key.currency1}`);
  }
}

async function quotePool(ctx: ChainContext, pool: PoolRecord, tokenIn: ResolvedToken, tokenOut: ResolvedToken, amountIn: bigint, bps: number): Promise<Quoted> {
  const d = requireDeployment(ctx);
  assertPairInPool(ctx, pool, tokenIn, tokenOut);
  const state = await readPoolState(ctx, pool);
  const call = pool.kind === "CL" ? quoteExactInputSingle({ quoter: d.clQuoter, poolKey: pool.key, tokenIn: tokenIn.address, amountIn }) : quoteBinExactInputSingle({ quoter: d.binQuoter, poolKey: pool.key, tokenIn: tokenIn.address, amountIn });
  let amountOut: bigint;
  try {
    const { result } = await ctx.client.simulateContract(call as never);
    amountOut = (result as readonly [bigint, bigint])[0];
  } catch {
    throw new UserError(`the quoter could not fill this on that pool`, "the pool may lack the depth, or its hook refused the swap", EXIT.SIMULATION);
  }
  return {
    via: "pool",
    amountOut,
    minOut: applySlippage(amountOut, bps),
    slippageBps: bps,
    priceImpactBps: null,
    fees: [
      { label: "Pool fee", value: pipsPercent(state.lpFee) },
      { label: "Protocol fee", value: formatProtocolFee(state.protocolFee) },
    ],
    route: `${pool.kind} pool ${pool.poolId}`,
    router: null,
  };
}

function fromRouter(q: RouterQuote, bps: number): Quoted {
  const routed = q.protocolFee.exempt || q.protocolFee.bps === 0 ? "none on a Gully Core pool" : `${bpsPercent(q.protocolFee.bps)} (read from the fill router)`;
  return {
    via: "router",
    amountOut: q.amountOut,
    minOut: q.minAmountOut,
    slippageBps: bps,
    priceImpactBps: q.priceImpactBps,
    fees: [
      { label: "Routed fee", value: routed },
      { label: "Pool fees", value: "inside the quoted output" },
    ],
    route: `${q.route.source} via ${q.route.execution === "gullycore-fill-router" ? "the fill router" : "the universal router"}`,
    router: q,
  };
}

function review(out: Output, q: Quoted, tokenIn: ResolvedToken, tokenOut: ResolvedToken, amountIn: bigint): void {
  out.line(ui.bold("Review"));
  out.rows([
    ["You pay", `${formatUnitsTrim(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`],
    ["Expected out", `${formatUnitsTrim(q.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`],
    ["Minimum out", `${formatUnitsTrim(q.minOut, tokenOut.decimals)} ${tokenOut.symbol}`],
    ["Slippage", bpsPercent(q.slippageBps)],
    ["Price impact", q.priceImpactBps === null ? "not measured" : bpsPercent(q.priceImpactBps)],
    ...q.fees.map((f) => [f.label, f.value] as const),
    ["Route", q.route],
  ]);
}

function json(q: Quoted, tokenIn: ResolvedToken, tokenOut: ResolvedToken, amountIn: bigint): Record<string, unknown> {
  return {
    via: q.via,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    amountOut: q.amountOut,
    minAmountOut: q.minOut,
    slippageBps: q.slippageBps,
    priceImpactBps: q.priceImpactBps,
    fees: q.fees,
    route: q.route,
    expiresAt: q.router?.expiresAt ?? null,
  };
}

interface Trade {
  readonly ctx: ChainContext;
  readonly api: string;
  readonly tokenIn: ResolvedToken;
  readonly tokenOut: ResolvedToken;
  readonly amountIn: bigint;
  readonly bps: number;
  readonly pool: PoolRecord | null;
  readonly accept: boolean;
}

async function setUp(cmd: ParsedCommand): Promise<Trade> {
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  await assertLiveChain(ctx);
  const accept = cmd.bool("accept-high-slippage");
  const bps = slippageBps(cmd.str("slippage"), loadConfig().slippage, accept);
  const api = apiBase(cmd.str("api"));
  const tokenIn = await resolveToken(ctx, requireFlag(cmd, "in"), "--in");
  const tokenOut = await resolveToken(ctx, requireFlag(cmd, "out"), "--out");
  if (isAddressEqual(tokenIn.address, tokenOut.address)) throw new UsageError("--in and --out are the same token");
  const amountIn = parseUnitsExact(requireFlag(cmd, "amount"), tokenIn.decimals, "--amount");
  if (amountIn <= 0n) throw new UsageError("--amount must be above zero");
  const poolFlag = cmd.str("pool");
  const pool = poolFlag === undefined ? null : await findPool(ctx, api, assertPoolId(poolFlag));
  return { ctx, api, tokenIn, tokenOut, amountIn, bps, pool, accept };
}

async function quote(t: Trade): Promise<Quoted> {
  if (t.pool !== null) return quotePool(t.ctx, t.pool, t.tokenIn, t.tokenOut, t.amountIn, t.bps);
  try {
    const q = await routerClient(t.api, t.ctx).quote({ chainId: t.ctx.chainId, tokenIn: t.tokenIn.address, tokenOut: t.tokenOut.address, amountIn: t.amountIn, slippageBps: t.bps });
    return fromRouter(q, t.bps);
  } catch (err) {
    throw routerFailure(err);
  }
}

export async function runSwapQuote(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, SWAP_QUOTE_SPEC);
  if (cmd.help) {
    cmd.out.line(helpText(SWAP_QUOTE_SPEC));
    return 0;
  }
  const t = await setUp(cmd);
  const q = await quote(t);
  review(cmd.out, q, t.tokenIn, t.tokenOut, t.amountIn);
  assertPriceImpact(q.priceImpactBps, t.accept);
  cmd.out.result("swap quote", { chainId: t.ctx.chainId, result: json(q, t.tokenIn, t.tokenOut, t.amountIn) });
  return 0;
}

/** The approvals a swap needs, from the router's list but built here. The API never decides what is approved. */
export function approvalsFrom(ctx: ChainContext, owner: Address, wanted: readonly RouterApproval[], t: { token: Address; amount: bigint; permit2: Address; targets: readonly Address[]; expiry: bigint; symbol: string }): FlowTx[] {
  const base = { chainId: ctx.chainId, from: owner };
  return wanted.map((a, i): FlowTx => {
    if (!isAddressEqual(a.token, t.token)) throw new UserError("the router asked to approve a different token; refused", undefined, EXIT.REFUSED);
    const trusted = a.kind === "erc20-approve" ? [t.permit2, ...t.targets] : t.targets;
    if (!trusted.some((s) => isAddressEqual(s, a.spender))) throw new UserError(`the router asked to approve an unknown spender ${a.spender}; refused`, undefined, EXIT.REFUSED);
    if (a.kind === "erc20-approve") return { label: `approve ${t.symbol} (exact amount)`, tx: { ...base, ...buildErc20Approve({ token: t.token, spender: a.spender, amount: t.amount }) }, afterPrevious: i > 0 };
    return { label: `grant ${t.symbol} through Permit2 (exact amount, 1 hour)`, tx: { ...base, to: t.permit2, data: encodePermit2Approve(t.token, a.spender, t.amount, Number(t.expiry)), value: 0n }, afterPrevious: i > 0 };
  });
}

const FLOW_ABIS = [UNIVERSAL_ROUTER_ABI as unknown as Abi, erc20Abi as unknown as Abi, PERMIT2_ABI as unknown as Abi];

export async function runSwapExec(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, SWAP_EXEC_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(SWAP_EXEC_SPEC));
    return 0;
  }
  const t = await setUp(cmd);
  const { ctx, tokenIn, tokenOut, amountIn, bps } = t;
  const d = requireDeployment(ctx);
  const yes = cmd.bool("yes");
  assertMayWrite(ctx, yes);
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const recipientFlag = cmd.str("recipient");
  if (recipientFlag !== undefined && !isAddress(recipientFlag)) throw new UsageError(`--recipient is not an address: ${recipientFlag}`);
  const recipient = recipientFlag !== undefined ? getAddress(recipientFlag) : signer.address;
  const minOutFlag = cmd.str("min-out");
  const ownFloor = minOutFlag === undefined ? null : parseUnitsExact(minOutFlag, tokenOut.decimals, "--min-out");

  const q = await quote(t);
  const shown: Quoted = ownFloor !== null ? { ...q, minOut: ownFloor } : q;
  review(out, shown, tokenIn, tokenOut, amountIn);
  assertPriceImpact(q.priceImpactBps, t.accept);
  assertMinOut(shown.minOut, q.amountOut, bps);

  const held = await balanceOf(ctx, tokenIn, signer.address);
  if (held < amountIn) {
    const text = `${signer.address} holds ${formatUnitsTrim(held, tokenIn.decimals)} ${tokenIn.symbol}, less than the ${formatUnitsTrim(amountIn, tokenIn.decimals)} this swap pays`;
    if (signer.account !== null || signer.hardware !== undefined) throw new UserError(text);
    out.warn(text);
  }

  const confirm = { prompting: !yes && !out.json && canPrompt(), yes, what: `This swaps ${formatUnitsTrim(amountIn, tokenIn.decimals)} ${tokenIn.symbol} for at least ${formatUnitsTrim(shown.minOut, tokenOut.decimals)} ${tokenOut.symbol}.`, expected: "swap" };
  const body = { chainId: ctx.chainId, quote: json(shown, tokenIn, tokenOut, amountIn) };
  const now = (await ctx.client.getBlock()).timestamp;

  if (t.pool !== null) {
    const deadline = now + 1_200n;
    const call = buildPoolSwap({ router: d.universalRouter, kind: t.pool.kind, key: t.pool.key, tokenIn: tokenIn.address, amountIn, minOut: shown.minOut, recipient, sender: signer.address, deadline });
    /* The SDK's own checker reads the bytes back: what is about to be signed is exactly this swap. */
    verifySwapCalldata("universal-router", call, { tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, recipient, minAmountOut: shown.minOut, deadline: Number(deadline), wrappedNative: d.weth });
    const txs: FlowTx[] = tokenIn.native ? [] : await permit2Steps(ctx, { owner: signer.address, token: tokenIn.address, symbol: tokenIn.symbol, spender: d.universalRouter, amount: amountIn, permit2: d.permit2, now });
    txs.push({ label: "swap", tx: { chainId: ctx.chainId, from: signer.address, ...call }, afterPrevious: txs.length > 0 });
    const r = await runFlow(out, ctx, signer, txs, confirm, FLOW_ABIS);
    out.result("swap exec", { ...body, txs: txs.map((x) => x.tx), result: r });
    return flowExit(r);
  }
  return execViaRouter(cmd, t, signer, recipient, shown, ownFloor, confirm, body, now);
}

async function execViaRouter(
  cmd: ParsedCommand,
  t: Trade,
  signer: Signer,
  recipient: Address,
  shown: Quoted,
  ownFloor: bigint | null,
  confirm: { prompting: boolean; yes: boolean; what: string; expected: string },
  body: Record<string, unknown>,
  now: bigint,
): Promise<number> {
  const { ctx, tokenIn, tokenOut, amountIn, bps } = t;
  const d = requireDeployment(ctx);
  const client = routerClient(t.api, ctx);
  const request = { chainId: ctx.chainId, tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, sender: signer.address, recipient, slippageBps: bps, ...(ownFloor !== null ? { amountOutMinimum: ownFloor } : {}) };
  const build = async (): Promise<Awaited<ReturnType<typeof client.swap>>> => {
    const built = await client.swap(request);
    assertMinOut(built.minAmountOut, built.quote.amountOut, bps);
    return built;
  };
  const out = cmd.out;
  let built: Awaited<ReturnType<typeof client.swap>> | null = null;
  let approvals: FlowTx[] = [];
  try {
    built = await build();
  } catch (err) {
    const wanted = approvalsOf(err);
    if (wanted.length === 0) throw routerFailure(err);
    const targets = [d.universalRouter, ...(d.fillRouter !== null ? [d.fillRouter] : [])];
    approvals = approvalsFrom(ctx, signer.address, wanted, { token: tokenIn.address, amount: amountIn, permit2: d.permit2, targets, expiry: now + 3_600n, symbol: tokenIn.symbol });
  }
  if (built === null) {
    const first = await runFlow(out, ctx, signer, approvals, confirm, FLOW_ABIS);
    if (first.sent.length === 0 || !first.ok) {
      if (first.ok) out.line(ui.muted("The router builds the swap once these approvals have landed: send them, then run this again."));
      out.result("swap exec", { ...body, needsApproval: true, txs: approvals.map((x) => x.tx), result: first });
      return flowExit(first);
    }
    try {
      built = await build();
    } catch (err) {
      throw routerFailure(err);
    }
  }
  const tx = { chainId: ctx.chainId, from: signer.address, to: built.tx.to, data: built.tx.data, value: built.tx.value };
  if (built.minAmountOut !== shown.minOut) out.line(ui.muted(`Minimum out now ${formatUnitsTrim(built.minAmountOut, tokenOut.decimals)} ${tokenOut.symbol}, fresh from the chain`));
  const r = await runFlow(out, ctx, signer, [{ label: "swap", tx }], approvals.length > 0 ? { ...confirm, yes: true, prompting: false } : confirm, FLOW_ABIS);
  out.result("swap exec", { ...body, tx, targetVerifiedBy: built.targetVerifiedBy, result: r });
  return flowExit(r);
}

export async function runSwap(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "quote") return runSwapQuote(rest);
  if (sub === "exec") return runSwapExec(rest);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    const cmd = parseCommand([], { name: "swap", summary: "", usage: "", flags: {} });
    cmd.out.line(`${helpText(SWAP_QUOTE_SPEC)}\n\n${helpText(SWAP_EXEC_SPEC)}`);
    return sub === undefined ? EXIT.USAGE : 0;
  }
  throw new UsageError(`unknown swap command "${sub}"`, "gullycore swap quote | exec");
}
