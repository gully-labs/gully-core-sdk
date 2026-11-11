// SPDX-License-Identifier: MIT
/* ============================================================================
   RangeBand — a price range against the current price (a locked liquidity
   position's ticks, a stock pool's band). Log scale by default, since a
   launch range spans orders of magnitude. The status is written out with a
   glyph ("● IN RANGE", "▼ BELOW RANGE", "▲ ABOVE RANGE"), never colour alone.
   ============================================================================ */

import { useState } from 'react'
import { m } from 'motion/react'
import { scaleLinear, scaleLog } from 'd3-scale'

import { EASE, GROW_S, compactTick, seriesColor } from './core'
import { ChartTable, Plot, TipRow, useChartView, type TableData } from './frame'
import { useReveal, useSize } from './runtime'

export interface RangeBandProps {
  readonly lower: number
  readonly upper: number
  /** The pool's price now; null when it could not be read (the band still draws, without a marker). */
  readonly current: number | null
  readonly label: string
  /** Pass fmtPrice for prices. */
  readonly format?: (n: number) => string
  readonly scale?: 'log' | 'linear'
  readonly lowerLabel?: string
  readonly upperLabel?: string
  readonly currentLabel?: string
}

export type RangeStatus = 'in' | 'below' | 'above' | 'unknown'

export function rangeStatus(lower: number, upper: number, current: number | null): RangeStatus {
  if (current === null || !Number.isFinite(current)) return 'unknown'
  if (current < lower) return 'below'
  if (current >= upper) return 'above'
  return 'in'
}

const STATUS_TEXT: Record<RangeStatus, string> = {
  in: '● IN RANGE',
  below: '▼ BELOW RANGE',
  above: '▲ ABOVE RANGE',
  unknown: 'PRICE NOT READ',
}

interface Mark {
  readonly key: 'lower' | 'current' | 'upper'
  readonly label: string
  readonly value: number
}

function marksOf(p: RangeBandProps): Mark[] {
  const out: Mark[] = [
    { key: 'lower', label: p.lowerLabel ?? 'Lower', value: p.lower },
    { key: 'upper', label: p.upperLabel ?? 'Upper', value: p.upper },
  ]
  if (p.current !== null && Number.isFinite(p.current)) out.push({ key: 'current', label: p.currentLabel ?? 'Current price', value: p.current })
  return out.sort((a, b) => a.value - b.value)
}

export function rangeBandGeometry(p: RangeBandProps, width: number) {
  const vals = [p.lower, p.upper, ...(p.current !== null && Number.isFinite(p.current) ? [p.current] : [])]
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const log = (p.scale ?? 'log') === 'log' && lo > 0
  const margin = { left: 16, right: 16 }
  const range: [number, number] = [margin.left, Math.max(margin.left + 10, width - margin.right)]
  let px: (v: number) => number
  if (log) {
    const span = Math.log10(hi / lo) || 1
    const pad = Math.pow(10, span * 0.18)
    const s = scaleLog()
      .domain([lo / pad, hi * pad])
      .range(range)
    px = (v) => s(v)
  } else {
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.18
    const s = scaleLinear()
      .domain([lo - pad, hi + pad])
      .range(range)
    px = (v) => s(v)
  }
  return { px, log }
}

export function rangeBandTable(p: RangeBandProps): TableData {
  const f = p.format ?? compactTick
  return {
    columns: [
      { key: 'k', label: 'Mark' },
      { key: 'v', label: 'Price', align: 'end' },
    ],
    rows: marksOf(p).map((mk) => [mk.label, f(mk.value)]),
  }
}

export function rangeBandSummary(p: RangeBandProps): string {
  const f = p.format ?? compactTick
  const st = rangeStatus(p.lower, p.upper, p.current)
  const where = st === 'in' ? 'inside the range' : st === 'below' ? 'below the range' : st === 'above' ? 'above the range' : 'not read'
  return `${p.label}. Range ${f(p.lower)} to ${f(p.upper)}. ${p.currentLabel ?? 'Current price'} ${p.current === null ? 'not read' : f(p.current)}, ${where}.`
}

