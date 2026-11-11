// SPDX-License-Identifier: MIT
/**
 * Launches created by the configured `LaunchpadKitV2`.
 *
 * A locked launch is a token plus one or more pools whose seeded liquidity can
 * never be withdrawn. There is no cap, no allocation and no claim, so there is
 * no progress bar here. Per launch: who created it, when trading opens, and
 * per pool: the quote, the pool type, the fee the guard is charging right now,
 * where in its decay the schedule is, and the frozen split of the trading fee.
 *
 * Who charges that fee differs by launch (`lib/launchWords.ts`): the pool, as
 * an LP fee the locked position earns, or the launch contract itself, in the
 * pool's quote currency. The words and the split shown follow the launch.
 */

import { Link } from "react-router-dom";
import { useState, type ReactElement } from "react";
import { formatEther } from "viem";

import { TokenLockBadge } from "../components/LockBadges";
import { Async, Empty, NotConfigured } from "../components/States";
import { resolveConfig } from "../config/resolve";
import { explorerAddressUrl } from "../lib/client";
import { ExplorerLink } from "../components/ExplorerLink";
import { formatBps, formatPips, formatUnits, shortAddress } from "../lib/format";
import { formatDuration } from "../lib/launches";
import { NATIVE_ADDRESS, readLaunchesV2, type LaunchLegV2, type LaunchRecordV2, type LaunchScanV2 } from "../lib/launchesV2";
import { feeIsInQuote, feeSplitOf, legFeeWords, lockedEarnsWords } from "../lib/launchWords";
import { windowProgress } from "../lib/chart";
import { Kpi, Kpis, Progress, ShareBar } from "../components/Charts";
import { LAUNCH_TOKEN_DECIMALS } from "../lib/createLaunchV2";
import { publicClient } from "../lib/client";
import { marketCapText, readLaunchMarketCaps, type LegMarketCap } from "../lib/launchMarketCap";
import { useAsync, type AsyncState } from "../lib/useAsync";
import { usdNote, usdText, usdValueOf, useUsdQuote } from "../lib/usd";
import type { Hex } from "viem";

const PHASE_LABEL: Record<LaunchRecordV2["phase"], string> = {
  scheduled: "Scheduled",
  decaying: "Fee decaying",
  settled: "Settled",
  /* The guard's schedule could not be read, so no phase is claimed. */
  unknown: "Schedule unreadable",
};

function tokenLabel(record: LaunchRecordV2): string {
  return record.tokenMeta?.symbol ?? shortAddress(record.token);
}

function quoteLabel(leg: LaunchLegV2, nativeSymbol: string): string {
  if (leg.quote === NATIVE_ADDRESS) return nativeSymbol;
  return leg.quoteMeta?.symbol ?? shortAddress(leg.quote);
}

type PhaseFilter = "all" | "scheduled" | "decaying" | "settled";
const PHASE_FILTERS: readonly (readonly [PhaseFilter, string])[] = [
  ["all", "All"],
  ["scheduled", "Scheduled"],
  ["decaying", "Fee decaying"],
  ["settled", "Settled"],
];

/** A pool's market cap line: the read's state, then the figure or the honest absence. Never zero, never stale. */
function MarketCapCell({ caps, leg, quoteSymbol, usd, weth }: { caps: AsyncState<ReadonlyMap<Hex, LegMarketCap>>; leg: LaunchLegV2; quoteSymbol: string; usd: ReturnType<typeof useUsdQuote>; weth: string | null }): ReactElement {
  if (caps.status === "loading") return <span className="muted">reading the pool&rsquo;s price&hellip;</span>;
  const cap = caps.status === "ready" ? caps.data.get(leg.poolId) : undefined;
  if (cap === undefined) return <span className="muted">couldn&rsquo;t load</span>;
  return (
    <>
      {marketCapText(cap, leg.quote, quoteSymbol, weth, usd)}
      <span className="muted"> · at the pool&rsquo;s current price, read now</span>
    </>
  );
}

