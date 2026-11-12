// SPDX-License-Identifier: MIT
/**
 * The "Locked by Gully Core" embed badge: its words, pure.
 *
 * The same reads as `LocksBadge`, cut to what a project site shows beside its
 * token or pool. The badge says only what was read:
 *
 *   pool    "X% of active liquidity locked" / "Locked permanently (LP locker)"
 *           / "No locked liquidity"            (delegates to `poolBadgeView`)
 *   token   "Y% of supply locked"  - the share of supply no beneficiary can
 *           take yet (`unvested / totalSupply`), not what merely sits in the
 *           locker; plus the permanent LP-locker liquidity when there is some.
 *
 * It never says "safe" or "rug-proof": a lock is a lock until its date, and
 * that is all the badge claims.
 */

import type { PoolLocksData, TokenLocksData } from "./fetch.js";
import { binPoolBadgeView, formatLockAmount, formatLockBps, formatUtc, poolBadgeView, type LocksBadgeView } from "./model.js";

/** A pool badge from a pool read (CL or Bin). */
export function poolEmbedView(d: PoolLocksData): LocksBadgeView {
  return d.bin !== null ? binPoolBadgeView(d.bin, d.currency0, d.currency1) : poolBadgeView(d.summary);
}

/** A token badge: the share of supply still locked, and any permanent LP-locker liquidity. */
export function tokenEmbedView(d: TokenLocksData): LocksBadgeView {
  const s = d.summary;
  const meta = d.token;
  const lp = d.permanent !== null && d.permanent.pools.length > 0 ? d.permanent : null;
  const supply = s?.totalSupply ?? null;
  const lpLine =
    lp === null
      ? null
      : `${formatLockAmount(lp.total, meta)}${supply !== null && supply > 0n ? ` (${formatLockBps(Number((lp.total * 10_000n) / supply))} of supply)` : ""} locked permanently as liquidity (LP locker)`;
  if (s !== null && s.unvested > 0n) {
    const headline = s.unvestedBps === null ? `${formatLockAmount(s.unvested, meta)} locked` : s.unvestedBps === 0 ? "<0.01% of supply locked" : `${formatLockBps(s.unvestedBps)} of supply locked`;
    const parts = [`Not yet vested in ${s.locks.length === 1 ? "1 Gully Core token lock" : `${s.locks.length.toLocaleString("en-US")} Gully Core token locks`}.`];
    if (lpLine !== null) parts.push(`${lpLine}.`);
    return { tone: "locked", headline, detail: parts.join(" "), countdownTo: s.nextCliffOrEnd, countdownLabel: s.nextCliffOrEnd === null ? null : `next release ${formatUtc(s.nextCliffOrEnd)}` };
  }
  if (lpLine !== null) {
    return { tone: "locked", headline: "Liquidity locked permanently (LP locker)", detail: `${lpLine}.`, countdownTo: null, countdownLabel: null };
  }
  if (s !== null && s.locks.length > 0) {
    return { tone: "open", headline: `No ${meta.symbol} locked now`, detail: "Every Gully Core token lock of it has fully vested.", countdownTo: null, countdownLabel: null };
  }
  return { tone: "none", headline: `No ${meta.symbol} locked`, detail: "No Gully Core token lock or LP-locker liquidity holds it.", countdownTo: null, countdownLabel: null };
}
