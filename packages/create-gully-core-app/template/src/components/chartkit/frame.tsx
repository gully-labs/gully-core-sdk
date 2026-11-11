// SPDX-License-Identifier: MIT
/* ============================================================================
   Chart kit — the frame every chart shares: the card (title, Chart | Table,
   range chips, legend, provenance), the four honest states, the table view,
   the legend, and the focusable plot that owns the crosshair, the tooltip
   and the keyboard.

   Every label that reaches the DOM is rendered as a React text node, never
   as HTML: series and token names come from chains and APIs.
   ============================================================================ */

import { createContext, useContext, useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'

import { Kit } from './runtime'
import { nearestIndex, stepIndex } from './core'

/* ---------------------------------------------------------------- view ---- */

export type ChartView = 'chart' | 'table'
const ViewCtx = createContext<ChartView>('chart')

/** Which view the enclosing card shows. Outside a card: the chart. */
export function useChartView(): ChartView {
  return useContext(ViewCtx)
}

/* -------------------------------------------------------------- states ---- */

/** What the card's body shows instead of the chart. Empty is the chart's own (it knows its count). */
export type ChartState = 'ready' | 'loading' | { readonly error: string; readonly onRetry?: () => void } | { readonly soon: string }

/* A skeleton is not data: the bar heights are a fixed pattern, never derived from anything. */
const SKELETON = [38, 54, 46, 70, 58, 44, 62, 50, 76, 60, 48, 66]

export function ChartSkeleton({ label = 'Reading the chain' }: { label?: string }) {
  return (
    <div role="status" className="dc-skeleton dc-skeleton--pulse" aria-label={label}>
      {SKELETON.map((h, i) => (
        <span key={i} style={{ height: `${h}%` }} />
      ))}
    </div>
  )
}

/** The honest empty: a sentence and EMPTY, never a sample shape. */
export function ChartEmpty({ title, detail = 'EMPTY' }: { title: string; detail?: string }) {
  return (
    <div className="dc-state" data-ck-state="empty">
      <span className="dc-state__h">{title}</span>
      <span className="dc-state__s">{detail}</span>
    </div>
  )
}

/** "Couldn’t read the chain · ERROR · RETRY" (System sheet § Charts). The message rides in a data attribute and the title. */
export function ChartError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="dc-state dc-state--error" data-ck-state="error" data-error={message} title={message}>
      <span className="dc-state__h">Couldn’t read the chain</span>
      {onRetry ? (
        <button type="button" className="dc-retry" onClick={onRetry}>
          ERROR · RETRY
        </button>
      ) : (
        <span className="dc-state__s">ERROR · RETRY</span>
      )}
    </div>
  )
}

export function ChartSoon({ chain }: { chain: string }) {
  return (
    <div className="dc-state dc-state--soon" data-ck-state="soon">
      <span className="dc-state__k">COMING SOON</span>
      <span className="dc-state__h">On {chain}</span>
    </div>
  )
}

/* --------------------------------------------------------------- table ---- */

export interface TableColumn {
  readonly key: string
  readonly label: string
  readonly align?: 'start' | 'end'
}
export interface TableData {
  readonly columns: readonly TableColumn[]
  /** One row per chart mark, cells already formatted. */
  readonly rows: readonly (readonly string[])[]
}

/** The accessible view of the chart: the SAME rows the chart draws. */
export function ChartTable({ data, caption }: { data: TableData; caption: string }) {
  return (
    <div className="ck-table-wrap" tabIndex={0} role="region" aria-label={`${caption}, table`}>
      <table className="ck-table">
        <caption className="ck-sr">{caption}</caption>
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c.key} scope="col" data-align={c.align ?? 'start'}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} data-align={data.columns[j]?.align ?? 'start'}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------- legend ---- */

export interface LegendItem {
  readonly label: string
  readonly color: string
  /** rect for areas, bars and segments; line for lines (the legend mirrors the mark). */
  readonly kind?: 'rect' | 'line'
  readonly value?: string
}

/** A legend: always present for two series or more, never for one (the title names it). */
export function Legend({ items }: { items: readonly LegendItem[] }) {
  if (items.length < 2) return null
  return (
    <ul className="ck-legend">
      {items.map((it) => (
        <li key={it.label}>
          <span className={`ck-key${it.kind === 'line' ? ' ck-key--line' : ''}`} style={{ background: it.color }} aria-hidden="true" />
          <span>{it.label}</span>
          {it.value !== undefined ? <b>{it.value}</b> : null}
        </li>
      ))}
    </ul>
  )
}

/* ---------------------------------------------------------------- card ---- */

export interface RangeChips {
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly value: string
  readonly onChange: (value: string) => void
}

