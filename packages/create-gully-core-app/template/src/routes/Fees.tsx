// SPDX-License-Identifier: MIT
/**
 * Every fee a user of this app pays, read from chain, on one page.
 *
 * This screen exists because three separate parties take a cut of one trade and
 * nobody discloses the other two. A user told about one of three has been
 * misled by omission, and the front end is the only surface that can see all
 * three at once.
 *
 * It is also where the shared-core bargain is stated plainly: Gully Core's protocol
 * fee is not something this app can change, and that is the price of not
 * deploying and verifying nineteen contracts.
 */

import { launchSplitBounds } from "@gullylabs/core-sdk";
import type { ReactElement } from "react";
import { formatEther } from "viem";

import { Async } from "../components/States";
import { resolveConfig } from "../config/resolve";
import { explorerAddressUrl } from "../lib/client";
import { ExplorerLink } from "../components/ExplorerLink";
import { formatBps, formatPips, shortAddress } from "../lib/format";
import { readKitV2Bounds } from "../lib/launchesV2";
import { feeDividedLine, lockedEarnsWords, lpShareOfPools } from "../lib/launchWords";
import { readProtocolStatus } from "../lib/protocol";
import { readFillRouterFee, useRouterService } from "../lib/routing";
import { useAsync } from "../lib/useAsync";

/**
 * Gully Core's routing fee: what a ROUTED fill pays, read off the fill router,
 * beside whether this app routes at all. Rendered whenever the chain has a
 * fill router, on or off, because a user who can be routed deserves the
 * number and a tenant who turned it off deserves to see what they declined.
 */
function RoutingFees(): ReactElement | null {
  const cfg = resolveConfig();
  const fee = useAsync(() => readFillRouterFee(), []);
  const service = useRouterService();
  if (cfg.contracts.fillRouter === null && cfg.routing.endpoint === undefined) return null;
  return (
    <section className="panel">
      <h2>Routed fills: what a trade filled off Gully Core pools pays</h2>
      <Async state={fee.state} onRetry={fee.reload} loadingLabel="Reading the fill router">
        {(f) =>
          f === null ? (
            <p className="state-hint">No GullyCoreFillRouter is recorded for {cfg.core.name}, so no trade here can be routed off Gully Core pools.</p>
          ) : (
            <>
              <dl className="kv">
                <dt>Routing fee, on a third-party fill</dt>
                <dd>
                  {formatBps(f.feeBps)} of the input, to the protocol
                  {f.pending === null ? "" : ` (changing to ${formatBps(f.pending.feeBps)} at ${new Date(f.pending.effectiveAt * 1000).toISOString()})`}
                </dd>
                <dt>On a Gully Core pool</dt>
                <dd>0 — a fill on a Gully Core pool pays no routing fee, which is what makes a Gully Core pool the cheaper venue.</dd>
                <dt>Cap</dt>
                <dd>{formatBps(f.maxFeeBps)}, immutable; an increase lands only after public notice, a decrease at once.</dd>
                <dt>Fill router</dt>
                <dd>
                  <ExplorerLink href={explorerAddressUrl(f.address)} className="mono">
                    {f.address}
                  </ExplorerLink>
                  {cfg.routing.customFillRouter ? " (your own, from routing.fillRouter)" : ""}
                </dd>
                <dt>In this app</dt>
                <dd>
                  {cfg.routing.endpoint === undefined
                    ? `Off. ${cfg.routing.reason ?? ""}`
                    : service.status === "ready"
                      ? service.data.k === "served"
                        ? `On, through ${cfg.routing.custom ? "your router API" : "Gully Core's router API"}${service.data.venues.length > 0 ? `: ${service.data.venues.join(", ")}` : ""}.`
                        : `Off. ${service.data.reason}`
                      : service.status === "error"
                        ? `The router API could not be reached (${service.error.message}).`
                        : "Asking the router API…"}
                </dd>
              </dl>
              <p className="state-hint">
                This fee is the protocol&rsquo;s, charged by Gully Core&rsquo;s fill router on the input of a routed fill; this app does not earn it.
                A routed quote shows it as its own line beside the price impact, never folded into either.
              </p>
            </>
          )
        }
      </Async>
    </section>
  );
}

