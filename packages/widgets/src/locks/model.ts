// SPDX-License-Identifier: MIT
/**
 * Locks: the pure half of `LocksBadge` / `LocksPanel`.
 *
 * Everything here turns what the SDK read from chain (`readPoolLocks`,
 * `readCurrencyLocks` in `@gullylabs/core-sdk/lock`) into words, with no
 * estimate added. Two rules the copy never breaks:
 *
 * - A CL pool has no LP token. The pool figure is the locked share of the
 *   pool's ACTIVE liquidity at the current tick (`lockedActiveBps`), and it is
 *   called exactly that. When the pool has no active liquidity the share is
 *   "not measurable", never 0% and never 100%.
 * - Time is the chain's `block.timestamp`, the clock the contracts compare
 *   `unlockAt` against. Callers pass `now` from the chain, never `Date.now()`.
 *
 * - Two kinds of lock, never blurred: "time-locked until <date>"
 *   (`GullyCorePositionLock`, `GullyCoreTokenLock`) and "locked permanently (LP
 *   locker)" (`GullyCoreLPLocker` / `GullyCoreBinLPLocker`, which hold every Kit v2
 *   launch's seed liquidity and have NO withdraw path). Permanent in-range CL
 *   liquidity counts in the locked share and is also shown on its own. A Bin
 *   pool's permanent figure is the locked fraction of its ACTIVE bin.
 *
 * No USD anywhere: amounts are token units with a symbol.
 */

import type { Address, Hex } from "viem";
import { vestedAt, type BinPoolPermanentSummary, type CurrencyLockSummary, type PoolLockSummary, type PositionLockStatus, type TokenLockView, type TokenPermanentPool } from "@gullylabs/core-sdk/lock";

/** Which locks a widget shows. `null` lock address = the chain has no address for it; surfaces say "coming soon". */
export type LocksTarget =
  | ({ readonly kind: "pool"; readonly poolId: Hex; readonly positionLock: Address | null } & LpLockerSource)
  | ({ readonly kind: "token"; readonly token: Address; readonly tokenLock: Address | null } & LpLockerSource);

/**
 * The protocol's permanent LP lockers (the address book's `launchpadV2.clLPLocker`
 * / `binLPLocker`). CL positions are found from the locker's `PositionLocked`
 * logs: pass their token ids when you know them, or `lpLockerFromBlock` (the
 * locker's deploy block) and one log scan to the latest block is made. Bin locks
 * are enumerable and need neither. All optional: omitted = not counted.
 */
export interface LpLockerSource {
  readonly lpLocker?: Address | null;
  readonly binLpLocker?: Address | null;
  readonly lpLockerTokenIds?: readonly bigint[];
  readonly lpLockerFromBlock?: bigint;
  /** A pool target that is a Bin pool: its permanent share is read from the Bin locker. */
  readonly poolType?: "cl" | "bin";
}

/** Token display facts. `decimals: null` means amounts are shown in base units. */
export interface LocksTokenMeta {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number | null;
}

/** The Gully Core lock page for a target: `<siteUrl>/app/locks/pool/<poolId>` or `/app/locks/token/<address>`. */
export function lockPageUrl(
  siteUrl: string,
  target: Pick<LocksTarget, "kind"> & { readonly poolId?: Hex; readonly token?: Address },
  opts: { readonly pathBase?: string; readonly query?: string } = {},
): string {
  const base = siteUrl.replace(/\/+$/, "");
  const path = `/${(opts.pathBase ?? "/app/locks").replace(/^\/+|\/+$/g, "")}`;
  const q = opts.query ? `?${opts.query.replace(/^\?/, "")}` : "";
  if (target.kind === "pool") return `${base}${path}/pool/${target.poolId ?? ""}${q}`;
  return `${base}${path}/token/${target.token ?? ""}${q}`;
}

/** Basis points as a percentage: 8234 → "82.34%", 10000 → "100%", 1 → "0.01%". */
export function formatLockBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
}

