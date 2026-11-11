// SPDX-License-Identifier: MIT
/* ============================================================================
   Bars and DivergingBars — magnitude per bucket (launches per day, volume per
   hour) and polarity per bucket (buys above the baseline, sells below it).
   Columns are at most 24px thick, 4px rounded at the data end and square at
   the baseline, and rise from the baseline on reveal.
   ============================================================================ */

import { useState } from 'react'
import { m } from 'motion/react'
import { scaleBand, scaleLinear } from 'd3-scale'

import { BARUP_S, DOWN_COLOR, EASE, STAGGER_S, UP_COLOR, compactTick, notEnough, seriesColor } from './core'
import { ChartEmpty, ChartTable, Legend, Plot, TipRow, useChartView, type TableData } from './frame'
import { useReveal, useSize } from './runtime'

/** A column from `base` to `end` (either direction), `w` wide, rounded `r` at the data end only. */
export function roundedBar(x: number, base: number, end: number, w: number, r = 4): string {
  const h = Math.abs(end - base)
  if (h === 0 || w <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  if (end < base) {
    /* grows up: rounded top */
    return `M${x},${base}V${end + rr}Q${x},${end} ${x + rr},${end}H${x + w - rr}Q${x + w},${end} ${x + w},${end + rr}V${base}Z`
  }
  /* grows down: rounded bottom */
  return `M${x},${base}V${end - rr}Q${x},${end} ${x + rr},${end}H${x + w - rr}Q${x + w},${end} ${x + w},${end - rr}V${base}Z`
}

/** The delay of bar i of n: 70 ms apart, the whole run inside half a second. */
export function barDelay(i: number, n: number): number {
  return Math.min(i * STAGGER_S, n > 1 ? (i / (n - 1)) * 0.5 : 0)
}

interface BandGeometry {
  readonly margin: { top: number; right: number; bottom: number; left: number }
  readonly centers: readonly number[]
  readonly barW: number
  readonly yTicks: readonly { y: number; label: string }[]
  readonly xLabels: readonly { x: number; label: string }[]
  readonly py: (v: number) => number
}

function bandGeometry(keys: readonly string[], labels: readonly string[], lo: number, hi: number, width: number, height: number, tick: (n: number) => string): BandGeometry {
  const yScale = scaleLinear().domain([lo, hi]).nice(4)
  const ticks = yScale.ticks(4)
  const tickLabels = ticks.map(tick)
  const left = Math.min(96, Math.max(28, Math.max(...tickLabels.map((s) => s.length)) * 6.2 + 10))
  const margin = { top: 10, right: 6, bottom: 22, left }
  const innerW = Math.max(10, width - margin.left - margin.right)
  const innerH = Math.max(10, height - margin.top - margin.bottom)
  yScale.range([margin.top + innerH, margin.top])
  const band = scaleBand<string>().domain(keys).range([margin.left, margin.left + innerW]).paddingInner(0.25).paddingOuter(0.15)
  const barW = Math.max(1, Math.min(24, band.bandwidth()))
  const centers = keys.map((k) => (band(k) ?? 0) + band.bandwidth() / 2)
  const every = Math.max(1, Math.ceil(keys.length / Math.max(1, Math.floor(innerW / 64))))
  const xLabels = keys.flatMap((_, i) => (i % every === 0 ? [{ x: centers[i] as number, label: labels[i] ?? '' }] : []))
  return { margin, centers, barW, yTicks: ticks.map((v, i) => ({ y: yScale(v), label: tickLabels[i] ?? '' })), xLabels, py: (v) => yScale(v) }
}

/* ================================================================= Bars ==== */

export interface BarDatum {
  readonly key: string
  /** The bucket as the reader names it ("Oct 11", "14:00"). */
  readonly label: string
  readonly value: number
}

export interface BarsProps {
  readonly data: readonly BarDatum[]
  readonly label: string
  readonly formatValue?: (n: number) => string
  /** Table column titles. */
  readonly keyLabel?: string
  readonly valueLabel?: string
  /** Series slot (0–3), default 0. */
  readonly slot?: number
  readonly minPoints?: number
  readonly noun?: string
  readonly nounOne?: string
}

export function barsTable(p: BarsProps): TableData {
  const f = p.formatValue ?? compactTick
  return {
    columns: [
      { key: 'k', label: p.keyLabel ?? 'Bucket' },
      { key: 'v', label: p.valueLabel ?? 'Value', align: 'end' },
    ],
    rows: p.data.map((d) => [d.label, f(d.value)]),
  }
}

export function barsSummary(p: BarsProps): string {
  const f = p.formatValue ?? compactTick
  if (p.data.length === 0) return `${p.label}. No buckets.`
  let hi = p.data[0] as BarDatum
  let total = 0
  for (const d of p.data) {
    total += d.value
    if (d.value > hi.value) hi = d
  }
  return `${p.label}. ${p.data.length} buckets from ${p.data[0]?.label} to ${p.data[p.data.length - 1]?.label}, total ${f(total)}, highest ${f(hi.value)} at ${hi.label}.`
}

export function Bars(props: BarsProps) {
  const view = useChartView()
  const { ref, width, height } = useSize<HTMLDivElement>()
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const f = props.formatValue ?? compactTick
  if (props.data.length < (props.minPoints ?? 1)) return <ChartEmpty title={notEnough(props.data.length, props.noun ?? 'buckets', props.nounOne)} />
  if (view === 'table') return <ChartTable data={barsTable(props)} caption={props.label} />
  if (props.data.some((d) => d.value < 0)) throw new RangeError('Bars draws non-negative values; use DivergingBars for signed data')
  const max = Math.max(0, ...props.data.map((d) => d.value))
  const g = bandGeometry(
    props.data.map((d) => d.key),
    props.data.map((d) => d.label),
    0,
    max === 0 ? 1 : max,
    width,
    height,
    f,
  )
  const base = g.py(0)
  const color = seriesColor(props.slot ?? 0)
  const a = active !== null ? props.data[active] : undefined
  return (
    <Plot
      sizeRef={ref}
      summary={barsSummary(props)}
      count={props.data.length}
      positions={g.centers}
      active={active}
      onActive={setActive}
      readout={a ? `${a.label}: ${f(a.value)}` : null}
      tip={
        a ? (
          <>
            <span className="ck-tip__head">{a.label}</span>
            <TipRow color={color} value={f(a.value)} label={props.valueLabel ?? props.label} />
          </>
        ) : null
      }
      tipX={active !== null ? (g.centers[active] ?? null) : null}
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
          {g.xLabels.map((t, i) => (
            <text key={`x${i}`} x={t.x} y={height - 6} textAnchor="middle">
              {t.label}
            </text>
          ))}
        </g>
        {props.data.map((d, i) => {
          const cx = g.centers[i] as number
          return (
            <m.path
              key={d.key}
              className="ck-mark"
              data-on={active === i}
              d={roundedBar(cx - g.barW / 2, base, g.py(d.value), g.barW)}
              fill={color}
              style={{ transformBox: 'fill-box', originY: 1 }}
              initial={reveal.armed ? { scaleY: 0 } : false}
              animate={{ scaleY: reveal.play ? 1 : 0 }}
              transition={{ duration: BARUP_S, ease: EASE, delay: barDelay(i, props.data.length) }}
            />
          )
        })}
        <line className="ck-baseline" x1={g.margin.left} x2={width - g.margin.right} y1={base} y2={base} />
      </svg>
    </Plot>
  )
}

/* ======================================================== DivergingBars ==== */

export interface DivergingDatum {
  readonly key: string
  readonly label: string
  /** Drawn above the baseline (buys). Non-negative. */
  readonly up: number
  /** Drawn below the baseline (sells). Non-negative; the chart flips it. */
  readonly down: number
}

export interface DivergingBarsProps {
  readonly data: readonly DivergingDatum[]
  readonly label: string
  readonly upLabel?: string
  readonly downLabel?: string
  readonly formatValue?: (n: number) => string
  readonly keyLabel?: string
  readonly minPoints?: number
  readonly noun?: string
  readonly nounOne?: string
}

export function divergingTable(p: DivergingBarsProps): TableData {
  const f = p.formatValue ?? compactTick
  return {
    columns: [
      { key: 'k', label: p.keyLabel ?? 'Bucket' },
      { key: 'u', label: p.upLabel ?? 'Buys', align: 'end' },
      { key: 'd', label: p.downLabel ?? 'Sells', align: 'end' },
    ],
    rows: p.data.map((d) => [d.label, f(d.up), f(d.down)]),
  }
}

export function divergingSummary(p: DivergingBarsProps): string {
  const f = p.formatValue ?? compactTick
  let up = 0
  let down = 0
  for (const d of p.data) {
    up += d.up
    down += d.down
  }
  return `${p.label}. ${p.data.length} buckets, ${p.upLabel ?? 'Buys'} ${f(up)} in total, ${p.downLabel ?? 'Sells'} ${f(down)} in total.`
}

export function DivergingBars(props: DivergingBarsProps) {
  const view = useChartView()
  const { ref, width, height } = useSize<HTMLDivElement>()
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const f = props.formatValue ?? compactTick
  const upLabel = props.upLabel ?? 'Buys'
  const downLabel = props.downLabel ?? 'Sells'
  if (props.data.length < (props.minPoints ?? 1)) return <ChartEmpty title={notEnough(props.data.length, props.noun ?? 'buckets', props.nounOne)} />
  if (view === 'table') return <ChartTable data={divergingTable(props)} caption={props.label} />
  if (props.data.some((d) => d.up < 0 || d.down < 0)) throw new RangeError('DivergingBars takes non-negative up and down values')
  const hi = Math.max(0, ...props.data.map((d) => d.up))
  const lo = Math.max(0, ...props.data.map((d) => d.down))
  const g = bandGeometry(
    props.data.map((d) => d.key),
    props.data.map((d) => d.label),
    lo === 0 && hi === 0 ? -1 : -lo,
    hi === 0 && lo === 0 ? 1 : hi,
    width,
    height,
    (n) => f(Math.abs(n)),
  )
  const base = g.py(0)
  const a = active !== null ? props.data[active] : undefined
  const n = props.data.length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Plot
          sizeRef={ref}
          summary={divergingSummary(props)}
          count={n}
          positions={g.centers}
          active={active}
          onActive={setActive}
          readout={a ? `${a.label}: ${upLabel} ${f(a.up)}, ${downLabel} ${f(a.down)}` : null}
          tip={
            a ? (
              <>
                <span className="ck-tip__head">{a.label}</span>
                <TipRow color={UP_COLOR} value={f(a.up)} label={upLabel} />
                <TipRow color={DOWN_COLOR} value={f(a.down)} label={downLabel} />
              </>
            ) : null
          }
          tipX={active !== null ? (g.centers[active] ?? null) : null}
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
              {g.xLabels.map((t, i) => (
                <text key={`x${i}`} x={t.x} y={height - 6} textAnchor="middle">
                  {t.label}
                </text>
              ))}
            </g>
            {props.data.map((d, i) => {
              const x = (g.centers[i] as number) - g.barW / 2
              const t = { duration: BARUP_S, ease: EASE, delay: barDelay(i, n) }
              return (
                <g key={d.key} className="ck-mark" data-on={active === i}>
                  <m.path
                    d={d.up > 0 ? roundedBar(x, base - 1, Math.min(base - 1, g.py(d.up)), g.barW) : ''}
                    fill={UP_COLOR}
                    style={{ transformBox: 'fill-box', originY: 1 }}
                    initial={reveal.armed ? { scaleY: 0 } : false}
                    animate={{ scaleY: reveal.play ? 1 : 0 }}
                    transition={t}
                  />
                  <m.path
                    d={d.down > 0 ? roundedBar(x, base + 1, Math.max(base + 1, g.py(-d.down)), g.barW) : ''}
                    fill={DOWN_COLOR}
                    style={{ transformBox: 'fill-box', originY: 0 }}
                    initial={reveal.armed ? { scaleY: 0 } : false}
                    animate={{ scaleY: reveal.play ? 1 : 0 }}
                    transition={t}
                  />
                </g>
              )
            })}
            <line className="ck-baseline" x1={g.margin.left} x2={width - g.margin.right} y1={base} y2={base} />
          </svg>
        </Plot>
      </div>
      <Legend
        items={[
          { label: upLabel, color: UP_COLOR },
          { label: downLabel, color: DOWN_COLOR },
        ]}
      />
    </div>
  )
}
