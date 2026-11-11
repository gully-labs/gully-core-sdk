// SPDX-License-Identifier: MIT
/**
 * Lock badges beside pools and launched tokens.
 *
 * TOKENS use `@gullylabs/core-widgets`' `LocksBadge` as it ships: it reads the
 * token's locks in `GullyCoreTokenLock` through the SDK and says exactly that.
 *
 * POOLS use the widgets' own view model (`poolBadgeView`, the same words and
 * the same `gullycore-locks` styles) over a summary this app reads itself, because
 * a pool's locked liquidity has TWO sources and the widget's pool reader
 * currently reads one: time locks in `GullyCorePositionLock`, and positions the
 * protocol's LP locker holds forever (every Kit v2 launch seeds its pools
 * there, and anyone can lock a position into it). A badge that saw only the
 * first would print "No locked liquidity" over a launch pool whose seed is
 * locked permanently — a false statement next to a real pool. This reader
 * passes both to the SDK's `readPoolLocks` / `summarizePoolLocks`, so the
 * share it shows is time-locked plus permanent, and it says which is which.
 */

import { LocksBadge, formatCountdown, poolBadgeView, useChainClock } from "@gullylabs/core-widgets";
import { useMemo, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type { Address, Hex } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "../lib/client";
import { useAsync } from "../lib/useAsync";
import { readPoolLockSummary } from "../lib/utilities";

/** One line for a CL pool: the locked share of its active liquidity, the next unlock, a link. */
export function PoolLockBadge({ poolId, detail = false }: { poolId: Hex; detail?: boolean }): ReactElement {
  const cfg = resolveConfig();
  const resource = useAsync(() => readPoolLockSummary(poolId), [poolId]);
  const data = resource.state.status === "ready" ? resource.state.data : null;
  /* The moment the read landed, so the countdown advances from the chain's own clock. */
  const readAtMs = useMemo(() => (data === null ? null : Date.now()), [data]);
  const now = useChainClock(data?.now ?? null, readAtMs);
  const view = data === null ? null : poolBadgeView(data);

  let body: ReactElement;
  if (resource.state.status === "loading") {
    body = <p className="gullycore-locks__headline gullycore-locks__headline--muted">Loading locks…</p>;
  } else if (resource.state.status === "error") {
    body = <p className="gullycore-locks__headline gullycore-locks__headline--error">Couldn&rsquo;t load locks. Try again.</p>;
  } else if (view === null) {
    body = (
      <p className="gullycore-locks__headline">
        <span className="gullycore-locks__dot gullycore-locks__dot--none" aria-hidden="true" />
        No Gully Core position lock or LP locker is deployed on {cfg.core.name}
      </p>
    );
  } else {
    body = (
      <>
        <p className="gullycore-locks__headline">
          <span className={`gullycore-locks__dot gullycore-locks__dot--${view.tone}`} aria-hidden="true" />
          <span>{view.headline}</span>
        </p>
        {detail && view.detail !== null ? <p className="gullycore-note">{view.detail}</p> : null}
        {view.countdownTo !== null && now !== null ? (
          <p className="gullycore-locks__countdown">
            <span className="gullycore-locks__timer">{formatCountdown(view.countdownTo - now)}</span> to {view.countdownLabel}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="gullycore-widget gullycore-locks gullycore-locks--badge" data-gullycore-theme="dark" data-tone={view?.tone ?? "none"}>
      {body}
      {detail ? null : (
        <Link className="gullycore-locks__link" to={`/locks/pool/${poolId}`}>
          Locks for this pool →
        </Link>
      )}
    </div>
  );
}

/** The widgets' token badge, pointed at this chain's `GullyCoreTokenLock`, linking to this app's page. */
export function TokenLockBadge({ token }: { token: Address }): ReactElement {
  const cfg = resolveConfig();
  return (
    <div className="lock-badge-wrap">
      <LocksBadge
        client={publicClient()}
        target={{ kind: "token", token, tokenLock: cfg.utilities.tokenLock }}
        native={{ symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals }}
      />
      <Link className="gullycore-locks__link" to={`/locks/token/${token}`}>
        Token locks →
      </Link>
    </div>
  );
}
