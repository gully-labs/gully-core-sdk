// SPDX-License-Identifier: MIT
/* ============================================================================
   TEST FIXTURES for the chart kit (src/components/chartkit; it lives under test/ so tsc never sees it). Shapes only:
   these numbers are not chain data and must never be imported by anything
   under src/. The dev gallery (test/chartkit-gallery/) and test/chartkit.test.ts
   read them; both label what they draw as a fixture.
   ============================================================================ */

import type { BarDatum, BarListRow, DivergingDatum, RingSegment, Step, XYSeries } from '../../src/components/chartkit'

const T0 = 1_791_000_000 // a fixed unix time, so every run draws the same thing
const HOUR = 3600
const DAY = 86_400

/** A deterministic wobble (no Math.random: screenshots must be reproducible). */
function wave(i: number, a: number, b: number): number {
  return Math.sin(i * a) * 0.6 + Math.sin(i * b + 1.3) * 0.4
}

/** A tiny price (sub-1e-6) over 48 hourly points: the subscript-zero formatter's case. */
export const tinyPriceSeries: XYSeries = {
  id: 'price',
  label: 'Price',
  points: Array.from({ length: 48 }, (_, i) => ({ x: T0 + i * HOUR, y: 1.4e-9 * (1 + i * 0.012 + wave(i, 0.45, 0.17) * 0.08) })),
}

/** Two series on one scale: buy volume and sell volume per day. */
export const twoSeries: readonly XYSeries[] = [
  { id: 'buys', label: 'Buy volume', points: Array.from({ length: 30 }, (_, i) => ({ x: T0 + i * DAY, y: 40 + i * 1.5 + wave(i, 0.7, 0.23) * 12 })) },
  { id: 'sells', label: 'Sell volume', points: Array.from({ length: 30 }, (_, i) => ({ x: T0 + i * DAY, y: 32 + i * 1.1 + wave(i, 0.5, 0.31) * 10 })) },
]

export const onePoint: XYSeries = { id: 'p', label: 'Price', points: [{ x: T0, y: 1 }] }

export const dailyBars: readonly BarDatum[] = Array.from({ length: 14 }, (_, i) => ({
  key: String(T0 + i * DAY),
  label: `Oct ${i + 1}`,
  value: Math.max(0, Math.round(6 + wave(i, 0.9, 0.4) * 5 + i * 0.3)),
}))

export const hourlyFlows: readonly DivergingDatum[] = Array.from({ length: 24 }, (_, i) => ({
  key: String(T0 + i * HOUR),
  label: `${String(i).padStart(2, '0')}:00`,
  up: Math.max(0, 3 + wave(i, 0.8, 0.3) * 2.5),
  down: Math.max(0, 2.2 + wave(i, 0.6, 0.5) * 2),
}))

export const lockSplit: readonly RingSegment[] = [
  { key: 'creator', label: 'Creator', value: 7500 },
  { key: 'protocol', label: 'Protocol', value: 2000 },
  { key: 'integrator', label: 'Integrator', value: 500 },
]

export const fourParts: readonly RingSegment[] = [
  { key: 'a', label: 'Part A', value: 40 },
  { key: 'b', label: 'Part B', value: 30 },
  { key: 'c', label: 'Part C', value: 20 },
  { key: 'd', label: 'Part D', value: 10 },
]

/** A cliff then monthly unlocks: 12 steps of 1,000,000 after a 90-day cliff. */
export const vestingSteps: readonly Step[] = Array.from({ length: 12 }, (_, i) => ({ t: T0 + 90 * DAY + i * 30 * DAY, value: (i + 1) * 1_000_000 }))
export const vestingNow = T0 + 90 * DAY + 4 * 30 * DAY + 10 * DAY

export const lpRange = { lower: 2.4e-10, upper: 3.9e-9, current: 1.4e-9 }

export const topHolders: readonly BarListRow[] = [
  { key: '0x1', label: '0xaaaa…0001', value: 182_400_000, note: 'LP lock' },
  { key: '0x2', label: '0xaaaa…0002', value: 96_000_000 },
  { key: '0x3', label: '0xaaaa…0003', value: 41_250_000 },
  { key: '0x4', label: '0xaaaa…0004', value: 12_000_000 },
  { key: '0x5', label: '0xaaaa…0005', value: 3_100_000 },
]
export const topHoldersTotal = 1_000_000_000

export const sparkValues: readonly number[] = Array.from({ length: 24 }, (_, i) => 100 + i * 0.8 + wave(i, 0.7, 0.2) * 4)
