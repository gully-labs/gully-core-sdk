// SPDX-License-Identifier: MIT
/**
 * The buy alert widget's pure model: attributes, API answers to SDK records,
 * the merge of a poll into the tape, and the words and figures one alert shows.
 *
 * Nothing here touches the DOM or the network, so every rule is unit-tested
 * (`test/buys.test.ts`). The element (`./element.ts`) and the source
 * (`./source.ts`) call into this file and add nothing of their own to the
 * numbers.
 *
 * Money rule (owner, 2026-11-10): a trade is shown in USD first ("$42.10")
 * with the quote amount in small print ("0.021 ETH"); a quote the Gully Core
 * API has no dollar price for shows "unpriced" and the quote amount, never a
 * bare token amount posing as a dollar figure.
 */

import { isAddress, type Address, type Hex } from "viem";
import { getDeployment, priceFromBinId, priceFromSqrt, type MarketPool, type Trade } from "@gullylabs/core-sdk";

export const BUYS_TAG = "gully-buys";

export type BuysLayout = "strip" | "feed" | "toast";
export type BuysTheme = "dark" | "light" | "auto";

/** Chains the widget serves: every chain in the SDK address book (Solana later). */
export const BUYS_CHAIN_IDS: readonly number[] = [8453, 56, 4663, 99901, 6714, 485590];

/** The Gully Core API that indexes the chain's pools: the testnet host for the testnet, the app host for mainnets. */
export function apiBaseFor(chainId: number): string {
  return chainId === 485590 ? "https://testnet.gullycore.xyz/v1" : "https://app.gullycore.xyz/v1";
}

/** The Gully Core app that shows the token page, same split. */
export function siteFor(chainId: number): string {
  return chainId === 485590 ? "https://testnet.gullycore.xyz" : "https://app.gullycore.xyz";
}

/** Gully RPC's keyless project: every Gully Core chain, 25 req/s per visitor, no key. */
export function keylessRpcFor(chainId: number): string {
  return `https://rpc.gullyrpc.xyz/gullychain/evm/${chainId}`;
}

export interface BuysAttributes {
  readonly chainId: number;
  readonly target: { readonly kind: "token"; readonly token: Address } | { readonly kind: "pool"; readonly poolId: Hex };
  readonly layout: BuysLayout;
  readonly theme: BuysTheme;
  /** Sells shown too (default: buys only). */
  readonly sells: boolean;
  /** Alerts kept on screen (feed, strip); toasts stack at most 3. */
  readonly limit: number;
  /** Dollars per emoji on the scale. */
  readonly stepUsd: number;
  /** The buy emoji; sells always show the red circle. */
  readonly emoji: string;
  /** Only trades at or above this many dollars are shown (0 = all). */
  readonly minUsd: number;
  /** Overrides: an RPC URL, an API base (`…/v1`), the app origin for token links. */
  readonly rpc: string | null;
  readonly api: string;
  readonly site: string;
  /** Toast corner. */
  readonly corner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Seconds between polls (min 5). */
  readonly pollSeconds: number;
}

export type ParsedBuys = { readonly ok: true; readonly attrs: BuysAttributes } | { readonly ok: false; readonly message: string };

const trimmed = (v: string | null): string | null => (v === null || v.trim() === "" ? null : v.trim());

