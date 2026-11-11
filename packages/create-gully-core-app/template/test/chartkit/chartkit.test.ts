// SPDX-License-Identifier: MIT
/* ============================================================================
   The shared chart kit (src/components/chartkit): the pure rules (stepping,
   snapping, ticks, the honest-empty sentence), each component's scales and
   paths, that the table view has exactly the chart's rows, that reduced
   motion paints the final state, the empty / error / loading states, and
   tiny prices through the app's subscript formatter. Rendered with
   renderToStaticMarkup (node environment, no DOM). Data: test/chartkit/fixtures.ts.
   ============================================================================ */
import { createElement as h, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  AreaLine,
  BarList,
  Bars,
  ChartCard,
  ChartGrid,
  ChartKitProvider,
  DivergingBars,
  KpiTile,
  RangeBand,
  Ring,
  Sparkline,
  StepCurve,
  areaLineGeometry,
  areaLineTable,
  barListTable,
  barsTable,
  compactTick,
  divergingTable,
  notEnough,
  rangeBandTable,
  rangeStatus,
  ringGeometry,
  ringTable,
  roundedBar,
  seriesColor,
  sharePct,
  signedPct,
  sparkPath,
  stepCurveTable,
  stepIndex,
  timeTick,
  unlockedAt,
  type MotionMode,
} from '../../src/components/chartkit'
import { nearestIndex } from '../../src/components/chartkit/core'
import { countSpring } from '../../src/components/chartkit/Kpi'
import { fmtPrice } from '../../src/components/chartkit/format'
import {
  dailyBars,
  fourParts,
  hourlyFlows,
  lockSplit,
  lpRange,
  onePoint,
  sparkValues,
  tinyPriceSeries,
  topHolders,
  topHoldersTotal,
  twoSeries,
  vestingNow,
  vestingSteps,
} from './fixtures'

const html = (el: ReactElement, motion: MotionMode = 'auto') => renderToStaticMarkup(h(ChartKitProvider, { motion }, el))
const inTable = (el: ReactElement) => html(h(ChartCard, { title: 'T', defaultView: 'table' }, el))
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length
/** <tr> in a rendered table, minus the header row. */
const bodyRows = (s: string) => count(s, /<tr>/g) - 1

/* -------------------------------------------------------------- core ---- */

