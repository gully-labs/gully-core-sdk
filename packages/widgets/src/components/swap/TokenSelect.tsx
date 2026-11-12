// SPDX-License-Identifier: MIT
/**
 * The token selector: a Radix Dialog with search, common tokens, balances for
 * the connected account and paste-an-address lookup through the adapter.
 *
 * Tokens carry their provenance. An entry that came from a token list
 * (`SwapWidget`'s `tokenLists`) is grouped under that list's name and says
 * which other lists also carry it; the adapter's own tokens - the tokens of the
 * pools this site routes through - come first, ungrouped. A tokenised stock
 * (`extensions.stock`) gets an issuer badge, and a REBASING one a warning,
 * because the issuer's control over the token is the thing a trader has to
 * know before choosing it. A pasted address that is in no list is looked up on
 * chain and labelled as unlisted; it is never silently promoted.
 *
 * Portals render INTO the widget root (see `PortalContainer`) rather than
 * `document.body`, so the same component works inside the shadow-root web
 * component, where body-level portals would render unstyled.
 */

import type { ReactElement } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import type { TokenInfo } from "../../adapters/protocol.js";
import { useOptionalWidgetContext, useWidgetContext } from "../../context/WidgetProvider.js";
import { formatAmount, shortAddress } from "../../core/format.js";
import { groupBySource, resolveLogoUrl } from "../../core/tokenLists.js";
import { useAccount } from "../../hooks/useTokens.js";
import { usePortalContainer } from "../portal.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A token's logo, or a monogram of its symbol. `https://` loads directly;
 * `ipfs://` resolves through the SDK's first allow-listed gateway; a URL that
 * fails to load falls back to the monogram rather than a broken image.
 */
