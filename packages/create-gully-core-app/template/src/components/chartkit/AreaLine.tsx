// SPDX-License-Identifier: MIT
/* ============================================================================
   AreaLine — one or two series over time (or any ascending x): price, volume,
   value locked. One y axis, always: two measures of different scale are two
   charts, never a second axis. A single series gets a 10% area wash; two
   series are lines only, with a legend.
   ============================================================================ */

import { useState } from 'react'
import { m } from 'motion/react'
import { scaleLinear, scaleUtc } from 'd3-scale'
import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape'

import { DRAW_S, EASE, compactTick, extent, notEnough, seriesColor, timeFull, timeTick } from './core'
import { ChartEmpty, ChartTable, Legend, Plot, TipRow, useChartView, type TableData } from './frame'
import { useReveal, useSize } from './runtime'

export interface XYPoint {
  readonly x: number
  readonly y: number
}
export interface XYSeries {
  readonly id: string
  readonly label: string
  /** Ascending x. Time series: x in unix SECONDS. */
  readonly points: readonly XYPoint[]
}

export interface AreaLineProps {
  /** One or two series (more is a different chart: facet, or fold into "Other"). */
  readonly series: readonly XYSeries[]
  /** What is plotted, in words: the aria-label and the table caption start with it. */
  readonly label: string
  readonly xKind?: 'time' | 'number'
  /** Values in the tooltip, the table and the y ticks. Pass fmtPrice for prices. */
  readonly formatY?: (n: number) => string
  readonly formatX?: (n: number) => string
  /** Column title for x in the table view. */
  readonly xLabel?: string
  readonly yFromZero?: boolean
  /** Area wash under a single series (default true). */
  readonly area?: boolean
  /** Fewer points than this is the honest empty (default 2). */
  readonly minPoints?: number
  /** What a point is, for the empty sentence: "trades". */
  readonly noun?: string
  readonly nounOne?: string
}

export interface AreaLineGeometry {
  readonly margin: { top: number; right: number; bottom: number; left: number }
  /** Union of every series' x, ascending: the crosshair's stops and the table's rows. */
  readonly xsData: readonly number[]
  readonly xsPx: readonly number[]
  readonly lines: readonly string[]
  readonly areas: readonly (string | null)[]
  readonly yTicks: readonly { y: number; label: string }[]
  readonly xTicks: readonly { x: number; label: string }[]
  readonly baseline: number
  readonly px: (x: number) => number
  readonly py: (y: number) => number
}

const fmtYDefault = compactTick

