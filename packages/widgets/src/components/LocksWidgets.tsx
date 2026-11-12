// SPDX-License-Identifier: MIT
/**
 * `LocksBadge` and `LocksPanel`: "is this liquidity (or this token) locked,
 * until when?", read live from the Gully Core lock contracts.
 *
 * - `LocksBadge` is one line: the locked share of a pool's ACTIVE liquidity
 *   (or of a token's supply), a countdown to the next unlock, and a link to
 *   the lock page. For beside a pool or a token, anywhere.
 * - `LocksPanel` is the list: every lock with its owner, liquidity or amount,
 *   unlock date, countdown and status.
 *
 * Both take a viem `PublicClient` and the lock contract's address from the
 * host's address book; `null` renders the not-deployed state instead of a
 * read. No provider, no wallet, no writes. Themed by the same `--gullycore-*`
 * properties as every other widget; `theme` falls back to a mounted
 * `WidgetProvider`'s, then to `system`.
 */

import type { ReactElement } from "react";
import { useEffect, useId } from "react";
import type { PublicClient } from "viem";

import { useOptionalWidgetContext, type WidgetTheme } from "../context/WidgetProvider.js";
import {
  useChainClock,
  usePoolLocks,
  useTokenLocks,
  type NativeCurrencyMeta,
  type PoolLocksData,
  type TokenLocksData,
} from "../hooks/useLocks.js";
import {
  POSITION_STATUS_LABEL,
  binPoolBadgeView,
  TOKEN_STATUS_LABEL,
  formatCountdown,
  formatLockAmount,
  formatLockBps,
  formatUtc,
  lockPageUrl,
  poolBadgeView,
  tokenBadgeView,
  vestedBps,
  binShareBar,
  poolShareBar,
  releaseSchedule,
  tokenShareBar,
  type LocksBadgeView,
  type ShareBarView,
  type LocksTarget,
} from "../locks/model.js";
import { injectWidgetStyles } from "../styles/css.js";
import { ScheduleSpark, ShareBar } from "./lockCharts.js";
import { tokenEmbedView } from "../locks/embedModel.js";
import { shortAddress } from "../core/format.js";
import type { AsyncResource } from "../hooks/useAsyncResource.js";

/** Props shared by {@link LocksBadge} and {@link LocksPanel}. */
export interface LocksWidgetProps {
  /** Reads go here. The chain it is connected to is the chain the lock address is on. */
  readonly client: PublicClient;
  /** A pool id with the chain's `GullyCorePositionLock`, or a token with its `GullyCoreTokenLock`. `null` address = the chain has no such contract in the host address book; the widget renders "coming soon". */
  readonly target: LocksTarget;
  /** Base URL of a Gully Core app; the widget links to `<siteUrl>/app/locks/...`. Omit to render no link. */
  readonly siteUrl?: string;
  /** The lock pages' path under `siteUrl`; default `/app/locks` (e.g. `/locks` for the public pages). */
  readonly lockPathBase?: string;
  /** Appended to the lock page URL, e.g. `net=hyperevm`. */
  readonly lockQuery?: string;
  /** Anchor target for the lock page link, e.g. `_blank` when the badge is inside an iframe. */
  readonly linkTarget?: "_blank" | "_top" | "_self";
  /**
   * `embed`: the "Locked by Gully Core" badge's words (`../locks/embedModel.ts`): a
   * token reads as the share of supply NOT YET VESTED ("Y% of supply locked")
   * rather than what the locker holds. Same reads either way.
   */
  readonly wording?: "default" | "embed";
  /**
   * The Gully Core icon (kit 02-icon, e.g.
   * `<gullycore site>/kit/gully-core-kit/02-icon/gully-core-icon-orange.svg`: one file for both grounds), shown at
   * the kit's 24 px minimum beside "Read from chain". Omit for no mark.
   */
  readonly brandMarkUrl?: string;
  readonly theme?: WidgetTheme;
  /** Native currency display facts (default ETH, 18). */
  readonly native?: NativeCurrencyMeta;
  /** Re-read interval in ms; default 60,000. */
  readonly refetchIntervalMs?: number;
  readonly className?: string;
}

type Loaded =
  | { readonly kind: "pool"; readonly res: AsyncResource<PoolLocksData> }
  | { readonly kind: "token"; readonly res: AsyncResource<TokenLocksData> };

