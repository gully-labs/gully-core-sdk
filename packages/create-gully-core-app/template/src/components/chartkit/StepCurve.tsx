// SPDX-License-Identifier: MIT
/* ============================================================================
   StepCurve — a schedule: cumulative amount unlocked (vested, released) at
   each step, held flat until the next. A vertical "NOW" marker shows where
   the chain clock is and a dot marks the amount unlocked at that moment.
   ============================================================================ */

import { useState } from 'react'
import { m } from 'motion/react'
import { scaleLinear, scaleUtc } from 'd3-scale'
import { area as d3area, curveStepAfter, line as d3line } from 'd3-shape'

import { DRAW_S, EASE, compactTick, notEnough, seriesColor, timeFull, timeTick } from './core'
import { ChartEmpty, ChartTable, Plot, TipRow, useChartView, type TableData } from './frame'
import { useReveal, useSize } from './runtime'

export interface Step {
  /** Unix seconds. Ascending. */
  readonly t: number
  /** Cumulative amount unlocked from `t` on. */
  readonly value: number
}

export interface StepCurveProps {
  readonly steps: readonly Step[]
  /** The chain's clock (block timestamp), unix seconds. */
  readonly now: number
  readonly label: string
  readonly formatValue?: (n: number) => string
  /** Top of the y axis (the whole lock); default the last step. */
  readonly total?: number
  readonly valueLabel?: string
  readonly minPoints?: number
}

/** The amount unlocked at `t`: the last step at or before it, 0 before the first. */
export function unlockedAt(steps: readonly Step[], t: number): number {
  let v = 0
  for (const s of steps) {
    if (s.t <= t) v = s.value
    else break
  }
  return v
}

export function stepCurveGeometry(p: StepCurveProps, width: number, height: number) {
  const f = p.formatValue ?? compactTick
  const t0 = Math.min(p.steps[0]?.t ?? p.now, p.now)
  const t1 = Math.max(p.steps[p.steps.length - 1]?.t ?? p.now, p.now)
  const top = Math.max(p.total ?? 0, ...p.steps.map((s) => s.value), 1)
  const yScale = scaleLinear().domain([0, top]).nice(4)
  const ticks = yScale.ticks(4)
  const labels = ticks.map(f)
  const left = Math.min(96, Math.max(28, Math.max(...labels.map((s) => s.length)) * 6.2 + 10))
  const margin = { top: 18, right: 12, bottom: 22, left }
  const innerW = Math.max(10, width - margin.left - margin.right)
  const innerH = Math.max(10, height - margin.top - margin.bottom)
  yScale.range([margin.top + innerH, margin.top])
  const x = scaleUtc()
    .domain([new Date(t0 * 1000), new Date((t1 === t0 ? t0 + 1 : t1) * 1000)])
    .range([margin.left, margin.left + innerW])
  const px = (t: number) => x(new Date(t * 1000))
  const py = (v: number) => yScale(v)
  /* The path runs from the start of the axis at 0 (or the first step), through every step, to the end of the axis. */
  const pts: Step[] = []
  if ((p.steps[0]?.t ?? t0) > t0) pts.push({ t: t0, value: 0 })
  pts.push(...p.steps)
  const last = pts[pts.length - 1]
  if (last !== undefined && last.t < t1) pts.push({ t: t1, value: last.value })
  const lineGen = d3line<Step>()
    .x((s) => px(s.t))
    .y((s) => py(s.value))
    .curve(curveStepAfter)
  const areaGen = d3area<Step>()
    .x((s) => px(s.t))
    .y0(py(0))
    .y1((s) => py(s.value))
    .curve(curveStepAfter)
  return {
    margin,
    px,
    py,
    line: lineGen(pts) ?? '',
    area: areaGen(pts) ?? '',
    xsPx: p.steps.map((s) => px(s.t)),
    yTicks: ticks.map((v, i) => ({ y: yScale(v), label: labels[i] ?? '' })),
    xTicks: x.ticks(Math.max(2, Math.floor(innerW / 90))).map((d) => ({ x: x(d), label: timeTick(d.getTime() / 1000, t1 - t0) })),
  }
}