function LaunchesBody({ scan, kit }: { scan: LaunchScanV2; kit: string }): ReactElement {
  const cfg = resolveConfig();
  const usd = useUsdQuote();
  const weth = cfg.contracts.weth ?? null;
  /* One getSlot0 per pool, for every launch on the screen, read fresh with the scan. */
  const caps = useAsync(() => readLaunchMarketCaps(publicClient(), scan.launches, { tokenDecimals: LAUNCH_TOKEN_DECIMALS, nativeDecimals: cfg.nativeCurrency.decimals }), [scan]).state;
  const [phase, setPhase] = useState<PhaseFilter>("all");
  const feesWei = scan.launches.reduce((t, l) => t + l.protocolFeeWei, 0n);
  /* Dollars first, where the native/USD feed answered; the native figure stays beside it. */
  const feesUsd = usdValueOf(feesWei, cfg.nativeCurrency.decimals, NATIVE_ADDRESS, cfg.contracts.weth ?? null, usd);
  const byPhase = (p: LaunchRecordV2["phase"]): number => scan.launches.filter((l) => l.phase === p).length;
  const shown = phase === "all" ? scan.launches : scan.launches.filter((l) => l.phase === phase);
  return (
          <>
            <Kpis>
              <Kpi label="Launches" value={String(scan.launches.length)} sub={`through ${shortAddress(kit)}`} />
              <Kpi label="Fee still decaying" value={String(byPhase("decaying"))} sub={`${byPhase("scheduled")} scheduled · ${byPhase("settled")} settled`} />
              {feesUsd === null ? (
                <Kpi label={`Protocol launch fees, ${cfg.nativeCurrency.symbol}`} value={formatEther(feesWei)} sub="all time" />
              ) : (
                <Kpi label="Protocol launch fees" value={usdText(feesUsd)} sub={`${formatEther(feesWei)} ${cfg.nativeCurrency.symbol} all time · ${usd?.provenance.source ?? ""} ${cfg.nativeCurrency.symbol}/USD`} />
              )}
            </Kpis>

            <div className="chart-head">
              <div className="filter-chips" role="group" aria-label="Filter launches by phase">
                {PHASE_FILTERS.map(([k, label]) => (
                  <button key={k} type="button" className={`filter-chip${phase === k ? " active" : ""}`} aria-pressed={phase === k} onClick={() => setPhase(k)}>
                    {label} <span className="muted">{k === "all" ? scan.launches.length : byPhase(k)}</span>
                  </button>
                ))}
              </div>
            </div>

            {usd !== null ? <p className="muted">{usdNote(usd)} Market caps are each pool&rsquo;s current price times the token&rsquo;s total supply.</p> : <p className="muted">Market caps are each pool&rsquo;s current price times the token&rsquo;s total supply, in the pool&rsquo;s quote; no dollar price was read for this chain.</p>}
            {shown.length === 0 ? <p className="muted">No launch is in this phase right now.</p> : null}
            <div className="cards">
              {shown.map((record) => (
                <article className="card" key={record.token}>
                  <header className="card-head">
                    <h2>
                      {tokenLabel(record)}{" "}
                      <span className="muted">{record.tokenMeta?.name ?? ""}</span>
                    </h2>
                    <span className={`tag tag-${record.phase}`}>{PHASE_LABEL[record.phase]}</span>
                  </header>

                  <dl className="kv">
                    <dt>Token</dt>
                    <dd>
                      <ExplorerLink href={explorerAddressUrl(record.token)} className="mono">
                        {record.token}
                      </ExplorerLink>
                    </dd>
                    <dt>Supply</dt>
                    <dd>
                      {formatUnits(record.seedSupply, LAUNCH_TOKEN_DECIMALS)} of{" "}
                      {formatUnits(record.totalSupply, LAUNCH_TOKEN_DECIMALS)} seeded into pools and locked
  {record.totalSupply > 0n ? (
                        <Progress
                          fraction={Number((record.seedSupply * 10_000n) / record.totalSupply) / 10_000}
                          label="Supply seeded and locked"
                          caption={`${formatBps(Number((record.seedSupply * 10_000n) / record.totalSupply))} of supply sits in the locked pools`}
                        />
                      ) : null}
                    </dd>
                    <dt>Trading opens</dt>
                    <dd className="mono">
                      {new Date(Number(record.startTime) * 1000).toISOString()}
                      {record.phase === "scheduled" ? ` · in ${formatDuration(Number(record.startTime - scan.now))}` : ""}
                    </dd>
                    <dt>Creator</dt>
                    <dd>
                      <ExplorerLink href={explorerAddressUrl(record.creator)}>
                        {shortAddress(record.creator)}
                      </ExplorerLink>
                      {record.operator.toLowerCase() !== record.creator.toLowerCase() ? (
                        <>
                          {" "}
                          · operator{" "}
                          <ExplorerLink href={explorerAddressUrl(record.operator)}>
                            {shortAddress(record.operator)}
                          </ExplorerLink>
                        </>
                      ) : null}
                    </dd>
                    <dt>Launch fees paid</dt>
                    <dd>
                      {formatEther(record.protocolFeeWei)} {cfg.nativeCurrency.symbol} to the protocol
                      {record.integratorFeeWei > 0n
                        ? `, ${formatEther(record.integratorFeeWei)} ${cfg.nativeCurrency.symbol} to ${shortAddress(record.integrator)}`
                        : ""}
                    </dd>
                    <dt>Tenant</dt>
                    <dd>
                      {record.tenant === NATIVE_ADDRESS ? (
                        <span className="muted">direct launch</span>
                      ) : (
                        <ExplorerLink href={explorerAddressUrl(record.tenant)}>
                          {shortAddress(record.tenant)}
                          {cfg.launchTenant !== null && cfg.launchTenant.toLowerCase() === record.tenant.toLowerCase() ? ` (${cfg.brand.name})` : ""}
                        </ExplorerLink>
                      )}
                    </dd>
                  </dl>

                  {cfg.features.locks ? <TokenLockBadge token={record.token} /> : null}

                  {record.legs.map((leg) => {
                    const words = legFeeWords(leg.guardGeneration, quoteLabel(leg, cfg.nativeCurrency.symbol));
                    const split = feeSplitOf(leg);
                    return (
                    <div className="panel" key={leg.poolId}>
                      <h3>
                        {tokenLabel(record)} / {quoteLabel(leg, cfg.nativeCurrency.symbol)}{" "}
                        <span className="muted">· {leg.kind === "CL" ? "concentrated liquidity" : "bin"}</span>{" "}
                        <span className={`tag tag-${leg.phase}`}>{PHASE_LABEL[leg.phase]}</span>
                      </h3>
                      <dl className="kv">
                        <dt>Market cap</dt>
                        <dd>
                          <MarketCapCell caps={caps} leg={leg} quoteSymbol={quoteLabel(leg, cfg.nativeCurrency.symbol)} usd={usd} weth={weth} />
                        </dd>
                        <dt>{words.feeLabel}</dt>
                        <dd>
                          {leg.currentFeePips === null ? <span className="muted">couldn&rsquo;t load</span> : formatPips(leg.currentFeePips)}
                          {leg.currentFeePips !== null && words.paidIn !== null ? ` · ${words.paidIn}` : ""}
                        </dd>
                        <dt>Schedule</dt>
                        <dd>
                          {leg.guard === null ? (
                            <span className="muted">couldn&rsquo;t load</span>
                          ) : (
                            <>
                              {formatPips(leg.guard.initialFeeBips)} to {formatPips(leg.guard.finalFeeBips)} over{" "}
                              {formatDuration(leg.guard.decaySeconds)} on <code>block.timestamp</code>
                              {leg.remaining !== null ? ` · ${formatDuration(Number(leg.remaining))} left` : ""}
                              {!leg.guard.enabled ? ` · schedule disabled, ${words.plainFee}` : ""}
                              {leg.guard.maxBuyPerTx > 0n ? ` · max buy ${leg.guard.maxBuyPerTx.toString()} raw quote units per tx` : ""}
                              <Progress
                                fraction={windowProgress(Number(leg.guard.startTime), Number(leg.guard.startTime) + leg.guard.decaySeconds, Number(scan.now))}
                                label="Fee decay"
                                caption={
                                  scan.now < leg.guard.startTime
                                    ? "not started: trading has not opened"
                                    : `${Math.round(windowProgress(Number(leg.guard.startTime), Number(leg.guard.startTime) + leg.guard.decaySeconds, Number(scan.now)) * 100)}% of the decay window elapsed`
                                }
                              />
                            </>
                          )}
                        </dd>
                        <dt>Seeded</dt>
                        <dd>
                          {formatUnits(leg.launchTokenSeeded, LAUNCH_TOKEN_DECIMALS)} {tokenLabel(record)} ({formatBps(leg.weightBps)} of the seed)
                        </dd>
                        <dt>{words.splitLabel}</dt>
                        <dd>
                          {split === null ? (
                            <span className="muted">couldn&rsquo;t load</span>
                          ) : (
                            <>
                              creator {formatBps(split.creatorBps)} · integrator {formatBps(split.integratorBps)}
                              {split.integratorBps > 0 ? ` (${shortAddress(split.integrator)})` : ""} · protocol{" "}
                              {formatBps(split.protocolBps)}
                              {feeIsInQuote(leg.guardGeneration) ? "" : ` · locked forever, ${leg.kind === "CL" ? "position" : "lock"} #${leg.lockId.toString()}`}
                              <ShareBar
                                caption={words.splitCaption}
                                shares={[
                                  { label: "creator", part: split.creatorBps, display: formatBps(split.creatorBps) },
                                  { label: "integrator", part: split.integratorBps, display: formatBps(split.integratorBps) },
                                  { label: "protocol", part: split.protocolBps, display: formatBps(split.protocolBps) },
                                ]}
                              />
                            </>
                          )}
                        </dd>
                        {feeIsInQuote(leg.guardGeneration) ? (
                          <>
                            <dt>Liquidity</dt>
                            <dd>
                              locked forever, {leg.kind === "CL" ? "position" : "lock"} #{leg.lockId.toString()} · {lockedEarnsWords(leg.lpShareBps)}
                            </dd>
                          </>
                        ) : null}
                        <dt>Pool id</dt>
                        <dd className="mono">
                          {leg.poolId}
                          {cfg.features.locks && leg.kind === "CL" ? (
                            <>
                              {" "}
                              <Link to={`/locks/pool/${leg.poolId}`}>locks</Link>
                            </>
                          ) : null}
                        </dd>
                      </dl>
                    </div>
                    );
                  })}
                </article>
              ))}
            </div>

          </>
          );
}

