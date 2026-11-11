// SPDX-License-Identifier: MIT
/**
 * `gullycore liquidity add|remove`.
 *
 * CL: a position between two ticks (`--tick-lower/--tick-upper`, `--range-pct`, or `--full-range`). Bin: a
 * uniform spread over `--bins` bins each side of the active id. Liquidity comes out of the amounts given, the
 * most each side may pay is `--slippage` above what the pool needs now, and a removal floors what comes back
 * at `--slippage` under what the position holds now. Approvals are exact, through Permit2.
 */

import { positionAmounts } from "@gullylabs/core-sdk/lock";
import { poolKeyToId, sqrtRatioAtTick, type PoolKey } from "@gullylabs/core-sdk";
import { BIN_POSITION_MANAGER_ABI, CL_POSITION_MANAGER_ABI, applySlippage, applySlippageToInput } from "@gullylabs/core-sdk/trading";
import { erc20Abi, getAddress, isAddress, isAddressEqual, parseAbi, type Abi, type Address, type Hex } from "viem";

import { API_FLAGS, apiBase } from "../lib/api.js";
import { PERMIT2_ABI, permit2Steps } from "../lib/approvals.js";
import { formatUnitsTrim, parseIntStrict, parseUnitsExact } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { binPositionId, buildBinAdd, buildBinRemove, buildClDecrease, buildClMint, liquidityForAmounts, uniformBins } from "../lib/callpath.js";
import { CHAIN_FLAGS, assertLiveChain, requireDeployment, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, requireFlag, type CommandSpec, type ParsedCommand } from "../lib/command.js";
import { loadConfig } from "../lib/config.js";
import { assertMayWrite, flowExit, runFlow, type FlowTx } from "../lib/flow.js";
import { assertPoolId, findPool, readPoolState, type PoolRecord } from "../lib/pools.js";
import { canPrompt } from "../lib/prompt.js";
import { SLIPPAGE_FLAGS, slippageBps } from "../lib/slippage.js";
import { resolveToken, type ResolvedToken } from "../lib/tokens.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf, type Signer } from "../lib/tx.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

export const LIQUIDITY_ADD_SPEC: CommandSpec = {
  name: "liquidity add",
  summary: "add liquidity to a CL or Bin pool",
  usage: "gullycore liquidity add --pool <id> --amount0 <n> --amount1 <n> (--range-pct <n> | --full-range | --tick-lower <t> --tick-upper <t>) --chain <chain> [signing]",
  bytes32Flags: ["pool"],
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    ...SLIPPAGE_FLAGS,
    ...API_FLAGS,
    pool: { kind: "string", describe: "the pool", placeholder: "<poolId>" },
    amount0: { kind: "string", describe: "currency0 to deposit, whole tokens", placeholder: "<n>" },
    amount1: { kind: "string", describe: "currency1 to deposit, whole tokens", placeholder: "<n>" },
    "tick-lower": { kind: "string", describe: "CL: lower tick (negatives need --tick-lower=-600)", placeholder: "<tick>" },
    "tick-upper": { kind: "string", describe: "CL: upper tick", placeholder: "<tick>" },
    "range-pct": { kind: "string", describe: "CL: this many percent either side of the current price", placeholder: "<pct>" },
    "full-range": { kind: "boolean", describe: "CL: every tick the pool allows" },
    bins: { kind: "string", describe: "Bin: bins each side of the active one", placeholder: "<n>", defaultLabel: "5" },
    "id-slippage": { kind: "string", describe: "Bin: how far the active bin may move", placeholder: "<n>", defaultLabel: "5" },
  },
  examples: ["gullycore liquidity add --pool 0x… --amount0 1 --amount1 3500 --range-pct 10 --chain gully-testnet --dry-run --from 0x…"],
};

export const LIQUIDITY_REMOVE_SPEC: CommandSpec = {
  name: "liquidity remove",
  summary: "take liquidity out of a CL position or Bin bins",
  usage: "gullycore liquidity remove (--token-id <id> | --pool <id> --ids <a,b,…>) [--percent <n>] --chain <chain> [signing]",
  bytes32Flags: ["pool"],
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    ...SLIPPAGE_FLAGS,
    ...API_FLAGS,
    "token-id": { kind: "string", describe: "CL: the position's NFT id", placeholder: "<id>" },
    pool: { kind: "string", describe: "Bin: the pool", placeholder: "<poolId>" },
    ids: { kind: "string", describe: "Bin: comma list of bin ids", placeholder: "<a,b,…>" },
    percent: { kind: "string", describe: "how much of the position", placeholder: "<pct>", defaultLabel: "100" },
  },
  examples: ["gullycore liquidity remove --token-id 42 --percent 50 --chain gully-testnet --dry-run --from 0x…"],
};