/** Both hooks always run (rules of hooks); the one not targeted is disabled. */
function useTargetLocks(props: LocksWidgetProps): Loaded {
  const t = props.target;
  const lp = {
    ...(t.lpLocker !== undefined ? { lpLocker: t.lpLocker } : {}),
    ...(t.binLpLocker !== undefined ? { binLpLocker: t.binLpLocker } : {}),
    ...(t.lpLockerTokenIds !== undefined ? { lpLockerTokenIds: t.lpLockerTokenIds } : {}),
    ...(t.lpLockerFromBlock !== undefined ? { lpLockerFromBlock: t.lpLockerFromBlock } : {}),
    ...(t.poolType !== undefined ? { poolType: t.poolType } : {}),
  };
  const opts = { lp, ...(props.native ? { native: props.native } : {}), ...(props.refetchIntervalMs !== undefined ? { refetchIntervalMs: props.refetchIntervalMs } : {}) };
  const pool = usePoolLocks(props.client, t.kind === "pool" ? t.positionLock : null, t.kind === "pool" ? t.poolId : "0x", opts);
  const token = useTokenLocks(props.client, t.kind === "token" ? t.tokenLock : null, t.kind === "token" ? t.token : "0x0000000000000000000000000000000000000000", opts);
  return t.kind === "pool" ? { kind: "pool", res: pool } : { kind: "token", res: token };
}

/** Something to read: the time-lock contract, or a permanent LP locker. */
function lockAddressOf(t: LocksTarget) {
  if (t.kind === "pool" && t.poolType === "bin") return t.binLpLocker ?? null;
  return (t.kind === "pool" ? t.positionLock : t.tokenLock) ?? t.lpLocker ?? t.binLpLocker ?? null;
}

function useShell(theme: WidgetTheme | undefined): WidgetTheme {
  const ctx = useOptionalWidgetContext();
  useEffect(() => {
    injectWidgetStyles();
  }, []);
  return theme ?? ctx?.theme ?? "dark";
}

function Link({ props }: { props: LocksWidgetProps }): ReactElement | null {
  if (props.siteUrl === undefined) return null;
  const t = props.target;
  const href = lockPageUrl(props.siteUrl, t.kind === "pool" ? { kind: "pool", poolId: t.poolId } : { kind: "token", token: t.token }, {
    ...(props.lockPathBase !== undefined ? { pathBase: props.lockPathBase } : {}),
    ...(props.lockQuery !== undefined ? { query: props.lockQuery } : {}),
  });
  return (
    <a className="gullycore-locks__link" href={href} {...(props.linkTarget === undefined || props.linkTarget === "_self" ? {} : { target: props.linkTarget, rel: "noopener noreferrer" })}>
      {t.kind === "pool" ? "Locks for this pool →" : "Locks for this token →"}
    </a>
  );
}

function view(l: Loaded, wording: LocksWidgetProps["wording"] = "default"): LocksBadgeView | null {
  if (l.res.data === null) return null;
  if (wording === "embed" && l.kind === "token") return tokenEmbedView(l.res.data as TokenLocksData);
  if (l.kind === "pool") {
    const d = l.res.data as PoolLocksData;
    return d.bin !== null ? binPoolBadgeView(d.bin, d.currency0, d.currency1) : poolBadgeView(d.summary);
  }
  const d = l.res.data as TokenLocksData;
  const empty = { locks: [], totalHeld: 0n, unvested: 0n, heldBps: null, unvestedBps: null, nextCliffOrEnd: null, lastEnd: null, totalSupply: null };
  return tokenBadgeView(d.summary ?? empty, d.token, d.permanent);
}

/** The share bar for what was read: a CL pool's active liquidity, a Bin pool's active bin, or a token's supply. */
function shareView(l: Loaded): ShareBarView | null {
  if (l.res.data === null) return null;
  if (l.kind === "pool") {
    const d = l.res.data as PoolLocksData;
    return d.bin !== null ? binShareBar(d.bin) : poolShareBar(d.summary);
  }
  const d = l.res.data as TokenLocksData;
  if (d.summary === null) return null;
  return tokenShareBar(d.summary, d.permanent?.total ?? null);
}