export function TokenLogo(props: { readonly token: TokenInfo | null; readonly size?: number }): ReactElement {
  const size = props.size ?? 24;
  const t = props.token;
  const fromList = useContext(TokenLogoLookup);
  const host = useOptionalWidgetContext()?.tokenLogo;
  /* The host's answer first (a launch token's own icon, verified against its CID; the chain's native
     mark), else the token's own logo, else the widget's lists for that address (a pinned token passed
     without one), else the monogram. */
  const src = t === null ? null : (resolveLogoUrl(host?.(t)) ?? resolveLogoUrl(t.logoUrl) ?? resolveLogoUrl(fromList?.(t)));
  const [failed, setFailed] = useState<string | null>(null);
  if (src !== null && failed !== src) {
    return <img className="gullycore-token-logo" src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
  }
  const label = (t?.symbol ?? "?").slice(0, 4).toUpperCase();
  return (
    <span
      className="gullycore-token-logo gullycore-token-logo--initials"
      style={{ width: size, height: size, fontSize: Math.round(size * (label.length > 3 ? 0.3 : 0.38)), ["--gullycore-mono-hue" as string]: String(hueOf(t?.address ?? label)) }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

/** The logo the widget's merged lists carry for a token's address, for tokens handed over without one. */
export const TokenLogoLookup = createContext<((token: TokenInfo) => string | undefined) | null>(null);

/** A stable hue per token (0-359), so a token without a logo is still recognisable at a glance. */
export function hueOf(key: string): number {
  let h = 2166136261;
  const k = key.toLowerCase();
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

function SearchGlyph(): ReactElement {
  return (
    <svg className="gullycore-search-wrap__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/** The badges a row carries: the issuer of a stock, a rebasing warning, a test-token mark. */
export function TokenBadges(props: { readonly token: TokenInfo }): ReactElement | null {
  const t = props.token;
  const badges: { key: string; label: string; tone: "info" | "warn" | "muted"; title: string }[] = [];
  if (t.stock !== undefined) {
    badges.push({ key: "stock", label: `${t.stock.issuer} · ${t.stock.ticker}`, tone: "info", title: `Tokenised stock issued by ${t.stock.issuer} (underlying ${t.stock.ticker}). The issuer can pause transfers and upgrade the token.` });
    if (t.stock.rebasing) badges.push({ key: "rebasing", label: "rebasing", tone: "warn", title: "The issuer rescales balances. Not usable as a Gully Core pool currency." });
  }
  if (t.note !== undefined) badges.push({ key: "note", label: t.note, tone: "warn", title: `${t.symbol}: ${t.note}` });
  if (t.tags?.includes("test")) badges.push({ key: "test", label: "test token", tone: "muted", title: "A throwaway token with no economic meaning." });
  if (t.tags?.includes("launch")) badges.push({ key: "launch", label: "launch", tone: "muted", title: "Launched on Gully Core; its launch pools are locked forever." });
  if (badges.length === 0) return null;
  return (
    <span className="gullycore-token-row__badges">
      {badges.map((b) => (
        <span key={b.key} className="gullycore-badge" data-gullycore-tone={b.tone} title={b.title}>
          {b.label}
        </span>
      ))}
    </span>
  );
}

/**
 * The read-only form of the selector, for a pinned pair (`SwapWidget`'s
 * `lockPair`): the same chip, the token it shows, no chevron and no dialog.
 * A `<span>`, not a disabled button, so it is not announced as a control that
 * happens to be off; the label says the pair is fixed.
 */
export function TokenChip(props: { readonly value: TokenInfo | null; readonly label: string }): ReactElement {
  return (
    <span className="gullycore-token-button gullycore-token-button--locked" role="img" aria-label={`${props.label}: ${props.value?.symbol ?? "loading"} (fixed)${props.value?.note !== undefined ? ` (${props.value.note})` : ""}`} title={props.value?.note !== undefined ? `${props.value.note}. This pair is fixed on this page` : "This pair is fixed on this page"}>
      <TokenLogo token={props.value} size={20} />
      <span className="gullycore-token-button__symbol">{props.value?.symbol ?? "…"}</span>
    </span>
  );
}

export interface TokenSelectProps {
  readonly value: TokenInfo | null;
  readonly tokens: readonly TokenInfo[];
  readonly onChange: (token: TokenInfo) => void;
  /** The other side of the pair, greyed out in the list. */
  readonly exclude?: TokenInfo | null;
  readonly label: string;
  /** Lists that were asked for and did not load, shown as a note so an empty group is explained. */
  readonly listFailures?: readonly { readonly url: string; readonly message: string }[];
  /** `true` while lists are still loading. */
  readonly listsLoading?: boolean;
}

/** The trigger button plus its dialog. */
export function TokenSelect(props: TokenSelectProps): ReactElement {
  const { adapter } = useWidgetContext();
  const container = usePortalContainer();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [pasted, setPasted] = useState<TokenInfo | null | "loading" | "none">("none");

  /* Balances for the list, read once per open per account. Read, never guessed:
     a row without a balance shows nothing there. */
  useEffect(() => {
    if (!open || account.data === null || account.data === undefined) return;
    let cancelled = false;
    const owner = account.data;
    void Promise.all(
      props.tokens.map(async (t) => {
        try {
          return [t.address.toLowerCase(), await adapter.getBalance(t, owner)] as const;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const next: Record<string, bigint> = {};
      for (const r of rows) if (r !== null) next[r[0]] = r[1];
      setBalances(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, account.data, props.tokens, adapter]);

  /* A pasted address that is not in the list is looked up on chain through the adapter. */
  useEffect(() => {
    const q = query.trim();
    if (!ADDRESS_RE.test(q)) {
      setPasted("none");
      return;
    }
    if (props.tokens.some((t) => t.address.toLowerCase() === q.toLowerCase())) {
      setPasted("none");
      return;
    }
    let cancelled = false;
    setPasted("loading");
    void adapter
      .getToken(q as Address)
      .then((t) => !cancelled && setPasted(t))
      .catch(() => !cancelled && setPasted(null));
    return () => {
      cancelled = true;
    };
  }, [query, props.tokens, adapter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list =
      q === ""
        ? props.tokens
        : props.tokens.filter(
            (t) =>
              t.symbol.toLowerCase().includes(q) ||
              t.name.toLowerCase().includes(q) ||
              t.address.toLowerCase() === q ||
              (t.stock !== undefined && (t.stock.ticker.toLowerCase().includes(q) || t.stock.issuer.toLowerCase().includes(q))),
          );
    /* Held tokens first, then the list's own order. */
    return [...list].sort((a, b) => {
      const ba = balances[a.address.toLowerCase()] ?? 0n;
      const bb = balances[b.address.toLowerCase()] ?? 0n;
      return ba === bb ? 0 : ba > bb ? -1 : 1;
    });
  }, [props.tokens, query, balances]);

  /* Groups only when at least one entry came from a list; a plain adapter list stays flat. */
  const grouped = useMemo(() => (filtered.some((t) => t.listSource !== undefined) ? groupBySource(filtered) : null), [filtered]);

  const common = props.tokens.slice(0, 5);
  const pick = (t: TokenInfo): void => {
    props.onChange(t);
    setOpen(false);
    setQuery("");
  };

  const row = (t: TokenInfo): ReactElement => {
    const bal = balances[t.address.toLowerCase()];
    const disabled = props.exclude?.address.toLowerCase() === t.address.toLowerCase();
    const alsoIn = t.listSource?.alsoIn ?? [];
    return (
      <li key={t.address}>
        <button type="button" className="gullycore-token-row" onClick={() => pick(t)} disabled={disabled} aria-selected={props.value?.address === t.address} role="option">
          <TokenLogo token={t} size={32} />
          <span className="gullycore-token-row__main">
            <span className="gullycore-token-row__symbol">
              {t.symbol}
              <TokenBadges token={t} />
            </span>
            <span className="gullycore-token-row__name">
              {t.name}
              {t.isNative ? "" : ` · ${shortAddress(t.address)}`}
              {alsoIn.length > 0 ? ` · also in ${alsoIn.join(", ")}` : ""}
            </span>
          </span>
          {bal !== undefined && bal > 0n ? (
            <span className="gullycore-token-row__balance">
              <span>{formatAmount(bal, t.decimals)}</span>
              <span className="gullycore-token-row__balance-sym">{t.symbol}</span>
            </span>
          ) : null}
          {props.value?.address.toLowerCase() === t.address.toLowerCase() ? (
            <span className="gullycore-token-row__check" aria-hidden="true">
              ✓
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="gullycore-token-button"
          aria-label={`${props.label}: ${props.value?.symbol ?? "choose a token"}${props.value?.note !== undefined ? ` (${props.value.note})` : ""}`}
          {...(props.value?.note !== undefined ? { title: props.value.note } : {})}
        >
          <TokenLogo token={props.value} size={20} />
          <span className="gullycore-token-button__symbol">{props.value?.symbol ?? "Select"}</span>
          <span className="gullycore-token-button__chevron" aria-hidden="true">
            ▾
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="gullycore-overlay" />
        <Dialog.Content className="gullycore-dialog" aria-describedby={undefined}>
          <div className="gullycore-dialog__head">
            <Dialog.Title className="gullycore-dialog__title">
              Select a token <span className="gullycore-dialog__count">{props.tokens.length}</span>
            </Dialog.Title>
            <Dialog.Close className="gullycore-icon-button" aria-label="Close">
              ×
            </Dialog.Close>
          </div>
          <div className="gullycore-search-wrap">
            <SearchGlyph />
            <input
              className="gullycore-search"
              type="text"
              autoFocus
              placeholder="Search or paste an address"
              aria-label="Search tokens"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {query !== "" ? (
              <button type="button" className="gullycore-search-wrap__clear" aria-label="Clear search" onClick={() => setQuery("")}>
                ×
              </button>
            ) : null}
          </div>
          {query === "" && common.length > 0 ? (
            <div className="gullycore-common">
              {common.map((t) => (
                <button key={t.address} type="button" className="gullycore-chip gullycore-chip--token" onClick={() => pick(t)} aria-pressed={props.value?.address === t.address}>
                  <TokenLogo token={t} size={18} /> {t.symbol}
                </button>
              ))}
            </div>
          ) : null}
          <ul className="gullycore-token-list" role="listbox" aria-label="Tokens">
            {pasted === "loading" ? <li className="gullycore-token-row gullycore-token-row--note">Loading the token…</li> : null}
            {pasted === null ? <li className="gullycore-token-row gullycore-token-row--note">That address does not answer as an ERC-20.</li> : null}
            {pasted !== "none" && pasted !== "loading" && pasted !== null ? (
              <li>
                <button type="button" className="gullycore-token-row gullycore-token-row--unlisted" onClick={() => pick(pasted)}>
                  <TokenLogo token={pasted} size={32} />
                  <span className="gullycore-token-row__main">
                    <span className="gullycore-token-row__symbol">
                      {pasted.symbol}
                      <span className="gullycore-token-row__badges">
                        <span className="gullycore-badge" data-gullycore-tone="warn" title="Read off the contract at this address. It is in none of this site's lists: check the address yourself before trading.">
                          unlisted
                        </span>
                      </span>
                    </span>
                    <span className="gullycore-token-row__name">
                      {pasted.name} · {shortAddress(pasted.address)} · not in any of this site&rsquo;s lists
                    </span>
                  </span>
                </button>
              </li>
            ) : null}
            {grouped === null
              ? (() => {
                  const held = filtered.filter((t) => (balances[t.address.toLowerCase()] ?? 0n) > 0n);
                  const rest = filtered.filter((t) => (balances[t.address.toLowerCase()] ?? 0n) === 0n);
                  if (held.length === 0) return filtered.map(row);
                  return (
                    <>
                      <li className="gullycore-token-group">
                        <span className="gullycore-token-group__label" role="presentation">
                          Your tokens
                        </span>
                        <ul className="gullycore-token-group__list" role="group" aria-label="Your tokens">
                          {held.map(row)}
                        </ul>
                      </li>
                      {rest.length > 0 ? (
                        <li className="gullycore-token-group">
                          <span className="gullycore-token-group__label" role="presentation">
                            All tokens
                          </span>
                          <ul className="gullycore-token-group__list" role="group" aria-label="All tokens">
                            {rest.map(row)}
                          </ul>
                        </li>
                      ) : null}
                    </>
                  );
                })()
              : grouped.map((g) => (
                  <li key={g.source ?? "__adapter"} className="gullycore-token-group">
                    <span className="gullycore-token-group__label" role="presentation">
                      {g.source ?? "Pools on this site"}
                    </span>
                    <ul className="gullycore-token-group__list" role="group" aria-label={g.source ?? "Pools on this site"}>
                      {g.tokens.map(row)}
                    </ul>
                  </li>
                ))}
            {filtered.length === 0 && pasted === "none" ? (
              <li className="gullycore-token-row gullycore-token-row--note gullycore-token-row--empty">
                No token matches &ldquo;{query.trim()}&rdquo;. Paste a contract address to look it up.
              </li>
            ) : null}
            {props.listsLoading === true ? <li className="gullycore-token-row gullycore-token-row--note">Loading token lists…</li> : null}
            {(props.listFailures ?? []).map((f) => (
              <li key={f.url} className="gullycore-token-row gullycore-token-row--note" title={f.message}>
                A token list did not load: {f.url}
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
