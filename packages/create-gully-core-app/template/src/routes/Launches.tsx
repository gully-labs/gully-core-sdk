// SPDX-License-Identifier: MIT
/**
 * Launches created by the configured `LaunchpadKit`.
 *
 * A Gully Core launch is a pool whose LP fee starts high and decays block by block —
 * not a token sale. There is no cap, no allocation and no claim, so there is
 * nothing to draw a progress bar against and this screen does not draw one. It
 * shows the schedule, the fee the hook is charging right now, and whether the
 * first swap has happened.
 */

import { Link } from "react-router-dom";
import type { ReactElement } from "react";

import { Async, Empty, NotConfigured } from "../components/States";
import { resolveConfig } from "../config/resolve";
import { explorerAddressUrl } from "../lib/client";
import { ExplorerLink } from "../components/ExplorerLink";
import { formatPips, shortAddress } from "../lib/format";
import {
  blocksToSeconds,
  formatDuration,
  presetLabel,
  readLaunchBounds,
  readLaunches,
  type LaunchRecord,
} from "../lib/launches";
import { useAsync } from "../lib/useAsync";

const PHASE_LABEL: Record<LaunchRecord["phase"], string> = {
  scheduled: "Scheduled",
  decaying: "Fee decaying",
  settled: "Settled",
};

function tokenLabel(record: LaunchRecord): string {
  return record.launchTokenMeta?.symbol ?? shortAddress(record.launchToken);
}

function quoteLabel(record: LaunchRecord): string {
  return record.quoteTokenMeta?.symbol ?? shortAddress(record.quoteToken);
}

export function Launches(): ReactElement {
  const cfg = resolveConfig();

  const resource = useAsync(async () => {
    const [scan, bounds] = await Promise.all([readLaunches(), readLaunchBounds()]);
    return { scan, bounds };
  }, [cfg.launchpadKit]);

  if (cfg.launchpadKit === null) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Launch</h1>
        </header>
        <NotConfigured
          what="The launchpad"
          field="chain.launchpadKit"
          detail={
            <>
              Gully Core has no shared <code>LaunchpadKit</code> deployed on any chain yet, so there is
              nothing to point this at until either Gully Core ships one or you deploy your own. Run{" "}
              <code>npm run gullycore:verify</code> for the current state, and see the README section
              &ldquo;The launchpad half is not live yet&rdquo;.
            </>
          }
        />
      </div>
    );
  }

  /* Bound to a local so the narrowing above survives into the render callbacks.
     TS re-widens a property access inside a closure, and the provenance line at
     the bottom is inside one. */
  const kit = cfg.launchpadKit;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Launch</h1>
        <p className="page-sub">
          Pools created through <code>{shortAddress(kit)}</code> with a decaying
          launch fee.
        </p>
        <Link className="btn btn-primary" to="/launch/new">
          New launch
        </Link>
      </header>

      <Async
        state={resource.state}
        onRetry={resource.reload}
        loadingLabel="Loading launches"
        isEmpty={({ scan }) => scan.launches.length === 0}
        empty={
          <Empty
            title="No launches yet"
            detail="Nothing has launched yet."
          />
        }
      >
        {({ scan, bounds }) => (
          <>
            <div className="cards">
              {scan.launches.map((record) => (
                <article className="card" key={record.poolId}>
                  <header className="card-head">
                    <h2>
                      {tokenLabel(record)} <span className="muted">/ {quoteLabel(record)}</span>
                    </h2>
                    <span className={`tag tag-${record.phase}`}>{PHASE_LABEL[record.phase]}</span>
                  </header>

                  <dl className="kv">
                    <dt>Fee now</dt>
                    <dd>
                      {record.currentFeePips === null ? (
                        <span className="muted">couldn&rsquo;t load</span>
                      ) : (
                        formatPips(record.currentFeePips)
                      )}
                    </dd>

                    <dt>Schedule</dt>
                    {bounds.durationClock === "timestamp" ? (
                      <dd>
                        {formatPips(record.initialFeeBips)} to {formatPips(record.finalFeeBips)} over{" "}
                        {record.window.toLocaleString()} seconds ({formatDuration(record.window)}, measured
                        on <code>block.timestamp</code>)
                      </dd>
                    ) : (
                      <dd>
                        {formatPips(record.initialFeeBips)} to {formatPips(record.finalFeeBips)} over{" "}
                        {record.window.toLocaleString()} blocks (about{" "}
                        {formatDuration(blocksToSeconds(record.window, bounds.contractBlockTimeCentis))}{" "}
                        of real time: the hook&rsquo;s block advances every ~
                        {bounds.contractBlockTimeCentis / 100}s
                        {bounds.contractBlockTimeCentis !== bounds.blockTimeCentis
                          ? `, not the ${bounds.blockTimeCentis / 100}s this kit was configured with`
                          : ""}
                        )
                      </dd>
                    )}

                    <dt>Starts</dt>
                    {bounds.durationClock === "timestamp" ? (
                      <dd className="mono">
                        {new Date(Number(record.start) * 1000).toISOString()}
                        {record.phase === "scheduled"
                          ? ` · in ${formatDuration(Number(record.start - scan.now))}`
                          : ""}
                      </dd>
                    ) : (
                      <dd className="mono">
                        hook block {record.start.toString()}
                        {record.phase === "scheduled"
                          ? ` · in ~${formatDuration(
                              blocksToSeconds(record.start - scan.now, bounds.contractBlockTimeCentis),
                            )}`
                          : ""}
                      </dd>
                    )}

                    <dt>Max buy per tx</dt>
                    <dd>
                      {record.maxBuyPerTx === 0n ? (
                        <span className="muted">uncapped</span>
                      ) : (
                        `${record.maxBuyPerTx.toString()} raw units`
                      )}
                    </dd>

                    <dt>Preset</dt>
                    <dd>{presetLabel(record.preset)}</dd>

                    <dt>Operator</dt>
                    <dd>
                      <ExplorerLink href={explorerAddressUrl(record.operator)}>
                        {shortAddress(record.operator)}
                      </ExplorerLink>
                    </dd>
                  </dl>

                  {!record.enabled ? (
                    <p className="warn-inline">
                      The launch schedule is disabled on the hook, so this pool charges its plain
                      LP fee rather than the decay above.
                    </p>
                  ) : null}
                  {record.launched ? (
                    <p className="state-hint">
                      Trading has started, so the schedule is frozen. It cannot be reconfigured.
                    </p>
                  ) : (
                    <p className="state-hint">
                      Not yet traded. The operator can still call <code>reconfigureLaunch</code>{" "}
                      until the launch starts.
                    </p>
                  )}
                </article>
              ))}
            </div>

          </>
        )}
      </Async>
    </div>
  );
}
