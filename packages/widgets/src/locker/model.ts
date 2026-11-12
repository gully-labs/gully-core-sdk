// SPDX-License-Identifier: MIT
/**
 * The locker widget: its pure half.
 *
 * Input parsing (exact decimals, UTC dates), the live fee in words, the
 * transaction plan for each action (approval only when the chain says it is
 * missing, and only for exactly what the lock takes), and which actions a
 * connected wallet may take on each of its locks. The contracts enforce all
 * of this; the widget checks first so a wallet is never asked to sign a call
 * that would revert.
 */

import { parseUnits, type Address } from "viem";
import type { FeeGateTerms, PositionLockRecord, TokenLockView, VestingSchedule } from "@gullylabs/core-sdk/lock";

/* ------------------------------------------------------------------ inputs --- */

/** An exact decimal amount in base units, or `null` when it is not one (never rounded). */
export function parseLockAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

/** A `datetime-local` value ("2027-01-31T12:00"), read as UTC, to unix seconds; `null` when malformed. */
export function parseUtcInput(text: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

/** Unix seconds to a `datetime-local` value in UTC. */
export function toUtcInput(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 16);
}

/** A whole number of days as seconds, or `null`. */
export function parseDays(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  return BigInt(t) * 86_400n;
}

export type VestingMode = "timelock" | "vesting";

/**
 * The schedule for a token lock: a time lock releases everything at `unlockAt`;
 * vesting accrues linearly from `start` over `durationDays`, nothing claimable
 * before `start + cliffDays`.
 */
export function lockSchedule(
  mode: VestingMode,
  input: { readonly unlockAt: bigint | null; readonly start: bigint | null; readonly cliffDays: bigint | null; readonly durationDays: bigint | null },
): VestingSchedule | null {
  if (mode === "timelock") return input.unlockAt === null ? null : { start: input.unlockAt, cliff: input.unlockAt, end: input.unlockAt };
  if (input.start === null || input.cliffDays === null || input.durationDays === null) return null;
  return { start: input.start, cliff: input.start + input.cliffDays, end: input.start + input.durationDays };
}

/* --------------------------------------------------------------------- fee --- */

function units(v: bigint, decimals: number): string {
  if (v === 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole.toLocaleString("en-US") : `${whole.toLocaleString("en-US")}.${frac}`;
}

export interface LockerFeeView {
  /** "0.075 ETH per lock". */
  readonly fee: string;
  /** What the lock transaction sends for the fee (the higher of the fee and an announced increase). */
  readonly sends: string;
  /** An announced increase, in words, or `null`. */
  readonly pending: string | null;
  readonly note: string;
}

/** The live fee in words. Native units only, never a dollar figure. */
export function lockerFeeView(terms: Pick<FeeGateTerms, "feeWei" | "pendingFee" | "recipient">, native: { readonly symbol: string; readonly decimals: number }): LockerFeeView {
  const fee = `${units(terms.feeWei, native.decimals)} ${native.symbol} per lock`;
  const p = terms.pendingFee;
  const rises = p !== null && p.feeWei > terms.feeWei;
  const sendsWei = rises ? p.feeWei : terms.feeWei;
  const pending =
    p === null
      ? null
      : `${p.feeWei > terms.feeWei ? "An increase" : "A change"} to ${units(p.feeWei, native.decimals)} ${native.symbol} applies from ${new Date(Number(p.effectiveAt) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC.`;
  return {
    fee,
    sends: `${units(sendsWei, native.decimals)} ${native.symbol}`,
    pending,
    note: `Charged by the lock contract itself and paid only to its fee recipient ${terms.recipient.slice(0, 6)}…${terms.recipient.slice(-4)}.${rises ? " The transaction sends the announced higher fee in case it applies before it mines; the contract refunds any surplus in the same call." : ""}`,
  };
}

/* -------------------------------------------------------------------- plan --- */

export interface PlanStep {
  readonly key: "approve" | "lock";
  readonly label: string;
}

/** Lock a position: approve this ONE NFT to the lock (when not already approved), then lock. */
export function planPositionLock(args: { readonly tokenId: bigint; readonly approved: boolean; readonly unlockAt: bigint }): PlanStep[] {
  const steps: PlanStep[] = [];
  if (!args.approved) steps.push({ key: "approve", label: `Approve GullyCorePositionLock to move position #${args.tokenId} (this NFT only)` });
  steps.push({ key: "lock", label: `Lock position #${args.tokenId} until ${new Date(Number(args.unlockAt) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC, paying the fee` });
  return steps;
}

/** Lock tokens: an exact `approve(lock, amount)` when the allowance is short (never for native), then lock. */
export function planTokenLock(args: { readonly native: boolean; readonly allowance: bigint; readonly amount: bigint; readonly amountText: string; readonly symbol: string }): PlanStep[] {
  const steps: PlanStep[] = [];
  if (!args.native && args.allowance < args.amount) steps.push({ key: "approve", label: `Approve GullyCoreTokenLock for exactly ${args.amountText} ${args.symbol}` });
  steps.push({ key: "lock", label: `Lock ${args.amountText} ${args.symbol}, paying the fee${args.native ? " (the amount is sent with it)" : ""}` });
  return steps;
}

/* ------------------------------------------------------------ my locks --- */

export type PositionLockAction = "collect" | "extend" | "withdraw" | "accept";
export type TokenLockAction = "claim" | "accept";

const same = (a: string | null | undefined, b: string | null | undefined): boolean => a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** What `account` may do with one position lock, as the contract allows it. */
export function positionLockActions(r: Pick<PositionLockRecord, "owner" | "pendingOwner" | "withdrawn" | "unlockAt">, account: Address | null, now: bigint): PositionLockAction[] {
  if (r.withdrawn) return [];
  const out: PositionLockAction[] = ["collect"]; // permissionless; fees always go to the lock owner
  if (same(r.owner, account)) {
    out.push("extend");
    if (now >= r.unlockAt) out.push("withdraw");
  }
  if (same(r.pendingOwner, account)) out.push("accept");
  return out;
}

/** What `account` may do with one token lock. */
export function tokenLockActions(l: Pick<TokenLockView, "beneficiary" | "pendingBeneficiary" | "claimable">, account: Address | null): TokenLockAction[] {
  const out: TokenLockAction[] = [];
  if (same(l.beneficiary, account) && l.claimable > 0n) out.push("claim");
  if (same(l.pendingBeneficiary, account)) out.push("accept");
  return out;
}

export const POSITION_ACTION_LABEL: Record<PositionLockAction, string> = {
  collect: "Collect fees",
  extend: "Extend",
  withdraw: "Withdraw",
  accept: "Accept lock",
};

export const TOKEN_ACTION_LABEL: Record<TokenLockAction, string> = {
  claim: "Claim vested",
  accept: "Accept lock",
};