/** Pure geometry: scales, paths, ticks. Exported for tests and for pages that need a matching overlay. */
export function areaLineGeometry(p: AreaLineProps, width: number, height: number): AreaLineGeometry {
  const formatY = p.formatY ?? fmtYDefault
  const time = (p.xKind ?? 'time') === 'time'
  const all = p.series.flatMap((s) => s.points)
  const ye = extent(all.map((q) => q.y)) ?? { min: 0, max: 1 }
  let lo = p.yFromZero ? Math.min(0, ye.min) : ye.min
  let hi = p.yFromZero ? Math.max(0, ye.max) : ye.max
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1
    lo -= pad
    hi += pad
  } else if (!p.yFromZero) {
    const pad = (hi - lo) * 0.06
    lo -= pad
    hi += pad
  }
  const yScale = scaleLinear().domain([lo, hi]).nice(4)
  const yTickValues = yScale.ticks(4)
  const yLabels = yTickValues.map((v) => formatY(v))
  const left = Math.min(96, Math.max(28, Math.max(...yLabels.map((s) => s.length)) * 6.2 + 10))
  const margin = { top: 10, right: 10, bottom: 22, left }
  const innerW = Math.max(10, width - margin.left - margin.right)
  const innerH = Math.max(10, height - margin.top - margin.bottom)
  yScale.range([margin.top + innerH, margin.top])

  const xsData = [...new Set(all.map((q) => q.x))].sort((a, b) => a - b)
  const x0 = xsData[0] ?? 0
  const x1 = xsData[xsData.length - 1] ?? 1
  const span = x1 - x0
  const range: [number, number] = [margin.left, margin.left + innerW]
  const tickCount = Math.max(2, Math.floor(innerW / 90))
  let px: (x: number) => number
  let xTicks: { x: number; label: string }[]
  if (time) {
    const s = scaleUtc()
      .domain([new Date(x0 * 1000), new Date((x1 === x0 ? x0 + 1 : x1) * 1000)])
      .range(range)
    px = (x) => s(new Date(x * 1000))
    xTicks = s.ticks(tickCount).map((d) => ({ x: s(d), label: timeTick(d.getTime() / 1000, span) }))
  } else {
    const s = scaleLinear()
      .domain([x0, x1 === x0 ? x0 + 1 : x1])
      .range(range)
    px = (x) => s(x)
    xTicks = s.ticks(tickCount).map((v) => ({ x: s(v), label: (p.formatX ?? compactTick)(v) }))
  }
  const py = (y: number) => yScale(y)
  const baseline = yScale(p.yFromZero ? 0 : (yScale.domain()[0] ?? lo))
  const lineGen = d3line<XYPoint>()
    .x((q) => px(q.x))
    .y((q) => py(q.y))
    .curve(curveMonotoneX)
  const wantArea = p.series.length === 1 && (p.area ?? true)
  const areaGen = d3area<XYPoint>()
    .x((q) => px(q.x))
    .y0(baseline)
    .y1((q) => py(q.y))
    .curve(curveMonotoneX)
  return {
    margin,
    xsData,
    xsPx: xsData.map(px),
    lines: p.series.map((s) => lineGen(s.points as XYPoint[]) ?? ''),
    areas: p.series.map((s) => (wantArea ? (areaGen(s.points as XYPoint[]) ?? null) : null)),
    yTicks: yTickValues.map((v, i) => ({ y: yScale(v), label: yLabels[i] ?? '' })),
    xTicks,
    baseline,
    px,
    py,
  }
}

function xText(p: AreaLineProps, x: number): string {
  if (p.formatX) return p.formatX(x)
  return (p.xKind ?? 'time') === 'time' ? timeFull(x) : compactTick(x)
}

/** The table view: one row per x on the chart, one column per series. */
export function areaLineTable(p: AreaLineProps): TableData {
  const formatY = p.formatY ?? fmtYDefault
  const xs = [...new Set(p.series.flatMap((s) => s.points.map((q) => q.x)))].sort((a, b) => a - b)
  const maps = p.series.map((s) => new Map(s.points.map((q) => [q.x, q.y])))
  return {
    columns: [{ key: 'x', label: p.xLabel ?? ((p.xKind ?? 'time') === 'time' ? 'Time (UTC)' : 'X') }, ...p.series.map((s) => ({ key: s.id, label: s.label, align: 'end' as const }))],
    rows: xs.map((x) => [xText(p, x), ...maps.map((mp) => (mp.has(x) ? formatY(mp.get(x) as number) : '—'))]),
  }
}

/** One sentence for the aria-label: count, span, last, low, high. */
export function areaLineSummary(p: AreaLineProps): string {
  const formatY = p.formatY ?? fmtYDefault
  const parts = p.series.map((s) => {
    const e = extent(s.points.map((q) => q.y))
    const first = s.points[0]
    const last = s.points[s.points.length - 1]
    if (e === null || first === undefined || last === undefined) return `${s.label}: no points`
    return `${s.label}: ${s.points.length} points from ${xText(p, first.x)} to ${xText(p, last.x)}, last ${formatY(last.y)}, low ${formatY(e.min)}, high ${formatY(e.max)}`
  })
  return `${p.label}. ${parts.join('. ')}.`
}