const MAX_TICK = 887_272;
const BIN_STATE_ABI = parseAbi(["function getBin(bytes32 id, uint24 binId) view returns (uint128 binReserveX, uint128 binReserveY, uint256 binLiquidity, uint256 totalShares)"]);

function alignDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/** The tick pair a command asked for, on the pool's spacing. Exported for tests. */
export function tickRange(cmd: { tickLower?: string | undefined; tickUpper?: string | undefined; rangePct?: string | undefined; fullRange: boolean }, tick: number, spacing: number): readonly [number, number] {
  const widest = alignDown(MAX_TICK, spacing);
  if (cmd.fullRange) return [-widest, widest];
  if (cmd.rangePct !== undefined) {
    const pct = Number(cmd.rangePct);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new UsageError("--range-pct must be above 0 and below 100");
    const up = Math.log(1 + pct / 100) / Math.log(1.0001);
    const down = Math.log(1 - pct / 100) / Math.log(1.0001);
    const lower = alignDown(Math.round(tick + down), spacing);
    const upper = alignDown(Math.round(tick + up), spacing) + spacing;
    return [Math.max(lower, -widest), Math.min(upper, widest)];
  }
  if (cmd.tickLower === undefined || cmd.tickUpper === undefined) throw new UsageError("say the range: --range-pct, --full-range, or --tick-lower with --tick-upper");
  const lower = Number(cmd.tickLower);
  const upper = Number(cmd.tickUpper);
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower >= upper) throw new UsageError("--tick-lower must be a whole number below --tick-upper");
  if (lower % spacing !== 0 || upper % spacing !== 0) throw new UsageError(`both ticks must be multiples of the pool's tick spacing, ${spacing}`);
  return [lower, upper];
}

async function context(cmd: ParsedCommand): Promise<{ ctx: ChainContext; signer: Signer; bps: number; yes: boolean; deadline: bigint; now: bigint }> {
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  const yes = cmd.bool("yes");
  assertMayWrite(ctx, yes);
  await assertLiveChain(ctx);
  const bps = slippageBps(cmd.str("slippage"), loadConfig().slippage, cmd.bool("accept-high-slippage"));
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const now = (await ctx.client.getBlock()).timestamp;
  return { ctx, signer, bps, yes, deadline: now + 1_200n, now };
}

async function pair(ctx: ChainContext, key: PoolKey): Promise<[ResolvedToken, ResolvedToken]> {
  return Promise.all([resolveToken(ctx, key.currency0, "currency0"), resolveToken(ctx, key.currency1, "currency1")]);
}

const ABIS = [CL_POSITION_MANAGER_ABI as unknown as Abi, BIN_POSITION_MANAGER_ABI as unknown as Abi, erc20Abi as unknown as Abi, PERMIT2_ABI as unknown as Abi];