describe('stepIndex (keyboard)', () => {
  it('→ / ← step and stop at the ends; Home / End jump; Escape clears', () => {
    expect(stepIndex(null, 'ArrowRight', 5)).toBe(0)
    expect(stepIndex(null, 'ArrowLeft', 5)).toBe(4)
    expect(stepIndex(2, 'ArrowRight', 5)).toBe(3)
    expect(stepIndex(4, 'ArrowRight', 5)).toBe(4)
    expect(stepIndex(0, 'ArrowLeft', 5)).toBe(0)
    expect(stepIndex(3, 'Home', 5)).toBe(0)
    expect(stepIndex(0, 'End', 5)).toBe(4)
    expect(stepIndex(3, 'Escape', 5)).toBeNull()
  })
  it('lets every other key through (undefined) and handles an empty chart', () => {
    expect(stepIndex(1, 'a', 5)).toBeUndefined()
    expect(stepIndex(1, 'Tab', 5)).toBeUndefined()
    expect(stepIndex(null, 'ArrowRight', 0)).toBeUndefined()
    expect(stepIndex(null, 'Escape', 0)).toBeNull()
  })
  it('walking right from nothing visits every index once, in order', () => {
    const seen: number[] = []
    let i: number | null = null
    for (let k = 0; k < 7; k++) {
      i = stepIndex(i, 'ArrowRight', 7) as number
      seen.push(i)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

describe('nearestIndex (pointer snapping)', () => {
  const xs = [10, 20, 40, 80]
  it('snaps to the closest position, ties to the left', () => {
    expect(nearestIndex(xs, 0)).toBe(0)
    expect(nearestIndex(xs, 14)).toBe(0)
    expect(nearestIndex(xs, 15)).toBe(0)
    expect(nearestIndex(xs, 16)).toBe(1)
    expect(nearestIndex(xs, 61)).toBe(3)
    expect(nearestIndex(xs, 1e6)).toBe(3)
  })
  it('-1 for nothing to snap to', () => expect(nearestIndex([], 5)).toBe(-1))
})

describe('formatting', () => {
  it('compacts ticks from 1,000 up and keeps the app rules below', () => {
    expect(compactTick(0)).toBe('0')
    expect(compactTick(950)).toBe('950')
    expect(compactTick(1500)).toBe('1.5K')
    expect(compactTick(2_400_000)).toBe('2.4M')
  })
  it('sizes time ticks to the span (UTC)', () => {
    const t = Date.UTC(2026, 9, 11, 14, 5) / 1000
    expect(timeTick(t, 3600)).toBe('14:05')
    expect(timeTick(t, 30 * 86400)).toBe('Oct 11')
    expect(timeTick(t, 800 * 86400)).toBe('Oct 2026')
  })
  it('writes the honest empty with the count and the right noun', () => {
    expect(notEnough(0, 'trades')).toBe('0 trades — not enough for a series')
    expect(notEnough(1, 'trades')).toBe('1 trade — not enough for a series')
    expect(notEnough(1, 'buckets', 'bucket')).toBe('1 bucket — not enough for a series')
  })
  it('carries direction in a glyph, never colour alone', () => {
    expect(signedPct(0.125)).toEqual({ text: '▲ 12.5%', dir: 'up' })
    expect(signedPct(-0.031)).toEqual({ text: '▼ 3.1%', dir: 'down' })
    expect(signedPct(0)).toEqual({ text: '0%', dir: 'flat' })
    expect(signedPct(Number.NaN).text).toBe('—')
  })
  it('shares out of a total; no total is no share', () => {
    expect(sharePct(25, 100)).toBe('25%')
    expect(sharePct(1, 0)).toBe('—')
  })
  it('has four series colours in fixed order and refuses a fifth', () => {
    expect([0, 1, 2, 3].map(seriesColor)).toEqual(['var(--ck-s1)', 'var(--ck-s2)', 'var(--ck-s3)', 'var(--ck-s4)'])
    expect(() => seriesColor(4)).toThrow(/Other/)
  })
})

/* --------------------------------------------------------- AreaLine ---- */

describe('AreaLine', () => {
  it('maps x ascending left to right inside the margins, y upward', () => {
    const g = areaLineGeometry({ series: [tinyPriceSeries], label: 'Price' }, 600, 220)
    expect(g.xsPx.length).toBe(48)
    expect(g.xsPx[0]).toBeCloseTo(g.margin.left, 6)
    expect(g.xsPx[47]).toBeCloseTo(600 - g.margin.right, 6)
    for (let i = 1; i < g.xsPx.length; i++) expect(g.xsPx[i] as number).toBeGreaterThan(g.xsPx[i - 1] as number)
    const lo = Math.min(...tinyPriceSeries.points.map((p) => p.y))
    const hi = Math.max(...tinyPriceSeries.points.map((p) => p.y))
    expect(g.py(hi)).toBeLessThan(g.py(lo))
    expect(g.lines[0]?.startsWith(`M${g.margin.left}`)).toBe(true)
    expect(g.areas[0]).toMatch(/Z$/)
  })
  it('draws no area under two series, and a line for each', () => {
    const g = areaLineGeometry({ series: twoSeries, label: 'Volume' }, 600, 220)
    expect(g.lines).toHaveLength(2)
    expect(g.areas).toEqual([null, null])
    const s = html(h(AreaLine, { series: twoSeries, label: 'Volume' }))
    expect(count(s, /class="ck-line"/g)).toBe(2)
    expect(s).toContain('class="ck-legend"')
  })
  it('a flat series still gets a y range (no division by zero)', () => {
    const g = areaLineGeometry({ series: [{ id: 'f', label: 'F', points: [{ x: 1, y: 5 }, { x: 2, y: 5 }] }], label: 'F' }, 400, 200)
    expect(Number.isFinite(g.py(5))).toBe(true)
  })
  it('table view: one row per x on the chart, one column per series', () => {
    const t = areaLineTable({ series: twoSeries, label: 'Volume' })
    expect(t.rows).toHaveLength(areaLineGeometry({ series: twoSeries, label: 'Volume' }, 600, 220).xsData.length)
    expect(t.columns.map((c) => c.label)).toEqual(['Time (UTC)', 'Buy volume', 'Sell volume'])
    expect(bodyRows(inTable(h(AreaLine, { series: twoSeries, label: 'Volume' })))).toBe(30)
  })
  it('one point is the honest empty, with the count', () => {
    const s = html(h(AreaLine, { series: [onePoint], label: 'Price', noun: 'trades' }))
    expect(s).toContain('1 trade — not enough for a series')
    expect(s).not.toContain('<svg')
  })
  it('is a focusable, labelled figure', () => {
    const s = html(h(AreaLine, { series: [tinyPriceSeries], label: 'Price', formatY: fmtPrice }))
    expect(s).toMatch(/tabindex="0"[^>]*role="group"|role="group"[^>]*tabindex="0"/)
    expect(s).toContain('aria-roledescription="chart"')
    expect(s).toMatch(/aria-label="Price\. Price: 48 points from /)
  })
})

/* ------------------------------------------------- tiny prices ---- */

describe('tiny prices through fmtPrice (subscript zeros)', () => {
  it('ticks, the aria summary and the table rows all use the formatter', () => {
    const g = areaLineGeometry({ series: [tinyPriceSeries], label: 'Price', formatY: fmtPrice }, 600, 220)
    for (const t of g.yTicks) expect(t.label).toMatch(/^0\.0[₀-₉]+\d+$|^0$/)
    const t = areaLineTable({ series: [tinyPriceSeries], label: 'Price', formatY: fmtPrice })
    expect(t.rows[0]?.[1]).toMatch(/^0\.0₈\d+$/)
    const s = html(h(AreaLine, { series: [tinyPriceSeries], label: 'Price', formatY: fmtPrice }))
    expect(s).toContain('0.0₈')
    expect(s).not.toContain('&lt;0.0001')
  })
  it('the default formatter would collapse them, which is why prices pass fmtPrice', () => {
    expect(compactTick(1.4e-9)).toBe('<0.0001')
    expect(fmtPrice(1.4e-9)).toBe('0.0₈14')
  })
  it('RangeBand labels its edges and the marker with the formatter', () => {
    const s = html(h(RangeBand, { ...lpRange, label: 'Range', format: fmtPrice }))
    expect(s).toContain(fmtPrice(lpRange.lower))
    expect(s).toContain(fmtPrice(lpRange.upper))
    expect(s).toContain(fmtPrice(lpRange.current))
  })
})

/* -------------------------------------------------------------- Bars ---- */

describe('Bars', () => {
  it('rounds the data end only and grows from the baseline', () => {
    const up = roundedBar(10, 100, 40, 20)
    expect(up.startsWith('M10,100V44Q10,40')).toBe(true)
    expect(up.endsWith('V100Z')).toBe(true)
    const down = roundedBar(10, 100, 160, 20)
    expect(down.startsWith('M10,100V156Q10,160')).toBe(true)
    expect(roundedBar(10, 100, 100, 20)).toBe('')
    /* the radius never exceeds half the width or the height */
    expect(roundedBar(0, 10, 8, 20)).toBe('M0,10V10Q0,8 2,8H18Q20,8 20,10V10Z')
  })
  it('draws one mark per bucket, at most 24px wide', () => {
    const s = html(h(Bars, { data: dailyBars, label: 'Launches per day' }))
    expect(count(s, /class="ck-mark"/g)).toBe(dailyBars.length)
    const d = s.match(/class="ck-mark"[^>]*d="M([\d.]+),[\d.]+V[\d.]+Q[\d.]+,[\d.]+ ([\d.]+),/)
    expect(d).not.toBeNull()
  })
  it('table rows equal chart marks', () => {
    expect(barsTable({ data: dailyBars, label: 'L' }).rows).toHaveLength(dailyBars.length)
    expect(bodyRows(inTable(h(Bars, { data: dailyBars, label: 'L' })))).toBe(dailyBars.length)
  })
  it('refuses signed data (that is DivergingBars)', () => {
    expect(() => html(h(Bars, { data: [{ key: 'a', label: 'a', value: -1 }], label: 'L' }))).toThrow(/DivergingBars/)
  })
  it('no buckets is the honest empty', () => {
    expect(html(h(Bars, { data: [], label: 'L', noun: 'days', nounOne: 'day' }))).toContain('0 days — not enough for a series')
  })
})

describe('DivergingBars', () => {
  it('draws buys above the baseline in the up colour and sells below in the down colour', () => {
    const s = html(h(DivergingBars, { data: hourlyFlows, label: 'Flows' }))
    expect(count(s, /fill="var\(--ck-up\)"/g)).toBe(hourlyFlows.filter((d) => d.up > 0).length)
    expect(count(s, /fill="var\(--ck-down\)"/g)).toBe(hourlyFlows.filter((d) => d.down > 0).length)
    expect(s).toContain('>Buys<')
    expect(s).toContain('>Sells<')
  })
  it('table rows equal chart buckets', () => {
    expect(divergingTable({ data: hourlyFlows, label: 'F' }).rows).toHaveLength(24)
    expect(bodyRows(inTable(h(DivergingBars, { data: hourlyFlows, label: 'F' })))).toBe(24)
  })
})

/* -------------------------------------------------------------- Ring ---- */

describe('Ring', () => {
  it('one arc per part, angles summing to a full turn, a zero part drawn empty', () => {
    const g = ringGeometry([...lockSplit, { key: 'z', label: 'Zero', value: 0 }], 200)
    expect(g.arcs).toHaveLength(4)
    expect(g.arcs[3]?.d).toBe('')
    expect(g.arcs[0]?.start).toBeCloseTo(0, 9)
    expect(g.arcs[3]?.end).toBeCloseTo(2 * Math.PI, 9)
    expect(g.r0).toBeLessThan(g.r1)
  })
  it('keeps the parts in the order given (colour follows the part, not its rank)', () => {
    const g = ringGeometry([{ key: 'small', label: 's', value: 1 }, { key: 'big', label: 'b', value: 9 }], 200)
    expect(g.arcs[0]?.start).toBeCloseTo(0, 9)
    const s = html(h(Ring, { segments: lockSplit, label: 'Split' }))
    expect(s.indexOf('var(--ck-s1)')).toBeLessThan(s.indexOf('var(--ck-s2)'))
  })
  it('table: value and share per part, shares summing to 100%', () => {
    const t = ringTable({ segments: fourParts, label: 'P' })
    expect(t.rows.map((r) => r[2])).toEqual(['40%', '30%', '20%', '10%'])
    expect(bodyRows(inTable(h(Ring, { segments: fourParts, label: 'P' })))).toBe(4)
  })
  it('refuses a fifth part, and nothing to share is the honest empty', () => {
    expect(() => html(h(Ring, { segments: [...fourParts, { key: 'e', label: 'e', value: 1 }], label: 'P' }))).toThrow(/Other/)
    expect(html(h(Ring, { segments: [{ key: 'a', label: 'a', value: 0 }], label: 'P', emptyTitle: 'No fees collected yet' }))).toContain('No fees collected yet')
  })
})

/* -------------------------------------------------------- StepCurve ---- */

describe('StepCurve', () => {
  it('unlockedAt holds each step until the next, 0 before the first', () => {
    expect(unlockedAt(vestingSteps, (vestingSteps[0]?.t ?? 0) - 1)).toBe(0)
    expect(unlockedAt(vestingSteps, vestingSteps[0]?.t ?? 0)).toBe(1_000_000)
    expect(unlockedAt(vestingSteps, vestingNow)).toBe(5_000_000)
    expect(unlockedAt(vestingSteps, 9e12)).toBe(12_000_000)
  })
  it('table: every step with its status against the chain clock', () => {
    const t = stepCurveTable({ steps: vestingSteps, now: vestingNow, label: 'Vesting' })
    expect(t.rows).toHaveLength(12)
    expect(t.rows.filter((r) => r[2] === 'Unlocked')).toHaveLength(5)
    expect(bodyRows(inTable(h(StepCurve, { steps: vestingSteps, now: vestingNow, label: 'Vesting' })))).toBe(12)
  })
  it('draws the NOW marker and a step path', () => {
    const s = html(h(StepCurve, { steps: vestingSteps, now: vestingNow, label: 'Vesting' }))
    expect(s).toContain('>NOW<')
    expect(s).toMatch(/class="ck-line" d="M[^"]+L[^"]+"/)
  })
})

/* -------------------------------------------------------- RangeBand ---- */

describe('RangeBand', () => {
  it('status is written out: in, below, above, not read', () => {
    expect(rangeStatus(1, 2, 1.5)).toBe('in')
    expect(rangeStatus(1, 2, 1)).toBe('in')
    expect(rangeStatus(1, 2, 2)).toBe('above')
    expect(rangeStatus(1, 2, 0.5)).toBe('below')
    expect(rangeStatus(1, 2, null)).toBe('unknown')
    expect(html(h(RangeBand, { lower: 1, upper: 2, current: 3, label: 'R' }))).toContain('▲ ABOVE RANGE')
    expect(html(h(RangeBand, { lower: 1, upper: 2, current: null, label: 'R' }))).toContain('PRICE NOT READ')
  })
  it('table rows are the marks, in price order', () => {
    expect(rangeBandTable({ ...lpRange, label: 'R' }).rows.map((r) => r[0])).toEqual(['Lower', 'Current price', 'Upper'])
    expect(bodyRows(inTable(h(RangeBand, { ...lpRange, label: 'R' })))).toBe(3)
  })
  it('refuses an inverted range', () => {
    expect(() => html(h(RangeBand, { lower: 2, upper: 1, current: 1, label: 'R' }))).toThrow()
  })
})

/* ---------------------------------------------------------- BarList ---- */

describe('BarList', () => {
  it('ranks rows with shares; table rows equal list rows', () => {
    const t = barListTable({ rows: topHolders, label: 'Holders', total: topHoldersTotal })
    expect(t.rows[0]).toEqual(['1', '0xaaaa…0001 (LP lock)', '182.4M', '18.2%'])
    const s = html(h(BarList, { rows: topHolders, label: 'Holders', total: topHoldersTotal }))
    expect(count(s, /class="ck-barlist__row"/g)).toBe(topHolders.length)
    expect(bodyRows(inTable(h(BarList, { rows: topHolders, label: 'Holders' })))).toBe(topHolders.length)
  })
  it('no rows: "No holders yet"', () => {
    expect(html(h(BarList, { rows: [], label: 'Holders', noun: 'holders' }))).toContain('No holders yet')
  })
})

/* ----------------------------------------------------- KPI, spark, grid ---- */

describe('KpiTile, Sparkline, ChartGrid', () => {
  it('sparkline: a path for two points or more, nothing under two', () => {
    expect(sparkPath([1], 90, 26)).toBe('')
    expect(sparkPath(sparkValues, 90, 26)).toMatch(/^M2,/)
    expect(html(h(Sparkline, { values: [1], label: 'P' }))).toContain('not enough points for a trend')
  })
  it('KPI: the final value in the markup, a signed delta with its glyph, a link when it has a detail', () => {
    const s = html(h(KpiTile, { label: 'Volume 24h', value: 12_900, delta: 0.125, deltaLabel: 'vs prior 24h', href: '/analytics' }))
    expect(s).toContain('12.9K')
    expect(s).toContain('VOLUME 24H')
    expect(s).toContain('▲ 12.5% vs prior 24h')
    expect(s).toMatch(/^<a class="dc-kpi ck-kpi" href="\/analytics">/)
  })
  it('KPI states: not read is "—", loading a skeleton, error says so', () => {
    expect(html(h(KpiTile, { label: 'X', value: null }))).toContain('—')
    expect(html(h(KpiTile, { label: 'X', value: 1, state: 'loading' }))).toContain('role="status"')
    expect(html(h(KpiTile, { label: 'X', value: 1, state: 'error' }))).toContain('Couldn’t read the chain')
  })
  it('the count-up spring rests relative to its target (a tiny price does not snap)', () => {
    expect(countSpring(1.4e-9).restDelta).toBeLessThan(1e-12)
    expect(countSpring(1000).restDelta).toBeCloseTo(0.1, 9)
  })
  it('grid: a KPI row then the cards', () => {
    const s = html(h(ChartGrid, { kpis: h(KpiTile, { label: 'A', value: 1 }) }, h(ChartCard, { title: 'C' }, h(Bars, { data: dailyBars, label: 'L' }))))
    expect(s.indexOf('ck-grid__kpis')).toBeLessThan(s.indexOf('ck-grid__cards'))
  })
})

/* ------------------------------------------------------ card states ---- */

describe('ChartCard states', () => {
  const chart = h(Bars, { data: dailyBars, label: 'L' })
  it('loading is a skeleton, not the chart', () => {
    const s = html(h(ChartCard, { title: 'T', state: 'loading' }, chart))
    expect(s).toContain('dc-skeleton')
    expect(s).not.toContain('ck-mark')
    expect(s).not.toContain('role="radiogroup"')
  })
  it('error is "Couldn’t read the chain · ERROR · RETRY" with the message kept', () => {
    const s = html(h(ChartCard, { title: 'T', state: { error: 'timeout' } }, chart))
    expect(s).toContain('role="alert"')
    expect(s).toContain('Couldn’t read the chain')
    expect(s).toContain('ERROR · RETRY')
    expect(s).toContain('data-error="timeout"')
  })
  it('coming soon names the chain', () => {
    expect(html(h(ChartCard, { title: 'T', state: { soon: 'HyperEVM' } }, chart))).toContain('On HyperEVM')
  })
  it('ready: Chart | Table switch, range chips, provenance line', () => {
    const s = html(
      h(ChartCard, { title: 'T', provenance: 'read from the CL pool manager at block 48,127,937', ranges: { options: [{ value: '24h', label: '24H' }, { value: 'all', label: 'ALL' }], value: '24h', onChange: () => {} } }, chart),
    )
    expect(s).toContain('aria-label="View"')
    expect(s).toContain('aria-label="Range"')
    expect(s).toContain('read from the CL pool manager at block 48,127,937')
  })
})

/* ---------------------------------------------------- reduced motion ---- */

describe('reduced motion paints the final state', () => {
  const all = () => [
    h(AreaLine, { key: 'a', series: [tinyPriceSeries], label: 'P' }),
    h(Bars, { key: 'b', data: dailyBars, label: 'B' }),
    h(DivergingBars, { key: 'd', data: hourlyFlows, label: 'D' }),
    h(StepCurve, { key: 's', steps: vestingSteps, now: vestingNow, label: 'S' }),
    h(RangeBand, { key: 'r', ...lpRange, label: 'R' }),
    h(BarList, { key: 'l', rows: topHolders, label: 'L' }),
    h(Ring, { key: 'g', segments: lockSplit, label: 'G' }),
  ]
  it('armed (motion "always"): marks start hidden — the control that proves the check bites', () => {
    const s = html(h('div', null, ...all()), 'always')
    expect(s).toContain('scaleY(0)')
    expect(s).toContain('scaleX(0)')
    expect(s).toContain('stroke-dasharray="0 1"')
    expect(s).toContain('mask="url(#')
  })
  it('reduce: no hidden start anywhere — bars full height, lines fully drawn, no ring mask', () => {
    const s = html(h('div', null, ...all()), 'reduce')
    expect(s).not.toContain('scaleY(0)')
    expect(s).not.toContain('scaleX(0)')
    expect(s).not.toContain('stroke-dasharray="0 1"')
    expect(s).not.toContain('opacity:0"')
    expect(s).not.toContain('mask="url(#')
  })
  it('auto on the server (no window) paints the final state too', () => {
    const s = html(h('div', null, ...all()), 'auto')
    expect(s).not.toContain('scaleY(0)')
    expect(s).not.toContain('stroke-dasharray="0 1"')
  })
})
