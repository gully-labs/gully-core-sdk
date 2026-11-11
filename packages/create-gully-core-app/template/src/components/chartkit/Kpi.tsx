// SPDX-License-Identifier: MIT
/* ============================================================================
   Sparkline, KpiTile and ChartGrid.

   A sparkline is a trend beside a number, not a chart: no axis, no hover,
   one aria-label sentence. A KPI tile is one headline figure that counts up
   on a spring when it scrolls in, with an optional signed change (glyph AND
   colour) and an optional sparkline; with `href` the whole tile links to the
   figure's detail. ChartGrid lays out the KPI row and the even chart grid.
   ============================================================================ */

import { useEffect, useRef, type ReactNode } from 'react'
import { m, useMotionValueEvent, useSpring } from 'motion/react'
import { scaleLinear } from 'd3-scale'
import { line as d3line, curveMonotoneX } from 'd3-shape'

import { DOWN_COLOR, DRAW_S, EASE, UP_COLOR, compactTick, extent, seriesColor, signedPct } from './core'
import { Kit, useReveal } from './runtime'

/* ============================================================ Sparkline ==== */

export interface SparklineProps {
  readonly values: readonly number[]
  /** What the trend is: "Price, last 24h". */
  readonly label: string
  readonly width?: number
  readonly height?: number
  /** up / down colour the line by polarity; auto picks by last vs first; neutral is the first series colour. */
  readonly tone?: 'neutral' | 'up' | 'down' | 'auto'
  readonly format?: (n: number) => string
}

/** The sparkline's path in a w × h box, 2px inset. Empty under two points. */
export function sparkPath(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return ''
  const e = extent(values) ?? { min: 0, max: 1 }
  const y = scaleLinear()
    .domain(e.min === e.max ? [e.min - 1, e.max + 1] : [e.min, e.max])
    .range([h - 2, 2])
  const x = scaleLinear()
    .domain([0, values.length - 1])
    .range([2, w - 2])
  return (
    d3line<number>()
      .x((_, i) => x(i))
      .y((v) => y(v))
      .curve(curveMonotoneX)(values as number[]) ?? ''
  )
}

export function Sparkline({ values, label, width = 90, height = 26, tone = 'neutral', format = compactTick }: SparklineProps) {
  const reveal = useReveal()
  const first = values[0]
  const last = values[values.length - 1]
  const t = tone === 'auto' ? (first !== undefined && last !== undefined && last < first ? 'down' : 'up') : tone
  const color = t === 'up' ? UP_COLOR : t === 'down' ? DOWN_COLOR : seriesColor(0)
  const d = sparkPath(values, width, height)
  const summary = values.length < 2 ? `${label}: not enough points for a trend` : `${label}: ${values.length} points, from ${format(first as number)} to ${format(last as number)}`
  return (
    <Kit>
      <svg ref={reveal.ref} className="ck-spark" width={width} height={height} role="img" aria-label={summary}>
        {d !== '' ? (
          <m.path
            className="ck-line"
            d={d}
            stroke={color}
            style={{ strokeWidth: 1.5 }}
            initial={reveal.armed ? { pathLength: 0 } : false}
            animate={{ pathLength: reveal.play ? 1 : 0 }}
            transition={{ duration: DRAW_S, ease: EASE }}
          />
        ) : null}
      </svg>
    </Kit>
  )
}

/* ============================================================== KpiTile ==== */

export interface KpiTileProps {
  readonly label: string
  /** null = not read (renders "—"). */
  readonly value: number | null
  readonly format?: (n: number) => string
  /** The unit or the source in one line: "WETH · summed from logs since block N". */
  readonly caption?: ReactNode
  /** A ratio (0.125 = +12.5%), shown with ▲ / ▼. */
  readonly delta?: number | null
  readonly deltaLabel?: string
  readonly spark?: readonly number[]
  readonly sparkTone?: SparklineProps['tone']
  /** The figure's detail page: the whole tile becomes the link. */
  readonly href?: string
  readonly state?: 'ready' | 'loading' | 'error'
}

/** The spring that drives the count-up: settles within ~1 s, rests to a tolerance relative to the target. */
export function countSpring(target: number) {
  return { stiffness: 70, damping: 20, mass: 1, restDelta: Math.max(Math.abs(target) * 1e-4, Number.MIN_VALUE) }
}

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const reveal = useReveal()
  const text = useRef<HTMLSpanElement | null>(null)
  const mv = useSpring(reveal.armed ? 0 : value, countSpring(value))
  useMotionValueEvent(mv, 'change', (v) => {
    if (text.current !== null) text.current.textContent = format(v)
  })
  useMotionValueEvent(mv, 'animationComplete', () => {
    if (text.current !== null) text.current.textContent = format(value)
  })
  useEffect(() => {
    if (!reveal.play) return
    if (!reveal.armed) {
      mv.jump(value)
      if (text.current !== null) text.current.textContent = format(value)
      return
    }
    if (text.current !== null) text.current.textContent = format(mv.get())
    mv.set(value)
  }, [reveal.play, reveal.armed, value, mv, format])
  return (
    <span ref={reveal.ref}>
      <span ref={text} aria-hidden="true" style={{ opacity: reveal.armed && !reveal.play ? 0 : 1 }}>
        {format(value)}
      </span>
      <span className="ck-sr">{format(value)}</span>
    </span>
  )
}

export function KpiTile({ label, value, format = compactTick, caption, delta, deltaLabel, spark, sparkTone = 'auto', href, state = 'ready' }: KpiTileProps) {
  const d = delta !== undefined && delta !== null ? signedPct(delta) : null
  const body = (
    <>
      <span className="dc-kpi__label">{label.toUpperCase()}</span>
      <span className="dc-kpi__row">
        <span className="dc-kpi__value">
          {state === 'loading' ? <span className="ck-kpi__skel" role="status" aria-label="Reading the chain" /> : state === 'error' || value === null ? '—' : <CountUp value={value} format={format} />}
        </span>
        {spark !== undefined && spark.length >= 2 && state === 'ready' ? (
          <span className="dc-kpi__spark">
            <Sparkline values={spark} label={label} tone={sparkTone} format={format} />
          </span>
        ) : null}
      </span>
      {state === 'error' ? (
        <span className="dc-kpi__caption">Couldn’t read the chain</span>
      ) : d !== null || caption !== undefined ? (
        <span className="dc-kpi__caption">
          {d !== null ? (
            <span className="ck-kpi__delta" data-dir={d.dir}>
              {d.text}
              {deltaLabel ? ` ${deltaLabel}` : ''}
            </span>
          ) : null}
          {d !== null && caption !== undefined ? ' · ' : null}
          {caption}
        </span>
      ) : null}
    </>
  )
  return (
    <Kit>
      {href !== undefined ? (
        <a className="dc-kpi ck-kpi" href={href}>
          {body}
        </a>
      ) : (
        <div className="dc-kpi ck-kpi">{body}</div>
      )}
    </Kit>
  )
}

/* ============================================================ ChartGrid ==== */

/** The one even grid: an optional KPI row, then chart cards in equal columns (3 / 2 / 1 by width) and equal heights. */
export function ChartGrid({ kpis, children, className }: { kpis?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`ck-grid${className ? ` ${className}` : ''}`}>
      {kpis !== undefined ? <div className="ck-grid__kpis">{kpis}</div> : null}
      <div className="ck-grid__cards">{children}</div>
    </div>
  )
}
