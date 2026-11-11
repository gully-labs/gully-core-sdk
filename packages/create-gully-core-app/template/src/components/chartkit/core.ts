// SPDX-License-Identifier: MIT
/* ============================================================================
   Chart kit — the pure part: series colours, keyboard stepping, pointer
   snapping, tick and time formatting, the honest-empty sentence. No React, no
   DOM, so every rule here is unit-tested directly (test/chartkit/chartkit.test.ts).
   ============================================================================ */

import { fmtInt, fmtNumber, fmtUtc } from './format'

/** Categorical series colours, in FIXED order (never cycled): see chartkit.css for the validation. */
export const SERIES_COLORS = ['var(--ck-s1)', 'var(--ck-s2)', 'var(--ck-s3)', 'var(--ck-s4)'] as const
/** Polarity colours: buys / gain, sells / loss. */
export const UP_COLOR = 'var(--ck-up)'
export const DOWN_COLOR = 'var(--ck-down)'

/** The colour of series slot `i`. A fifth series has no colour: fold it into "Other" before it gets here. */
export function seriesColor(i: number): string {
  const c = SERIES_COLORS[i]
  if (c === undefined) throw new RangeError(`chart kit: series slot ${i} has no colour (max ${SERIES_COLORS.length}); fold the rest into "Other"`)
  return c
}

/** The handoff's motion values (anim.js). */
export const EASE = [0.2, 0.7, 0.2, 1] as const
export const DRAW_S = 1.4
export const BARUP_S = 0.7
export const GROW_S = 0.8
export const STAGGER_S = 0.07

/**
 * The index a key moves the active point to, or `undefined` when the key is not a chart key
 * (the caller then lets it through). ←/→ step and stop at the ends, Home/End jump, Escape
 * clears (null). From nothing, → starts at the first point and ← at the last.
 */
export function stepIndex(current: number | null, key: string, n: number): number | null | undefined {
  if (n <= 0) return key === 'Escape' ? null : undefined
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current === null ? 0 : Math.min(n - 1, current + 1)
    case 'ArrowLeft':
    case 'ArrowUp':
      return current === null ? n - 1 : Math.max(0, current - 1)
    case 'Home':
      return 0
    case 'End':
      return n - 1
    case 'Escape':
      return null
    default:
      return undefined
  }
}

/** The index of the position nearest `px` in an ascending list (binary search). -1 for an empty list. */
export function nearestIndex(xs: readonly number[], px: number): number {
  const n = xs.length
  if (n === 0) return -1
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((xs[mid] as number) <= px) lo = mid
    else hi = mid
  }
  return Math.abs(px - (xs[lo] as number)) <= Math.abs((xs[hi] as number) - px) ? lo : hi
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** An axis tick: compact from 1,000 up (1K, 2.5M), the app's number rules below. */
export function compactTick(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Math.abs(n) >= 1000 ? COMPACT.format(n) : fmtNumber(n)
}

const DAY = 86_400
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A time-axis tick (UTC), sized to the span on screen: HH:MM inside two days, "Oct 11" beyond, "Oct 2026" past a year. */
export function timeTick(seconds: number, spanSeconds: number): string {
  const d = new Date(seconds * 1000)
  if (!Number.isFinite(d.getTime())) return '—'
  if (spanSeconds <= 2 * DAY) return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  if (spanSeconds <= 400 * DAY) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** A time in a tooltip or table cell: the app's one time format. */
export function timeFull(seconds: number): string {
  return fmtUtc(seconds)
}

/** The honest empty: "1 trade — not enough for a series", "0 trades — …". */
export function notEnough(count: number, noun: string, nounOne?: string): string {
  const word = count === 1 ? (nounOne ?? noun.replace(/s$/, '')) : noun
  return `${fmtInt(count)} ${word} — not enough for a series`
}

/** "▲ 12.5%" / "▼ 3.1%" / "0%": the glyph carries direction, so colour is never alone. */
export function signedPct(ratio: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (!Number.isFinite(ratio)) return { text: '—', dir: 'flat' }
  const pct = ratio * 100
  const abs = Math.abs(pct)
  const body = `${abs.toLocaleString('en-US', { maximumFractionDigits: abs < 1 ? 2 : 1 })}%`
  if (pct > 0) return { text: `▲ ${body}`, dir: 'up' }
  if (pct < 0) return { text: `▼ ${body}`, dir: 'down' }
  return { text: body, dir: 'flat' }
}

/** Share of a total as a percentage string; "—" when the total is not positive. */
export function sharePct(value: number, total: number): string {
  if (!(total > 0) || !Number.isFinite(value)) return '—'
  const p = (value / total) * 100
  return `${p.toLocaleString('en-US', { maximumFractionDigits: p < 1 ? 2 : 1 })}%`
}

/** Low / high / last of a list of numbers, for aria summaries. */
export function extent(values: readonly number[]): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return min === Infinity ? null : { min, max }
}
