// SPDX-License-Identifier: MIT
/**
 * Swap.
 *
 * The widget itself comes from `@gullylabs/core-widgets`: it quotes every
 * Gully Core pool, asks the configured router API for a routed fill when one is
 * on, pays the native coin straight into a wrapped-native pool (wrap and swap
 * in one transaction), grants Permit2 by signature, simulates the exact bytes
 * before every send, and takes this app's fee as a `TAKE_PORTION` action
 * inside the swap plan. Everything around it exists to make the cost legible:
 * the fee this front end takes is disclosed on the page rather than only in a
 * settings panel, because a fee a user finds out about afterwards is a fee
 * they were not told about.
 */

import { SwapWidget, useWidgetContext, type TokenInfo } from "@gullylabs/core-widgets";
import { useMemo, type ReactElement } from "react";
import { Link } from "react-router-dom";

import { NotConfigured } from "../components/States";
import { resolveConfig } from "../config/resolve";
import { formatBps } from "../lib/format";
import { useRouterService } from "../lib/routing";
import { usdPerUnit, useUsdQuote } from "../lib/usd";
import { useAsync } from "../lib/useAsync";

/** One line on routed fills: on and where, or off and why. Read, never assumed. */
function RoutingLine(): ReactElement {
  const cfg = resolveConfig();
  const service = useRouterService();
  if (cfg.routing.endpoint === undefined) {
    return (
      <>
        <strong>Routed fills</strong> — off. {cfg.routing.reason}
      </>
    );
  }
  if (service.status === "loading") {
    return (
      <>
        <strong>Routed fills</strong> — asking {cfg.routing.custom ? "your router API" : "Gully Core's router API"} whether it serves {cfg.core.name}…
      </>
    );
  }
  if (service.status === "error") {
    return (
      <>
        <strong>Routed fills</strong> — the router API could not be reached ({service.error.message}); every swap goes through Gully Core pools until it can.
      </>
    );
  }
  const s = service.data;
  if (s.k !== "served") {
    return (
      <>
        <strong>Routed fills</strong> — off. {s.reason} Every swap goes through Gully Core pools.
      </>
    );
  }
  return (
    <>
      <strong>Routed fills</strong> — on. When {s.venues.length === 0 ? "a third-party venue" : s.venues.join(", ")} pays more than every Gully Core pool, the trade
      is filled there through Gully Core&rsquo;s fill router and pays Gully Core&rsquo;s routing fee, shown on the quote as its own line (
      <Link to="/fees">the live rate</Link>); a fill on a Gully Core pool pays none. {cfg.routing.custom ? "Quotes come from your own router API." : ""}
    </>
  );
}

export function Swap(): ReactElement {
  const cfg = resolveConfig();
  const { adapter } = useWidgetContext();
  /* What the picker actually holds: the configured list plus the tokens of every
     pool found on this core (App.tsx merges them). The native asset is always
     there, so "one token" means there is nothing to swap it against. */
  const listed = useAsync(() => adapter.listTokens(), [adapter]);
  const tokenCount = listed.state.status === "ready" ? listed.state.data.length : cfg.tokens.length + 1;
  /* The lists gullycore.config.ts names ("gullycore" already resolved to the chain's
     published URL). The widget fetches and schema-checks each one and names a
     list that did not load inside the picker. */
  const tokenLists = useMemo(() => cfg.tokenLists.map((url) => ({ url })), [cfg.tokenLists]);
  /* ≈ $ under a well, only from the chain's native/USD feed read on chain: the
     native coin and its wrapped form. Every other token shows no dollar figure. */
  const usd = useUsdQuote();
  const weth = cfg.contracts.weth ?? null;
  const usdPrice = useMemo(() => (token: TokenInfo) => usdPerUnit(token.address, weth, usd), [usd, weth]);

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>Swap</h1>
        <p className="page-sub">
          Routed through the Gully Core core deployed on {cfg.core.name}. Your pools, our Vault.
        </p>
      </header>

      {tokenCount <= 1 ? (
        <NotConfigured
          what="The token list"
          field="tokens"
          detail={
            <>
              No pool has been initialised on this core yet and <code>tokens</code> is empty, so the
              picker holds only the native asset and there is nothing to swap it against. Tokens of
              every pool that exists are offered automatically; add entries to <code>tokens</code> to
              list more (symbols and decimals are read back off each contract, so a wrong entry is
              reported rather than shown).
            </>
          }
        />
      ) : (
        <SwapWidget title="Swap" tokenLists={tokenLists} usdPrice={usdPrice} />
      )}

      <section className="disclosure">
        <h2>What this swap costs</h2>
        <ul>
          <li>
            <strong>Pool LP fee</strong> — set by whoever created the pool, taken from the input.
            It differs per pool; the widget shows the one being routed through. A launch pool
            charges no LP fee and takes a trading fee in the pool&rsquo;s quote currency instead, on
            buys and sells alike, with a creator tax where one is set; the widget shows each as its
            own line.
          </li>
          <li>
            <strong>Gully Core protocol fee</strong> — set by Gully Core governance on the shared pool
            manager and capped at 0.4% by core. It is frequently zero.{" "}
            <Link to="/fees">Read the live value.</Link>
          </li>
          <li>
            <RoutingLine />
          </li>
          <li>
            <strong>A buy on a launch pool is sized from its quote.</strong> The launch contract takes
            its fee on the amount named, so a buy larger than the pool can fill is refused
            (<code>SwapNotFilled</code>) rather than partly filled and over-charged; the widget says
            so and asks for a smaller amount.
          </li>
          <li>
            <strong>Token lists</strong> —{" "}
            {cfg.tokenLists.length === 0 ? (
              <>none configured; the picker offers the configured tokens and every pool&rsquo;s tokens.</>
            ) : (
              <>
                the picker also offers {cfg.tokenLists.length} list{cfg.tokenLists.length === 1 ? "" : "s"} named in <code>gullycore.config.ts</code>, first
                list wins on a duplicate address. A pasted address is read off its contract and marked unlisted.
              </>
            )}
          </li>
          <li>
            <strong>This app&rsquo;s fee</strong> —{" "}
            {cfg.fee.active ? (
              <>
                {formatBps(cfg.fee.bps)} of the swap <em>output</em>, paid to{" "}
                <code>{cfg.fee.wallet}</code> in the same transaction as the swap.
              </>
            ) : (
              <>nothing. This front end takes no fee today.</>
            )}
          </li>
          <li>
            <strong>Dollar figures</strong> —{" "}
            {usd === null ? (
              <>none shown: no native/USD price was read for {cfg.core.name}, and nothing here estimates one.</>
            ) : (
              <>
                shown only for {usd.nativeSymbol} and its wrapped form, from {usd.provenance.source} {usd.nativeSymbol}/USD read on chain. Every
                other token stays in its own units.
              </>
            )}
          </li>
        </ul>
      </section>
    </div>
  );
}
