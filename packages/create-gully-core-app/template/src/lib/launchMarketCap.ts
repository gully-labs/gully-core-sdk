// SPDX-License-Identifier: MIT
/**
 * A launched token's market cap, per pool, from the chain: the pool's CURRENT
 * price (`getSlot0`, through the SDK's `readSpotPrice`) times the token's total
 * supply, in the pool's quote; in dollars only where the quote is the chain's
 * native currency (or its wrapped form) AND the native/USD read answered.
 *
 * What it is NOT: the opening cap the creator chose (that is `marketCap.ts`,
 * exact integers, for the wizard). This is the figure a buyer judges a launch
 * by today, and it moves with every trade. A pool whose key or price could not
 * be read has NO cap here — never zero, never a stale one. Nothing in this app
 * prices an arbitrary ERC-20 quote, so a pool quoted in one shows its cap in
 * that token and no dollars (`lib/usd.ts`).
 *
 * Floating point, deliberately and only here: this is a DISPLAY figure read
 * fresh on every visit, not a number anybody signs. The pure half is tested in
 * `launchMarketCap.test.ts`.
 */

import { readSpotPrice, type LaunchLegV2, type LaunchRecordV2, type MarketPool, type NativeUsdQuote } from "@gullylabs/core-sdk";
import { formatUnits, type Address, type Hex, type PublicClient } from "viem";

import { usdCompact, usdPerUnit } from "./usdFormat";

/** The zero address: the native currency as the kit and the router spell it. */
const NATIVE = "0x0000000000000000000000000000000000000000";

export interface LegMarketCap {
  readonly poolId: Hex;
  /** Quote per WHOLE token at the pool's current price. */
  readonly price: number;
  /** `price × total supply`, in WHOLE units of the quote. */
  readonly capQuote: number;
}

/** `price × supply`, both in whole units; `null` for a supply or price that is not a positive finite number. */
export function capFromSpot(price: number, totalSupplyRaw: bigint, tokenDecimals: number): number | null {
  if (!Number.isFinite(price) || price <= 0 || totalSupplyRaw <= 0n) return null;
  const supply = Number(formatUnits(totalSupplyRaw, tokenDecimals));
  const cap = price * supply;
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** Dollars for a quote-denominated cap, or `null` unless the quote is native/wrapped and the rate is known. */
export function capUsd(capQuote: number, quote: Address, weth: string | null, usd: NativeUsdQuote | null): number | null {
  const perUnit = usdPerUnit(quote, weth, usd);
  if (perUnit === null) return null;
  const v = capQuote * perUnit;
  return Number.isFinite(v) ? v : null;
}

/** A cap in its quote: `12.5 WETH`, `0.0421 ETH`, `1,250,000 USDC` — three significant digits below 1, whole-ish above. */
export function formatQuoteCap(capQuote: number, symbol: string): string {
  if (!Number.isFinite(capQuote) || capQuote <= 0) return `0 ${symbol}`;
  const text =
    capQuote >= 1000
      ? capQuote.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : capQuote >= 1
        ? capQuote.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : capQuote.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  return `${text} ${symbol}`;
}

/** The one line a screen prints: dollars first where read, the quote figure always. */
export function marketCapText(cap: LegMarketCap, quote: Address, quoteSymbol: string, weth: string | null, usd: NativeUsdQuote | null): string {
  const dollars = capUsd(cap.capQuote, quote, weth, usd);
  const inQuote = formatQuoteCap(cap.capQuote, quoteSymbol);
  return dollars === null ? inQuote : `${usdCompact(dollars)} · ${inQuote}`;
}

/** The SDK's pool shape for a leg, or `null` when the leg's key was not read (its position reverted). */
export function marketPoolOf(leg: LaunchLegV2, tokenDecimals: number, nativeDecimals: number): MarketPool | null {
  if (leg.key === null) return null;
  const quoteDecimals = leg.quote.toLowerCase() === NATIVE ? nativeDecimals : (leg.quoteMeta?.decimals ?? null);
  if (quoteDecimals === null) return null;
  return { poolId: leg.poolId, kind: leg.kind, key: leg.key, baseIsCurrency0: leg.launchTokenIsCurrency0, baseDecimals: tokenDecimals, quoteDecimals };
}

/**
 * One `getSlot0` per leg of every launch. A leg whose key or price cannot be read is simply
 * absent from the map (the screen says "couldn't load"); one failing pool never hides the others.
 */
export async function readLaunchMarketCaps(
  client: PublicClient,
  launches: readonly LaunchRecordV2[],
  opts: { readonly tokenDecimals: number; readonly nativeDecimals: number; readonly readPrice?: (pool: MarketPool) => Promise<number> },
): Promise<ReadonlyMap<Hex, LegMarketCap>> {
  const readPrice = opts.readPrice ?? ((pool: MarketPool) => readSpotPrice(client, pool));
  const out = new Map<Hex, LegMarketCap>();
  await Promise.all(
    launches.flatMap((record) =>
      record.legs.map(async (leg) => {
        const pool = marketPoolOf(leg, opts.tokenDecimals, opts.nativeDecimals);
        if (pool === null) return;
        try {
          const price = await readPrice(pool);
          const capQuote = capFromSpot(price, record.totalSupply, opts.tokenDecimals);
          if (capQuote !== null) out.set(leg.poolId, { poolId: leg.poolId, price, capQuote });
        } catch {
          /* unreadable: no figure, never a stale or invented one */
        }
      }),
    ),
  );
  return out;
}
