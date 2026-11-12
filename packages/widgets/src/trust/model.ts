// SPDX-License-Identifier: MIT
/**
 * Token trust: the pure half of `TokenTrustPanel`.
 *
 * Turns the SDK's `readTokenTrust` result into labelled rows, each carrying
 * the words (from `@gullylabs/core-sdk/trust`'s formatters, so every surface
 * says the same thing) and the contract each figure came from (name and
 * address, linkable; no view names or block numbers in user copy — owner rule
 * 2026-09-27). Nothing is added that was not read; nothing says "safe".
 */

import type { Address, Hex } from "viem";
import {
  describeCreatorTax,
  describeLaunch,
  describeLiquidity,
  describeLpFee,
  describeProtocolFee,
  describeRegistry,
  describeTokenLocks,
  formatTrustSource,
  summarizeTokenTrust,
  type PoolTrust,
  type TokenTrust,
  type TokenTrustSummary,
  type TrustLine,
  type TrustSource,
  type TrustTone,
} from "@gullylabs/core-sdk/trust";
import { shareBarFromBps, tokenShareBar, type ShareBarView } from "../locks/model.js";

export interface TrustRowView {
  readonly key: string;
  readonly label: string;
  readonly headline: string;
  readonly detail: string | null;
  readonly tone: TrustTone;
  /** One line per source: "GullyCoreTokenLock 0x12ab…cdef". */
  readonly provenance: readonly string[];
  /** The same sources, for linking each contract to an explorer. */
  readonly sources: readonly TrustSource[];
  /** A locked-share bar for the rows that measure one (liquidity, token locks); `null` otherwise. */
  readonly share?: ShareBarView | null;
}

export interface TrustPoolView {
  readonly poolId: Hex;
  readonly title: string;
  /** How the pool was found, in words. */
  readonly foundBy: string;
  readonly rows: readonly TrustRowView[];
}

export interface TokenTrustView {
  readonly summary: TokenTrustSummary;
  readonly launch: TrustRowView;
  readonly tokenLocks: TrustRowView;
  readonly creatorTax: TrustRowView;
  readonly pools: readonly TrustPoolView[];
  /** Pools found but not described, one sentence each. */
  readonly failedPools: readonly string[];
  /** Which pools are listed, and that the list is not every pool of the token. */
  readonly discoveryNote: string;
  readonly readAtNote: string;
}

type Sectionish = { readonly status: string; readonly sources?: readonly TrustSource[]; readonly source?: TrustSource | null };

function sourcesOf(s: Sectionish): readonly TrustSource[] {
  if (s.status === "read") return s.sources ?? [];
  if (s.status === "error" && s.source) return [s.source];
  return [];
}

function row(key: string, label: string, line: TrustLine, sources: readonly TrustSource[], t: Pick<TokenTrust, "readAt">): TrustRowView {
  return { key, label, headline: line.headline, detail: line.detail, tone: line.tone, provenance: sources.map((s) => formatTrustSource(s, t.readAt).split(" · ")[0] ?? s.contract), sources };
}

const ORIGIN_WORDS: Record<PoolTrust["origins"][number], string> = {
  "launch-leg": "a Kit v2 launch leg",
  "lp-locker": "an LP-locker lock",
  "position-lock": "a GullyCorePositionLock time lock",
  given: "this page's pool list",
};

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Symbols the host resolved, by lowercase address; the short address otherwise. */
export type SymbolBook = Readonly<Record<string, string>>;

const labelOf = (book: SymbolBook, a: Address): string => book[a.toLowerCase()] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;

function poolView(p: PoolTrust, t: TokenTrust, book: SymbolBook): TrustPoolView {
  /* Where the launch guard takes the fee itself the row is the trading fee's, the whole of it: the pool's
     own LP fee is only the part of a buy's fee the guard leaves it, and nothing on a sell. */
  const launchTakesFee = p.lpFee.kind === "launch-guard" && p.lpFee.takenBy === "launch";
  const rows: TrustRowView[] = [
    {
      ...row("liquidity", "Liquidity locks", describeLiquidity(p.liquidity, p.kind), sourcesOf(p.liquidity), t),
      share:
        p.liquidity.status !== "read" || !p.liquidity.measurable
          ? null
          : p.kind === "Bin"
            ? shareBarFromBps([{ key: "permanent", label: "Locked permanently (LP locker)", bps: p.liquidity.lockedActiveBps }], "of the active bin")
            : shareBarFromBps(
                [
                  { key: "permanent", label: "Locked permanently (LP locker)", bps: p.liquidity.permanentActiveBps },
                  { key: "time", label: "Time-locked until a date", bps: p.liquidity.timeLockedActiveBps },
                ],
                "of active liquidity",
              ),
    },
    row("lp-fee", launchTakesFee ? "Trading fee" : "LP fee", describeLpFee(p.lpFee), p.lpFee.kind === "error" ? [] : p.lpFee.source === null ? [] : [p.lpFee.source], t),
    row("protocol-fee", "Protocol fee", describeProtocolFee(p.protocolFee), sourcesOf(p.protocolFee), t),
  ];
  if (p.tax.status !== "not-a-launch-pool") rows.push(row("tax", "Creator tax", describeCreatorTax(p.tax, t.readAt.chainNow, launchTakesFee ? "launch" : "pool"), sourcesOf(p.tax), t));
  rows.push(row("registry", "Hook in GullyCoreRegistry", describeRegistry(p.registry), p.registry.status === "no-hook" ? [] : sourcesOf(p.registry), t));
  return {
    poolId: p.poolId,
    title: `${t.symbol} / ${labelOf(book, p.pairedWith)} · ${p.kind} pool`,
    foundBy: `Found through ${joinWords(p.origins.map((o) => ORIGIN_WORDS[o]))}.`,
    rows,
  };
}