export async function runLiquidityAdd(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, LIQUIDITY_ADD_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(LIQUIDITY_ADD_SPEC));
    return 0;
  }
  const { ctx, signer, bps, yes, deadline, now } = await context(cmd);
  const d = requireDeployment(ctx);
  const pool: PoolRecord = await findPool(ctx, apiBase(cmd.str("api")), assertPoolId(requireFlag(cmd, "pool")));
  const state = await readPoolState(ctx, pool);
  const [t0, t1] = await pair(ctx, pool.key);
  const want0 = parseUnitsExact(cmd.str("amount0") ?? "0", t0.decimals, "--amount0");
  const want1 = parseUnitsExact(cmd.str("amount1") ?? "0", t1.decimals, "--amount1");
  if (want0 === 0n && want1 === 0n) throw new UsageError("say how much: --amount0 and/or --amount1");

  let call;
  let need0: bigint;
  let need1: bigint;
  let detail: string;
  const positionManager = state.kind === "CL" ? d.clPositionManager : d.binPositionManager;
  if (state.kind === "CL") {
    const [lower, upper] = tickRange({ tickLower: cmd.str("tick-lower"), tickUpper: cmd.str("tick-upper"), rangePct: cmd.str("range-pct"), fullRange: cmd.bool("full-range") }, state.tick, state.tickSpacing);
    const liquidity = liquidityForAmounts(state.sqrtPriceX96, sqrtRatioAtTick(lower), sqrtRatioAtTick(upper), want0, want1);
    if (liquidity === 0n) throw new UserError("those amounts buy no liquidity in this range", "the range may sit on one side of the price: add the other token, or widen it");
    const held = positionAmounts({ liquidity, tickLower: lower, tickUpper: upper, tick: state.tick, sqrtPriceX96: state.sqrtPriceX96 });
    need0 = held.amount0 + (held.amount0 > 0n ? 1n : 0n);
    need1 = held.amount1 + (held.amount1 > 0n ? 1n : 0n);
    const max0 = need0 === 0n ? 0n : applySlippageToInput(need0, bps);
    const max1 = need1 === 0n ? 0n : applySlippageToInput(need1, bps);
    const value = t0.native ? max0 : t1.native ? max1 : 0n;
    call = { ...buildClMint({ positionManager, key: pool.key, tickLower: lower, tickUpper: upper, liquidity, amount0Max: max0, amount1Max: max1, owner: signer.address, deadline, value }), max0, max1 };
    detail = `ticks ${lower} to ${upper}`;
  } else {
    const perSide = parseIntStrict(cmd.str("bins") ?? "5", "--bins", 0, 50);
    const idSlippage = parseIntStrict(cmd.str("id-slippage") ?? "5", "--id-slippage", 0, 1_000);
    const shape = uniformBins(perSide);
    need0 = want0;
    need1 = want1;
    const max0 = need0 === 0n ? 0n : applySlippageToInput(need0, bps);
    const max1 = need1 === 0n ? 0n : applySlippageToInput(need1, bps);
    const value = t0.native ? max0 : t1.native ? max1 : 0n;
    call = { ...buildBinAdd({ positionManager, key: pool.key, amount0: need0, amount1: need1, amount0Max: max0, amount1Max: max1, activeId: state.activeId, idSlippage, ...shape, to: signer.address, deadline, value }), max0, max1 };
    detail = `${perSide * 2 + 1} bins around ${state.activeId}`;
  }

  const txs: FlowTx[] = [];
  for (const [t, amount] of [[t0, call.max0], [t1, call.max1]] as const) {
    if (t.native || amount === 0n) continue;
    const steps = await permit2Steps(ctx, { owner: signer.address, token: t.address, symbol: t.symbol, spender: positionManager, amount, permit2: d.permit2, now });
    txs.push(...steps.map((s) => ({ ...s, afterPrevious: txs.length > 0 || s.afterPrevious === true })));
  }
  const { to, data, value } = call;
  txs.push({ label: "add liquidity", tx: { chainId: ctx.chainId, from: signer.address, to, data, value }, afterPrevious: txs.length > 0 });

  out.line(ui.bold("Review"));
  out.rows([
    ["Pool", `${t0.symbol}/${t1.symbol} ${state.kind}`],
    ["Range", detail],
    [`Deposit ${t0.symbol}`, `${formatUnitsTrim(need0, t0.decimals)}, at most ${formatUnitsTrim(call.max0, t0.decimals)}`],
    [`Deposit ${t1.symbol}`, `${formatUnitsTrim(need1, t1.decimals)}, at most ${formatUnitsTrim(call.max1, t1.decimals)}`],
  ]);
  const confirm = { prompting: !yes && !out.json && canPrompt(), yes, what: `This deposits into ${t0.symbol}/${t1.symbol}.`, expected: "add" };
  const r = await runFlow(out, ctx, signer, txs, confirm, ABIS);
  out.result("liquidity add", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: { ...r, poolId: pool.poolId, amount0: need0, amount1: need1, amount0Max: call.max0, amount1Max: call.max1 } });
  return flowExit(r);
}

/** "12.5" percent as a fraction of 1e6. Whole position at 100. */
function share(text: string): bigint {
  const pct = Number(text);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new UsageError("--percent must be above 0 and at most 100");
  return BigInt(Math.round(pct * 10_000));
}