/**
 * The fees a LAUNCH pays, separate from the three a swap pays. Rendered only
 * when a `LaunchpadKitV2` is configured; every number is read off the kit and
 * its lockers, and the tenant terms are whichever the kit will enforce.
 */
function LaunchFees(): ReactElement | null {
  const cfg = resolveConfig();
  const resource = useAsync(() => readKitV2Bounds(), [cfg.launchpadKitV2, cfg.launchTenant]);
  if (cfg.launchpadKitV2 === null) return null;
  return (
    <section className="panel">
      <h2>Launches: what a locked launch pays</h2>
      <Async state={resource.state} onRetry={resource.reload} loadingLabel="Loading launch terms">
        {(b) => (
          <>
            <dl className="kv">
              <dt>Protocol launch fee</dt>
              <dd>
                {formatEther(b.value.launchFeeWei)} {cfg.nativeCurrency.symbol} once, at launch
                {b.value.pending === null
                  ? ""
                  : ` (rising to ${formatEther(b.value.pending.feeWei)} at ${new Date(Number(b.value.pending.effectiveAt) * 1000).toISOString()})`}
              </dd>
              <dt>This app&rsquo;s launch fee</dt>
              <dd>
                {formatEther(b.integrator.launchFeeWei)} {cfg.nativeCurrency.symbol} once, at launch
                {b.integrator.launchFeeWei > 0n ? `, to ${shortAddress(b.integrator.address)}` : ""}
              </dd>
              <dt>{b.feeSplit !== null ? "Trading fee of every launch" : "LP fees of every locked position"}</dt>
              <dd>
                {formatBps(launchSplitBounds(b).minProtocolBps)} to {formatBps(launchSplitBounds(b).maxProtocolBps)} to the protocol (the
                creator picks, {formatBps(cfg.launch.defaultProtocolBps)} proposed) · {formatBps(b.integrator.bps)} to
                this app · the rest to the creator.{" "}
                {b.feeSplit !== null
                  ? `Paid in each pool’s quote currency on every trade, buys and sells alike. ${feeDividedLine(lpShareOfPools(b.lpShareBps, []))} Fixed per launch, forever; the locked liquidity ${lockedEarnsWords(lpShareOfPools(b.lpShareBps, []))}.`
                  : "Frozen per lock, forever."}
              </dd>
              <dt>Core protocol fee on launch pools</dt>
              <dd>
                Whatever the fee controller sets for them; Gully Core&rsquo;s stated policy is zero on kit-created
                locked pools. The Pools screen shows the fee each pool actually carries.
              </dd>
            </dl>
            <p className="state-hint">
              Terms are {b.integrator.source === "tenant" ? "this Launchpad’s stored terms" : "gullycore.config.ts (direct launches; nothing on chain enforces them)"}
              . Caps are immutable: integrator share at most {formatBps(launchSplitBounds(b).maxIntegratorBps)}, integrator launch
              fee at most {formatEther(b.maxIntegratorLaunchFeeWei)} {cfg.nativeCurrency.symbol}, protocol launch fee at
              most {formatEther(b.maxLaunchFeeWei)} {cfg.nativeCurrency.symbol} and only raised after public notice.
            </p>
          </>
        )}
      </Async>
    </section>
  );
}

