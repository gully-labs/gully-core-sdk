// SPDX-License-Identifier: MIT
/* ============================================================================
   A STOCK POOL'S LIVE STATE, read from its market-hours hook.

   `MarketHoursHook` and `StockPairHook` (GPL, packages/hooks-rwa) keep a per-pool
   calendar, halt flag and price band. This module reads them for a front end, with
   an ABI written here from the PUBLIC function signatures (no GPL import):

     marketConfig(poolId)            the stored configuration
     isTradable(poolId)              calendar + halt, right now (the band is judged per swap)
     isSessionOpenAt(poolId, t)      the calendar alone at any instant, day overrides included
     dayOverride(poolId, dayIndex)   the issuer's holiday / special session for a day
     priceBand(poolId)               the band as PPM of the reference
     referencePrice(poolId)          on the band ORACLE: the cached reference, (0, 0) when none

   NEXT OPEN / NEXT CLOSE ARE ASKED OF THE CONTRACT, never computed from a profile. The
   candidate instants are every weekly and override open / close second over the next
   `horizonDays`, and the answer is the first candidate where `isSessionOpenAt` flips,
   so holidays, early closes and wrapping sessions are exactly what the hook enforces.
   A halted pool reports its calendar but `tradable` stays false until it is resumed.
   ============================================================================ */

import { parseAbi, type Address, type Hex, type PublicClient } from "viem";

/** The read-only market-hours surface, from the public signatures. */
export const MARKET_HOURS_READ_ABI = parseAbi([
  "struct MarketConfig { bool configured; bool halted; bool sessionEnabled; bool gateLiquidity; bool bandEnabled; uint8 weekdayMask; uint24 openSecondOfDay; uint24 closeSecondOfDay; address issuer; address oracle; uint32 maxUpPpm; uint32 maxDownPpm; uint32 maxPriceAge; }",
  "struct DayOverride { bool isSet; bool closed; uint24 openSecondOfDay; uint24 closeSecondOfDay; }",
  "function marketConfig(bytes32 poolId) view returns (MarketConfig)",
  "function isTradable(bytes32 poolId) view returns (bool)",
  "function isSessionOpenAt(bytes32 poolId, uint256 timestamp) view returns (bool)",
  "function dayOverride(bytes32 poolId, uint32 dayIndex) view returns (DayOverride)",
  "function priceBand(bytes32 poolId) view returns (bool active, uint256 lowerPpm, uint256 upperPpm)",
]);

/** `IPriceBandOracle.referencePrice`, shared by every band oracle. */
export const PRICE_BAND_ORACLE_READ_ABI = parseAbi([
  "function referencePrice(bytes32 poolId) view returns (uint160 sqrtPriceX96, uint64 updatedAt)",
]);

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const DAY = 86_400;

export interface StockMarketStatus {
  readonly poolId: Hex;
  readonly hook: Address;
  /** False: the hook has never been configured for this pool (it cannot have been initialised through it). */
  readonly configured: boolean;
  readonly halted: boolean;
  /** False: the pool trades around the clock (no calendar). */
  readonly sessionEnabled: boolean;
  /** Calendar AND halt, at the block read. The band is judged per swap and is not in this. */
  readonly tradable: boolean;
  /** The calendar alone at the block read (ignores the halt). */
  readonly sessionOpen: boolean;
  /** Next instant (unix seconds) the calendar opens, `null` when open now, when there is no calendar, or none within the horizon. */
  readonly nextOpen: number | null;
  /** Next instant the calendar closes, `null` when closed now, when there is no calendar, or none within the horizon. */
  readonly nextClose: number | null;
  readonly band: { readonly enabled: boolean; readonly lowerPpm: number; readonly upperPpm: number };
  /** The band oracle, `null` when none is set. */
  readonly oracle: Address | null;
  /** The oracle's cached reference; `null` without an oracle, `{ sqrtPriceX96: 0n, updatedAt: 0 }` when it serves none. */
  readonly reference: { readonly sqrtPriceX96: bigint; readonly updatedAt: number } | null;
  readonly issuer: Address;
  readonly weekly: { readonly weekdayMask: number; readonly openSecondOfDay: number; readonly closeSecondOfDay: number };
  readonly atBlock: bigint;
  /** `block.timestamp` of the block read: the clock the hook judges by. */
  readonly timestamp: number;
}

