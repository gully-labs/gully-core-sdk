// SPDX-License-Identifier: MIT
/**
 * Reads for the Gully Core utilities (Team splits, locks, airdrops), through the MIT
 * SDK (`@gullylabs/core-sdk/split`, `/lock`, `/drop`). This module only adds
 * what the SDK cannot know: which addresses `gullycore.config.ts` and the address
 * book resolve to, the configured token list, the configured launch kit (whose
 * lockers, guards and fee credits pay a split), and the log-scan start block.
 */

import { NATIVE_ADDRESS, readTokenMeta, type TokenMeta } from "@gullylabs/core-sdk";
import {
  findClLpLockerTokenIds,
  readCLPoolState,
  readChainNow,
  readClLpLockerPositions,
  readFeeGate,
  readPoolLocks,
  summarizePoolLocks,
  type FeeGateTerms,
  type PoolLockSummary,
} from "@gullylabs/core-sdk/lock";
import { GULLYCORE_SPLIT_FACTORY_ABI, type SplitSource } from "@gullylabs/core-sdk/split";
import { zeroAddress, type Address, type Hex } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "./client";
import { readKitV2Env, readLaunchesV2 } from "./launchesV2";

/* -------------------------------------------------------------- tokens --- */

export interface CurrencyMeta {
  readonly address: Address;
  readonly symbol: string;
  /** `null` when the token does not answer `decimals()`: amounts are then shown in base units. */
  readonly decimals: number | null;
}

const metaCache = new Map<string, Promise<CurrencyMeta>>();

/** Symbol and decimals of a currency; the zero address is the chain's native asset. Never invents a symbol. */
export function currencyMeta(address: Address): Promise<CurrencyMeta> {
  const key = address.toLowerCase();
  const hit = metaCache.get(key);
  if (hit !== undefined) return hit;
  const cfg = resolveConfig();
  const p: Promise<CurrencyMeta> =
    key === zeroAddress
      ? Promise.resolve({ address: zeroAddress, symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals })
      : readTokenMeta(publicClient(), address).then((m: TokenMeta | null) =>
          m === null ? { address, symbol: `${address.slice(0, 6)}…${address.slice(-4)}`, decimals: null } : { address, symbol: m.symbol, decimals: m.decimals },
        );
  metaCache.set(key, p);
  return p;
}

/** The currencies this app knows without a scan: native, then the configured tokens. */
export function knownCurrencies(): Address[] {
  return [NATIVE_ADDRESS, ...resolveConfig().tokens.map((t) => t.address)];
}

/* ---------------------------------------------------------------- fees --- */

export function readUtilityFee(address: Address): Promise<FeeGateTerms> {
  return readFeeGate(publicClient(), address);
}

/* -------------------------------------------------------------- splits --- */

/**
 * The Gully Core contracts that can owe a split money, from the configured launch
 * kit: both LP lockers and both launch guards (creator LP fees; creator tax,
 * and the trading fee where the guard takes it itself; `claimable` / `claim`) and the kit itself (integrator launch fees,
 * `feesOwed` / `claimFees`). Empty when no `LaunchpadKitV2` is configured —
 * a split then holds only what is sent to it directly.
 */
export async function splitSources(): Promise<readonly SplitSource[]> {
  if (resolveConfig().launchpadKitV2 === null) return [];
  const env = await readKitV2Env();
  return [
    { kind: "claim", address: env.clLocker, label: "CL LP locker (creator LP fees)" },
    { kind: "claim", address: env.binLocker, label: "Bin LP locker (creator LP fees)" },
    { kind: "claim", address: env.clHook, label: "CL launch guard (creator tax, trading fees)" },
    { kind: "claim", address: env.binHook, label: "Bin launch guard (creator tax, trading fees)" },
    { kind: "kitFees", address: env.kit, label: "Launch kit (integrator launch fees)" },
  ];
}

/**
 * Currencies to read a split's books in: native, the configured tokens, and
 * every currency of a v2 launch whose creator IS this split (its launch token
 * and its quotes) — read from the kit's logs, not typed.
 */
