// SPDX-License-Identifier: MIT
/**
 * Finding a pool and reading its state.
 *
 * The API answers fast; the chain answers always. A pool key that came from the API is re-hashed to its pool
 * id before anything uses it, so a wrong answer can only be "not found", never a different pool.
 */

import {
  LOG_RANGE_LIMITS,
  poolKeyToId,
  readBinPoolKeyParameters,
  readCLPoolKeyParameters,
  readPoolDirectory,
  type PoolKey,
  type PoolListing,
} from "@gullylabs/core-sdk";
import { getAddress, type Address, type Hex } from "viem";

import { apiGet } from "./api.js";
import type { ChainContext } from "./chain.js";
import { requireDeployment } from "./chain.js";
import { EXIT, UserError } from "../util/log.js";

export interface PoolRecord {
  readonly poolId: Hex;
  readonly kind: "CL" | "Bin";
  readonly key: PoolKey;
  readonly source: "api" | "chain";
  /** Token symbols when the API gave them. */
  readonly symbols?: readonly [string, string];
}

interface ApiToken {
  readonly address: string;
  readonly symbol?: string;
}

interface ApiPool {
  readonly poolId: string;
  readonly poolType: string;
  readonly poolManager: string;
  readonly token0: ApiToken;
  readonly token1: ApiToken;
  readonly config: { readonly feeRaw: number; readonly parameters: string };
  readonly hook: { readonly address: string } | null;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** An API pool as a record, or null when its key does not hash to its id. */
export function poolFromApi(p: ApiPool): PoolRecord | null {
  try {
    const key: PoolKey = {
      currency0: getAddress(p.token0.address),
      currency1: getAddress(p.token1.address),
      hooks: p.hook === null ? ZERO : getAddress(p.hook.address),
      poolManager: getAddress(p.poolManager),
      fee: p.config.feeRaw,
      parameters: p.config.parameters as Hex,
    };
    if (poolKeyToId(key).toLowerCase() !== p.poolId.toLowerCase()) return null;
    const symbols = p.token0.symbol !== undefined && p.token1.symbol !== undefined ? ([p.token0.symbol, p.token1.symbol] as const) : undefined;
    return { poolId: p.poolId as Hex, kind: p.poolType === "CL" ? "CL" : "Bin", key, source: "api", ...(symbols !== undefined ? { symbols } : {}) };
  } catch {
    return null;
  }
}

/** Blocks per `eth_getLogs`: the endpoint's recorded limit, else a window every public RPC serves. */
export function logWindow(ctx: ChainContext): bigint {
  const known = ctx.rpcUrls.map((u) => LOG_RANGE_LIMITS[u]).filter((n): n is number => n !== undefined);
  return BigInt(known.length > 0 ? Math.min(...known) : 5_000);
}

/** The `Initialize` logs from the deployment block on, in windows the RPC will serve. */
export async function scanPools(ctx: ChainContext, stopAt?: Hex): Promise<PoolRecord[]> {
  const d = requireDeployment(ctx);
  const head = await ctx.client.getBlockNumber();
  const step = logWindow(ctx);
  const found: PoolListing[] = [];
  for (let from = d.deployedAtBlock; from <= head; from += step) {
    const to = from + step - 1n < head ? from + step - 1n : head;
    const page = await readPoolDirectory(ctx.client, d, { fromBlock: from, toBlock: to });
    found.push(...page);
    if (stopAt !== undefined && page.some((p) => p.poolId.toLowerCase() === stopAt.toLowerCase())) break;
  }
  return found.map((p) => ({ poolId: p.poolId, kind: p.kind, key: p.key, source: "chain" as const }));
}

/** Pools from the API, or null when the API cannot answer for this chain. */
export async function apiPools(api: string, chainId: number, limit: number): Promise<PoolRecord[] | null> {
  const data = (await apiGet(api, `/v1/chains/${chainId}/pools?limit=${limit}`)) as { items?: readonly ApiPool[] } | null;
  if (data === null || !Array.isArray(data.items)) return null;
  return (data.items as readonly ApiPool[]).map(poolFromApi).filter((p): p is PoolRecord => p !== null);
}

export function assertPoolId(id: string): Hex {
  /* Never echoes the value: a mistaken paste could be a private key. */
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new UserError("a pool id is 32 bytes of 0x-prefixed hex");
  return id as Hex;
}

/** One pool by id: API first, then the chain's logs. */
export async function findPool(ctx: ChainContext, api: string, poolId: Hex): Promise<PoolRecord> {
  const data = (await apiGet(api, `/v1/chains/${ctx.chainId}/pools/${poolId}`)) as ApiPool | null;
  const viaApi = data !== null && typeof data.poolId === "string" ? poolFromApi(data) : null;
  if (viaApi !== null) return viaApi;
  const onChain = (await scanPools(ctx, poolId)).find((p) => p.poolId.toLowerCase() === poolId.toLowerCase());
  if (onChain === undefined) throw new UserError(`no pool with that id on ${ctx.name}`);
  return onChain;
}

const SLOT0_ABI = {
  CL: [
    {
      type: "function",
      name: "getSlot0",
      stateMutability: "view",
      inputs: [{ name: "id", type: "bytes32" }],
      outputs: [
        { name: "sqrtPriceX96", type: "uint160" },
        { name: "tick", type: "int24" },
        { name: "protocolFee", type: "uint24" },
        { name: "lpFee", type: "uint24" },
      ],
    },
    { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "liquidity", type: "uint128" }] },
  ],
  Bin: [
    {
      type: "function",
      name: "getSlot0",
      stateMutability: "view",
      inputs: [{ name: "id", type: "bytes32" }],
      outputs: [
        { name: "activeId", type: "uint24" },
        { name: "protocolFee", type: "uint24" },
        { name: "lpFee", type: "uint24" },
      ],
    },
  ],
} as const;

