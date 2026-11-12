// SPDX-License-Identifier: MIT
/**
 * Two compact lock visuals the lock widgets share, in plain SVG / CSS (no
 * chart library, so the embed bundle stays small):
 *
 * - `ShareBar`: a whole split into its locked parts (permanent LP locker,
 *   time-locked, unvested, vested-unclaimed); the empty track is "not
 *   locked". Grows in from the left. Each part states its exact share on
 *   hover (title) and to a screen reader (the bar's label).
 * - `ScheduleSpark`: a token's cumulative release schedule (the SDK's
 *   `vestedAt`, the contract's own formula), drawn on, with a "now" rule.
 *   Pointer or arrow keys read any point: its date and the amount vested by
 *   then.
 *
 * Themed only by `--gullycore-*` properties; motion is CSS and is switched off
 * under `prefers-reduced-motion`. Nothing is drawn that was not read.
 */

import type { ReactElement } from "react";
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { formatLockAmount, formatLockBps, formatUtc, type LocksTokenMeta, type SchedulePoint, type ShareBarView } from "../locks/model.js";

const partText = (p: ShareBarView["parts"][number]): string => (p.bps === 0 && p.nonZero ? "<0.01%" : formatLockBps(p.bps));

export function ShareBar({ view, label, keyed = true }: { view: ShareBarView; label: string; keyed?: boolean }): ReactElement {
  const words = view.parts.map((p) => `${p.label} ${partText(p)}`).join(", ");
  return (
    <div className="gullycore-sharebar" role="img" aria-label={`${label}: ${words || "nothing locked"}, ${formatLockBps(view.restBps)} not locked, ${view.of}`}>
      <div className="gullycore-sharebar__track">
        <div className="gullycore-sharebar__grow">
          {view.parts.map((p) => (
            <span
              key={p.key}
              className={`gullycore-sharebar__part gullycore-sharebar__part--${p.key}`}
              style={{ width: p.bps === 0 ? "2px" : `${p.bps / 100}%` } as CSSProperties}
              title={`${p.label}: ${partText(p)} ${view.of}`}
            />
          ))}
        </div>
      </div>
      {keyed && view.parts.length > 1 ? (
        <ul className="gullycore-sharebar__key" aria-hidden="true">
          {view.parts.map((p) => (
            <li key={p.key}>
              <span className={`gullycore-sharebar__sw gullycore-sharebar__part--${p.key}`} />
              {p.label} {partText(p)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const W = 240;
const H = 44;

export function ScheduleSpark({
  points,
  total,
  now,
  token,
}: {
  points: readonly SchedulePoint[];
  total: bigint;
  now: bigint | null;
  token: Pick<LocksTokenMeta, "symbol" | "decimals">;
}): ReactElement | null {
  const [active, setActive] = useState<number | null>(null);
  const geo = useMemo(() => {
    if (points.length < 2 || total === 0n) return null;
    const t0 = Number(points[0]!.t);
    const t1 = Number(points[points.length - 1]!.t);
    const x = (t: bigint) => ((Number(t) - t0) / (t1 - t0)) * W;
    const y = (v: bigint) => H - 3 - (Number((v * 10_000n) / total) / 10_000) * (H - 6);
    return { x, y, d: points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.vested).toFixed(1)}`).join(" ") };
  }, [points, total]);
  if (geo === null) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const nowX = now !== null && now > first.t && now < last.t ? geo.x(now) : null;
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(geo.x(points[i]!.t) - fx) < Math.abs(geo.x(points[best]!.t) - fx)) best = i;
    setActive(best);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setActive((a) => Math.max(0, Math.min(points.length - 1, (a ?? (e.key === "ArrowLeft" ? points.length : -1)) + (e.key === "ArrowLeft" ? -1 : 1))));
  };
  const at = active === null ? null : points[active]!;
  return (
    <figure className="gullycore-spark">
      <svg
        className="gullycore-spark__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        tabIndex={0}
        role="img"
        aria-label={`Release schedule from ${formatUtc(first.t)} to ${formatUtc(last.t)}, ${formatLockAmount(total, token)} in all. Arrow keys read points.`}
        onPointerMove={pick}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <line className="gullycore-spark__base" x1={0} x2={W} y1={H - 3} y2={H - 3} vectorEffect="non-scaling-stroke" />
        <path className="gullycore-spark__line" d={geo.d} fill="none" vectorEffect="non-scaling-stroke" />
        {nowX !== null ? <line className="gullycore-spark__now" x1={nowX} x2={nowX} y1={1} y2={H - 3} vectorEffect="non-scaling-stroke" /> : null}
        {at !== null ? <line className="gullycore-spark__cross" x1={geo.x(at.t)} x2={geo.x(at.t)} y1={1} y2={H - 3} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <figcaption className="gullycore-spark__cap" aria-live="polite">
        {at !== null ? (
          <>
            <span className="gullycore-locks__timer">{formatUtc(at.t)}</span> · {formatLockAmount(at.vested, token)} vested
          </>
        ) : (
          <>
            Release schedule {formatUtc(first.t).slice(0, 10)} → {formatUtc(last.t).slice(0, 10)}
            {nowX !== null ? " · dashed line = now" : ""}
          </>
        )}
      </figcaption>
    </figure>
  );
}