/** The token-level creator tax: from the launch, then its legs. */
function creatorTaxRow(t: TokenTrust): TrustRowView {
  const launch = t.launch;
  if (launch.status === "not-configured") {
    return row("tax", "Creator tax", { headline: "Coming soon", detail: "Gully Core launches are coming soon on this chain, so there is no creator tax to read.", tone: "missing" }, [], t);
  }
  if (launch.status === "error") {
    return row("tax", "Creator tax", { headline: "Could not be read", detail: `The launch read failed: ${launch.message}.`, tone: "error" }, sourcesOf(launch), t);
  }
  if (launch.launch === null) {
    return row("tax", "Creator tax", { headline: "Not a Gully Core launch", detail: "This token was not launched on Gully Core, so no Gully Core creator tax applies to it.", tone: "neutral" }, sourcesOf(launch), t);
  }
  const legs = t.pools.filter((p) => p.origins.includes("launch-leg") && p.tax.status !== "not-a-launch-pool");
  if (legs.length === 0) {
    return row("tax", "Creator tax", { headline: "Could not be read", detail: "No launch pool of this token could be described, so its tax was not read.", tone: "error" }, sourcesOf(launch), t);
  }
  const lines = legs.map((p) => describeCreatorTax(p.tax, t.readAt.chainNow));
  const sources = legs.flatMap((p) => sourcesOf(p.tax)).filter((s, i, a) => a.findIndex((x) => x.address.toLowerCase() === s.address.toLowerCase()) === i);
  const first = lines[0]!;
  if (lines.every((l) => l.headline === first.headline && l.detail === first.detail)) {
    return row("tax", "Creator tax", legs.length === 1 ? first : { ...first, detail: `${first.detail ?? ""} Same on all ${legs.length} launch pools.`.trim() }, sources, t);
  }
  return row("tax", "Creator tax", { headline: "Differs by pool", detail: "Each launch pool below carries its own terms.", tone: lines.some((l) => l.tone === "caution") ? "caution" : "neutral" }, sources, t);
}

/** Pure: every row of the trust panel from one read. */
export function tokenTrustView(t: TokenTrust, book: SymbolBook = {}): TokenTrustView {
  const searched = t.discovery.searched.map((o) => ORIGIN_WORDS[o]);
  const discoveryNote =
    `Pools listed are those found through ${searched.length === 0 ? "no source yet: these reads are coming soon on this chain" : joinWords(searched)}` +
    `${t.discovery.truncated ? ", and only the first of them were read" : ""}${t.discovery.positionLocksTruncated ? " (newest position locks only)" : ""}. ` +
    "A pool of this token that no Gully Core launch or lock knows about is not listed.";
  return {
    summary: summarizeTokenTrust(t),
    launch: row("launch", "Gully Core launch", describeLaunch(t.launch, t.readAt), sourcesOf(t.launch), t),
    tokenLocks: {
      ...row("token-locks", "Token locks & vesting", describeTokenLocks(t.tokenLocks, t.symbol, t.decimals), sourcesOf(t.tokenLocks), t),
      share: t.tokenLocks.status === "read" && t.tokenLocks.lockCount > 0 ? tokenShareBar(t.tokenLocks) : null,
    },
    creatorTax: creatorTaxRow(t),
    pools: t.pools.map((p) => poolView(p, t, book)),
    failedPools: t.failedPools.map((f) => `${f.kind} pool ${f.poolId.slice(0, 10)}… could not be described: ${f.message}.`),
    discoveryNote,
    readAtNote: "Live from the chain. Token units, never priced. A registry listing is what the registry records, not an audit.",
  };
}