function StateLine({ l, target }: { l: Loaded; target: LocksTarget }): ReactElement | null {
  if (lockAddressOf(target) === null) {
    return (
      <p className="gullycore-locks__headline">
        <span className="gullycore-locks__dot gullycore-locks__dot--none" aria-hidden="true" />
        {target.kind === "pool" ? "Gully Core liquidity locks are coming soon on this chain" : "Gully Core token locks are coming soon on this chain"}
      </p>
    );
  }
  if (l.res.status === "error" && l.res.data === null) {
    return (
      <p className="gullycore-locks__headline gullycore-locks__headline--error" role="status">
        Couldn&rsquo;t load locks. Try again.
      </p>
    );
  }
  if (l.res.data === null) {
    return (
      <p className="gullycore-locks__headline gullycore-locks__headline--muted" role="status">
        Loading locks…
      </p>
    );
  }
  return null;
}

/** One line: the share locked, the countdown to the next unlock, a link. */
export function LocksBadge(props: LocksWidgetProps): ReactElement {
  const theme = useShell(props.theme);
  const l = useTargetLocks(props);
  const v = view(l, props.wording);
  const share = shareView(l);
  const data = l.res.data;
  const now = useChainClock(data?.chainNow ?? null, data?.readAtMs ?? null);
  const pending = <StateLine l={l} target={props.target} />;
  return (
    <div
      className={`gullycore-widget gullycore-locks gullycore-locks--badge${props.className ? ` ${props.className}` : ""}`}
      data-gullycore-theme={theme}
      data-tone={v?.tone ?? "none"}
    >
      {v === null ? (
        pending
      ) : (
        <>
          <p className="gullycore-locks__headline">
            <span className={`gullycore-locks__dot gullycore-locks__dot--${v.tone}`} aria-hidden="true" />
            <span>{v.headline}</span>
          </p>
          {share !== null ? <ShareBar view={share} label={v.headline} keyed={false} /> : null}
          {v.countdownTo !== null && now !== null ? (
            <p className="gullycore-locks__countdown">
              <span className="gullycore-locks__timer">{formatCountdown(v.countdownTo - now)}</span> to {v.countdownLabel}
            </p>
          ) : null}
        </>
      )}
      {props.brandMarkUrl !== undefined ? (
        <p className="gullycore-brand">
          <img className="gullycore-brand__mark" src={props.brandMarkUrl} width={220} height={220} alt="Gully Core" />
          <span>Live from the chain</span>
          <span className="gullycore-brand__spacer" />
          <Link props={props} />
        </p>
      ) : (
        <Link props={props} />
      )}
    </div>
  );
}

/** The list of every lock for the target, under the badge's summary. */
export function LocksPanel(props: LocksWidgetProps & { readonly title?: string }): ReactElement {
  const theme = useShell(props.theme);
  const headingId = useId();
  const l = useTargetLocks(props);
  const v = view(l);
  const share = shareView(l);
  const schedule = l.kind === "token" && l.res.data !== null ? releaseSchedule((l.res.data as TokenLocksData).summary?.locks ?? [], (l.res.data as TokenLocksData).chainNow) : null;
  const data = l.res.data;
  const now = useChainClock(data?.chainNow ?? null, data?.readAtMs ?? null);
  return (
    <section
      className={`gullycore-widget gullycore-locks gullycore-locks--panel${props.className ? ` ${props.className}` : ""}`}
      data-gullycore-theme={theme}
      aria-labelledby={headingId}
    >
      <header className="gullycore-header">
        <h2 id={headingId} className="gullycore-title">
          {props.title ?? "Locks"}
        </h2>
        <Link props={props} />
      </header>
      {v === null ? (
        <StateLine l={l} target={props.target} />
      ) : (
        <>
          <p className="gullycore-locks__headline">
            <span className={`gullycore-locks__dot gullycore-locks__dot--${v.tone}`} aria-hidden="true" />
            <span>{v.headline}</span>
          </p>
          {share !== null ? <ShareBar view={share} label={v.headline} /> : null}
          {v.detail !== null ? <p className="gullycore-note">{v.detail}</p> : null}
          {v.countdownTo !== null && now !== null ? (
            <p className="gullycore-locks__countdown">
              <span className="gullycore-locks__timer">{formatCountdown(v.countdownTo - now)}</span> to {v.countdownLabel}
            </p>
          ) : null}
          {schedule !== null && l.kind === "token" ? <ScheduleSpark points={schedule.points} total={schedule.total} now={now} token={(l.res.data as TokenLocksData).token} /> : null}
          {l.kind === "pool" ? <PoolRows data={l.res.data as PoolLocksData} now={now} /> : <TokenRows data={l.res.data as TokenLocksData} now={now} />}
        </>
      )}
      <p className="gullycore-footer gullycore-footer--brand">Live from the chain</p>
    </section>
  );
}

