// SPDX-License-Identifier: MIT
/**
 * The template's chart names, drawn by the chart kit.
 *
 * `components/chartkit` is the one set of charts in this app: a copy of
 * Gully Core's shared kit (Motion for the draw-on, rise and count-up; d3-scale
 * and d3-shape for the maths; MIT). Every screen here reaches it through
 * these thin names, so a screen says `<Kpi>` or `<BarList>` and never
 * builds a second chart. Keep it that way: a new visual is a kit component
 * (import it from `./chartkit`), not a hand-rolled SVG beside one.
 *
 * - `Kpis` / `Kpi`: the KPI row; each tile counts up once (a spring).
 * - `Sparkline`: recent prices, drawn on; one point is a dot, none a baseline.
 * - `BarList`: ranked bars on ONE scale, with the kit's table view.
 * - `ShareBar`: parts of a whole, a ring with a legend that prints every value.
 * - `Progress`: how far a time window has run (a fee decay, a vesting).
 * - `ViewToggle`: Chart | Table, where the table is the accessible view.
 *
 * Every colour is a `--brand-*` token (`chartkit.css` maps the kit's tokens
 * onto them), so a restyle in `gullycore.config.ts` restyles these too. Motion
 * is off under `prefers-reduced-motion: reduce`. Nothing here reads the chain:
 * callers pass values they read, and the kit refuses to invent a series.
 */

import type { ReactElement, ReactNode } from "react";

import { BarList as KitBarList, KpiTile, Ring, Sparkline as KitSparkline } from "./chartkit";
import { fmtPrice } from "./chartkit/format";

/* ------------------------------------------------------------------ KPIs */

/**
 * A headline figure. `value` is the exact text (a count, an amount with its
 * unit); a plain number in it counts up from zero once, anything else (an
 * ellipsis, "unread") is shown as it is. `sub` is the provenance or the unit.
 */
export function Kpi({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }): ReactElement {
  const m = /^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)(\s?[^\d]{0,16})$/.exec(value);
  if (m === null) {
    return <KpiTile label={label} value={null} {...(sub === undefined ? {} : { caption: sub })} {...(href === undefined ? {} : { href })} state="ready" />;
  }
  const [, prefix = "", raw = "", suffix = ""] = m;
  const plain = raw.replace(/,/g, "");
  const dot = plain.indexOf(".");
  const decimals = dot === -1 ? 0 : plain.length - dot - 1;
  const grouped = raw.includes(",");
  const format = (n: number): string =>
    `${prefix}${grouped ? n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : n.toFixed(decimals)}${suffix}`;
  return <KpiTile label={label} value={Number(plain)} format={format} {...(sub === undefined ? {} : { caption: sub })} {...(href === undefined ? {} : { href })} />;
}

/** The KPI row: equal tiles, two per row on a phone. */
export function Kpis({ children }: { children: ReactNode }): ReactElement {
  return <div className="ck-grid__kpis">{children}</div>;
}

/* ------------------------------------------------------------- Sparkline */

/**
 * Prices oldest to newest, drawn on. The direction is in the accessible
 * label, never carried by colour alone; `unit` names what the prices are in.
 */
export function Sparkline({ prices, unit, width = 96, height = 28 }: { prices: readonly number[]; unit: string; width?: number; height?: number }): ReactElement {
  const label =
    prices.length === 0
      ? "No swaps in the window"
      : prices.length === 1
        ? `1 swap: ${fmtPrice(prices[0] ?? null)} ${unit}`
        : `${prices.length} swaps, ${fmtPrice(prices[0] ?? null)} to ${fmtPrice(prices[prices.length - 1] ?? null)} ${unit}`;
  return <KitSparkline values={prices} label={label} width={width} height={height} tone="auto" format={fmtPrice} />;
}

/* -------------------------------------------------------------- Bar list */

export interface BarRow {
  readonly key: string;
  readonly label: ReactNode;
  /** Plain text for the accessible name and the table. */
  readonly text: string;
  readonly value: number;
  /** The exact figure, with its unit. */
  readonly display: string;
  readonly href?: string;
}

/** Ranked bars on one shared scale, with the kit's keyboard stepping and table view. */
export function BarList({ rows, caption, empty, noun }: { rows: readonly BarRow[]; caption: string; empty: string; noun?: string }): ReactElement {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  const display = new Map(rows.map((r) => [r.key, r.display]));
  return (
    <KitBarList
      rows={rows.map((r) => ({ key: r.key, label: r.text, value: r.value, ...(r.href === undefined ? {} : { href: r.href }) }))}
      label={caption}
      formatValue={(n) => {
        /* The row's own exact text (it carries the unit); the kit asks per value, so find it by value. */
        const row = rows.find((r) => r.value === n);
        return row === undefined ? String(n) : (display.get(row.key) ?? String(n));
      }}
      {...(noun === undefined ? {} : { noun })}
    />
  );
}

/* ------------------------------------------------------------- Share bar */

export interface Share {
  readonly label: string;
  /** Parts in any one unit (basis points, weights, raw amounts). */
  readonly part: number;
  /** Printed beside the label, e.g. "75%". */
  readonly display: string;
}

/**
 * Parts of one whole: a ring with a legend that prints every value, so no
 * reader depends on telling the shades apart. At most four parts (the kit's
 * validated palette); fold the rest into "Other" before calling.
 */
export function ShareBar({ shares, caption }: { shares: readonly Share[]; caption: string }): ReactElement {
  const live = shares.filter((s) => s.part > 0);
  const total = live.reduce((t, s) => t + s.part, 0);
  if (total <= 0) return <p className="muted">Nothing to divide.</p>;
  const display = new Map(live.map((s) => [s.part, s.display]));
  return (
    <Ring
      segments={live.slice(0, 4).map((s) => ({ key: s.label, label: s.label, value: s.part }))}
      label={caption}
      formatValue={(n) => display.get(n) ?? `${((n / total) * 100).toFixed(1)}%`}
    />
  );
}

/* -------------------------------------------------------------- Progress */

/** How far a window has run, 0..1, with the words that say it. */
export function Progress({ fraction, label, caption }: { fraction: number; label: string; caption: string }): ReactElement {
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <div className="progress">
      <span className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)} aria-label={`${label}: ${caption}`}>
        <span className="progress-fill" style={{ width: `${(f * 100).toFixed(2)}%` }} />
      </span>
      <span className="progress-caption">{caption}</span>
    </div>
  );
}

/* ----------------------------------------------------------- View toggle */

export type View = "chart" | "table";

export function ViewToggle({ view, onChange, label }: { view: View; onChange: (v: View) => void; label: string }): ReactElement {
  return (
    <div className="viewtoggle" role="group" aria-label={`${label}: chart or table`}>
      {(["chart", "table"] as const).map((v) => (
        <button key={v} type="button" aria-pressed={view === v} className={view === v ? "active" : ""} onClick={() => onChange(v)}>
          {v === "chart" ? "Chart" : "Table"}
        </button>
      ))}
    </div>
  );
}
