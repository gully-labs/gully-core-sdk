// SPDX-License-Identifier: MIT
/**
 * The lock reads with no React in them: one pool's locks or one token's locks,
 * read through the MIT SDK (`@gullylabs/core-sdk/lock`). `usePoolLocks` /
 * `useTokenLocks` wrap these as resources; the framework-free embed
 * (`gullycore-embed.js`) calls them directly.
 */

import { erc20Abi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  findClLpLockerTokenIds,
  permanentTokenPools,
  readBinLpLockerLocks,
  readBinPoolPermanent,
  readChainNow,
  readClLpLockerPositionsPriced,
  readClPoolPermanent,
  readCurrencyLocks,
  readPoolLocks,
  summarizePoolLocks,
  type BinPoolPermanentSummary,
  type CurrencyLockSummary,
  type PoolLockSummary,
  type TokenPermanentPool,
} from "@gullylabs/core-sdk/lock";

import type { LocksTokenMeta, LpLockerSource } from "./model.js";
import { shortAddress } from "../core/format.js";

/** What a lock read needs beyond the addresses. */
export interface LocksReadOptions {
  readonly native?: NativeCurrencyMeta;
  /** The protocol's LP lockers: their permanent liquidity is read and counted. */
  readonly lp?: LpLockerSource;
}

/** Native currency display facts (address zero). */
export interface NativeCurrencyMeta {
  readonly symbol: string;
  readonly decimals: number;
}

export const DEFAULT_NATIVE: NativeCurrencyMeta = { symbol: "ETH", decimals: 18 };

/**
 * Symbol and decimals as the token answers them. Read here rather than through
 * the SDK's kit reader so the framework-free embed does not carry the kit's ABI.
 */
async function metaOf(client: PublicClient, address: Address, native: NativeCurrencyMeta): Promise<LocksTokenMeta> {
  if (address.toLowerCase() === zeroAddress) return { address: zeroAddress, symbol: native.symbol, decimals: native.decimals };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
  ]);
  return { address, symbol: symbol ?? shortAddress(address), decimals: decimals === null ? null : Number(decimals) };
}

export interface PoolLocksData {
  /** CL: time locks and the CL LP locker's permanent positions. Bin pool: an empty summary. */
  readonly summary: PoolLockSummary;
  /** Bin pool: what the Bin LP locker holds forever; `null` for a CL pool. */
  readonly bin: BinPoolPermanentSummary | null;
  readonly currency0: LocksTokenMeta;
  readonly currency1: LocksTokenMeta;
  /** The chain's `block.timestamp` when read. */
  readonly chainNow: bigint;
  /** `Date.now()` when read, to advance `chainNow` locally. */
  readonly readAtMs: number;
}

export interface TokenLocksData {
  /** `null` when no token lock is deployed (only LP-locker liquidity is read). */
  readonly summary: CurrencyLockSummary | null;
  /** How much of the token the LP lockers hold forever, per pool; `null` when no LP locker was given. */
  readonly permanent: { readonly pools: readonly TokenPermanentPool[]; readonly total: bigint; readonly unpriced: number } | null;
  readonly token: LocksTokenMeta;
  readonly chainNow: bigint;
  readonly readAtMs: number;
}


async function clLockerTokenIds(client: PublicClient, lp: LpLockerSource, poolId?: Hex): Promise<readonly bigint[]> {
  if (!lp.lpLocker) return [];
  if (lp.lpLockerTokenIds) return lp.lpLockerTokenIds;
  if (lp.lpLockerFromBlock === undefined) return [];
  const toBlock = await client.getBlockNumber();
  return (await findClLpLockerTokenIds(client, lp.lpLocker, { fromBlock: lp.lpLockerFromBlock, toBlock }, poolId)).map((x) => x.tokenId);
}

/**
 * Every lock in one pool (the SDK's `readPoolLocks`), with both currencies'
 * metadata. The loader behind {@link usePoolLocks}, usable without React (the
 * framework-free embed reads through it).
 */
export async function fetchPoolLocks(
  client: PublicClient,
  positionLock: Address | null,
  poolId: Hex,
  options: LocksReadOptions = {},
): Promise<PoolLocksData> {
  const native = options.native ?? DEFAULT_NATIVE;
  const lp = options.lp ?? {};
  if (lp.poolType === "bin") {
    const [bin, now] = await Promise.all([readBinPoolPermanent(client, lp.binLpLocker as Address, poolId), readChainNow(client)]);
    const readAtMs = Date.now();
    const f = bin.locks[0];
    const [currency0, currency1] = await Promise.all([metaOf(client, f?.currency0 ?? zeroAddress, native), metaOf(client, f?.currency1 ?? zeroAddress, native)]);
    const summary = summarizePoolLocks({ poolId, currency0: currency0.address, currency1: currency1.address, pool: null, locks: [] });
    return { summary, bin, currency0, currency1, chainNow: now, readAtMs };
  }
  const ids = await clLockerTokenIds(client, lp, poolId);
  let summary: PoolLockSummary;
  let chainNow: bigint;
  if (positionLock !== null) {
    const s = await readPoolLocks(client, positionLock, poolId, { lpLocker: lp.lpLocker ?? null, lpLockerTokenIds: ids });
    summary = s;
    chainNow = s.now;
  } else {
    const [perm, now] = await Promise.all([readClPoolPermanent(client, lp.lpLocker as Address, poolId, { tokenIds: ids }), readChainNow(client)]);
    const f = perm.permanent[0];
    summary = summarizePoolLocks({ poolId, currency0: f?.currency0 ?? zeroAddress, currency1: f?.currency1 ?? zeroAddress, pool: perm.pool, locks: [], permanent: perm.permanent });
    chainNow = now;
  }
  const readAtMs = Date.now();
  const [currency0, currency1] = await Promise.all([metaOf(client, summary.currency0, native), metaOf(client, summary.currency1, native)]);
  return { summary, bin: null, currency0, currency1, chainNow, readAtMs };
}

/** Whether {@link fetchPoolLocks} has anything to read for this target. */
export function poolLocksEnabled(positionLock: Address | null, lp: LpLockerSource = {}): boolean {
  return lp.poolType === "bin" ? !!lp.binLpLocker : positionLock !== null || !!lp.lpLocker;
}

/**
 * Every lock of one token (the SDK's `readCurrencyLocks`), with its metadata
 * and what the LP lockers hold of it. The loader behind {@link useTokenLocks}.
 */
export async function fetchTokenLocks(
  client: PublicClient,
  tokenLock: Address | null,
  token: Address,
  options: LocksReadOptions = {},
): Promise<TokenLocksData> {
  const native = options.native ?? DEFAULT_NATIVE;
  const lp = options.lp ?? {};
  const hasLp = !!lp.lpLocker || !!lp.binLpLocker;
  const [summary, meta, now, permanent] = await Promise.all([
    tokenLock === null ? Promise.resolve(null) : readCurrencyLocks(client, tokenLock, token),
    metaOf(client, token, native),
    readChainNow(client),
    hasLp
      ? (async () => {
          const ids = await clLockerTokenIds(client, lp);
          const [cl, bin] = await Promise.all([
            lp.lpLocker ? readClLpLockerPositionsPriced(client, lp.lpLocker, ids) : Promise.resolve([]),
            lp.binLpLocker ? readBinLpLockerLocks(client, lp.binLpLocker).then((r) => r.locks) : Promise.resolve([]),
          ]);
          return permanentTokenPools(token, cl, bin);
        })()
      : Promise.resolve(null),
  ]);
  return { summary, permanent, token: meta, chainNow: summary?.now ?? now, readAtMs: Date.now() };
}