export function stepCurveTable(p: StepCurveProps): TableData {
  const f = p.formatValue ?? compactTick
  return {
    columns: [
      { key: 't', label: 'Time (UTC)' },
      { key: 'v', label: p.valueLabel ?? 'Unlocked', align: 'end' },
      { key: 's', label: 'Status' },
    ],
    rows: p.steps.map((s) => [timeFull(s.t), f(s.value), s.t <= p.now ? 'Unlocked' : 'Scheduled']),
  }
}

export function stepCurveSummary(p: StepCurveProps): string {
  const f = p.formatValue ?? compactTick
  const last = p.steps[p.steps.length - 1]
  const next = p.steps.find((s) => s.t > p.now)
  return `${p.label}. ${p.steps.length} steps, ${f(unlockedAt(p.steps, p.now))} unlocked now of ${f(p.total ?? last?.value ?? 0)}${next ? `, next ${f(next.value)} at ${timeFull(next.t)}` : ', fully unlocked'}.`
}

export function StepCurve(props: StepCurveProps) {
  const view = useChartView()
  const { ref, width, height } = useSize<HTMLDivElement>()
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const f = props.formatValue ?? compactTick
  if (props.steps.length < (props.minPoints ?? 1)) return <ChartEmpty title={notEnough(props.steps.length, 'steps', 'step')} />
  if (view === 'table') return <ChartTable data={stepCurveTable(props)} caption={props.label} />
  const g = stepCurveGeometry(props, width, height)
  const color = seriesColor(0)
  const nowX = g.px(props.now)
  const nowV = unlockedAt(props.steps, props.now)
  const a = active !== null ? props.steps[active] : undefined
  return (
    <Plot
      sizeRef={ref}
      summary={stepCurveSummary(props)}
      count={props.steps.length}
      positions={g.xsPx}
      active={active}
      onActive={setActive}
      readout={a ? `${timeFull(a.t)}: ${f(a.value)} ${a.t <= props.now ? 'unlocked' : 'scheduled'}` : null}
      tip={
        a ? (
          <>
            <span className="ck-tip__head">{timeFull(a.t)}</span>
            <TipRow color={color} value={f(a.value)} label={a.t <= props.now ? 'Unlocked' : 'Scheduled'} />
          </>
        ) : null
      }
      tipX={a ? g.px(a.t) : null}
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
        <m.path
          className="ck-area"
          d={g.area}
          fill={color}
          initial={reveal.armed ? { opacity: 0 } : false}
          animate={{ opacity: reveal.play ? 0.1 : 0 }}
          transition={{ duration: 0.8, delay: reveal.armed ? DRAW_S * 0.6 : 0, ease: EASE }}
        />
        <m.path
          className="ck-line"
          d={g.line}
          stroke={color}
          initial={reveal.armed ? { pathLength: 0 } : false}
          animate={{ pathLength: reveal.play ? 1 : 0 }}
          transition={{ duration: DRAW_S, ease: EASE }}
        />
        <line className="ck-now" x1={nowX} x2={nowX} y1={g.margin.top - 4} y2={height - g.margin.bottom} />
        <text className="ck-now-label" x={nowX} y={g.margin.top - 8} textAnchor={nowX > width - 40 ? 'end' : 'middle'}>
          NOW
        </text>
        <circle className="ck-dot" cx={nowX} cy={g.py(nowV)} r={4} fill={color} />
        {a ? (
          <g>
            <line className="ck-cross" x1={g.px(a.t)} x2={g.px(a.t)} y1={g.margin.top} y2={height - g.margin.bottom} />
            <circle className="ck-dot" cx={g.px(a.t)} cy={g.py(a.value)} r={4} fill={color} />
          </g>
        ) : null}
      </svg>
    </Plot>
  )
}
