// SPDX-License-Identifier: MIT
/* ============================================================================
   BarList — ranked rows with a share track: top holders, top pools, launches
   by volume. The values are printed on every row (this chart IS a list), so
   its table view only adds the rank and share columns side by side.
   ============================================================================ */

import { useState, type KeyboardEvent } from 'react'
import { m } from 'motion/react'

import { EASE, GROW_S, compactTick, sharePct, stepIndex } from './core'
import { ChartEmpty, ChartTable, useChartView, type TableData } from './frame'
import { Kit, useReveal } from './runtime'

export interface BarListRow {
  readonly key: string
  readonly label: string
  readonly value: number
  /** A link to the row's detail (a holder's address page, a pool). */
  readonly href?: string
  /** A short tag after the label ("Vault", "LP lock"): what the address is, when it is known. */
  readonly note?: string
}

export interface BarListProps {
  /** Already ranked by the caller, largest first. */
  readonly rows: readonly BarListRow[]
  readonly label: string
  readonly formatValue?: (n: number) => string
  /** The whole (total supply, total volume): adds a share after each value. */
  readonly total?: number
  readonly valueLabel?: string
  /** What a row is, for the empty state: "holders". */
  readonly noun?: string
}

export function barListTable(p: BarListProps): TableData {
  const f = p.formatValue ?? compactTick
  const cols = [
    { key: 'r', label: '#' },
    { key: 'l', label: 'Name' },
    { key: 'v', label: p.valueLabel ?? 'Value', align: 'end' as const },
  ]
  return {
    columns: p.total !== undefined ? [...cols, { key: 's', label: 'Share', align: 'end' as const }] : cols,
    rows: p.rows.map((r, i) => {
      const base = [String(i + 1), r.note ? `${r.label} (${r.note})` : r.label, f(r.value)]
      return p.total !== undefined ? [...base, sharePct(r.value, p.total)] : base
    }),
  }
}

export function BarList(props: BarListProps) {
  const view = useChartView()
  const reveal = useReveal()
  const [active, setActive] = useState<number | null>(null)
  const f = props.formatValue ?? compactTick
  if (props.rows.length === 0) return <ChartEmpty title={`No ${props.noun ?? 'rows'} yet`} />
  if (view === 'table') return <ChartTable data={barListTable(props)} caption={props.label} />
  const max = Math.max(0, ...props.rows.map((r) => r.value))
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const next = stepIndex(active, e.key, props.rows.length)
    if (next === undefined) return
    e.preventDefault()
    setActive(next)
  }
  const a = active !== null ? props.rows[active] : undefined
  return (
    <Kit>
      <ol ref={reveal.ref} className="ck-barlist" tabIndex={0} aria-label={`${props.label}, ${props.rows.length} rows`} onKeyDown={onKeyDown} onBlur={() => setActive(null)}>
        {props.rows.map((r, i) => (
          <li key={r.key} className="ck-barlist__row" data-on={active === i} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
            <span className="ck-barlist__rank">{i + 1}</span>
            <span className="ck-barlist__label">
              {r.href ? <a href={r.href}>{r.label}</a> : r.label}
              {r.note ? <span style={{ color: 'var(--muted)' }}> · {r.note}</span> : null}
            </span>
            <span className="ck-barlist__value">
              {f(r.value)}
              {props.total !== undefined ? <small>{sharePct(r.value, props.total)}</small> : null}
            </span>
            <span className="ck-barlist__track" aria-hidden="true">
              <m.span
                className="ck-barlist__fill"
                style={{ width: `${max > 0 ? (Math.max(0, r.value) / max) * 100 : 0}%`, originX: 0 }}
                initial={reveal.armed ? { scaleX: 0 } : false}
                animate={{ scaleX: reveal.play ? 1 : 0 }}
                transition={{ duration: GROW_S, ease: EASE, delay: Math.min(i * 0.07, 0.5) }}
              />
            </span>
          </li>
        ))}
      </ol>
      <div className="ck-sr" aria-live="polite">
        {a ? `${active !== null ? active + 1 : ''}. ${a.label}: ${f(a.value)}${props.total !== undefined ? `, ${sharePct(a.value, props.total)}` : ''}` : ''}
      </div>
    </Kit>
  )
}