export function AreaLine(props: AreaLineProps) {
  const view = useChartView()
  const { ref, width, height } = useSize<HTMLDivElement>()
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const formatY = props.formatY ?? fmtYDefault
  const min = props.minPoints ?? 2
  const longest = Math.max(0, ...props.series.map((s) => s.points.length))
  if (props.series.length > 2) throw new RangeError('AreaLine draws one or two series')
  if (longest < min) return <ChartEmpty title={notEnough(longest, props.noun ?? 'points', props.nounOne)} />
  if (view === 'table') return <ChartTable data={areaLineTable(props)} caption={props.label} />

  const g = areaLineGeometry(props, width, height)
  const ax = active !== null ? g.xsData[active] : undefined
  const at = ax === undefined ? [] : props.series.map((s) => s.points.find((q) => q.x === ax))
  const tip =
    ax === undefined ? null : (
      <>
        <span className="ck-tip__head">{xText(props, ax)}</span>
        {props.series.map((s, i) => {
          const q = at[i]
          return <TipRow key={s.id} color={seriesColor(i)} value={q ? formatY(q.y) : '—'} label={s.label} />
        })}
      </>
    )
  const readout = ax === undefined ? null : `${xText(props, ax)}: ${props.series.map((s, i) => `${s.label} ${at[i] ? formatY((at[i] as XYPoint).y) : 'no value'}`).join(', ')}`
  const drawT = { duration: DRAW_S, ease: EASE }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Plot
          sizeRef={ref}
          summary={areaLineSummary(props)}
          count={g.xsData.length}
          positions={g.xsPx}
          active={active}
          onActive={setActive}
          readout={readout}
          tip={tip}
          tipX={ax === undefined ? null : g.px(ax)}
          width={width}
        >
          <svg ref={reveal.ref} width={width} height={height} aria-hidden="true">
            <g className="ck-axis">
              {g.yTicks.map((t) => (
                <g key={`y${t.y}`}>
                  <line className="ck-gridline" x1={g.margin.left} x2={width - g.margin.right} y1={t.y} y2={t.y} />
                  <text x={g.margin.left - 8} y={t.y} dy="0.32em" textAnchor="end">
                    {t.label}
                  </text>
                </g>
              ))}
              {g.xTicks.map((t, i) => (
                <text key={`x${i}`} x={t.x} y={height - 6} textAnchor="middle">
                  {t.label}
                </text>
              ))}
            </g>
            {g.areas.map((d, i) =>
              d === null ? null : (
                <m.path
                  key={`a${i}`}
                  className="ck-area"
                  d={d}
                  fill={seriesColor(i)}
                  initial={reveal.armed ? { opacity: 0 } : false}
                  animate={{ opacity: reveal.play ? 0.1 : 0 }}
                  transition={{ duration: 0.8, delay: reveal.armed ? DRAW_S * 0.6 : 0, ease: EASE }}
                />
              ),
            )}
            {g.lines.map((d, i) => (
              <m.path
                key={`l${i}`}
                className="ck-line"
                d={d}
                stroke={seriesColor(i)}
                initial={reveal.armed ? { pathLength: 0 } : false}
                animate={{ pathLength: reveal.play ? 1 : 0 }}
                transition={{ ...drawT, delay: i * 0.07 }}
              />
            ))}
            {ax !== undefined ? (
              <g>
                <line className="ck-cross" x1={g.px(ax)} x2={g.px(ax)} y1={g.margin.top} y2={height - g.margin.bottom} />
                {at.map((q, i) => (q ? <circle key={i} className="ck-dot" cx={g.px(q.x)} cy={g.py(q.y)} r={4} fill={seriesColor(i)} /> : null))}
              </g>
            ) : null}
          </svg>
        </Plot>
      </div>
      <Legend items={props.series.map((s, i) => ({ label: s.label, color: seriesColor(i), kind: 'line' }))} />
    </div>
  )
}