export function RangeBand(props: RangeBandProps) {
  const view = useChartView()
  const { ref, width, height } = useSize<HTMLDivElement>(600, 160)
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const f = props.format ?? compactTick
  if (!(props.upper > props.lower)) throw new RangeError('RangeBand needs upper > lower')
  if (view === 'table') return <ChartTable data={rangeBandTable(props)} caption={props.label} />
  const g = rangeBandGeometry(props, width)
  const marks = marksOf(props)
  const st = rangeStatus(props.lower, props.upper, props.current)
  const color = seriesColor(0)
  const cy = Math.round(height * 0.55)
  const x0 = g.px(props.lower)
  const x1 = g.px(props.upper)
  const cx = props.current !== null && Number.isFinite(props.current) ? g.px(props.current) : null
  const a = active !== null ? marks[active] : undefined
  return (
    <Plot
      sizeRef={ref}
      summary={rangeBandSummary(props)}
      count={marks.length}
      positions={marks.map((mk) => g.px(mk.value))}
      active={active}
      onActive={setActive}
      readout={a ? `${a.label}: ${f(a.value)}` : null}
      tip={a ? <TipRow color={a.key === 'current' ? 'var(--ink)' : color} value={f(a.value)} label={a.label} /> : null}
      tipX={a ? g.px(a.value) : null}
      width={width}
    >
      <svg ref={reveal.ref} width={width} height={height} aria-hidden="true">
        <text className="ck-range__status" x={16} y={18}>
          {STATUS_TEXT[st]}
        </text>
        <text className="ck-axis-label" x={width - 16} y={18} textAnchor="end">
          {g.log ? 'LOG SCALE' : 'LINEAR SCALE'}
        </text>
        <rect x={16} y={cy - 4} width={Math.max(0, width - 32)} height={8} rx={4} fill="var(--track)" />
        <m.rect
          x={x0}
          y={cy - 4}
          width={Math.max(2, x1 - x0)}
          height={8}
          rx={4}
          fill={color}
          className="ck-mark"
          data-on={active !== null && marks[active]?.key !== 'current'}
          style={{ transformBox: 'fill-box', originX: 0 }}
          initial={reveal.armed ? { scaleX: 0 } : false}
          animate={{ scaleX: reveal.play ? 1 : 0 }}
          transition={{ duration: GROW_S, ease: EASE }}
        />
        <g className="ck-axis">
          <line className="ck-gridline" x1={x0} x2={x0} y1={cy + 6} y2={cy + 14} />
          <line className="ck-gridline" x1={x1} x2={x1} y1={cy + 6} y2={cy + 14} />
          <text x={x0} y={cy + 28} textAnchor={x0 < 60 ? 'start' : 'middle'}>
            {f(props.lower)}
          </text>
          <text x={x1} y={cy + 28} textAnchor={x1 > width - 60 ? 'end' : 'middle'}>
            {f(props.upper)}
          </text>
        </g>
        {cx !== null ? (
          <m.g initial={reveal.armed ? { opacity: 0 } : false} animate={{ opacity: reveal.play ? 1 : 0 }} transition={{ duration: 0.5, delay: reveal.armed ? GROW_S : 0 }}>
            <line x1={cx} x2={cx} y1={cy - 16} y2={cy + 10} stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
            <path d={`M${cx - 5},${cy - 22}L${cx + 5},${cy - 22}L${cx},${cy - 15}Z`} fill="var(--ink)" />
            <text className="ck-axis-label" x={cx} y={cy - 28} textAnchor={cx < 60 ? 'start' : cx > width - 60 ? 'end' : 'middle'} style={{ fill: 'var(--ink)' }}>
              {f(props.current as number)}
            </text>
          </m.g>
        ) : null}
        {a ? <line className="ck-cross" x1={g.px(a.value)} x2={g.px(a.value)} y1={cy - 30} y2={cy + 16} /> : null}
      </svg>
    </Plot>
  )
}