export function Fees(): ReactElement {
  const cfg = resolveConfig();
  const resource = useAsync(() => readProtocolStatus(), []);

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>Fees</h1>
        <p className="page-sub">
          Three fees stack on one trade. All three are below, and the on-chain two are read live.
        </p>
      </header>

      <section className="panel">
        <h2>1 · The pool&rsquo;s LP fee</h2>
        <p>
          Set by whoever created the pool, taken from the input, and paid to the liquidity
          providers in range. It differs per pool, so there is no single number to show here — the
          Pools screen lists each one, and the swap widget shows the fee on the route it picked.
        </p>
        <p>
          A launch pool may charge its trading fee another way: the fee is paid in the pool&rsquo;s quote currency,
          on buys and sells alike. On a buy, part of the trading fee goes to the pool&rsquo;s liquidity providers; the
          launch contract takes the rest. On a sell the launch contract takes all of it. The swap widget then shows
          the whole trading fee, with the currency it is paid in.
        </p>
      </section>

      <Async
        state={resource.state}
        onRetry={resource.reload}
        loadingLabel="Loading fees"
      >
        {(status) => (
          <>
            <section className="panel">
              <h2>2 · Gully Core&rsquo;s protocol fee</h2>
              {!status.controllerWired ? (
                <p>
                  <strong>Zero.</strong> The shared pool manager&rsquo;s{" "}
                  <code>protocolFeeController</code> is the zero address, so no protocol fee is in
                  force on this chain today. A controller can be deployed and still be inert; this
                  is read from the slot that settles it rather than from the controller itself.
                </p>
              ) : (
                <>
                  <p>
                    <strong>{formatPips(status.effectiveProtocolFeePips)}</strong> of the input, set
                    by the controller at{" "}
                    <ExplorerLink href={explorerAddressUrl(status.feeController)}>
                      {shortAddress(status.feeController)}
                    </ExplorerLink>
                    .
                  </p>
                  {status.effectiveProtocolFeePips === 0 ? (
                    <p className="state-hint">
                      A controller is wired but is currently charging nothing, either because it is
                      disabled or because no default is set.
                    </p>
                  ) : null}
                </>
              )}
              <p className="state-hint">
                Capped at {formatPips(status.maxProtocolFeePips)} by core&rsquo;s{" "}
                <code>MAX_PROTOCOL_FEE</code>. This app cannot change it: the controller belongs to
                Gully Core governance, and that is the trade for running on core that is already
                deployed, verified and exercised.
              </p>
            </section>

            <section className="panel">
              <h2>3 · This app&rsquo;s fee</h2>
              {cfg.fee.active ? (
                <>
                  <p>
                    <strong>{formatBps(cfg.fee.bps)}</strong> of the swap <em>output</em>, paid to{" "}
                    <ExplorerLink href={explorerAddressUrl(cfg.fee.wallet)}>
                      {cfg.fee.wallet}
                    </ExplorerLink>{" "}
                    in the same transaction as the swap.
                  </p>
                  <p className="state-hint">
                    Taken from the output, not the input, so it is not additive with the two above
                    — adding a pip figure and a bps figure taken from opposite sides of a trade
                    produces a number that is wrong in both directions.
                  </p>
                </>
              ) : (
                <p>
                  <strong>Nothing.</strong> <code>fee.bps</code> is 0 in{" "}
                  <code>gullycore.config.ts</code>, so this front end takes no cut.
                </p>
              )}
            </section>

            <section className="panel">
              <h2>Where this app runs</h2>
              <dl className="kv">
                <dt>Chain</dt>
                <dd>
                  {status.chainName} ({status.chainId})
                </dd>
                <dt>Vault</dt>
                <dd>
                  <ExplorerLink href={explorerAddressUrl(status.vault)}>
                    {status.vault}
                  </ExplorerLink>
                </dd>
                <dt>Vault owner</dt>
                <dd className="mono">{status.vaultOwner}</dd>
                <dt>CL manager registered</dt>
                <dd>{status.clRegistered ? "yes" : "no — nothing will work"}</dd>
              </dl>
              <p className="state-hint">
                These are Gully Core&rsquo;s contracts, not this app&rsquo;s. Your pools live in that
                Vault. You did not deploy it, you cannot upgrade it, and neither can anyone
                operating this front end.
              </p>
            </section>

            <LaunchFees />

            <RoutingFees />

          </>
        )}
      </Async>
    </div>
  );
}