export interface ReadStockMarketStatusOptions {
  readonly hook: Address;
  readonly poolId: Hex;
  /** How far ahead to look for the next open / close. Default 14 days. */
  readonly horizonDays?: number;
}

/**
 * The live state of one stock pool, every figure from the chain at one block.
 * Throws on a transport failure (an error state, never a guess).
 */
export async function readStockMarketStatus(client: PublicClient, options: ReadStockMarketStatusOptions): Promise<StockMarketStatus> {
  const { hook, poolId } = options;
  const horizon = Math.max(1, Math.min(60, options.horizonDays ?? 14));
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const at = { blockNumber } as const;

  const [cfg, tradable, sessionOpen, band] = await Promise.all([
    client.readContract({ address: hook, abi: MARKET_HOURS_READ_ABI, functionName: "marketConfig", args: [poolId], ...at }),
    client.readContract({ address: hook, abi: MARKET_HOURS_READ_ABI, functionName: "isTradable", args: [poolId], ...at }),
    client.readContract({ address: hook, abi: MARKET_HOURS_READ_ABI, functionName: "isSessionOpenAt", args: [poolId, BigInt(now)], ...at }),
    client.readContract({ address: hook, abi: MARKET_HOURS_READ_ABI, functionName: "priceBand", args: [poolId], ...at }),
  ]);

  const oracle = cfg.oracle.toLowerCase() === ZERO ? null : cfg.oracle;
  const reference =
    oracle === null
      ? null
      : await client
          .readContract({ address: oracle, abi: PRICE_BAND_ORACLE_READ_ABI, functionName: "referencePrice", args: [poolId], ...at })
          .then(([sqrtPriceX96, updatedAt]) => ({ sqrtPriceX96, updatedAt: Number(updatedAt) }));

  let nextOpen: number | null = null;
  let nextClose: number | null = null;
  if (cfg.configured && cfg.sessionEnabled) {
    const today = Math.floor(now / DAY);
    const days = Array.from({ length: horizon + 1 }, (_, i) => today + i);
    const overrides = await Promise.all(
      days.map((d) => client.readContract({ address: hook, abi: MARKET_HOURS_READ_ABI, functionName: "dayOverride", args: [poolId, d], ...at })),
    );
    const candidates = new Set<number>();
    days.forEach((d, i) => {
      const o = overrides[i]!;
      const secs = o.isSet && !o.closed ? [o.openSecondOfDay, o.closeSecondOfDay] : [cfg.openSecondOfDay, cfg.closeSecondOfDay];
      for (const s of secs) {
        const t = d * DAY + Number(s);
        if (t > now) candidates.add(t);
      }
      /* A day boundary can end a session too (a wrapping session whose next day is a holiday). */
      if ((d + 1) * DAY > now) candidates.add((d + 1) * DAY);
    });
    const sorted = [...candidates].sort((a, b) => a - b);
    const open = await Promise.all(
      sorted.map((t) => client.readContract({ address: hook, abi: MARKET_HOURS_READ_ABI, functionName: "isSessionOpenAt", args: [poolId, BigInt(t)], ...at })),
    );
    for (let i = 0; i < sorted.length; i++) {
      if (sessionOpen && nextClose === null && !open[i]) nextClose = sorted[i]!;
      if (!sessionOpen && nextOpen === null && open[i]) nextOpen = sorted[i]!;
    }
  }

  return {
    poolId,
    hook,
    configured: cfg.configured,
    halted: cfg.halted,
    sessionEnabled: cfg.sessionEnabled,
    tradable,
    sessionOpen,
    nextOpen,
    nextClose,
    band: { enabled: band[0], lowerPpm: Number(band[1]), upperPpm: Number(band[2]) },
    oracle,
    reference,
    issuer: cfg.issuer,
    weekly: { weekdayMask: cfg.weekdayMask, openSecondOfDay: cfg.openSecondOfDay, closeSecondOfDay: cfg.closeSecondOfDay },
    atBlock: blockNumber,
    timestamp: now,
  };
}

/** The band as "−10% / +10%" style edges, in percent of the reference. */
export function bandPercentEdges(band: StockMarketStatus["band"]): { readonly down: number; readonly up: number } {
  return { down: (1_000_000 - band.lowerPpm) / 10_000, up: (band.upperPpm - 1_000_000) / 10_000 };
}