/** `12d 04h 03m` above a day, `4h 03m 20s` below, `now` at zero. */
export function formatCountdown(seconds: bigint): string {
  if (seconds <= 0n) return "now";
  const s = Number(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  if (d >= 365) return `${Math.floor(d / 365)}y ${d % 365}d`;
  if (d > 0) return `${d}d ${p(h)}h ${p(m)}m`;
  if (h > 0) return `${h}h ${p(m)}m ${p(sec)}s`;
  return `${m}m ${p(sec)}s`;
}

/** Unix seconds → "2026-10-01 14:05 UTC". */
export function formatUtc(unixSeconds: bigint): string {
  return `${new Date(Number(unixSeconds) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Exact decimal, trimmed, never "0" for a non-zero amount. */
export function formatLockAmount(value: bigint, meta: Pick<LocksTokenMeta, "symbol" | "decimals">, maxFrac = 6): string {
  if (meta.decimals === null) return `${value.toLocaleString("en-US")} base units ${meta.symbol}`;
  if (value === 0n) return `0 ${meta.symbol}`;
  const base = 10n ** BigInt(meta.decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(meta.decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  if (whole === 0n && frac === "") return `<0.${"0".repeat(Math.max(0, maxFrac - 1))}1 ${meta.symbol}`;
  return `${whole.toLocaleString("en-US")}${frac === "" ? "" : `.${frac}`} ${meta.symbol}`;
}

/** The badge's words. `countdownTo` is the moment the countdown runs to (chain seconds). */
export interface LocksBadgeView {
  /** `locked`: something is locked now. `open`: locks exist, none still locked. `none`: no lock at all. */
  readonly tone: "locked" | "open" | "none";
  readonly headline: string;
  readonly detail: string | null;
  readonly countdownTo: bigint | null;
  /** What the countdown is to, e.g. "first unlock". */
  readonly countdownLabel: string | null;
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A pool: the locked share of active liquidity (time-locked + permanent), and the soonest unlock. */
export function poolBadgeView(
  s: Pick<PoolLockSummary, "locks" | "liveCount" | "lockedCount" | "lockedActiveBps" | "outOfRangeLocked" | "nextUnlockAt" | "lastUnlockAt" | "pool"> &
    Partial<Pick<PoolLockSummary, "permanent" | "permanentActiveBps" | "timeLockedActiveBps" | "permanentOutOfRange">>,
): LocksBadgeView {
  const permanent = s.permanent ?? [];
  const hasPermanent = permanent.length > 0;
  if (s.locks.length === 0 && !hasPermanent) {
    return { tone: "none", headline: "No locked liquidity", detail: "No position in this pool is time-locked (GullyCorePositionLock) or held permanently by the protocol's LP locker.", countdownTo: null, countdownLabel: null };
  }
  if (s.lockedCount === 0 && !hasPermanent) {
    const open = s.liveCount;
    return {
      tone: "open",
      headline: "No time-locked positions now",
      detail:
        open > 0
          ? `${plural(open, "lock is", "locks are")} past the unlock date and can be withdrawn by the lock owner.`
          : "Every lock on this pool has been withdrawn.",
      countdownTo: null,
      countdownLabel: null,
    };
  }
  const headline =
    s.lockedActiveBps === null
      ? hasPermanent && s.lockedCount === 0
        ? "Locked permanently (LP locker) · share of active liquidity not measurable"
        : `${plural(s.lockedCount + permanent.length, "locked position", "locked positions")} · share of active liquidity not measurable`
      : `${formatLockBps(s.lockedActiveBps)} of active liquidity locked`;
  const parts: string[] = [];
  if (s.lockedActiveBps === null) {
    parts.push(s.pool === null ? "The pool's state could not be read." : "The pool has no liquidity at the current price, so no share can be measured.");
  } else {
    const split: string[] = [];
    if (hasPermanent) split.push(`${formatLockBps(s.permanentActiveBps ?? 0)} locked permanently (LP locker, no withdraw path)`);
    if (s.lockedCount > 0) split.push(`${formatLockBps(s.timeLockedActiveBps ?? 0)} time-locked until a date`);
    parts.push(`${split.join(", ")}. The share is of liquidity at the current price and moves with it.`);
    const out = s.outOfRangeLocked + (s.permanentOutOfRange ?? 0);
    if (out > 0) parts.push(`${plural(out, "locked position is", "locked positions are")} out of range and not counted.`);
  }
  if (s.lastUnlockAt !== null && s.nextUnlockAt !== null && s.lastUnlockAt !== s.nextUnlockAt) parts.push(`Last time-lock unlock ${formatUtc(s.lastUnlockAt)}.`);
  return {
    tone: "locked",
    headline,
    detail: parts.join(" "),
    countdownTo: s.nextUnlockAt,
    countdownLabel: s.nextUnlockAt === null ? null : `first time-lock unlock ${formatUtc(s.nextUnlockAt)}`,
  };
}

/** A Bin pool: what the protocol's Bin LP locker holds forever. */
export function binPoolBadgeView(
  b: Pick<BinPoolPermanentSummary, "locks" | "activeBinLockedBps" | "amount0" | "amount1">,
  c0: Pick<LocksTokenMeta, "symbol" | "decimals">,
  c1: Pick<LocksTokenMeta, "symbol" | "decimals">,
): LocksBadgeView {
  if (b.locks.length === 0) {
    return { tone: "none", headline: "No locked liquidity", detail: "The protocol's Bin LP locker holds nothing in this pool. Time locks cover CL positions only.", countdownTo: null, countdownLabel: null };
  }
  const amounts = `${formatLockAmount(b.amount0, c0)} + ${formatLockAmount(b.amount1, c1)}`;
  const bins = b.locks.reduce((n, l) => n + l.bins.length, 0);
  return {
    tone: "locked",
    headline: b.activeBinLockedBps === null ? "Locked permanently (LP locker)" : `${formatLockBps(b.activeBinLockedBps)} of the active bin locked permanently (LP locker)`,
    detail: `${amounts} held forever by the Bin LP locker across ${plural(bins, "bin", "bins")}.${b.activeBinLockedBps === null ? " No lock holds the bin that trades at the current price." : " The share is of the bin that trades at the current price; a pool-wide share across all bins is not computed."}`,
    countdownTo: null,
    countdownLabel: null,
  };
}

/** A token: the share of `totalSupply` held for locks and not yet vested. */
export function tokenBadgeView(
  s: Pick<CurrencyLockSummary, "locks" | "totalHeld" | "unvested" | "heldBps" | "unvestedBps" | "nextCliffOrEnd" | "lastEnd"> & { readonly totalSupply?: bigint | null },
  meta: Pick<LocksTokenMeta, "symbol" | "decimals">,
  lp: { readonly pools: readonly TokenPermanentPool[]; readonly total: bigint } | null = null,
): LocksBadgeView {
  const lpLine =
    lp !== null && lp.pools.length > 0
      ? `${formatLockAmount(lp.total, meta)}${s.totalSupply ? ` (${formatLockBps(Number((lp.total * 10_000n) / s.totalSupply))} of supply)` : ""} locked permanently as pool liquidity (LP locker) in ${plural(lp.pools.length, "pool", "pools")}, at the current price.`
      : null;
  if (s.locks.length === 0 && lpLine !== null) {
    return { tone: "locked", headline: `${meta.symbol} liquidity locked permanently (LP locker)`, detail: `${lpLine} No time lock or vesting of ${meta.symbol} with the Gully Core token lock.`, countdownTo: null, countdownLabel: null };
  }
  if (s.locks.length === 0) {
    return { tone: "none", headline: `No ${meta.symbol} locked`, detail: "No lock of this token has been made with the Gully Core token lock.", countdownTo: null, countdownLabel: null };
  }
  if (s.totalHeld === 0n) {
    return {
      tone: lpLine !== null ? "locked" : "open",
      headline: lpLine !== null ? `${meta.symbol} liquidity locked permanently (LP locker)` : `No ${meta.symbol} locked now`,
      detail: `${plural(s.locks.length, "time lock has", "time locks have")} been fully released and claimed.${lpLine !== null ? ` ${lpLine}` : ""}`,
      countdownTo: null,
      countdownLabel: null,
    };
  }
  const headline =
    s.heldBps === null ? `${formatLockAmount(s.totalHeld, meta)} held in locks` : `${formatLockBps(s.heldBps)} of supply held in locks`;
  const parts: string[] = [];
  parts.push(
    s.unvestedBps === null
      ? `${formatLockAmount(s.unvested, meta)} not yet vested.`
      : `${formatLockBps(s.unvestedBps)} of supply (${formatLockAmount(s.unvested, meta)}) not yet vested; the rest is vested and waiting to be claimed.`,
  );
  if (s.lastEnd !== null) parts.push(`Fully vested ${formatUtc(s.lastEnd)}.`);
  if (lpLine !== null) parts.push(lpLine);
  return {
    tone: s.unvested > 0n ? "locked" : "open",
    headline,
    detail: parts.join(" "),
    countdownTo: s.nextCliffOrEnd,
    countdownLabel: s.nextCliffOrEnd === null ? null : `next release ${formatUtc(s.nextCliffOrEnd)}`,
  };
}

export const POSITION_STATUS_LABEL: Record<PositionLockStatus, string> = {
  locked: "Locked",
  unlockable: "Unlockable",
  withdrawn: "Withdrawn",
};

export const TOKEN_STATUS_LABEL: Record<TokenLockView["status"], string> = {
  cliff: "Before cliff",
  vesting: "Vesting",
  vested: "Fully vested",
  claimed: "Claimed",
};

/** `vested / amount` in basis points (floor), for a vesting bar. */
export function vestedBps(l: Pick<TokenLockView, "vested" | "amount">): number {
  return l.amount === 0n ? 0 : Number((l.vested * 10_000n) / l.amount);
}

/** The chain's `now` at a later wall-clock moment: `chainNow` read at `readAtMs`, advanced by elapsed seconds. */
export function advanceChainNow(chainNow: bigint, readAtMs: number, nowMs: number): bigint {
  return chainNow + BigInt(Math.max(0, Math.floor((nowMs - readAtMs) / 1000)));
}

/* ------------------------------------------------------------ chart views --- */

/** One part of a share bar. `bps` is floored; `nonZero` keeps a sub-0.01% part visible ("<0.01%"). */
export interface SharePart {
  readonly key: "permanent" | "time" | "unvested" | "vested" | "lp";
  readonly label: string;
  readonly bps: number;
  readonly nonZero: boolean;
}

/** A whole split into locked parts; the rest of the bar is "not locked". */
export interface ShareBarView {
  readonly parts: readonly SharePart[];
  /** What the share is OF: "of active liquidity", "of the active bin", "of supply". */
  readonly of: string;
  readonly restBps: number;
}

const bpsOf = (part: bigint, whole: bigint): number => {
  const b = (part * 10_000n) / whole;
  return Number(b > 10_000n ? 10_000n : b);
};

function bar(parts: SharePart[], of: string): ShareBarView {
  return { parts: parts.filter((p) => p.bps > 0 || p.nonZero), of, restBps: Math.max(0, 10_000 - parts.reduce((n, p) => n + p.bps, 0)) };
}

/** A CL pool's active liquidity: permanent (LP locker) and time-locked. `null` when no share is measurable. */
export function poolShareBar(
  s: Pick<PoolLockSummary, "pool" | "lockedActiveLiquidity"> & Partial<Pick<PoolLockSummary, "permanentActiveLiquidity" | "timeLockedActiveLiquidity">>,
): ShareBarView | null {
  const active = s.pool?.activeLiquidity ?? 0n;
  if (s.pool === null || active === 0n) return null;
  const perm = s.permanentActiveLiquidity ?? 0n;
  const time = s.timeLockedActiveLiquidity ?? s.lockedActiveLiquidity - perm;
  return bar(
    [
      { key: "permanent", label: "Locked permanently (LP locker)", bps: bpsOf(perm, active), nonZero: perm > 0n },
      { key: "time", label: "Time-locked until a date", bps: bpsOf(time, active), nonZero: time > 0n },
    ],
    "of active liquidity",
  );
}

/** A Bin pool's active bin: the permanent share. `null` when no lock holds it. */
export function binShareBar(b: Pick<BinPoolPermanentSummary, "activeBinLockedBps">): ShareBarView | null {
  if (b.activeBinLockedBps === null) return null;
  return bar([{ key: "permanent", label: "Locked permanently (LP locker)", bps: b.activeBinLockedBps, nonZero: b.activeBinLockedBps > 0 }], "of the active bin");
}

/** A token's supply: unvested, vested-unclaimed, and (optionally) its side of permanent LP. `null` without a supply. */
export function tokenShareBar(
  s: Pick<CurrencyLockSummary, "totalHeld" | "unvested"> & { readonly totalSupply?: bigint | null },
  lpTotal: bigint | null = null,
): ShareBarView | null {
  const ts = s.totalSupply ?? null;
  if (ts === null || ts === 0n) return null;
  const vested = s.totalHeld > s.unvested ? s.totalHeld - s.unvested : 0n;
  const lp = lpTotal ?? 0n;
  return bar(
    [
      { key: "unvested", label: "Not yet vested", bps: bpsOf(s.unvested, ts), nonZero: s.unvested > 0n },
      { key: "vested", label: "Vested, not yet claimed", bps: bpsOf(vested, ts), nonZero: vested > 0n },
      { key: "lp", label: "In permanent LP (LP locker)", bps: bpsOf(lp, ts), nonZero: lp > 0n },
    ],
    "of supply",
  );
}

/** A point of a release schedule: `t` unix seconds, `vested` summed over the locks (the contract's `_vested`). */
export interface SchedulePoint {
  readonly t: bigint;
  readonly vested: bigint;
}

/**
 * The cumulative release schedule of one token's locks: every start, the
 * second before and of each cliff, every end, `now`, and `samples` evenly
 * spaced points between, each computed with the SDK's `vestedAt`. A SCHEDULE
 * of fixed on-chain terms, not a history of claims. `null` when it has no length.
 */
export function releaseSchedule(
  locks: readonly Pick<TokenLockView, "start" | "cliff" | "end" | "amount">[],
  now: bigint | null,
  samples = 24,
): { readonly points: readonly SchedulePoint[]; readonly total: bigint } | null {
  if (locks.length === 0) return null;
  const lo = locks.reduce((m, l) => (l.start < m ? l.start : m), locks[0]!.start);
  const hi = locks.reduce((m, l) => (l.end > m ? l.end : m), locks[0]!.end);
  if (hi <= lo) return null;
  const xs = new Set<bigint>([lo, hi]);
  if (now !== null && now > lo && now < hi) xs.add(now);
  for (const l of locks) {
    xs.add(l.start);
    xs.add(l.end);
    if (l.cliff > l.start) {
      xs.add(l.cliff - 1n);
      xs.add(l.cliff);
    }
  }
  const step = (hi - lo) / BigInt(samples);
  if (step > 0n) for (let i = 1n; i < BigInt(samples); i++) xs.add(lo + step * i);
  const points = [...xs]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((t) => ({ t, vested: locks.reduce((sum, l) => sum + vestedAt(l, t), 0n) }));
  return { points, total: locks.reduce((sum, l) => sum + l.amount, 0n) };
}

/** A share bar from figures already in basis points (the trust read's pool facts). */
export function shareBarFromBps(parts: readonly { readonly key: SharePart["key"]; readonly label: string; readonly bps: number | null }[], of: string): ShareBarView | null {
  if (parts.every((p) => p.bps === null)) return null;
  return bar(
    parts.map((p) => ({ key: p.key, label: p.label, bps: p.bps ?? 0, nonZero: false })),
    of,
  );
}