export type PoolState =
  | { readonly kind: "CL"; readonly sqrtPriceX96: bigint; readonly tick: number; readonly protocolFee: number; readonly lpFee: number; readonly liquidity: bigint; readonly tickSpacing: number }
  | { readonly kind: "Bin"; readonly activeId: number; readonly protocolFee: number; readonly lpFee: number; readonly binStep: number };

/** The pool's live state from its own manager. An uninitialised pool is an error, not zeros. */
export async function readPoolState(ctx: ChainContext, pool: Pick<PoolRecord, "poolId" | "kind" | "key">): Promise<PoolState> {
  const address = pool.key.poolManager;
  if (pool.kind === "CL") {
    const abi = SLOT0_ABI.CL;
    const [slot0, liquidity] = await Promise.all([
      ctx.client.readContract({ address, abi, functionName: "getSlot0", args: [pool.poolId] }),
      ctx.client.readContract({ address, abi, functionName: "getLiquidity", args: [pool.poolId] }),
    ]);
    if (slot0[0] === 0n) throw new UserError(`that pool is not initialised on ${ctx.name}`);
    return { kind: "CL", sqrtPriceX96: slot0[0], tick: Number(slot0[1]), protocolFee: Number(slot0[2]), lpFee: Number(slot0[3]), liquidity, tickSpacing: readCLPoolKeyParameters(pool.key).tickSpacing };
  }
  const slot0 = await ctx.client.readContract({ address, abi: SLOT0_ABI.Bin, functionName: "getSlot0", args: [pool.poolId] });
  return { kind: "Bin", activeId: Number(slot0[0]), protocolFee: Number(slot0[1]), lpFee: Number(slot0[2]), binStep: readBinPoolKeyParameters(pool.key).binStep };
}


/**
 * After `initializePool`: read slot0 and require the pool to be live.
 *
 * A pool manager can return from `initializePool` having initialised nothing: a hook's `beforeInitialize` wrapped
 * in try/catch, or a gas limit too low for the hook, "succeeds" without writing the price. The transaction then
 * has a success receipt and no pool. So a create is not done until slot0 shows a price. The read is retried a few
 * times because an RPC behind several nodes can answer from a block behind the receipt's.
 * Throws `UserError` (exit 4) naming the transaction hash when the pool is still not initialised.
 */
export async function requireInitialised(
  ctx: ChainContext,
  pool: Pick<PoolRecord, "poolId" | "kind" | "key">,
  hash: Hex,
  opts: { readonly tries?: number; readonly delayMs?: number } = {},
): Promise<PoolState> {
  const tries = opts.tries ?? 4;
  const delay = opts.delayMs ?? 1_500;
  let last = "not initialised";
  for (let i = 0; i < tries; i++) {
    try {
      const s = await readPoolState(ctx, pool);
      const live = s.kind === "CL" ? s.sqrtPriceX96 !== 0n : s.activeId !== 0;
      if (live) return s;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delay));
  }
  throw new UserError(
    `transaction ${hash} succeeded but pool ${pool.poolId} is not initialised on ${ctx.name} (${last})`,
    "the call returned without setting a price; a hook that catches its own failure does this. Do not assume the pool exists: read it with gullycore pool info before adding liquidity",
    EXIT.SIMULATION,
  );
}