/** Pure: the element's attributes, validated, with every default applied. */
export function parseBuysAttributes(get: (name: string) => string | null): ParsedBuys {
  const chainId = Number(trimmed(get("chain")) ?? "");
  if (!Number.isInteger(chainId) || chainId <= 0) return { ok: false, message: 'Set the chain attribute to a chain id, e.g. chain="8453".' };
  if (getDeployment(chainId) === undefined) return { ok: false, message: `Gully Core is not on chain ${chainId}. Chains: ${BUYS_CHAIN_IDS.join(", ")}.` };
  const token = trimmed(get("token"));
  const pool = trimmed(get("pool"));
  let target: BuysAttributes["target"];
  if (pool !== null) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pool)) return { ok: false, message: "The pool attribute is not a 32-byte pool id." };
    target = { kind: "pool", poolId: pool.toLowerCase() as Hex };
  } else if (token !== null) {
    if (!isAddress(token, { strict: false })) return { ok: false, message: "The token attribute is not an address." };
    target = { kind: "token", token: token.toLowerCase() as Address };
  } else return { ok: false, message: "Set a token attribute (the token's address) or a pool attribute (a pool id)." };
  const layoutRaw = (trimmed(get("layout")) ?? "feed").toLowerCase();
  const layout: BuysLayout = layoutRaw === "strip" || layoutRaw === "toast" ? layoutRaw : "feed";
  const themeRaw = (trimmed(get("theme")) ?? "dark").toLowerCase();
  const theme: BuysTheme = themeRaw === "light" ? "light" : themeRaw === "auto" || themeRaw === "system" ? "auto" : "dark";
  const sellsRaw = get("sells");
  const sells = sellsRaw !== null && sellsRaw.trim().toLowerCase() !== "false" && sellsRaw.trim() !== "0";
  const num = (name: string, dflt: number, min: number, max: number): number => {
    const raw = trimmed(get(name));
    if (raw === null) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const cornerRaw = (trimmed(get("corner")) ?? "bottom-right").toLowerCase();
  const corner = cornerRaw === "bottom-left" || cornerRaw === "top-right" || cornerRaw === "top-left" ? cornerRaw : "bottom-right";
  const emoji = trimmed(get("emoji")) ?? "🟢";
  return {
    ok: true,
    attrs: {
      chainId,
      target,
      layout,
      theme,
      sells,
      limit: Math.round(num("limit", layout === "strip" ? 12 : 10, 1, 50)),
      stepUsd: num("step", 10, 0.01, 1_000_000),
      emoji: [...emoji].slice(0, 2).join(""),
      minUsd: num("min", 0, 0, 1_000_000_000),
      rpc: trimmed(get("rpc")),
      api: (trimmed(get("api")) ?? apiBaseFor(chainId)).replace(/\/+$/, ""),
      site: (trimmed(get("site")) ?? siteFor(chainId)).replace(/\/+$/, ""),
      corner,
      pollSeconds: num("poll", 15, 5, 600),
    },
  };
}

/* ------------------------------------------------------------- API shapes --- */

/** One pool as `GET /v1/chains/:id/pools` answers it (the fields the widget reads). */
export interface ApiPoolRow {
  readonly poolId: string;
  readonly poolType: string;
  readonly poolManager: string;
  readonly token0: { readonly address: string; readonly symbol: string | null; readonly decimals: number | null };
  readonly token1: { readonly address: string; readonly symbol: string | null; readonly decimals: number | null };
  readonly config: { readonly feeRaw: number; readonly parameters: string };
  readonly hook: { readonly address: string } | null;
}

/** One swap as `GET /v1/chains/:id/pools/:poolId/swaps` answers it. */
export interface ApiSwapRow {
  readonly txHash: string;
  readonly blockNumber: string | number;
  readonly blockTimestamp: string;
  readonly logIndex: number;
  readonly sender: string;
  readonly amount0: string;
  readonly amount1: string;
  readonly sqrtPriceX96: string | null;
  readonly activeId: number | null;
}

export interface TokenSide {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/** A pool the widget follows: the SDK's market view of it plus the two sides' words. */
export interface FollowedPool {
  readonly pool: MarketPool;
  readonly base: TokenSide;
  readonly quote: TokenSide;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

function side(t: ApiPoolRow["token0"], chainId: number): TokenSide {
  const address = t.address.toLowerCase() as Address;
  if (address === ZERO) {
    const d = getDeployment(chainId);
    return { address, symbol: d?.nativeCurrency.symbol ?? "native", decimals: d?.nativeCurrency.decimals ?? 18 };
  }
  return { address, symbol: t.symbol ?? short(address), decimals: t.decimals ?? 18 };
}

/**
 * A pool row as the SDK's `MarketPool`, oriented on `base` (the token the alerts are
 * about). With no base given (a `pool` attribute), the base is the side that is not a
 * priced quote (native, wrapped native, a stablecoin), else token1.
 */
export function followedPoolFromApi(row: ApiPoolRow, chainId: number, base: Address | null, pricedQuotes: ReadonlySet<string>): FollowedPool | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.poolId)) return null;
  const t0 = side(row.token0, chainId);
  const t1 = side(row.token1, chainId);
  let baseIs0: boolean;
  if (base !== null) {
    const b = base.toLowerCase();
    if (t0.address === b) baseIs0 = true;
    else if (t1.address === b) baseIs0 = false;
    else return null;
  } else if (pricedQuotes.has(t0.address) && !pricedQuotes.has(t1.address)) baseIs0 = false;
  else if (pricedQuotes.has(t1.address) && !pricedQuotes.has(t0.address)) baseIs0 = true;
  else baseIs0 = t0.address !== ZERO;
  const kind = /bin/i.test(row.poolType) ? "Bin" : "CL";
  const pool: MarketPool = {
    poolId: row.poolId.toLowerCase() as Hex,
    kind,
    key: {
      currency0: t0.address,
      currency1: t1.address,
      hooks: (row.hook?.address.toLowerCase() ?? ZERO) as Address,
      poolManager: row.poolManager.toLowerCase() as Address,
      fee: row.config.feeRaw,
      parameters: row.config.parameters as Hex,
    },
    baseIsCurrency0: baseIs0,
    baseDecimals: baseIs0 ? t0.decimals : t1.decimals,
    quoteDecimals: baseIs0 ? t1.decimals : t0.decimals,
  };
  return { pool, base: baseIs0 ? t0 : t1, quote: baseIs0 ? t1 : t0 };
}