export async function runLiquidityRemove(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, LIQUIDITY_REMOVE_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(LIQUIDITY_REMOVE_SPEC));
    return 0;
  }
  const { ctx, signer, bps, yes, deadline } = await context(cmd);
  const d = requireDeployment(ctx);
  const part = share(cmd.str("percent") ?? "100");
  const tokenId = cmd.str("token-id");
  let call;
  let key: PoolKey;
  let expect0: bigint;
  let expect1: bigint;
  let poolId: Hex | null = null;
  if (tokenId !== undefined) {
    if (!/^\d+$/.test(tokenId)) throw new UsageError("--token-id must be a whole number");
    const id = BigInt(tokenId);
    const owner = await ctx.client.readContract({ address: d.clPositionManager, abi: CL_POSITION_MANAGER_ABI, functionName: "ownerOf", args: [id] }).catch(() => null);
    if (owner === null) throw new UserError(`no CL position ${id} on ${ctx.name}`);
    if (!isAddressEqual(owner as Address, signer.address)) throw new UserError(`position ${id} belongs to ${getAddress(owner as Address)}, not ${signer.address}`);
    const p = (await ctx.client.readContract({ address: d.clPositionManager, abi: CL_POSITION_MANAGER_ABI, functionName: "positions", args: [id] })) as unknown as readonly [PoolKey, number, number, bigint, ...unknown[]];
    const [positionKey, tickLower, tickUpper, liquidity] = p;
    key = positionKey;
    if (liquidity === 0n) throw new UserError(`position ${id} is empty`);
    const take = (liquidity * part) / 1_000_000n;
    const state = await readPoolState(ctx, { poolId: poolKeyToId(key), kind: "CL", key });
    if (state.kind !== "CL") throw new Error("unreachable");
    const held = positionAmounts({ liquidity: take, tickLower: Number(tickLower), tickUpper: Number(tickUpper), tick: state.tick, sqrtPriceX96: state.sqrtPriceX96 });
    expect0 = held.amount0;
    expect1 = held.amount1;
    call = buildClDecrease({ positionManager: d.clPositionManager, key, tokenId: id, liquidity: take, amount0Min: applySlippage(expect0, bps), amount1Min: applySlippage(expect1, bps), deadline });
  } else {
    const pool = await findPool(ctx, apiBase(cmd.str("api")), assertPoolId(requireFlag(cmd, "pool", "--token-id for a CL position, --pool with --ids for Bin")));
    if (pool.kind !== "Bin") throw new UsageError("a CL position is removed by --token-id");
    const ids = requireFlag(cmd, "ids", "the bin ids to burn, e.g. --ids 8388608,8388609").split(",").map((s) => parseIntStrict(s, "--ids", 0, 16_777_215));
    key = pool.key;
    poolId = pool.poolId;
    const amounts: bigint[] = [];
    expect0 = 0n;
    expect1 = 0n;
    for (const bin of ids) {
      const held = await ctx.client.readContract({ address: d.binPositionManager, abi: BIN_POSITION_MANAGER_ABI, functionName: "balanceOf", args: [signer.address, binPositionId(pool.poolId, bin)] });
      if (held === 0n) throw new UserError(`${signer.address} holds nothing in bin ${bin}`);
      const take = (held * part) / 1_000_000n;
      const [rx, ry, , total] = await ctx.client.readContract({ address: key.poolManager, abi: BIN_STATE_ABI, functionName: "getBin", args: [pool.poolId, bin] });
      amounts.push(take);
      if (total > 0n) {
        expect0 += (BigInt(rx) * take) / total;
        expect1 += (BigInt(ry) * take) / total;
      }
    }
    call = buildBinRemove({ positionManager: d.binPositionManager, key, amount0Min: applySlippage(expect0, bps), amount1Min: applySlippage(expect1, bps), ids, amounts, from: signer.address, deadline });
  }
  const [t0, t1] = await pair(ctx, key);
  const min0 = applySlippage(expect0, bps);
  const min1 = applySlippage(expect1, bps);
  out.line(ui.bold("Review"));
  out.rows([
    [`Back ${t0.symbol}`, `${formatUnitsTrim(expect0, t0.decimals)}, at least ${formatUnitsTrim(min0, t0.decimals)}`],
    [`Back ${t1.symbol}`, `${formatUnitsTrim(expect1, t1.decimals)}, at least ${formatUnitsTrim(min1, t1.decimals)}`],
  ]);
  const tx = { chainId: ctx.chainId, from: signer.address, ...call };
  const confirm = { prompting: !yes && !out.json && canPrompt(), yes, what: `This withdraws from ${t0.symbol}/${t1.symbol}.`, expected: "remove" };
  const r = await runFlow(out, ctx, signer, [{ label: "remove liquidity", tx }], confirm, ABIS);
  out.result("liquidity remove", { chainId: ctx.chainId, tx, result: { ...r, poolId, amount0Min: min0, amount1Min: min1 } });
  return flowExit(r);
}

export const LIQUIDITY_SPECS = [LIQUIDITY_ADD_SPEC, LIQUIDITY_REMOVE_SPEC];

export async function runLiquidity(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "add") return runLiquidityAdd(rest);
  if (sub === "remove") return runLiquidityRemove(rest);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    const cmd = parseCommand([], { name: "liquidity", summary: "", usage: "", flags: {} });
    cmd.out.line(LIQUIDITY_SPECS.map(helpText).join("\n\n"));
    return sub === undefined ? EXIT.USAGE : 0;
  }
  throw new UsageError(`unknown liquidity command "${sub}"`, "gullycore liquidity add | remove");
}
