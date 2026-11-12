// SPDX-License-Identifier: MIT
/**
 * Headless readers for the lock widgets: one pool's position locks or one
 * token's locks, read through the MIT SDK (`@gullylabs/core-sdk/lock`), plus
 * the chain clock their countdowns run on.
 *
 * No provider is required: a lock badge is read-only and takes a viem
 * `PublicClient` directly, so a host can drop it beside any pool without the
 * swap stack. A `null` lock address (the chain has no address for it) leaves the
 * resource `idle`; the component says "coming soon" rather than reading.
 * The loaders themselves live in `../locks/fetch.ts`, React-free.
 */

import { useEffect, useState } from "react";
import type { Address, Hex, PublicClient } from "viem";

import { advanceChainNow, type LpLockerSource } from "../locks/model.js";
import {
  DEFAULT_NATIVE,
  fetchPoolLocks,
  fetchTokenLocks,
  poolLocksEnabled,
  type NativeCurrencyMeta,
  type PoolLocksData,
  type TokenLocksData,
} from "../locks/fetch.js";
import { useAsyncResource, type AsyncResource } from "./useAsyncResource.js";

export { fetchPoolLocks, fetchTokenLocks, poolLocksEnabled, type LocksReadOptions, type NativeCurrencyMeta, type PoolLocksData, type TokenLocksData } from "../locks/fetch.js";

export interface UseLocksOptions {
  readonly native?: NativeCurrencyMeta;
  /** Re-read interval; default 60 s. 0 disables polling. */
  readonly refetchIntervalMs?: number;
  /** The protocol's LP lockers: their permanent liquidity is read and counted. */
  readonly lp?: LpLockerSource;
}

/** Every lock in one pool, as a React resource. See {@link fetchPoolLocks}. */
export function usePoolLocks(
  client: PublicClient,
  positionLock: Address | null,
  poolId: Hex,
  options: UseLocksOptions = {},
): AsyncResource<PoolLocksData> {
  const native = options.native ?? DEFAULT_NATIVE;
  const lp = options.lp ?? {};
  return useAsyncResource(
    () => fetchPoolLocks(client, positionLock, poolId, { native, lp }),
    [client, positionLock, poolId, native.symbol, native.decimals, lp.lpLocker, lp.binLpLocker, lp.poolType, lp.lpLockerFromBlock, (lp.lpLockerTokenIds ?? []).join(",")],
    { enabled: poolLocksEnabled(positionLock, lp), refetchIntervalMs: options.refetchIntervalMs ?? 60_000 },
  );
}

/** Every lock of one token, as a React resource. See {@link fetchTokenLocks}. */
export function useTokenLocks(
  client: PublicClient,
  tokenLock: Address | null,
  token: Address,
  options: UseLocksOptions = {},
): AsyncResource<TokenLocksData> {
  const native = options.native ?? DEFAULT_NATIVE;
  const lp = options.lp ?? {};
  const hasLp = !!lp.lpLocker || !!lp.binLpLocker;
  return useAsyncResource(
    () => fetchTokenLocks(client, tokenLock, token, { native, lp }),
    [client, tokenLock, token, native.symbol, native.decimals, lp.lpLocker, lp.binLpLocker, lp.lpLockerFromBlock, (lp.lpLockerTokenIds ?? []).join(",")],
    { enabled: tokenLock !== null || hasLp, refetchIntervalMs: options.refetchIntervalMs ?? 60_000 },
  );
}

/**
 * The chain's `block.timestamp` now: `chainNow` as read, advanced by the
 * local clock once a second. `null` until there is a read.
 */
export function useChainClock(chainNow: bigint | null, readAtMs: number | null): bigint | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (chainNow === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [chainNow]);
  if (chainNow === null || readAtMs === null) return null;
  return advanceChainNow(chainNow, readAtMs, nowMs);
}