export interface ChartCardProps {
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  /** "read from <source> at block N" — always under a chart that draws chain data. */
  readonly provenance?: ReactNode
  readonly state?: ChartState
  readonly defaultView?: ChartView
  /** Hide the Chart | Table switch (a chart that is itself a table, e.g. BarList). */
  readonly tableToggle?: boolean
  readonly ranges?: RangeChips
  readonly legend?: ReactNode
  /** Body height in px; the grid keeps every card the same by default (--ck-h). */
  readonly height?: number
  readonly className?: string
  readonly children: ReactNode
}

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="dc-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const VIEW_OPTIONS = [
  { value: 'chart', label: 'Chart' },
  { value: 'table', label: 'Table' },
] as const

/** The one card every chart sits in. Header, body (state or chart or table), legend, provenance. */
export function ChartCard({ title, subtitle, provenance, state = 'ready', defaultView = 'chart', tableToggle = true, ranges, legend, height, className, children }: ChartCardProps) {
  const [view, setView] = useState<ChartView>(defaultView)
  const titleId = useId()
  const style = height !== undefined ? ({ '--ck-h': `${height}px` } as CSSProperties) : undefined
  let body: ReactNode
  if (state === 'loading') body = <ChartSkeleton />
  else if (state === 'ready') body = children
  else if ('soon' in state) body = <ChartSoon chain={state.soon} />
  else body = <ChartError message={state.error} {...(state.onRetry ? { onRetry: state.onRetry } : {})} />
  const ready = state === 'ready'
  return (
    <Kit>
      <figure className={`ck-card${className ? ` ${className}` : ''}`} style={style} aria-labelledby={titleId}>
        <div className="ck-card__head">
          <div className="ck-card__titles">
            <h3 className="ck-card__title" id={titleId}>
              {title}
            </h3>
            {subtitle !== undefined ? <span className="ck-card__sub">{subtitle}</span> : null}
          </div>
          <div className="ck-card__controls">
            {ranges !== undefined ? <Segmented label="Range" options={ranges.options} value={ranges.value} onChange={ranges.onChange} /> : null}
            {tableToggle && ready ? <Segmented label="View" options={VIEW_OPTIONS} value={view} onChange={setView} /> : null}
          </div>
        </div>
        <div className="ck-card__body">
          <ViewCtx.Provider value={view}>{body}</ViewCtx.Provider>
        </div>
        {(ready && legend !== undefined) || provenance !== undefined ? (
          <figcaption className="ck-card__foot">
            {ready && view === 'chart' ? legend : null}
            {provenance !== undefined ? <p className="ck-prov">{provenance}</p> : null}
          </figcaption>
        ) : null}
      </figure>
    </Kit>
  )
}

/* ---------------------------------------------------------------- plot ---- */

export interface PlotProps {
  readonly sizeRef: RefObject<HTMLDivElement | null>
  /** The aria-label: what the chart shows, in one sentence with its extremes. */
  readonly summary: string
  readonly count: number
  /** Pixel x of each index, ascending, for pointer snapping. Empty: marks set the active index themselves. */
  readonly positions: readonly number[]
  readonly active: number | null
  readonly onActive: (i: number | null) => void
  /** What a screen reader hears for the active point. */
  readonly readout: string | null
  readonly tip: ReactNode | null
  readonly tipX: number | null
  readonly width: number
  readonly children: ReactNode
}

/** The focusable figure: pointer snapping to the nearest X, ←/→ Home End Escape, tooltip, live readout. */
export function Plot({ sizeRef, summary, count, positions, active, onActive, readout, tip, tipX, width, children }: PlotProps) {
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (positions.length === 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const i = nearestIndex(positions, e.clientX - r.left)
    if (i >= 0 && i !== active) onActive(i)
  }
  const onPointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') onActive(null)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(active, e.key, count)
    if (next === undefined) return
    e.preventDefault()
    onActive(next)
  }
  const right = tipX !== null && tipX > width / 2
  return (
    <div
      ref={sizeRef}
      className="ck-plot"
      tabIndex={0}
      role="group"
      aria-roledescription="chart"
      aria-label={summary}
      data-active={active !== null}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      onBlur={() => onActive(null)}
    >
      {children}
      {tip !== null && tipX !== null ? (
        <div className="dc-tooltip ck-tip" style={{ left: tipX, transform: right ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}>
          {tip}
        </div>
      ) : null}
      <div className="ck-sr" aria-live="polite">
        {readout ?? ''}
      </div>
    </div>
  )
}

/** One tooltip row: line key, VALUE first (strong), label after. */
export function TipRow({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <div className="ck-tip__row">
      <span className="ck-key ck-key--line" style={{ background: color }} aria-hidden="true" />
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}
