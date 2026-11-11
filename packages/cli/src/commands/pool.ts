// SPDX-License-Identifier: MIT
/**
 * `gullycore pool list|info|create`.
 *
 * `create` opens a CL or Bin pool on the shared core through a position manager's `initializePool`. It shows
 * the protocol fee the installed controller gives the new pool, read from the chain, beside the LP fee the
 * creator picks. An outside builder's pool pays Gully the flat 0.30% once fee controller V5 is live; where
 * it is not, the chain's own figure is what is shown.
 */

import {
  BUILDER_POOL_RULES,
  DYNAMIC_FEE_FLAG,
  NATIVE_CURRENCY,
  createBinPoolKey,
  createCLPoolKey,
  encodeProtocolFee,
  isValidHookBitmap,
  poolKeyToId,
  priceFromSqrtPriceX96,
  sqrtPriceX96FromPrice,
  sortCurrencies,
  binIdFromRawPrice,
  type PoolKey,
} from "@gullylabs/core-sdk";
import { BIN_POSITION_MANAGER_ABI, CL_POSITION_MANAGER_ABI } from "@gullylabs/core-sdk/trading";
import { encodeFunctionData, getAddress, isAddress, isAddressEqual, parseAbi, type Abi, type Address, type Hex } from "viem";

import { API_FLAGS, apiBase } from "../lib/api.js";
import { parseIntStrict, pipsPercent } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, assertLiveChain, requireDeployment, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, requireFlag, type CommandSpec } from "../lib/command.js";
import { formatProtocolFee, readController, readFeeForNewPool } from "../lib/fees.js";
import { assertMayWrite, flowExit, runFlow } from "../lib/flow.js";
import { apiPools, assertPoolId, findPool, readPoolState, requireInitialised, scanPools, type PoolRecord } from "../lib/pools.js";
import { canPrompt } from "../lib/prompt.js";
import { resolveToken, type ResolvedToken } from "../lib/tokens.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf } from "../lib/tx.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

export const POOL_LIST_SPEC: CommandSpec = {
  name: "pool list",
  summary: "list the pools on a chain",
  usage: "gullycore pool list --chain <chain> [--limit <n>] [--token <address>] [--from-chain]",
  flags: {
    ...CHAIN_FLAGS,
    ...API_FLAGS,
    limit: { kind: "string", describe: "how many pools", placeholder: "<n>", defaultLabel: "25" },
    token: { kind: "string", describe: "only pools holding this token", placeholder: "<address>" },
    "from-chain": { kind: "boolean", describe: "read the Initialize logs directly, skipping the API" },
  },
  examples: ["gullycore pool list --chain gully-testnet", "gullycore pool list --chain 485590 --from-chain --json"],
};

export const POOL_INFO_SPEC: CommandSpec = {
  name: "pool info",
  summary: "one pool: key, price, liquidity, fees in force",
  usage: "gullycore pool info <poolId> --chain <chain>",
  bytes32Positional: true,
  flags: { ...CHAIN_FLAGS, ...API_FLAGS },
  examples: ["gullycore pool info 0x… --chain gully-testnet --json"],
};

export const POOL_CREATE_SPEC: CommandSpec = {
  name: "pool create",
  summary: "open a CL or Bin pool on the shared core",
  usage: "gullycore pool create --token-a <token> --token-b <token> --price <b per a> --fee <pct> --chain <chain> [signing]",
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    "token-a": { kind: "string", describe: "one token: native, a book symbol, or an address", placeholder: "<token>" },
    "token-b": { kind: "string", describe: "the other token", placeholder: "<token>" },
    price: { kind: "string", describe: "the opening price: whole token-b per whole token-a", placeholder: "<n>" },
    type: { kind: "string", describe: "CL or Bin", placeholder: "<CL|Bin>", defaultLabel: "CL" },
    fee: { kind: "string", describe: "the LP fee, percent; dynamic for a hook that sets it", placeholder: "<pct|dynamic>", defaultLabel: "0.3" },
    "tick-spacing": { kind: "string", describe: "CL tick spacing", placeholder: "<n>", defaultLabel: "60" },
    "bin-step": { kind: "string", describe: "Bin step", placeholder: "<n>", defaultLabel: "10" },
    hook: { kind: "string", describe: "a hook contract; its bitmap is read from it", placeholder: "<address>" },
  },
  examples: ["gullycore pool create --token-a WETH --token-b USDC.e --price 3500 --fee 0.3 --chain gully-testnet --dry-run --from 0x…"],
};