/** `binStep` from a Bin pool key's parameters (bits 16..31), as the SDK decodes it. */
export function binStepFromParameters(parameters: string): number {
  return Number((BigInt(parameters) >> 16n) & 0xffffn);
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** An indexed swap as the SDK's `Trade`, with the same orientation and price functions a chain read uses. */
export function tradeFromApiSwap(s: ApiSwapRow, pool: MarketPool): Trade | null {
  const a0 = BigInt(s.amount0);
  const a1 = BigInt(s.amount1);
  const baseDelta = pool.baseIsCurrency0 ? a0 : a1;
  const quoteDelta = pool.baseIsCurrency0 ? a1 : a0;
  let price: number;
  if (pool.kind === "CL") {
    if (s.sqrtPriceX96 === null) return null;
    price = priceFromSqrt(BigInt(s.sqrtPriceX96), pool);
  } else {
    if (s.activeId === null) return null;
    price = priceFromBinId(s.activeId, binStepFromParameters(pool.key.parameters), pool);
  }
  const ts = Math.floor(new Date(s.blockTimestamp).getTime() / 1000);
  return {
    blockNumber: BigInt(s.blockNumber),
    txHash: s.txHash as Hex,
    logIndex: s.logIndex,
    sender: s.sender as Address,
    side: baseDelta > 0n ? "buy" : "sell",
    baseAmount: abs(baseDelta),
    quoteAmount: abs(quoteDelta),
    price,
    timestamp: Number.isFinite(ts) ? ts : null,
  };
}

/* ------------------------------------------------------------------ tape --- */

/** One trade on the tape: the SDK record plus the pool it came from. */
export interface TapeTrade {
  readonly trade: Trade;
  readonly poolId: Hex;
}

export const tradeKey = (t: Pick<Trade, "txHash" | "logIndex">): string => `${t.txHash.toLowerCase()}:${t.logIndex}`;

const newestFirst = (a: TapeTrade, b: TapeTrade): number =>
  a.trade.blockNumber === b.trade.blockNumber ? b.trade.logIndex - a.trade.logIndex : a.trade.blockNumber < b.trade.blockNumber ? 1 : -1;

/**
 * Merge a poll's trades into the tape: deduplicated by tx hash and log index, newest first,
 * cut to `cap`. Returns the new tape and the keys that were not on it before (for the
 * highlight and the toasts). A trade seen twice (the index and the chain both answered it)
 * is one trade.
 */
export function mergeTape(tape: readonly TapeTrade[], incoming: readonly TapeTrade[], cap: number): { readonly tape: readonly TapeTrade[]; readonly fresh: readonly string[] } {
  const seen = new Set(tape.map((t) => tradeKey(t.trade)));
  const fresh: string[] = [];
  const added: TapeTrade[] = [];
  for (const t of incoming) {
    const k = tradeKey(t.trade);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(k);
    added.push(t);
  }
  const merged = [...tape, ...added].sort(newestFirst).slice(0, Math.max(1, cap));
  const kept = new Set(merged.map((t) => tradeKey(t.trade)));
  return { tape: merged, fresh: fresh.filter((k) => kept.has(k)) };
}

/** The buy-bot rule: one emoji per `stepUsd`, at least one, at most `max`; an unpriced trade shows one. */
export function emojiCount(usd: number | null, stepUsd: number, max = 40): number {
  if (usd === null || !Number.isFinite(usd) || stepUsd <= 0) return 1;
  return Math.max(1, Math.min(max, Math.floor(usd / stepUsd + 1e-9) + 1));
}

/* --------------------------------------------------------------- figures --- */

/** Dollars as text: cents under $1, two decimals to $1K, then K / M / B. */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
  if (v >= 1) return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  if (v === 0) return "$0";
  return `$${v.toPrecision(2)}`;
}

