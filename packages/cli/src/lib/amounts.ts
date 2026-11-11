// SPDX-License-Identifier: MIT
/** Exact decimal <-> bigint conversions. No floating point touches an amount that is sent. */

import { UserError } from "../util/log.js";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const SCI = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

/**
 * `"1.5"` with 18 decimals -> 1500000000000000000n. Refuses more fractional digits than `decimals`
 * rather than rounding: a silently truncated amount is a different amount.
 */
export function parseUnitsExact(text: string, decimals: number, what = "amount"): bigint {
  const t = text.trim().replace(/_/g, "").replace(/,/g, "");
  const m = DECIMAL.exec(t);
  if (m === null) throw new UserError(`${what} must be a non-negative decimal number, received "${text}"`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new UserError(`${what} has more than ${decimals} decimal places: "${text}"`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/**
 * A decimal that may be in exponent form (as `Number#toPrecision` prints small numbers, e.g.
 * `"3.5000000e-9"`) to raw units, rounding DOWN past `decimals`. Used only to DISPLAY a snapped price's
 * implications; never for a value that is sent.
 */
export function decimalToRawFloor(text: string, decimals: number): bigint {
  const t = text.trim();
  let digits: string;
  let exp: number;
  const s = SCI.exec(t);
  const d = DECIMAL.exec(t);
  if (s !== null) {
    digits = `${s[1] ?? ""}${s[2] ?? ""}`;
    exp = Number(s[3]) - (s[2] ?? "").length;
  } else if (d !== null) {
    digits = `${d[1] ?? ""}${d[2] ?? ""}`;
    exp = -(d[2] ?? "").length;
  } else {
    throw new Error(`not a decimal: ${text}`);
  }
  const shift = exp + decimals;
  const n = BigInt(digits === "" ? "0" : digits);
  return shift >= 0 ? n * 10n ** BigInt(shift) : n / 10n ** BigInt(-shift);
}

/** Raw units to a trimmed decimal string: 1500000000000000000n, 18 -> "1.5". */
export function formatUnitsTrim(value: bigint, decimals: number, maxFraction = decimals): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (frac === "" && v % base !== 0n && maxFraction < decimals) frac = "";
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeStr}${frac === "" ? "" : `.${frac}`}`;
}

/** A small positive price with enough significant digits to read: 0.0000000035 -> "0.0000000035". */
export function formatSignificant(value: bigint, decimals: number, significant = 6): string {
  if (value === 0n) return "0";
  const s = value.toString();
  const keep = Math.max(0, s.length - significant);
  const rounded = (value / 10n ** BigInt(keep)) * 10n ** BigInt(keep);
  return formatUnitsTrim(rounded, decimals);
}

/** Basis points as a percentage string: 2000 -> "20%", 25 -> "0.25%". */
export function bpsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/** Pips (1e6 = 100%) as a percentage: 100000 -> "10%", 3000 -> "0.3%". */
export function pipsPercent(pips: number): string {
  const hundredths = pips / 100; // basis points of percent*100
  return `${Number((hundredths / 100).toFixed(4)).toString()}%`;
}

export function parseIntStrict(text: string, what: string, min: number, max: number): number {
  const t = text.trim().replace(/_/g, "");
  if (!/^\d+$/.test(t)) throw new UserError(`${what} must be a whole number, received "${text}"`);
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new UserError(`${what} must be between ${min} and ${max}, received ${t}`);
  return n;
}

/** "5%" or "5" or "0.5%" to basis points. */
export function parsePercentBps(text: string, what: string, maxBps: number): number {
  const t = text.trim().replace(/%$/, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (m === null) throw new UserError(`${what} must be a percentage like 5 or 2.5, received "${text}"`);
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (bps > maxBps) throw new UserError(`${what} is above the maximum of ${bpsPercent(maxBps)}`);
  return bps;
}

/** Human seconds: 300 -> "5 min", 86400 -> "1 day". */
export function humanSeconds(s: number): string {
  if (s === 0) return "immediately";
  if (s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? "" : "s"}`;
  if (s % 3_600 === 0) return `${s / 3_600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}
