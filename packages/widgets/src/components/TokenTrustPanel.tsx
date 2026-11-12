// SPDX-License-Identifier: MIT
/**
 * `TokenTrustPanel`: one place, for one token, with what the Gully Core contracts
 * hold about it - its liquidity locks per pool (time-locked and permanent LP
 * locker, as the locked share of ACTIVE liquidity), its token locks and
 * vesting, the creator tax a Kit v2 launch guard takes, each pool's LP fee and
 * protocol fee, and what GullyCoreRegistry records about each pool's hook. Every
 * row names the contract, the view and the blocks it was read at.
 *
 * Read-only: a viem `PublicClient` and the chain's contract addresses from the
 * host's address book. No wallet, no provider. Four states, each distinct:
 * reading, the rows, "could not be read" when the chain does not answer, and
 * "coming soon" when `contracts` is `null` — a feature that has not arrived is not an outage, and the two read differently. It never says
 * "safe": a listing is what the registry records, not an audit.
 */

import type { ReactElement } from "react";
import { useEffect, useId } from "react";
import type { Address, Hex, PublicClient } from "viem";

import { useOptionalWidgetContext, type WidgetTheme } from "../context/WidgetProvider.js";
import { useTokenTrust, type TokenTrustTarget } from "../hooks/useTokenTrust.js";
import { tokenTrustView, type TrustRowView } from "../trust/model.js";
import { injectWidgetStyles } from "../styles/css.js";
import { ShareBar } from "./lockCharts.js";

export interface TokenTrustPanelProps extends TokenTrustTarget {
  readonly client: PublicClient;
  readonly theme?: WidgetTheme;
  readonly title?: string;
  /** Links each source contract to an explorer. Return `null` for no link (e.g. a devnet). */
  readonly explorerAddressUrl?: (address: Address) => string | null;
  /** Links each pool to its lock page. Return `null` for no link. */
  readonly poolLockUrl?: (poolId: Hex) => string | null;
  /** Anchor target for those links, e.g. `_blank` inside an iframe. */
  readonly linkTarget?: "_blank" | "_top" | "_self";
  readonly refetchIntervalMs?: number;
  readonly className?: string;
}

function linkProps(target: TokenTrustPanelProps["linkTarget"]): { target?: string; rel?: string } {
  return target === undefined || target === "_self" ? {} : { target, rel: "noopener noreferrer" };
}

function Row({ r, props }: { r: TrustRowView; props: TokenTrustPanelProps }): ReactElement {
  return (
    <div className="gullycore-trust__row" data-tone={r.tone}>
      <dt className="gullycore-trust__label">{r.label}</dt>
      <dd className="gullycore-trust__value">
        <p className="gullycore-trust__headline">
          <span className={`gullycore-trust__dot gullycore-trust__dot--${r.tone}`} aria-hidden="true" />
          <span>{r.headline}</span>
        </p>
        {r.share ? <ShareBar view={r.share} label={`${r.label}: ${r.headline}`} /> : null}
        {r.detail !== null ? <p className="gullycore-trust__detail">{r.detail}</p> : null}
        {r.sources.length > 0 ? (
          <p className="gullycore-trust__source">
            {r.sources.map((s, i) => {
              const href = props.explorerAddressUrl?.(s.address) ?? null;
              const text = r.provenance[i] ?? s.contract;
              return (
                <span key={`${s.address}${i}`} className="gullycore-trust__source-item">
                  {href === null ? (
                    text
                  ) : (
                    <a href={href} {...linkProps(props.linkTarget ?? "_blank")}>
                      {text}
                    </a>
                  )}
                </span>
              );
            })}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

export function TokenTrustPanel(props: TokenTrustPanelProps): ReactElement {
  const ctx = useOptionalWidgetContext();
  const theme = props.theme ?? ctx?.theme ?? "dark";
  const headingId = useId();
  useEffect(() => {
    injectWidgetStyles();
  }, []);
  const res = useTokenTrust(props.client, props, props.refetchIntervalMs === undefined ? {} : { refetchIntervalMs: props.refetchIntervalMs });
  const data = res.data;
  const view = data === null ? null : tokenTrustView(data.trust, data.symbols);

  let body: ReactElement;
  if (props.contracts === null) {
    body = (
      <p className="gullycore-trust__state" role="status">
        Gully Core is coming soon on this chain, so nothing about this token can be read from its contracts yet.
      </p>
    );
  } else if (view === null && res.status === "error") {
    body = (
      <p className="gullycore-trust__state gullycore-trust__state--error" role="alert">
        Couldn&rsquo;t load. Try again.{" "}
        <button type="button" className="gullycore-trust__retry" onClick={res.refetch}>
          Retry
        </button>
      </p>
    );
  } else if (view === null) {
    body = (
      <p className="gullycore-trust__state" role="status">
        Loading…
      </p>
    );
  } else {
    body = (
      <>
        <dl className="gullycore-trust__list">
          <Row r={view.launch} props={props} />
          <Row r={view.tokenLocks} props={props} />
          <Row r={view.creatorTax} props={props} />
        </dl>
        <h3 className="gullycore-trust__subhead">Pools</h3>
        {view.pools.length === 0 ? (
          <p className="gullycore-trust__state">No pool of this token was found through a Gully Core launch, lock or this page&rsquo;s pool list.</p>
        ) : (
          view.pools.map((p) => {
            const href = props.poolLockUrl?.(p.poolId) ?? null;
            return (
              <section key={p.poolId} className="gullycore-trust__pool" aria-label={p.title}>
                <header className="gullycore-trust__pool-head">
                  <strong>{p.title}</strong>
                  <code title={p.poolId}>
                    {p.poolId.slice(0, 10)}…{p.poolId.slice(-6)}
                  </code>
                  {href !== null ? (
                    <a className="gullycore-trust__link" href={href} {...linkProps(props.linkTarget)}>
                      Locks →
                    </a>
                  ) : null}
                </header>
                <p className="gullycore-trust__found">{p.foundBy}</p>
                <dl className="gullycore-trust__list">
                  {p.rows.map((r) => (
                    <Row key={r.key} r={r} props={props} />
                  ))}
                </dl>
              </section>
            );
          })
        )}
        {view.failedPools.map((f) => (
          <p key={f} className="gullycore-trust__state gullycore-trust__state--error">
            {f}
          </p>
        ))}
        <p className="gullycore-note">{view.discoveryNote}</p>
        {res.status === "error" ? <p className="gullycore-note gullycore-note--warn">The last refresh failed; these rows are from the previous read.</p> : null}
        <p className="gullycore-footer gullycore-footer--brand">{view.readAtNote}</p>
      </>
    );
  }

  return (
    <section className={`gullycore-widget gullycore-trust${props.className ? ` ${props.className}` : ""}`} data-gullycore-theme={theme} aria-labelledby={headingId}>
      <header className="gullycore-header">
        <h2 id={headingId} className="gullycore-title">
          {props.title ?? "What the contracts say"}
        </h2>
      </header>
      {body}
    </section>
  );
}