export function LaunchesV2(): ReactElement {
  const cfg = resolveConfig();
  const resource = useAsync(() => readLaunchesV2(), [cfg.launchpadKitV2]);

  if (cfg.launchpadKitV2 === null) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Launch</h1>
        </header>
        <NotConfigured
          what="The locked launchpad"
          field="chain.launchpadKitV2"
          detail={
            <>
              Launches through Gully Core&rsquo;s shared <code>LaunchpadKitV2</code> are coming soon on this chain; run{" "}
              <code>npm run gullycore:verify</code> for the current state.
              {cfg.launchpadKit === null ? null : (
                <>
                  {" "}
                  A v1 kit is configured; its launches are at <Link to="/launch/v1">/launch/v1</Link>.
                </>
              )}
            </>
          }
        />
      </div>
    );
  }
  const kit = cfg.launchpadKitV2;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Launch</h1>
        <p className="page-sub">
          Tokens launched through <code>{shortAddress(kit)}</code>: pools seeded from their own supply and
          locked forever, with a decaying launch fee.
        </p>
        <Link className="btn btn-primary" to="/launch/new">
          New launch
        </Link>{" "}
        <Link className="btn btn-ghost" to="/launch/earnings">
          Your earnings
        </Link>
        {cfg.launchpadKit === null ? null : (
          <>
            {" "}
            <Link className="btn btn-ghost" to="/launch/v1">
              v1 launches
            </Link>
          </>
        )}
      </header>

      <Async
        state={resource.state}
        onRetry={resource.reload}
        loadingLabel="Loading launches"
        isEmpty={(scan) => scan.launches.length === 0}
        empty={<Empty title="No launches yet" detail="Nothing has launched yet." />}
      >
        {(scan) => <LaunchesBody scan={scan} kit={kit} />}
      </Async>
    </div>
  );
}