function PoolRows({ data, now }: { data: PoolLocksData; now: bigint | null }): ReactElement | null {
  const locks = data.summary.locks;
  const permanent = data.summary.permanent;
  const binLocks = data.bin?.locks ?? [];
  if (locks.length === 0 && permanent.length === 0 && binLocks.length === 0) return null;
  const active = data.summary.pool?.activeLiquidity ?? 0n;
  return (
    <ul className="gullycore-locks__list">
      {permanent.map((p) => {
        const share = p.inRange === true && active > 0n ? Number((p.liquidity * 10_000n) / active) : null;
        return (
          <li key={`lp${p.tokenId}`} className="gullycore-locks__item" data-status="permanent">
            <div className="gullycore-locks__row">
              <strong>Position #{p.tokenId.toString()}</strong>
              <span className="gullycore-locks__status gullycore-locks__status--permanent">Locked permanently (LP locker)</span>
            </div>
            <dl className="gullycore-locks__facts">
              <div>
                <dt>Fees to</dt>
                <dd title={p.creator}>{shortAddress(p.creator)} (creator)</dd>
              </div>
              {p.amount0 !== null && p.amount1 !== null ? (
                <div>
                  <dt>Holds now</dt>
                  <dd title={`Liquidity ${p.liquidity.toLocaleString("en-US")}`}>
                    {formatLockAmount(p.amount0, data.currency0)} + {formatLockAmount(p.amount1, data.currency1)}
                    {p.inRange === false ? " · out of range" : ""}
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>Liquidity</dt>
                  <dd>
                    L {p.liquidity.toLocaleString("en-US")}
                    {p.inRange === false ? " · out of range" : ""}
                  </dd>
                </div>
              )}
              <div>
                <dt>Share of active</dt>
                <dd>{share === null ? "—" : formatLockBps(share)}</dd>
              </div>
              <div>
                <dt>Unlocks</dt>
                <dd>never: the LP locker has no withdraw path</dd>
              </div>
            </dl>
          </li>
        );
      })}
      {binLocks.map((b) => (
        <li key={`bin${b.lockId}`} className="gullycore-locks__item" data-status="permanent">
          <div className="gullycore-locks__row">
            <strong>Bin lock #{b.lockId.toString()}</strong>
            <span className="gullycore-locks__status gullycore-locks__status--permanent">Locked permanently (LP locker)</span>
          </div>
          <dl className="gullycore-locks__facts">
            <div>
              <dt>Bins</dt>
              <dd>
                {b.bins.length.toLocaleString("en-US")}
                {b.bins.length > 0 ? ` (ids ${b.bins[0]!.binId}–${b.bins[b.bins.length - 1]!.binId})` : ""}
              </dd>
            </div>
            <div>
              <dt>Holds now</dt>
              <dd>
                {formatLockAmount(b.amount0, data.currency0)} + {formatLockAmount(b.amount1, data.currency1)}
              </dd>
            </div>
            <div>
              <dt>Unlocks</dt>
              <dd>never: the LP locker has no withdraw path</dd>
            </div>
          </dl>
        </li>
      ))}
      {locks.map((lk) => {
        const share = lk.inRange === true && lk.liquidity !== null && active > 0n && lk.status === "locked" ? Number((lk.liquidity * 10_000n) / active) : null;
        return (
          <li key={lk.tokenId.toString()} className="gullycore-locks__item" data-status={lk.status}>
            <div className="gullycore-locks__row">
              <strong>Position #{lk.tokenId.toString()}</strong>
              <span className={`gullycore-locks__status gullycore-locks__status--${lk.status}`}>{POSITION_STATUS_LABEL[lk.status]}</span>
            </div>
            <dl className="gullycore-locks__facts">
              <div>
                <dt>Lock owner</dt>
                <dd title={lk.owner}>{shortAddress(lk.owner)}</dd>
              </div>
              {lk.amount0 !== null && lk.amount1 !== null ? (
                <div>
                  <dt>Holds now</dt>
                  <dd title={lk.liquidity === null ? undefined : `Liquidity ${lk.liquidity.toLocaleString("en-US")}`}>
                    {formatLockAmount(lk.amount0, data.currency0)} + {formatLockAmount(lk.amount1, data.currency1)}
                    {lk.inRange === false ? " · out of range" : ""}
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>Liquidity</dt>
                  <dd>
                    {lk.liquidity === null ? "—" : `L ${lk.liquidity.toLocaleString("en-US")}`}
                    {lk.inRange === false ? " · out of range" : ""}
                  </dd>
                </div>
              )}
              <div>
                <dt>Share of active</dt>
                <dd>{share === null ? "—" : formatLockBps(share)}</dd>
              </div>
              <div>
                <dt>Unlocks</dt>
                <dd>
                  {formatUtc(lk.unlockAt)}
                  {lk.status === "locked" && now !== null ? <span className="gullycore-locks__timer"> · {formatCountdown(lk.unlockAt - now)}</span> : null}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function TokenRows({ data, now }: { data: TokenLocksData; now: bigint | null }): ReactElement | null {
  const locks = data.summary?.locks ?? [];
  const lpPools = data.permanent?.pools ?? [];
  if (locks.length === 0 && lpPools.length === 0) return null;
  const supply = data.summary?.totalSupply ?? null;
  return (
    <ul className="gullycore-locks__list">
      {lpPools.map((p) => (
        <li key={`${p.kind}${p.poolId}`} className="gullycore-locks__item" data-status="permanent">
          <div className="gullycore-locks__row">
            <strong>
              {p.kind === "cl-lp-locker" ? "CL" : "Bin"} pool {p.poolId.slice(0, 10)}…
            </strong>
            <span className="gullycore-locks__status gullycore-locks__status--permanent">Locked permanently (LP locker)</span>
          </div>
          <dl className="gullycore-locks__facts">
            <div>
              <dt>{data.token.symbol} in the locked liquidity</dt>
              <dd>
                {formatLockAmount(p.amount, data.token)}
                {supply !== null && supply > 0n ? ` · ${formatLockBps(Number((p.amount * 10_000n) / supply))} of supply` : ""}
              </dd>
            </div>
            <div>
              <dt>Locks</dt>
              <dd>{p.locks.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Unlocks</dt>
              <dd>never: the LP locker has no withdraw path</dd>
            </div>
          </dl>
        </li>
      ))}
      {locks.map((lk) => {
        const remaining = lk.amount - lk.claimed;
        const pct = supply === null || supply === 0n ? null : Number((remaining * 10_000n) / supply);
        const next = lk.status === "cliff" ? lk.cliff : lk.status === "vesting" ? lk.end : null;
        const vb = vestedBps(lk);
        return (
          <li key={lk.lockId.toString()} className="gullycore-locks__item" data-status={lk.status}>
            <div className="gullycore-locks__row">
              <strong>Lock #{lk.lockId.toString()}</strong>
              <span className={`gullycore-locks__status gullycore-locks__status--${lk.status}`}>{TOKEN_STATUS_LABEL[lk.status]}</span>
            </div>
            <dl className="gullycore-locks__facts">
              <div>
                <dt>Beneficiary</dt>
                <dd title={lk.beneficiary}>{shortAddress(lk.beneficiary)}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{formatLockAmount(lk.amount, data.token)}</dd>
              </div>
              <div>
                <dt>Still held</dt>
                <dd>
                  {formatLockAmount(remaining, data.token)}
                  {pct !== null ? ` · ${formatLockBps(pct)} of supply` : ""}
                </dd>
              </div>
              <div>
                <dt>{lk.start === lk.end ? "Unlocks" : "Vesting"}</dt>
                <dd>
                  {lk.start === lk.end ? formatUtc(lk.end) : `${formatUtc(lk.start)} → ${formatUtc(lk.end)}${lk.cliff > lk.start ? `, cliff ${formatUtc(lk.cliff)}` : ""}`}
                  {next !== null && now !== null ? <span className="gullycore-locks__timer"> · {formatCountdown(next - now)}</span> : null}
                </dd>
              </div>
            </dl>
            <div className="gullycore-progress" role="img" aria-label={`${formatLockBps(vb)} vested`}>
              <div className="gullycore-progress-fill" style={{ width: `${vb / 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
