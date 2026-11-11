// SPDX-License-Identifier: MIT
/**
 * Helpers beside the chart kit: a reduced-motion check, a sort that sinks
 * unread values, and the fraction of a time window that has run. The charts
 * themselves are `components/chartkit` (and the thin names in
 * `components/Charts.tsx`); nothing here draws.
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Sort by a numeric accessor; `null` (unread) always sinks to the bottom whatever the direction. */
export function sortRows<T>(rows: readonly T[], val: (r: T) => number | null, dir: "asc" | "desc"): T[] {
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir === "desc" ? y - x : x - y;
  });
}

/** Fraction of a [start, end] window elapsed at `now`, clamped to 0..1. A zero-length window is 0 before and 1 from its start. */
export function windowProgress(start: number, end: number, now: number): number {
  if (end <= start) return now >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}
