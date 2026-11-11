// SPDX-License-Identifier: MIT
/**
 * Pure form logic for the utility screens, kept out of the components so it
 * is tested on its own (`src/lib/forms.test.ts`). Nothing here reads a chain.
 *
 * Rules shared by every function: exact integer arithmetic (no float ever
 * reaches an amount, a share or a timestamp), and a problem is RETURNED with
 * the field it belongs to rather than thrown.
 */

import { ipfsToHttp } from "@gullylabs/core-sdk";
import { getAddress, isAddress, type Address } from "viem";
import type { SplitDraft, SplitDraftPayee } from "@gullylabs/core-sdk/split";

/* ------------------------------------------------------------- splits --- */

export const BPS = 10_000;

/** `"12.5"` → 1250 basis points; at most two decimals, 0 < x <= 100. `null` otherwise. */
export function percentToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (m === null) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps <= 0 || bps > BPS) return null;
  return bps;
}

/** 1250 → `"12.5%"`. */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

export interface PayeeRow {
  readonly address: string;
  /** Share in percent, as typed. */
  readonly percent: string;
  readonly label: string;
}

export interface SplitFormResult {
  readonly draft: SplitDraft | null;
  /** Field-level problems this form checks beyond the SDK's `validateSplitDraft`. */
  readonly problems: readonly { readonly row: number | null; readonly message: string }[];
  /** Sum of the parsed shares, in basis points. */
  readonly totalBps: number;
}

/**
 * The payee rows as a split draft, weights in basis points. The contract takes
 * any positive weights; this form asks for percentages that add up to exactly
 * 100% so what a payee is shown is what the weights mean.
 */
export function splitDraftFromRows(name: string, rows: readonly PayeeRow[]): SplitFormResult {
  const problems: { row: number | null; message: string }[] = [];
  const payees: SplitDraftPayee[] = [];
  let totalBps = 0;
  rows.forEach((row, i) => {
    const bps = percentToBps(row.percent);
    if (bps === null) {
      problems.push({ row: i, message: "The share must be a percentage above 0 and at most 100, with at most two decimals." });
      return;
    }
    totalBps += bps;
    payees.push({ address: row.address.trim(), weight: bps, label: row.label.trim() });
  });
  if (problems.length === 0 && totalBps !== BPS) {
    problems.push({ row: null, message: `The shares add up to ${bpsToPercent(totalBps)}; they must add up to exactly 100%.` });
  }
  return { draft: problems.length === 0 ? { name: name.trim(), payees } : null, problems, totalBps };
}

/* -------------------------------------------------------------- dates --- */

/**
 * A `<input type="datetime-local">` value as unix seconds, read as UTC so the
 * number does not depend on the viewer's time zone. `null` when unparseable.
 */
export function utcInputToUnix(value: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0"));
  if (!Number.isFinite(ms)) return null;
  return BigInt(Math.floor(ms / 1000));
}

/** Unix seconds as a `datetime-local` value in UTC (`2026-10-01T14:05`). */
export function unixToUtcInput(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString().slice(0, 16);
}

/** Whole days (as typed) to seconds; `null` unless a non-negative integer. */
export function daysToSeconds(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  return BigInt(t) * 86_400n;
}

export interface LockScheduleForm {
  readonly mode: "timelock" | "vesting";
  /** `datetime-local`, UTC: the unlock moment (time-lock) or the vesting start. */
  readonly at: string;
  readonly cliffDays: string;
  readonly durationDays: string;
}

/** `{ start, cliff, end }` exactly as `GullyCoreTokenLock.lock` takes them, or a reason. */
export function scheduleFromForm(form: LockScheduleForm): { start: bigint; cliff: bigint; end: bigint } | { error: string } {
  const at = utcInputToUnix(form.at);
  if (at === null) return { error: form.mode === "timelock" ? "Pick the unlock date and time (UTC)." : "Pick the vesting start (UTC)." };
  if (form.mode === "timelock") return { start: at, cliff: at, end: at };
  const cliff = daysToSeconds(form.cliffDays);
  const duration = daysToSeconds(form.durationDays);
  if (cliff === null || duration === null) return { error: "The cliff and the duration are whole numbers of days." };
  if (duration === 0n) return { error: "A vesting schedule needs a duration above zero days (use a time-lock for a single release)." };
  if (cliff > duration) return { error: "The cliff cannot be longer than the whole vesting duration." };
  return { start: at, cliff: at + cliff, end: at + duration };
}

/* ------------------------------------------------------------ airdrops --- */

/**
 * The https URLs a claims file can be fetched from, in order: an `https://`
 * URI as is, an `ipfs://` URI through the SDK's allow-listed gateways. `null`
 * for anything else (a plain `http://` host, a data URI, a relative path) —
 * the claim page then asks for an upload instead of fetching it.
 */
export function claimsFileUrls(uri: string): readonly string[] | null {
  const t = uri.trim();
  if (t === "") return null;
  if (/^https:\/\/[^\s]+$/i.test(t)) return [t];
  const ipfs = ipfsToHttp(t);
  return ipfs === null || ipfs.length === 0 ? null : ipfs;
}

/** A file name for the claims JSON of a drop (or of a draft, before it exists). */
export function claimsFileName(chainId: number, drop: string | null, root: string): string {
  return drop === null ? `gullycore-drop-${chainId}-${root.slice(2, 10)}.json` : `gullycore-drop-${chainId}-${drop.toLowerCase()}.json`;
}

/** A checksummed address from user input, or `null`. */
export function addressOrNull(text: string): Address | null {
  const t = text.trim();
  return isAddress(t, { strict: false }) ? getAddress(t) : null;
}
