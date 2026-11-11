// SPDX-License-Identifier: MIT
/**
 * The pure half of `lib/usd.ts`: the rule that decides WHICH tokens may carry a
 * dollar figure (the native coin and its wrapped form, nothing else), the
 * arithmetic from a resolved native/USD quote, and the two dollar formats.
 * No React, no chain, so it is tested in node (`usd.test.ts`).
 */

import type { NativeUsdQuote } from "@gullylabs/core-sdk";
import { formatUnits, type Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

/** True for the native coin (the zero address) or the chain's wrapped native. */
export function isNativeOrWrapped(token: string, weth: string | null): boolean {
  const t = token.toLowerCase();
  return t === ZERO || (weth !== null && t === weth.toLowerCase());
}

/** Dollars per WHOLE unit of `token`, or `null` for any token that is not native/wrapped or with no quote. */
export function usdPerUnit(token: string, weth: string | null, quote: NativeUsdQuote | null): number | null {
  if (quote === null || !isNativeOrWrapped(token, weth)) return null;
  return Number(quote.answer) / 10 ** quote.answerDecimals;
}

/** The dollar value of `amount` (raw units) of `token`, or `null` under the same rule. */
export function usdValueOf(amount: bigint, decimals: number, token: Address, weth: string | null, quote: NativeUsdQuote | null): number | null {
  if (quote === null || !isNativeOrWrapped(token, weth)) return null;
  return Number(formatUnits(amount * quote.answer, decimals + quote.answerDecimals));
}

/**
 * A dollar AMOUNT (a balance, a total, fees), not a price: `$0`, `<$0.01`, `$0.27`,
 * `$12,345.67`, then compact from $100K (`$1.2M`) so a tile never wraps.
 */
export function usdText(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (Math.round(v * 100) < 10_000_000) return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return usdCompact(v);
}

/** Compact dollars for market caps and other large figures: `$5K`, `$2.7K`, `$1.25M`, `$3B`. */
export function usdCompact(v: number): string {
  const trim = (s: string): string => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v >= 1e9) return `$${trim((v / 1e9).toFixed(2))}B`;
  if (v >= 1e6) return `$${trim((v / 1e6).toFixed(2))}M`;
  if (v >= 1e3) return `$${trim((v / 1e3).toFixed(1))}K`;
  if (v >= 1) return `$${trim(v.toFixed(2))}`;
  return `$${v.toFixed(2)}`;
}

/** "Dollar price from Chainlink ETH/USD, updated 2 min ago." — the source and its age, in plain words. */
export function usdNote(q: NativeUsdQuote): string {
  const age = Math.max(0, Math.round(q.provenance.ageSeconds));
  const ago = age < 90 ? `${age} s` : age < 5400 ? `${Math.round(age / 60)} min` : `${Math.round(age / 3600)} h`;
  return `Dollar price from ${q.provenance.source} ${q.nativeSymbol}/USD, updated ${ago} ago.`;
}