/** A raw token amount as compact text: "0.021 ETH", "12.5K ECHO", "1.2M". */
export function fmtAmount(raw: bigint, decimals: number, symbol?: string): string {
  const n = Number(raw) / 10 ** decimals;
  let s: string;
  if (!Number.isFinite(n)) s = "—";
  else if (n >= 1e9) s = `${(n / 1e9).toFixed(2)}B`;
  else if (n >= 1e6) s = `${(n / 1e6).toFixed(2)}M`;
  else if (n >= 1e4) s = `${(n / 1e3).toFixed(1)}K`;
  else if (n >= 1000) s = Math.round(n).toLocaleString("en-US");
  else if (n >= 100) s = n.toFixed(1);
  else if (n >= 1) s = n.toFixed(3).replace(/\.?0+$/, "");
  else if (n === 0) s = "0";
  else s = n.toPrecision(3).replace(/\.?0+$/, "");
  return symbol === undefined ? s : `${s} ${symbol}`;
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago"; "" with no time. */
export function relativeTime(timestamp: number | null, nowSeconds: number): string {
  if (timestamp === null) return "";
  const d = Math.max(0, nowSeconds - timestamp);
  if (d < 5) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

/** The Gully Core app's public token page for a token on a chain. */
export function tokenPageUrl(site: string, chainId: number, token: Address): string {
  const d = getDeployment(chainId);
  return `${site.replace(/\/+$/, "")}/tokens/${token}${d === undefined ? "" : `?net=${d.key}`}`;
}

/** The chain's explorer transaction page, from the SDK address book. */
export function txUrl(chainId: number, hash: Hex): string | null {
  const d = getDeployment(chainId);
  return d === undefined ? null : `${d.explorer}/tx/${hash}`;
}

/** The words and figures of one alert. Pure. */
export interface AlertView {
  readonly key: string;
  readonly side: "buy" | "sell";
  /** "$42.10", or null when the quote is unpriced. */
  readonly usd: string | null;
  readonly usdValue: number | null;
  /** "0.021 ETH" */
  readonly quoteText: string;
  /** "12.5K ECHO" */
  readonly baseText: string;
  readonly baseSymbol: string;
  readonly emojis: string;
  readonly ago: string;
  readonly txUrl: string | null;
  readonly timestamp: number | null;
}

export function alertView(
  t: TapeTrade,
  pools: ReadonlyMap<string, FollowedPool>,
  usdPerQuoteUnit: ReadonlyMap<string, number>,
  opts: { readonly chainId: number; readonly stepUsd: number; readonly emoji: string; readonly now: number },
): AlertView | null {
  const fp = pools.get(t.poolId.toLowerCase());
  if (fp === undefined) return null;
  const per = usdPerQuoteUnit.get(fp.quote.address) ?? null;
  const quoteUnits = Number(t.trade.quoteAmount) / 10 ** fp.quote.decimals;
  const usdValue = per === null ? null : quoteUnits * per;
  const count = emojiCount(usdValue, opts.stepUsd);
  return {
    key: tradeKey(t.trade),
    side: t.trade.side,
    usd: usdValue === null ? null : fmtUsd(usdValue),
    usdValue,
    quoteText: fmtAmount(t.trade.quoteAmount, fp.quote.decimals, fp.quote.symbol),
    baseText: fmtAmount(t.trade.baseAmount, fp.base.decimals, fp.base.symbol),
    baseSymbol: fp.base.symbol,
    emojis: (t.trade.side === "buy" ? opts.emoji : "🔴").repeat(count),
    ago: relativeTime(t.trade.timestamp, opts.now),
    txUrl: txUrl(opts.chainId, t.trade.txHash),
    timestamp: t.trade.timestamp,
  };
}

/** The quote prices of a chain from `GET /v1/prices?chain=`: lowercase address -> dollars per whole unit. */
export function pricesFromApi(answer: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof answer !== "object" || answer === null) return out;
  const tokens = (answer as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) return out;
  for (const t of tokens) {
    if (typeof t !== "object" || t === null) continue;
    const { address, usdPerUnit } = t as { address?: unknown; usdPerUnit?: unknown };
    const n = typeof usdPerUnit === "string" || typeof usdPerUnit === "number" ? Number(usdPerUnit) : NaN;
    if (typeof address === "string" && Number.isFinite(n) && n > 0) out.set(address.toLowerCase(), n);
  }
  return out;
}

/** The snippet a page pastes: one script tag and one element. */
export function buysSnippet(args: { readonly chainId: number; readonly token: string; readonly layout: BuysLayout; readonly theme?: BuysTheme; readonly scriptUrl?: string; readonly sells?: boolean }): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const src = args.scriptUrl ?? "https://gullycore.xyz/buys.js";
  const attrs = [`chain="${args.chainId}"`, `token="${esc(args.token)}"`, `layout="${args.layout}"`];
  if (args.theme !== undefined && args.theme !== "dark") attrs.push(`theme="${args.theme}"`);
  if (args.sells === true) attrs.push("sells");
  return `<script src="${esc(src)}" defer></script>\n<${BUYS_TAG} ${attrs.join(" ")}></${BUYS_TAG}>`;
}
