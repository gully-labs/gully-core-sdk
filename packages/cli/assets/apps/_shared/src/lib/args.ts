// SPDX-License-Identifier: MIT
/** Argument and date parsing shared by the scripts. */

import { parseArgs } from "node:util";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";

import { refuseKeyFlags } from "./chain.js";

export type Values = Record<string, string | boolean | undefined>;
export type Options = Record<string, { type: "string" | "boolean" }>;

/** Parse argv strictly (an unknown flag is an error). `--execute` and `--help` are always accepted. */
export function args(options: Options): { values: Values; execute: boolean } {
  const argv = process.argv.slice(2);
  refuseKeyFlags(argv);
  const { values } = parseArgs({
    args: argv,
    options: { ...options, execute: { type: "boolean" }, help: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  const v = values as Values;
  return { values: v, execute: v["execute"] === true };
}

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function need(values: Values, name: string): string {
  const v = str(values, name);
  if (v === undefined) throw new Error(`--${name} is required (see --help).`);
  return v;
}

export function address(text: string, what: string): Address {
  if (!isAddress(text, { strict: false })) throw new Error(`${what}: "${text}" is not an address.`);
  return getAddress(text);
}

/** `native` (or the zero address) or an ERC-20 address. */
export function currency(text: string): Address {
  return text.toLowerCase() === "native" ? zeroAddress : address(text, "--token");
}

/**
 * A moment in unix seconds: `now`, `+90d` / `+12h` / `+30m` from `now`,
 * an ISO date (`2027-01-01` is UTC midnight), or unix seconds.
 */
export function when(text: string, now: bigint): bigint {
  const t = text.trim();
  if (t === "now") return now;
  const rel = /^\+(\d+)([dhm])$/.exec(t);
  if (rel !== null) {
    const n = BigInt(rel[1] ?? "0");
    return now + n * (rel[2] === "d" ? 86_400n : rel[2] === "h" ? 3_600n : 60n);
  }
  if (/^\d{9,11}$/.test(t)) return BigInt(t);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  if (Number.isNaN(ms)) throw new Error(`"${text}" is not a date: use now, +90d, 2027-01-01 or unix seconds.`);
  return BigInt(Math.floor(ms / 1000));
}

export function utc(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Whole days as seconds, e.g. `--days 90`. */
export function days(text: string, what: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error(`${what} must be a whole number of days.`);
  return BigInt(text) * 86_400n;
}
