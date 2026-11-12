// SPDX-License-Identifier: MIT
/**
 * Keeping the liquidity widget's own lists true after a confirmed add or
 * removal, without a reload.
 *
 * The widget counts confirmed changes (`bumpOnConfirmed`); the positions list,
 * the pool state and the wallet balances take that count as a dependency, so a
 * confirmation re-reads them. The picker then re-selects from the FRESH list
 * (`reconcileSelection`), so a partial removal shows the new amounts and a
 * position emptied to zero disappears (`withdrawablePositions`).
 */

import type { PositionInfo } from "../adapters/protocol.js";

/**
 * Wraps the host's `onLiquidityChanged` so a confirmation also advances the
 * widget's refresh counter. The counter moves first: the host's callback can
 * throw without leaving the widget's lists stale.
 */
export function bumpOnConfirmed<H>(
  bump: () => void,
  host: ((hash: H) => void) | undefined,
): (hash: H) => void {
  return (hash: H) => {
    bump();
    host?.(hash);
  };
}

/**
 * The positions there is something to withdraw from. A CL position removed to
 * zero keeps its NFT (the widget decreases liquidity and takes the tokens; it
 * does not burn), so the adapter still lists it with zero liquidity and zero
 * owed fees - offering it in the Remove picker would quote a withdrawal of
 * nothing.
 */
export function withdrawablePositions(list: readonly PositionInfo[]): readonly PositionInfo[] {
  return list.filter((p) => p.liquidity > 0n || p.feesOwed0 > 0n || p.feesOwed1 > 0n);
}

/**
 * The selection after the list was re-read: the SAME position as its fresh
 * record (new amounts, new liquidity), else the first position, else `null`.
 * Returning the fresh object matters - a stale one keeps quoting the
 * withdrawal against the liquidity it had before the last removal.
 */
export function reconcileSelection<T extends { readonly id: string }>(current: T | null, list: readonly T[]): T | null {
  if (current !== null) {
    const fresh = list.find((p) => p.id === current.id);
    if (fresh !== undefined) return fresh;
  }
  return list[0] ?? null;
}
