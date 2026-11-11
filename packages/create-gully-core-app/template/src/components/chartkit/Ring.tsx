// SPDX-License-Identifier: MIT
/* ============================================================================
   Ring — a share or a composition in one to four parts (a lock's split, the
   two sides of a position, holder concentration). Segments keep the
   categorical order, never re-sorted by size, so a part keeps its colour
   when the numbers move. 2px surface gaps between segments; the ring sweeps
   in clockwise from twelve o'clock on reveal. The legend carries each part's
   value and share, so identity is never colour alone.
   ============================================================================ */

import { useId, useState } from 'react'
import { m } from 'motion/react'
import { arc as d3arc, pie as d3pie, type PieArcDatum } from 'd3-shape'

import { DRAW_S, EASE, compactTick, seriesColor, sharePct } from './core'
import { ChartEmpty, ChartTable, Legend, Plot, TipRow, useChartView, type TableData } from './frame'
import { useReveal, useSize } from './runtime'

export interface RingSegment {
  readonly key: string
  readonly label: string
  readonly value: number
}

export interface RingProps {
  /** One to four parts, in a FIXED order (colour follows the part). */
  readonly segments: readonly RingSegment[]
  readonly label: string
  readonly formatValue?: (n: number) => string
  /** The small caption in the hole; the formatted total is the figure above it unless `centerValue` is given. */
  readonly centerLabel?: string
  readonly centerValue?: string
  readonly emptyTitle?: string
}

export interface RingGeometry {
  readonly cx: number
  readonly cy: number
  readonly r0: number
  readonly r1: number
  readonly arcs: readonly { d: string; centroid: [number, number]; start: number; end: number }[]
}

/** Pure geometry: one arc per segment (zero-value parts get an empty path), 2px gaps. */
export function ringGeometry(segments: readonly RingSegment[], size: number): RingGeometry {
  const r1 = Math.max(10, size / 2 - 4)
  const r0 = r1 * 0.68
  const mid = (r0 + r1) / 2
  const live = segments.filter((s) => s.value > 0).length
  const pad = live > 1 ? 2 / mid : 0
  const pie = d3pie<RingSegment>()
    .sort(null)
    .value((s) => Math.max(0, s.value))
    .padAngle(pad)
  const arcGen = d3arc<PieArcDatum<RingSegment>>()
    .innerRadius(r0)
    .outerRadius(r1)
    .cornerRadius(live > 1 ? 2 : 0)
  const arcs = pie(segments as RingSegment[]).map((a) => ({
    d: a.value > 0 ? (arcGen(a) ?? '') : '',
    centroid: arcGen.centroid(a) as [number, number],
    start: a.startAngle,
    end: a.endAngle,
  }))
  return { cx: size / 2, cy: size / 2, r0, r1, arcs }
}

export function ringTable(p: RingProps): TableData {
  const f = p.formatValue ?? compactTick
  const total = p.segments.reduce((t, s) => t + Math.max(0, s.value), 0)
  return {
    columns: [
      { key: 'p', label: 'Part' },
      { key: 'v', label: 'Value', align: 'end' },
      { key: 's', label: 'Share', align: 'end' },
    ],
    rows: p.segments.map((s) => [s.label, f(s.value), sharePct(s.value, total)]),
  }
}

export function ringSummary(p: RingProps): string {
  const f = p.formatValue ?? compactTick
  const total = p.segments.reduce((t, s) => t + Math.max(0, s.value), 0)
  return `${p.label}. ${p.segments.map((s) => `${s.label} ${f(s.value)} (${sharePct(s.value, total)})`).join(', ')}. Total ${f(total)}.`
}

export function Ring(props: RingProps) {
  const view = useChartView()
  const { ref, width, height } = useSize<HTMLDivElement>(320, 200)
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const maskId = `ck-ring-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const f = props.formatValue ?? compactTick
  if (props.segments.length > 4) throw new RangeError('Ring draws one to four parts; fold the rest into "Other"')
  const total = props.segments.reduce((t, s) => t + Math.max(0, s.value), 0)
  if (props.segments.length === 0 || !(total > 0)) return <ChartEmpty title={props.emptyTitle ?? 'Nothing to share out yet'} />
  if (view === 'table') return <ChartTable data={ringTable(props)} caption={props.label} />

  const size = Math.max(60, Math.min(height, width))
  const g = ringGeometry(props.segments, size)
  const ox = (width - size) / 2
  const a = active !== null ? props.segments[active] : undefined
  const ca = active !== null ? g.arcs[active] : undefined
  const mid = (g.r0 + g.r1) / 2
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Plot
          sizeRef={ref}
          summary={ringSummary(props)}
          count={props.segments.length}
          positions={[]}
          active={active}
          onActive={setActive}
          readout={a ? `${a.label}: ${f(a.value)}, ${sharePct(a.value, total)}` : null}
          tip={a ? <TipRow color={seriesColor(active as number)} value={`${f(a.value)} · ${sharePct(a.value, total)}`} label={a.label} /> : null}
          tipX={ca ? ox + g.cx + ca.centroid[0] : null}
          width={width}
        >
          <svg ref={reveal.ref} width={width} height={height} aria-hidden="true">
            <defs>
              <mask id={maskId}>
                <m.circle
                  cx={g.cx}
                  cy={g.cy}
                  r={mid}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={g.r1 - g.r0 + 6}
                  transform={`rotate(-90 ${g.cx} ${g.cy})`}
                  initial={reveal.armed ? { pathLength: 0 } : false}
                  animate={{ pathLength: reveal.play ? 1 : 0 }}
                  transition={{ duration: DRAW_S * 0.8, ease: EASE }}
                />
              </mask>
            </defs>
            <g transform={`translate(${ox},${(height - size) / 2})`}>
              <g mask={reveal.armed ? `url(#${maskId})` : undefined}>
                <g transform={`translate(${g.cx},${g.cy})`}>
                  {g.arcs.map((arc, i) => (
                    <path
                      key={props.segments[i]?.key ?? i}
                      className="ck-mark"
                      data-on={active === i}
                      d={arc.d}
                      fill={seriesColor(i)}
                      onPointerEnter={() => setActive(i)}
                      onPointerDown={() => setActive(i)}
                    />
                  ))}
                </g>
              </g>
              <text x={g.cx} y={g.cy - 2} textAnchor="middle" style={{ font: '600 18px var(--dc-font-display, sans-serif)', fill: 'var(--ink)' }}>
                {props.centerValue ?? f(total)}
              </text>
              {props.centerLabel ? (
                <text x={g.cx} y={g.cy + 16} textAnchor="middle" className="ck-axis-label">
                  {props.centerLabel}
                </text>
              ) : null}
            </g>
          </svg>
        </Plot>
      </div>
      <Legend items={props.segments.map((s, i) => ({ label: s.label, color: seriesColor(i), value: `${f(s.value)} · ${sharePct(s.value, total)}` }))} />
    </div>
  )
}
