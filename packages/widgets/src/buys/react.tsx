// SPDX-License-Identifier: MIT
/**
 * `BuysFeed`: the buy alert widget for React hosts.
 *
 * It registers `<gully-buys>` once and renders it with the props as attributes,
 * so a React app and a plain page draw the same DOM from the same source
 * (`./element.ts`); nothing is implemented twice.
 *
 * ```tsx
 * <BuysFeed chain={8453} token="0x…" layout="feed" theme="auto" />
 * ```
 */

import { createElement, useEffect, type ReactElement } from "react";

import { defineGullyBuys } from "./element.js";
import { BUYS_TAG, type BuysLayout, type BuysTheme } from "./model.js";

export interface BuysFeedProps {
  readonly chain: number;
  /** The token's address (every Gully Core pool of it), or `pool` for one pool id. */
  readonly token?: string;
  readonly pool?: string;
  readonly layout?: BuysLayout;
  readonly theme?: BuysTheme;
  /** Sells shown too. */
  readonly sells?: boolean;
  /** Dollars per emoji on the scale (default 10). */
  readonly stepUsd?: number;
  readonly emoji?: string;
  /** Trades under this many dollars are hidden. */
  readonly minUsd?: number;
  readonly limit?: number;
  /** An RPC URL to read through instead of Gully RPC's keyless project. */
  readonly rpc?: string;
  /** The Gully Core API base (`…/v1`), e.g. `/v1` on the app's own origin. */
  readonly api?: string;
  /** The app origin token links open on. */
  readonly site?: string;
  readonly corner?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  readonly pollSeconds?: number;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}

export function BuysFeed(p: BuysFeedProps): ReactElement {
  useEffect(() => defineGullyBuys(), []);
  const attrs: Record<string, string | undefined> = {
    chain: String(p.chain),
    token: p.token,
    pool: p.pool,
    layout: p.layout,
    theme: p.theme,
    sells: p.sells === true ? "" : undefined,
    step: p.stepUsd === undefined ? undefined : String(p.stepUsd),
    emoji: p.emoji,
    min: p.minUsd === undefined ? undefined : String(p.minUsd),
    limit: p.limit === undefined ? undefined : String(p.limit),
    rpc: p.rpc,
    api: p.api,
    site: p.site,
    corner: p.corner,
    poll: p.pollSeconds === undefined ? undefined : String(p.pollSeconds),
    class: p.className,
  };
  const defined: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) defined[k] = v;
  return createElement(BUYS_TAG, { ...defined, ...(p.style === undefined ? {} : { style: p.style }) });
}