export async function splitCurrencies(split: Address): Promise<Address[]> {
  const out = new Map<string, Address>();
  for (const c of knownCurrencies()) out.set(c.toLowerCase(), c);
  if (resolveConfig().launchpadKitV2 !== null) {
    try {
      const scan = await readLaunchesV2();
      for (const launch of scan.launches) {
        if (launch.creator.toLowerCase() !== split.toLowerCase()) continue;
        out.set(launch.token.toLowerCase(), launch.token);
        for (const leg of launch.legs) out.set(leg.quote.toLowerCase(), leg.quote);
      }
    } catch {
      /* The launch scan is an enrichment; the split's own books still read. */
    }
  }
  return [...out.values()];
}

/** Whether `address` is a split the configured factory made (`isSplit`). */
export async function isFactorySplit(address: Address): Promise<boolean> {
  const factory = resolveConfig().utilities.splitFactory;
  if (factory === null) return false;
  return publicClient().readContract({ address: factory, abi: GULLYCORE_SPLIT_FACTORY_ABI, functionName: "isSplit", args: [address] });
}

/* --------------------------------------------------------------- locks --- */

/**
 * Which positions the protocol's CL LP locker holds, by pool, from its
 * `PositionLocked` logs since the scan start block. The locker has no withdraw
 * path, so every position found here is locked permanently. The locker is the
 * configured kit's when a kit is set, else the address book's.
 */
export interface LpLockerIndex {
  readonly locker: Address | null;
  readonly byPool: ReadonlyMap<string, readonly bigint[]>;
  readonly allTokenIds: readonly bigint[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint | null;
}

let lpIndexCache: Promise<LpLockerIndex> | null = null;

export function readLpLockerIndex(): Promise<LpLockerIndex> {
  if (lpIndexCache !== null) return lpIndexCache;
  lpIndexCache = (async (): Promise<LpLockerIndex> => {
    const cfg = resolveConfig();
    const locker = cfg.launchpadKitV2 !== null ? (await readKitV2Env()).clLocker : cfg.core.launchpadV2.clLPLocker;
    const fromBlock = cfg.core.deployedAtBlock;
    if (locker === null) return { locker: null, byPool: new Map(), allTokenIds: [], fromBlock, toBlock: null };
    const client = publicClient();
    const toBlock = await client.getBlockNumber();
    const found = await findClLpLockerTokenIds(client, locker, { fromBlock, toBlock });
    const byPool = new Map<string, bigint[]>();
    for (const f of found) {
      const k = f.poolId.toLowerCase();
      const list = byPool.get(k);
      if (list === undefined) byPool.set(k, [f.tokenId]);
      else list.push(f.tokenId);
    }
    return { locker, byPool, allTokenIds: found.map((f) => f.tokenId), fromBlock, toBlock };
  })();
  lpIndexCache.catch(() => {
    lpIndexCache = null;
  });
  return lpIndexCache;
}

/**
 * One CL pool's locks: the time locks in `GullyCorePositionLock` and the positions
 * the protocol's LP locker holds forever, with the locked share of the pool's
 * ACTIVE liquidity (the SDK's `summarizePoolLocks`). `null` when neither
 * contract exists on this chain.
 */
export async function readPoolLockSummary(poolId: Hex): Promise<(PoolLockSummary & { readonly now: bigint }) | null> {
  const cfg = resolveConfig();
  const client = publicClient();
  const index = await readLpLockerIndex();
  const positionLock = cfg.utilities.positionLock;
  const lpIds = index.byPool.get(poolId.toLowerCase()) ?? [];
  if (positionLock !== null) {
    return readPoolLocks(client, positionLock, poolId, { lpLocker: index.locker, lpLockerTokenIds: lpIds });
  }
  if (index.locker === null) return null;
  const [now, pool] = await Promise.all([
    readChainNow(client),
    readCLPoolState(client, cfg.contracts.clPoolManager, poolId).catch(() => null),
  ]);
  const permanent = await readClLpLockerPositions(client, index.locker, lpIds, new Map([[poolId.toLowerCase(), pool]]));
  const first = permanent[0];
  return {
    ...summarizePoolLocks({
      poolId,
      currency0: first?.currency0 ?? zeroAddress,
      currency1: first?.currency1 ?? zeroAddress,
      pool,
      locks: [],
      permanent,
    }),
    now,
  };
}