const HOOK_BITMAP_ABI = parseAbi(["function getHooksRegistrationBitmap() view returns (uint16)"]);

function listing(p: PoolRecord): Record<string, unknown> {
  return { poolId: p.poolId, type: p.kind, source: p.source, ...p.key, symbols: p.symbols ?? null };
}

function showHelp(spec: CommandSpec, out: { line(t: string): void }): number {
  out.line(helpText(spec));
  return 0;
}

export async function runPoolList(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, POOL_LIST_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(POOL_LIST_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  const limit = parseIntStrict(cmd.str("limit") ?? "25", "--limit", 1, 500);
  const tokenFlag = cmd.str("token");
  if (tokenFlag !== undefined && !isAddress(tokenFlag)) throw new UsageError(`--token must be an address, received ${tokenFlag}`);
  const holds = (p: PoolRecord): boolean => tokenFlag === undefined || isAddressEqual(p.key.currency0, tokenFlag) || isAddressEqual(p.key.currency1, tokenFlag);

  let pools = cmd.bool("from-chain") ? null : await apiPools(apiBase(cmd.str("api")), ctx.chainId, 500);
  if (pools === null) {
    await assertLiveChain(ctx);
    pools = await scanPools(ctx);
  }
  const shown = pools.filter(holds).slice(0, limit);
  if (shown.length === 0) out.line(`No pools on ${ctx.name}${tokenFlag !== undefined ? " hold that token" : ""}.`);
  for (const p of shown) {
    const pair = p.symbols !== undefined ? `${p.symbols[0]}/${p.symbols[1]}` : `${p.key.currency0.slice(0, 10)}…/${p.key.currency1.slice(0, 10)}…`;
    out.line(`${ui.accent(p.kind.padEnd(4))}${pair.padEnd(26)}${p.poolId}`);
  }
  out.line(ui.muted(`${shown.length} of ${pools.filter(holds).length} on ${ctx.name}, from the ${pools[0]?.source ?? "chain"}`));
  out.result("pool list", { chainId: ctx.chainId, result: { total: pools.filter(holds).length, pools: shown.map(listing) } });
  return 0;
}

export async function runPoolInfo(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, POOL_INFO_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(POOL_INFO_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  await assertLiveChain(ctx);
  const id = cmd.args.positionals[0];
  if (id === undefined) throw new UsageError("gullycore pool info <poolId> needs the pool id");
  const pool = await findPool(ctx, apiBase(cmd.str("api")), assertPoolId(id));
  const state = await readPoolState(ctx, pool);
  const [t0, t1] = await Promise.all([resolveToken(ctx, pool.key.currency0, "currency0"), resolveToken(ctx, pool.key.currency1, "currency1")]);
  const price = state.kind === "CL" ? priceFromSqrtPriceX96(state.sqrtPriceX96, t0.decimals, t1.decimals, 12) : null;
  const dynamic = (pool.key.fee & DYNAMIC_FEE_FLAG) !== 0;
  out.line(ui.bold(`${t0.symbol}/${t1.symbol}`));
  out.rows([
    ["Pool id", pool.poolId],
    ["Type", state.kind === "CL" ? `CL, tick spacing ${state.tickSpacing}` : `Bin, step ${state.binStep}`],
    ["currency0", `${t0.address} (${t0.symbol})`],
    ["currency1", `${t1.address} (${t1.symbol})`],
    ["Hook", /^0x0+$/.test(pool.key.hooks) ? "none" : pool.key.hooks],
    [state.kind === "CL" ? "Tick" : "Active bin", String(state.kind === "CL" ? state.tick : state.activeId)],
    ...(price !== null ? [["Price", `${price} ${t1.symbol} per ${t0.symbol}`] as const] : []),
    ...(state.kind === "CL" ? [["Active liquidity", state.liquidity.toString()] as const] : []),
    ["LP fee", `${pipsPercent(state.lpFee)}${dynamic ? " (dynamic)" : ""}`],
    ["Protocol fee", formatProtocolFee(state.protocolFee)],
  ]);
  out.result("pool info", { chainId: ctx.chainId, result: { ...listing(pool), state, price, dynamicFee: dynamic, tokens: [t0, t1] } });
  return 0;
}

function lpFeePips(text: string): number {
  if (text.trim().toLowerCase() === "dynamic") return DYNAMIC_FEE_FLAG;
  const m = /^(\d+)(?:\.(\d{1,4}))?%?$/.exec(text.trim());
  if (m === null) throw new UsageError(`--fee must be a percentage like 0.3, or dynamic, received ${text}`);
  const pips = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0") || "0");
  if (pips > 100_000) throw new UsageError("--fee is above 10%");
  return pips;
}

interface Pair {
  readonly token0: ResolvedToken;
  readonly token1: ResolvedToken;
  /** The price as whole token1 per whole token0, an exact decimal string. */
  readonly price: string;
}

/** Sorts the pair the way the core does and turns the price round with it. */
export function orderPair(a: ResolvedToken, b: ResolvedToken, priceBPerA: string): Pair {
  if (!/^\d+(\.\d+)?$/.test(priceBPerA.trim()) || Number(priceBPerA) <= 0) throw new UsageError(`--price must be a positive decimal, received ${priceBPerA}`);
  const [c0] = sortCurrencies(a.address, b.address);
  if (isAddressEqual(c0, a.address)) return { token0: a, token1: b, price: priceBPerA.trim() };
  /* 1 / price to eighteen places, which is far finer than a tick. */
  const places = priceBPerA.trim().split(".")[1]?.length ?? 0;
  const digits = BigInt(priceBPerA.trim().replace(".", ""));
  const inverted = (10n ** BigInt(18 + places)) / digits;
  const text = inverted.toString().padStart(19, "0");
  return { token0: b, token1: a, price: `${text.slice(0, -18)}.${text.slice(-18)}` };
}

async function hookBitmap(ctx: ChainContext, hook: Address, kind: "CL" | "Bin"): Promise<number> {
  let bitmap: number;
  try {
    bitmap = await ctx.client.readContract({ address: hook, abi: HOOK_BITMAP_ABI, functionName: "getHooksRegistrationBitmap" });
  } catch {
    throw new UserError(`${hook} does not answer getHooksRegistrationBitmap() on ${ctx.name}`, "is it a Gully Core hook on this chain?");
  }
  if (!isValidHookBitmap(bitmap, kind === "CL" ? "CL" : "BIN")) throw new UserError(`${hook} declares an invalid ${kind} hook bitmap: ${bitmap}`);
  return bitmap;
}

export async function runPoolCreate(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, POOL_CREATE_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(POOL_CREATE_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const d = requireDeployment(ctx);
  const yes = cmd.bool("yes");
  assertMayWrite(ctx, yes);
  await assertLiveChain(ctx);

  const typeText = (cmd.str("type") ?? "CL").toLowerCase();
  if (typeText !== "cl" && typeText !== "bin") throw new UsageError("--type must be CL or Bin");
  const kind = typeText === "cl" ? ("CL" as const) : ("Bin" as const);
  const a = await resolveToken(ctx, requireFlag(cmd, "token-a"), "--token-a");
  const b = await resolveToken(ctx, requireFlag(cmd, "token-b"), "--token-b");
  if (isAddressEqual(a.address, b.address)) throw new UsageError("--token-a and --token-b are the same token");
  const { token0, token1, price } = orderPair(a, b, requireFlag(cmd, "price"));
  const fee = lpFeePips(cmd.str("fee") ?? "0.3");
  const hookFlag = cmd.str("hook");
  if (hookFlag !== undefined && !isAddress(hookFlag)) throw new UsageError(`--hook is not an address: ${hookFlag}`);
  const hooks = hookFlag !== undefined ? getAddress(hookFlag) : NATIVE_CURRENCY;
  if (fee === DYNAMIC_FEE_FLAG && hookFlag === undefined) throw new UsageError("a dynamic fee needs a --hook that sets it");
  const bitmap = hookFlag !== undefined ? await hookBitmap(ctx, hooks, kind) : 0;

  let key: PoolKey;
  let openAt: bigint;
  let call: Hex;
  const manager = kind === "CL" ? d.clPoolManager : d.binPoolManager;
  const positionManager = kind === "CL" ? d.clPositionManager : d.binPositionManager;
  const shared = { currency0: token0.address, currency1: token1.address, hooks, poolManager: manager, fee, hooksRegistrationBitmap: bitmap };
  if (kind === "CL") {
    key = createCLPoolKey({ ...shared, tickSpacing: parseIntStrict(cmd.str("tick-spacing") ?? "60", "--tick-spacing", 1, 32_767) });
    openAt = sqrtPriceX96FromPrice({ price, decimals0: token0.decimals, decimals1: token1.decimals });
    call = encodeFunctionData({ abi: CL_POSITION_MANAGER_ABI, functionName: "initializePool", args: [key as never, openAt as never] });
  } else {
    const binStep = parseIntStrict(cmd.str("bin-step") ?? "10", "--bin-step", 1, 100);
    key = createBinPoolKey({ ...shared, binStep });
    const raw = Number(price) * 10 ** (token1.decimals - token0.decimals);
    const activeId = binIdFromRawPrice(raw, binStep);
    openAt = BigInt(activeId);
    call = encodeFunctionData({ abi: BIN_POSITION_MANAGER_ABI, functionName: "initializePool", args: [key as never, activeId as never] });
  }
  const poolId = poolKeyToId(key);
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (x) => isAddress(x));

  const controller = await readController(ctx, manager);
  const newPoolFee = await readFeeForNewPool(ctx, controller, key);
  const ruleFee = encodeProtocolFee({ zeroForOne: BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS, oneForZero: BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS });
  out.line(ui.bold("Review"));
  out.rows([
    ["Pool", `${token0.symbol}/${token1.symbol} ${kind}`],
    ["Pool id", poolId],
    ["Opening price", `${price} ${token1.symbol} per ${token0.symbol}`],
    ["LP fee", fee === DYNAMIC_FEE_FLAG ? "dynamic, set by the hook" : pipsPercent(fee)],
    ["Protocol fee", newPoolFee === null ? "the fee controller did not say; read it after with gullycore pool info" : `${formatProtocolFee(newPoolFee)}, from the fee controller`],
    ["Hook", hookFlag ?? "none"],
    ["Permanent", "the pair, the fee setting and the hook are the pool's identity and cannot change"],
  ]);
  if (newPoolFee !== null && newPoolFee !== ruleFee) out.line(ui.muted("The flat 0.30% for outside builders starts when fee controller V5 is live on this chain: gullycore fees shows what it charges today."));

  const tx = { chainId: ctx.chainId, from: signer.address, to: positionManager, data: call, value: 0n };
  const confirm = { prompting: !yes && !out.json && canPrompt(), yes, what: "This opens the pool at this price. Its first price cannot be set again.", expected: `${token0.symbol}/${token1.symbol}` };
  const r = await runFlow(out, ctx, signer, [{ label: "initializePool", tx }], confirm, [kind === "CL" ? (CL_POSITION_MANAGER_ABI as unknown as Abi) : (BIN_POSITION_MANAGER_ABI as unknown as Abi)]);
  /* A success receipt is not a pool: read slot0 (fails loudly, exit 4, naming the hash, when no price was set). */
  const created = r.ok && r.sent.length > 0 ? await requireInitialised(ctx, { poolId, kind, key }, (r.sent[r.sent.length - 1] as { hash: Hex }).hash) : null;
  out.result("pool create", { chainId: ctx.chainId, tx, result: { ...r, poolId, key, openAt, protocolFee: newPoolFee, initialised: created !== null ? true : r.sent.length > 0 ? false : null, state: created } });
  return flowExit(r);
}

export const POOL_SPECS = [POOL_LIST_SPEC, POOL_INFO_SPEC, POOL_CREATE_SPEC];

export async function runPool(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "list") return runPoolList(rest);
  if (sub === "info") return runPoolInfo(rest);
  if (sub === "create") return runPoolCreate(rest);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    const cmd = parseCommand([], { name: "pool", summary: "", usage: "", flags: {} });
    cmd.out.line(POOL_SPECS.map(helpText).join("\n\n"));
    return sub === undefined ? EXIT.USAGE : 0;
  }
  throw new UsageError(`unknown pool command "${sub}"`, "gullycore pool list | info | create");
}
