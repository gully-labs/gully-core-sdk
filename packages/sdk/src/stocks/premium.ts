// SPDX-License-Identifier: MIT
/* ============================================================================
   THE PREMIUM TRACKER: a tokenised stock's on-chain price beside its real one.

   A tokenised stock can trade far from the share it tracks (a token once traded
   at $61 against a $29 NYSE close). This module says how far, and — the part that
   matters more — WHEN THE TWO NUMBERS ARE NOT COMPARABLE, in which case it says
   why and returns no percentage at all. A wrong gap shared publicly costs more
   than no gap.

   THREE NUMBERS, EACH WITH ITS SOURCE
   -----------------------------------
   reference   The token's Chainlink feed (`deployments/stockFeeds.ts`, every
               address read on chain before it was written down). Two kinds:
                 token-priced   `prices: "tokenized-instrument"`: the feed prices
                                the ISSUER'S TOKEN. Matched to a token only when
                                the ticker AND the issuer agree ("Robinhood NVDA /
                                USD" prices Robinhood's NVDA, not Binance's).
                 share-priced   `prices: "underlying-share"` (BNB Chain): the feed
                                prices the SHARE. A raw token unit is worth
                                `uiMultiplier` shares (ERC-8056), so the token's
                                reference is share × multiplier, and ONLY when the
                                multiplier was READ on chain. Never assumed 1.0.
               The round is judged against its own heartbeat and the US equity
               session (`usCalendar.ts`): in session it must be fresh; out of
               session the board compares with the last print before the close
               and says "vs last close", and only when that print was within the
               heartbeat of the close.
   on-chain    What the token trades at on chain, from an EXECUTABLE quote: buy
               the token with a small fixed dollar amount of the chain's stable,
               sell the same tokens back, and take the mid of the two prices
               (venue in and venue out, so the routed fee is not part of it). A
               Gully Core pool's spot price is the fallback, labelled "spot". The
               stable's own dollars come from its Chainlink feed where one exists,
               else it is "$1 assumed" and labelled so.
   premium     (on-chain / reference - 1), signed, in basis points. `null` with a
               reason whenever either side is missing, stale, or not the same
               thing.

   This module reads (eth_call only) and computes. It sends nothing, holds no key,
   and does not decide when to alert: a caller applies its own threshold, and should
   widen it by `basisUncertaintyBps`.
   ============================================================================ */

import { getAddress, type Address, type PublicClient } from "viem";

import { stockFeedsFor, type StockFeedRecord } from "../deployments/stockFeeds.js";
import { stockTokenByAddress, stockTokensFor, type StockTokenRecord } from "../deployments/stocks.js";
import { readSpotPrice, type MarketPool } from "../market/index.js";
import { feedSessionLive, lastFeedSessionEnd, usEquitySession, type UsEquitySession } from "./usCalendar.js";

export * from "./usCalendar.js";

/* ------------------------------------------------------------------ constants --- */

/** Seconds past a feed's heartbeat before its round is called stale (the generator's own grace). */
export const PREMIUM_STALE_GRACE_SECONDS = 300;
/** Seconds a round's `updatedAt` may sit ahead of the reader's clock before it is refused. */
export const PREMIUM_FUTURE_SKEW_SECONDS = 120;
/** The dollar size of the executable probe. Small on purpose: it measures the price, not the depth. */
export const DEFAULT_PREMIUM_PROBE_USD = 100;
/** Above this buy/sell spread the mid is not a price anyone can trade at: not comparable. 10%. */
export const PREMIUM_MAX_SPREAD_BPS = 1_000;
/** The depth probe is this many times the probe size. */
export const PREMIUM_DEPTH_MULTIPLE = 5;
/**
 * Above this move between the probe-size price and the depth-size price (either side) the pool is
 * too thin for its price to mean anything: a reading is refused rather than reported. 5%.
 */
export const PREMIUM_MAX_DEPTH_MOVE_BPS = 500;
/** An on-chain price older than this is not compared. */
export const PREMIUM_MAX_ONCHAIN_AGE_SECONDS = 900;
/**
 * A token-priced feed on a UI-multiplier token: the issuer does not publish whether the feed
 * prices a raw unit or a multiplied share. The two differ by the multiplier, so the gap is
 * reported with that much uncertainty, and refused above 1% (a split would make it anything).
 */
export const PREMIUM_MULTIPLIER_AMBIGUITY_LIMIT_BPS = 100;

/* --------------------------------------------------------------------- the join --- */

export type StockReferenceKind = "token-priced" | "share-priced";

export interface PremiumSubject {
  readonly chainId: number;
  readonly token: StockTokenRecord;
  /** The feed the token is compared with, or null (see `why`). */
  readonly feed: StockFeedRecord | null;
  readonly kind: StockReferenceKind | null;
  /** Plain words when there is no feed. */
  readonly why: string | null;
}

/** The issuer brand a tokenised-price feed names ("Robinhood NVDA / USD" -> "robinhood"). */
export function feedIssuerKey(f: StockFeedRecord): string | null {
  if (f.tickerRule === "ondo-suffix") return "ondo";
  if (f.tickerRule === "backed-wrapper") return "backed";
  const first = /^([A-Za-z]+)\s/.exec(f.feedName)?.[1];
  return first ? first.toLowerCase() : null;
}

/** The issuer brand of a token record ("Robinhood", "Coinbase (B20 …)" -> "robinhood", "coinbase"). */
export function tokenIssuerKey(t: StockTokenRecord): string {
  return (/^([A-Za-z]+)/.exec(t.issuer)?.[1] ?? t.issuer).toLowerCase();
}

/**
 * Which feed, if any, prices `token` on its chain.
 *
 *   * A rebasing token is never a subject (its balance, not its price, moves).
 *   * A token-priced feed matches only the SAME issuer's token of the same ticker.
 *   * A share-priced feed matches a UI-multiplier token of that ticker (the multiplier is the
 *     conversion); any other token design has no published conversion and gets no feed.
 *   * Feeds Chainlink labels "deprecating" are never used.
 */
export function premiumSubject(chainId: number, token: StockTokenRecord): PremiumSubject {
  const ticker = token.ticker.toUpperCase();
  const feeds = stockFeedsFor(chainId).filter((f) => f.ticker.toUpperCase() === ticker && f.feedCategory !== "deprecating");
  const issuer = tokenIssuerKey(token);
  const tokenFeed = feeds.find((f) => f.prices === "tokenized-instrument" && feedIssuerKey(f) === issuer);
  if (tokenFeed) return { chainId, token, feed: tokenFeed, kind: "token-priced", why: null };
  const shareFeed = feeds.find((f) => f.prices === "underlying-share");
  if (shareFeed && token.controls.uiMultiplier && !token.controls.rebasing) return { chainId, token, feed: shareFeed, kind: "share-priced", why: null };
  let why: string;
  if (feeds.length === 0) why = `no verified price feed for ${ticker} on this chain`;
  else if (shareFeed) why = `the ${ticker} feed prices the share, and this token has no published share conversion`;
  else why = `the ${ticker} feeds on this chain price another issuer's token`;
  return { chainId, token, feed: null, kind: null, why };
}

/** Every non-rebasing stock token on `chainId` with its feed (or why none). */
export function premiumSubjects(chainId: number): PremiumSubject[] {
  return stockTokensFor(chainId)
    .filter((t) => !t.controls.rebasing)
    .map((t) => premiumSubject(chainId, t));
}

/** The subject for one token address, or null when the token is not in the stock table. */
export function premiumSubjectFor(chainId: number, token: string): PremiumSubject | null {
  const t = stockTokenByAddress(chainId, token);
  return t && !t.controls.rebasing ? premiumSubject(chainId, t) : null;
}

/* ------------------------------------------------------------------- reference --- */

export type PremiumReason =
  | "no-reference"
  | "reference-unreadable"
  | "reference-future"
  | "reference-stale"
  | "reference-older-than-last-close"
  | "share-priced-no-multiplier"
  | "multiplier-unread"
  | "multiplier-basis-ambiguous"
  | "calendar-unknown"
  | "session-unknown"
  | "no-onchain-price"
  | "onchain-stale"
  | "onchain-one-sided"
  | "onchain-spread-too-wide"
  | "onchain-too-thin";

/** One sentence per reason, for a reader who is not us. */
export const PREMIUM_REASON_TEXT: Readonly<Record<PremiumReason, string>> = {
  "no-reference": "no market price feed for this token on this chain",
  "reference-unreadable": "the price feed could not be read",
  "reference-future": "the price feed reported a time in the future",
  "reference-stale": "the market price is out of date",
  "reference-older-than-last-close": "the last market price predates the last close",
  "share-priced-no-multiplier": "the feed prices the share and the token's share multiplier could not be read",
  "multiplier-unread": "the token's share multiplier could not be read",
  "multiplier-basis-ambiguous": "the token's share multiplier is too far from 1 to compare safely",
  "calendar-unknown": "the exchange calendar for this date is not published yet",
  "session-unknown": "the feed's trading session is not known",
  "no-onchain-price": "no on-chain price: no route or pool trades this token",
  "onchain-stale": "the on-chain price is out of date",
  "onchain-one-sided": "only one side of the on-chain market could be quoted",
  "onchain-spread-too-wide": "the on-chain buy and sell prices are too far apart to call one price",
  "onchain-too-thin": "too thin to price: a larger trade moves the on-chain price too far",
};

/** `latestRoundData()` plus `decimals()`, as read. */
export interface FeedRoundRead {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly startedAt: bigint;
  readonly updatedAt: bigint;
  readonly decimals: number;
  readonly blockNumber: bigint | null;
}

/** A UI multiplier as read, 1e18 = 1.0. */
export interface MultiplierRead {
  readonly value: bigint;
  readonly blockNumber: bigint | null;
}

export interface ReferencePrice {
  readonly chainId: number;
  readonly token: Address;
  readonly ticker: string;
  readonly symbol: string;
  readonly kind: StockReferenceKind | "none";
  /** Dollars per WHOLE token, or null. */
  readonly usd: number | null;
  /** Share-priced only: the feed's dollars per share. */
  readonly shareUsd: number | null;
  /** The token's UI multiplier as read (1.0 = 1), or null when not read / not applicable. */
  readonly multiplier: number | null;
  readonly multiplierRaw: string | null;
  readonly feed: {
    readonly proxy: Address;
    readonly name: string;
    readonly heartbeat: number;
    readonly marketHours: string;
  } | null;
  /** The round's `updatedAt` (unix seconds). */
  readonly updatedAt: number | null;
  readonly ageSeconds: number | null;
  readonly roundBlock: string | null;
  /** The US equity session at the read. */
  readonly session: UsEquitySession;
  /** Whether the FEED's own session is live at the read; null for an unknown profile. */
  readonly feedLive: boolean | null;
  /** When the feed's session last ended (unix seconds), when it is not live. */
  readonly lastCloseAt: number | null;
  /** "live": compared with a live print. "last-close": compared with the print before the close. */
  readonly basis: "live" | "last-close" | null;
  readonly comparable: boolean;
  readonly reason: PremiumReason | null;
  readonly detail: string | null;
  /** How far the gap may be off because of an unpublished unit convention. 0 when exact. */
  readonly basisUncertaintyBps: number;
  /** Machine provenance, e.g. "chainlink:0x…@<block>" ("×uiMultiplier:<token>@<block>" for a share feed). */
  readonly source: string | null;
  /** Plain words for a provenance line. */
  readonly sourceText: string | null;
  /** When the reads were made (unix seconds). */
  readonly readAt: number;
}

const ratioToNumber = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;

/**
 * The reference price from reads already made. Pure: the reader below does the reads.
 *
 * @param round    the feed round, or an Error when the read failed, or null when there is no feed
 * @param multiplier the token's UI multiplier, or null when unread / not applicable
 * @param now      unix seconds of the read
 */
export function referenceFromReads(subject: PremiumSubject, round: FeedRoundRead | Error | null, multiplier: MultiplierRead | null, now: number): ReferencePrice {
  const t = subject.token;
  const session = usEquitySession(now);
  const f = subject.feed;
  const base = {
    chainId: subject.chainId,
    token: getAddress(t.address),
    ticker: t.ticker,
    symbol: t.symbol,
    kind: subject.kind ?? ("none" as const),
    feed: f ? { proxy: getAddress(f.proxyAddress), name: f.feedName, heartbeat: f.heartbeat, marketHours: f.marketHours } : null,
    session,
    readAt: now,
    multiplierRaw: multiplier ? multiplier.value.toString() : null,
    multiplier: multiplier ? ratioToNumber(multiplier.value, 18) : null,
  };
  const refuse = (reason: PremiumReason, detail: string, extra: Partial<ReferencePrice> = {}): ReferencePrice => ({
    usd: null,
    shareUsd: null,
    updatedAt: null,
    ageSeconds: null,
    roundBlock: null,
    feedLive: null,
    lastCloseAt: null,
    basis: null,
    basisUncertaintyBps: 0,
    source: null,
    sourceText: null,
    ...base,
    ...extra,
    comparable: false,
    reason,
    detail,
  });
  if (f === null || subject.kind === null) return refuse("no-reference", subject.why ?? "no price feed");
  if (round === null) return refuse("reference-unreadable", "the feed was not read");
  if (round instanceof Error) return refuse("reference-unreadable", `the feed read failed: ${round.message.split("\n")[0]}`);
  if (round.decimals !== f.decimals) return refuse("reference-unreadable", `the feed now reports ${round.decimals} decimals, the verified table says ${f.decimals}`);
  if (round.answer <= 0n || round.updatedAt === 0n || round.startedAt === 0n || round.roundId === 0n) return refuse("reference-unreadable", "the feed returned an incomplete or non-positive round");

  const updatedAt = Number(round.updatedAt);
  const ageSeconds = now - updatedAt;
  const feedPrice = ratioToNumber(round.answer, round.decimals);
  const roundBlock = round.blockNumber === null ? null : round.blockNumber.toString();
  const at = round.blockNumber === null ? "" : `@${round.blockNumber}`;
  const blockWords = round.blockNumber === null ? "" : ` at block ${round.blockNumber.toLocaleString("en-US")}`;
  const feedLive = feedSessionLive(f.marketHours, now);
  const lastCloseAt = feedLive === false ? lastFeedSessionEnd(f.marketHours, now) : null;
  const known = { updatedAt, ageSeconds, roundBlock, feedLive, lastCloseAt };

  let usd: number;
  let shareUsd: number | null = null;
  let uncertainty = 0;
  let source = `chainlink:${getAddress(f.proxyAddress)}${at}`;
  let sourceText = `Chainlink ${f.feedName}${blockWords}`;
  if (subject.kind === "share-priced") {
    if (multiplier === null) return refuse("share-priced-no-multiplier", "the feed prices one share; a token unit is worth uiMultiplier() shares, which was not read", known);
    shareUsd = feedPrice;
    usd = (Number(round.answer) * Number(multiplier.value)) / 10 ** (round.decimals + 18);
    const mAt = multiplier.blockNumber === null ? "" : `@${multiplier.blockNumber}`;
    source += `×uiMultiplier:${getAddress(t.address)}${mAt}`;
    sourceText += ` × the token's share multiplier ${ratioToNumber(multiplier.value, 18).toFixed(6)}`;
  } else {
    usd = feedPrice;
    if (t.controls.uiMultiplier) {
      if (multiplier === null) return refuse("multiplier-unread", "the token carries a share multiplier that was not read, so the feed's unit cannot be bounded", known);
      uncertainty = Math.ceil(Math.abs(ratioToNumber(multiplier.value, 18) - 1) * 10_000);
      if (uncertainty > PREMIUM_MULTIPLIER_AMBIGUITY_LIMIT_BPS) {
        return refuse("multiplier-basis-ambiguous", `multiplier ${ratioToNumber(multiplier.value, 18)}: whether the issuer's feed prices a raw unit or a share is not published`, known);
      }
    }
  }
  const priced = { ...known, usd, shareUsd, basisUncertaintyBps: uncertainty, source, sourceText };

  if (updatedAt > now + PREMIUM_FUTURE_SKEW_SECONDS) return refuse("reference-future", `the round is ${updatedAt - now}s ahead of the reader's clock`, priced);
  if (!session.calendarCovered) return refuse("calendar-unknown", `no published exchange calendar for ${session.nyDate.slice(0, 4)}`, priced);
  if (feedLive === null) return refuse("session-unknown", `market-hours profile "${f.marketHours}" is not mapped`, priced);
  const limit = f.heartbeat + PREMIUM_STALE_GRACE_SECONDS;
  if (feedLive) {
    if (ageSeconds > limit) return refuse("reference-stale", `the round is ${ageSeconds}s old in session; heartbeat ${f.heartbeat}s`, priced);
    return { ...base, ...priced, basis: "live", comparable: true, reason: null, detail: null };
  }
  if (lastCloseAt === null) return refuse("session-unknown", "no session end found in the last two weeks", priced);
  if (lastCloseAt - updatedAt > limit) {
    return refuse("reference-older-than-last-close", `the last round is ${lastCloseAt - updatedAt}s older than the session's close; heartbeat ${f.heartbeat}s`, priced);
  }
  return { ...base, ...priced, basis: "last-close", comparable: true, reason: null, detail: null };
}

const AGGREGATOR_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** ERC-8056 `uiMultiplier()` (Binance bStocks, Robinhood `Stock`) and Coinbase B20's `multiplier()`, both 1e18 = 1.0. */
export const STOCK_MULTIPLIER_ABI = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** A feed round and its decimals, pinned to one block. */
export async function readFeedRound(client: PublicClient, proxy: Address, blockNumber?: bigint): Promise<FeedRoundRead> {
  const block = blockNumber ?? (await client.getBlockNumber());
  const [decimals, r] = await Promise.all([
    client.readContract({ address: proxy, abi: AGGREGATOR_ABI, functionName: "decimals", blockNumber: block }),
    client.readContract({ address: proxy, abi: AGGREGATOR_ABI, functionName: "latestRoundData", blockNumber: block }),
  ]);
  return { roundId: r[0], answer: r[1], startedAt: r[2], updatedAt: r[3], decimals: Number(decimals), blockNumber: block };
}

/** The token's UI multiplier: `uiMultiplier()`, else `multiplier()`. Null when neither answers a positive value. */
export async function readStockMultiplier(client: PublicClient, token: Address, blockNumber?: bigint): Promise<MultiplierRead | null> {
  const block = blockNumber ?? (await client.getBlockNumber());
  for (const fn of ["uiMultiplier", "multiplier"] as const) {
    try {
      const v = await client.readContract({ address: token, abi: STOCK_MULTIPLIER_ABI, functionName: fn, blockNumber: block });
      if (v > 0n) return { value: v, blockNumber: block };
    } catch {
      /* the next selector */
    }
  }
  return null;
}

export interface ReferencePriceOptions {
  /** Unix seconds; default the wall clock. */
  readonly now?: number;
}

/**
 * The token's reference price, read now. eth_call only. Never throws for a token in the stock
 * table: a failure is a refusal with a reason.
 */
export async function referencePrice(client: PublicClient, chainId: number, token: string, opts: ReferencePriceOptions = {}): Promise<ReferencePrice> {
  const subject = premiumSubjectFor(chainId, token);
  if (subject === null) throw new Error(`${token} is not a listed, non-rebasing stock token on chain ${chainId}`);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (subject.feed === null) return referenceFromReads(subject, null, null, now);
  let block: bigint;
  try {
    block = await client.getBlockNumber();
  } catch (err) {
    return referenceFromReads(subject, err as Error, null, now);
  }
  const needsMultiplier = subject.token.controls.uiMultiplier;
  const [round, multiplier] = await Promise.all([
    readFeedRound(client, subject.feed.proxyAddress, block).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    needsMultiplier ? readStockMultiplier(client, subject.token.address, block) : Promise.resolve(null),
  ]);
  return referenceFromReads(subject, round, multiplier, now);
}

/* -------------------------------------------------------------------- on chain --- */

/**
 * The stable each chain's probe trades against, and where its dollars come from. Every feed
 * here was read on chain (code, `description()`, `decimals()`, a fresh `latestRoundData()`);
 * a stable with no feed is priced at $1 and labelled "assumed" wherever it shows.
 */
export const PREMIUM_QUOTE_STABLES: Readonly<
  Record<number, { readonly address: Address; readonly symbol: string; readonly decimals: number; readonly feed: { readonly proxy: Address; readonly description: string; readonly decimals: number; readonly heartbeat: number } | null; readonly note: string }>
> = {
  999: {
    address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
    symbol: "USD₮0",
    decimals: 6,
    feed: null,
    note: "Chainlink publishes no USDT0/USD feed on HyperEVM: priced at $1, assumed.",
  },
  56: {
    address: "0x55d398326f99059fF775485246999027B3197955",
    symbol: "USDT",
    decimals: 18,
    feed: { proxy: "0xB97Ad0E74fa7d920791E90258A6E2085088b4320", description: "USDT / USD", decimals: 8, heartbeat: 86_400 },
    note: "Binance-Peg USDT; feed read 2026-10-16 (description, decimals 8, answer 0.99872).",
  },
  4663: {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    symbol: "USDG",
    decimals: 6,
    feed: { proxy: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", description: "USDG / USD", decimals: 8, heartbeat: 86_400 },
    note: "Feed read 2026-10-16 (description 'USDG / USD', decimals 8).",
  },
  8453: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
    feed: { proxy: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", description: "USDC / USD", decimals: 8, heartbeat: 86_400 },
    note: "Feed read 2026-10-16 (description, decimals 8, answer 0.9998).",
  },
};

/** The dollars of the currency an on-chain price is measured in. */
export interface PremiumUsdLeg {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** Dollars per whole unit. */
  readonly usd: number;
  /** True for a stable priced at $1 with no feed. */
  readonly assumed: boolean;
  readonly source: string;
  readonly sourceText: string;
  /** Unix seconds of the read. */
  readonly at: number;
}

/** The chain's probe stable with its dollars, or an Error saying why not. */
export async function readPremiumUsdLeg(client: PublicClient, chainId: number, now: number = Math.floor(Date.now() / 1000)): Promise<PremiumUsdLeg | Error> {
  const s = PREMIUM_QUOTE_STABLES[chainId];
  if (!s) return new Error(`no probe stable is configured for chain ${chainId}`);
  const base = { token: getAddress(s.address), symbol: s.symbol, decimals: s.decimals, at: now };
  if (s.feed === null) return { ...base, usd: 1, assumed: true, source: "stable:assumed-1", sourceText: `${s.symbol} at $1 (assumed: no price feed on this chain)` };
  try {
    const r = await readFeedRound(client, s.feed.proxy);
    if (r.decimals !== s.feed.decimals) return new Error(`${s.feed.description} now reports ${r.decimals} decimals`);
    if (r.answer <= 0n || r.updatedAt === 0n) return new Error(`${s.feed.description} returned an incomplete round`);
    const age = now - Number(r.updatedAt);
    if (age > s.feed.heartbeat + PREMIUM_STALE_GRACE_SECONDS) return new Error(`${s.feed.description} is stale (${age}s, heartbeat ${s.feed.heartbeat}s)`);
    return {
      ...base,
      usd: ratioToNumber(r.answer, r.decimals),
      assumed: false,
      source: `chainlink:${getAddress(s.feed.proxy)}@${r.blockNumber}`,
      sourceText: `Chainlink ${s.feed.description} at block ${(r.blockNumber ?? 0n).toLocaleString("en-US")}`,
    };
  } catch (err) {
    return new Error(`${s.feed.description} could not be read: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** One executable quote, as the caller's router reports it. */
export interface PremiumQuoteRead {
  /** What the VENUE consumed (after any routed fee): the price is venue in / venue out. */
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** The venue (or route) that would fill it, e.g. "PANCAKESWAP_V3". */
  readonly venue: string;
  readonly blockNumber: bigint | null;
}

export type PremiumQuoteFn = (req: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountIn: bigint }) => Promise<PremiumQuoteRead>;

export interface OnchainPrice {
  readonly chainId: number;
  readonly token: Address;
  /** Dollars per whole token the premium uses, or null. */
  readonly usd: number | null;
  readonly kind: "executable-mid" | "executable-buy" | "executable-sell" | "spot" | "none";
  readonly buyUsd: number | null;
  readonly sellUsd: number | null;
  /** (buy - sell) / mid in bps, when both sides quoted. */
  readonly spreadBps: number | null;
  readonly probeUsd: number;
  /**
   * The depth check: the same buy and sell at `depth.multiple` times the probe size, and the larger
   * of the two price moves against the probe-size prices, in bps (always >= 0). `moveBps` null with a
   * `reason` when a depth quote failed; `depth` null when no depth check was asked for (or no
   * executable mid exists to check).
   */
  readonly depth: {
    readonly multiple: number;
    readonly buyUsd: number | null;
    readonly sellUsd: number | null;
    readonly moveBps: number | null;
    readonly reason: string | null;
  } | null;
  readonly venue: string | null;
  readonly blockNumber: string | null;
  readonly via: PremiumUsdLeg | null;
  readonly spot: { readonly usd: number; readonly poolId: string } | null;
  readonly source: string | null;
  readonly sourceText: string | null;
  /** Unix seconds. */
  readonly at: number;
  readonly reason: string | null;
}

/**
 * The executable prices from a buy and a sell quote. Pure.
 * buy:  `stableIn` of the stable -> tokens;  sell: those tokens -> stable.
 */
export function executablePrices(
  buy: PremiumQuoteRead | null,
  sell: PremiumQuoteRead | null,
  leg: Pick<PremiumUsdLeg, "usd" | "decimals">,
  tokenDecimals: number,
): { buyUsd: number | null; sellUsd: number | null; usd: number | null; spreadBps: number | null } {
  const buyUsd = buy && buy.amountOut > 0n && buy.amountIn > 0n ? (ratioToNumber(buy.amountIn, leg.decimals) * leg.usd) / ratioToNumber(buy.amountOut, tokenDecimals) : null;
  const sellUsd = sell && sell.amountOut > 0n && sell.amountIn > 0n ? (ratioToNumber(sell.amountOut, leg.decimals) * leg.usd) / ratioToNumber(sell.amountIn, tokenDecimals) : null;
  if (buyUsd !== null && sellUsd !== null) {
    const mid = (buyUsd + sellUsd) / 2;
    return { buyUsd, sellUsd, usd: mid, spreadBps: Math.round(((buyUsd - sellUsd) / mid) * 10_000) };
  }
  return { buyUsd, sellUsd, usd: buyUsd ?? sellUsd, spreadBps: null };
}

export interface OnchainPriceArgs {
  readonly chainId: number;
  readonly token: Address;
  readonly tokenDecimals: number;
  /** The caller's router. Omit to skip executable quotes. */
  readonly quote?: PremiumQuoteFn;
  /** The stable leg; read with `readPremiumUsdLeg`. An Error is carried into the reason. */
  readonly leg?: PremiumUsdLeg | Error;
  readonly probeUsd?: number;
  /**
   * Quote a buy and a sell this many times the probe size as well, so `premium` can refuse a thin
   * pool. Default `PREMIUM_DEPTH_MULTIPLE`; 0 or 1 skips the depth check (two quotes fewer).
   */
  readonly depthMultiple?: number;
  /** Gully Core pools of the token against the leg's stable, for a spot fallback. */
  readonly gullycorePools?: readonly { readonly client: PublicClient; readonly pool: MarketPool }[];
  readonly now?: number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

/** The token's on-chain price: an executable mid where a route exists, a Gully Core spot otherwise. */
export async function onchainPrice(a: OnchainPriceArgs): Promise<OnchainPrice> {
  const now = a.now ?? Math.floor(Date.now() / 1000);
  const probeUsd = a.probeUsd ?? DEFAULT_PREMIUM_PROBE_USD;
  const token = getAddress(a.token);
  const none = (reason: string, extra: Partial<OnchainPrice> = {}): OnchainPrice => ({
    chainId: a.chainId,
    token,
    usd: null,
    kind: "none",
    buyUsd: null,
    sellUsd: null,
    spreadBps: null,
    probeUsd,
    depth: null,
    venue: null,
    blockNumber: null,
    via: null,
    spot: null,
    source: null,
    sourceText: null,
    at: now,
    reason,
    ...extra,
  });
  const leg = a.leg ?? new Error("no stable leg was given");
  if (leg instanceof Error) return none(leg.message);
  const reasons: string[] = [];

  if (a.quote) {
    const stableIn = (BigInt(Math.round((probeUsd / leg.usd) * 1_000_000)) * 10n ** BigInt(leg.decimals)) / 1_000_000n;
    let buy: PremiumQuoteRead | null = null;
    let sell: PremiumQuoteRead | null = null;
    try {
      buy = await a.quote({ tokenIn: leg.token, tokenOut: token, amountIn: stableIn });
      if (buy.amountOut === 0n) buy = null;
    } catch (err) {
      reasons.push(`buy quote: ${errText(err)}`);
    }
    if (buy) {
      try {
        sell = await a.quote({ tokenIn: token, tokenOut: leg.token, amountIn: buy.amountOut });
        if (sell.amountOut === 0n) sell = null;
      } catch (err) {
        reasons.push(`sell quote: ${errText(err)}`);
      }
    }
    const p = executablePrices(buy, sell, leg, a.tokenDecimals);
    const multiple = a.depthMultiple ?? PREMIUM_DEPTH_MULTIPLE;
    let depth: OnchainPrice["depth"] = null;
    if (p.buyUsd !== null && p.sellUsd !== null && buy && multiple > 1 && Number.isInteger(multiple)) {
      const m = BigInt(multiple);
      const depthReasons: string[] = [];
      let bigBuy: PremiumQuoteRead | null = null;
      let bigSell: PremiumQuoteRead | null = null;
      try {
        bigBuy = await a.quote({ tokenIn: leg.token, tokenOut: token, amountIn: stableIn * m });
        if (bigBuy.amountOut === 0n) { bigBuy = null; depthReasons.push(`no fill for a buy of ${multiple}x the probe`); }
      } catch (err) {
        depthReasons.push(`buy at ${multiple}x: ${errText(err)}`);
      }
      try {
        bigSell = await a.quote({ tokenIn: token, tokenOut: leg.token, amountIn: buy.amountOut * m });
        if (bigSell.amountOut === 0n) { bigSell = null; depthReasons.push(`no fill for a sell of ${multiple}x the probe`); }
      } catch (err) {
        depthReasons.push(`sell at ${multiple}x: ${errText(err)}`);
      }
      const d = executablePrices(bigBuy, bigSell, leg, a.tokenDecimals);
      depth = {
        multiple,
        buyUsd: d.buyUsd,
        sellUsd: d.sellUsd,
        moveBps: d.buyUsd !== null && d.sellUsd !== null ? depthMoveBps(p.buyUsd, p.sellUsd, d.buyUsd, d.sellUsd) : null,
        reason: depthReasons.length > 0 ? depthReasons.join("; ") : null,
      };
    }
    if (p.usd !== null) {
      const kind = p.buyUsd !== null && p.sellUsd !== null ? "executable-mid" : p.buyUsd !== null ? "executable-buy" : "executable-sell";
      const q = buy ?? sell!;
      const venue = buy && sell && buy.venue !== sell.venue ? `${buy.venue} / ${sell.venue}` : q.venue;
      const words = kind === "executable-mid" ? "mid of a buy and a sell" : kind === "executable-buy" ? "buy" : "sell";
      return {
        chainId: a.chainId,
        token,
        usd: p.usd,
        kind,
        buyUsd: p.buyUsd,
        sellUsd: p.sellUsd,
        spreadBps: p.spreadBps,
        probeUsd,
        depth,
        venue,
        blockNumber: q.blockNumber === null ? null : q.blockNumber.toString(),
        via: leg,
        spot: null,
        source: `quote:${venue}@${q.blockNumber ?? "?"}×${leg.source}`,
        sourceText: `${words} quote for $${probeUsd} against ${leg.symbol} on ${venue}${q.blockNumber === null ? "" : ` at block ${q.blockNumber.toLocaleString("en-US")}`}, × ${leg.sourceText}`,
        at: now,
        reason: reasons.length > 0 ? reasons.join("; ") : null,
      };
    }
    if (reasons.length === 0) reasons.push("no route quoted this token");
  }

  for (const { client, pool } of a.gullycorePools ?? []) {
    try {
      const px = await readSpotPrice(client, pool);
      if (!(px > 0) || !Number.isFinite(px)) continue;
      const usd = px * leg.usd;
      return {
        ...none("", {}),
        usd,
        kind: "spot",
        via: leg,
        spot: { usd, poolId: pool.poolId },
        source: `pool:${pool.poolId}×${leg.source}`,
        sourceText: `Gully Core pool ${pool.poolId.slice(0, 10)}… spot × ${leg.sourceText}`,
        reason: null,
      };
    } catch (err) {
      reasons.push(`Gully Core pool ${pool.poolId.slice(0, 10)}…: ${errText(err)}`);
    }
  }
  return none(reasons.length > 0 ? reasons.join("; ") : "no router and no Gully Core pool for this token");
}

/* --------------------------------------------------------------------- premium --- */

export interface StockPremium {
  /** Signed basis points, (on-chain / reference - 1) × 10,000; null when not comparable. */
  readonly bps: number | null;
  readonly percent: number | null;
  readonly direction: "premium" | "discount" | "flat" | null;
  readonly comparable: boolean;
  readonly reason: PremiumReason | null;
  readonly detail: string | null;
  readonly basis: "live" | "last-close" | null;
  /** "vs live price" / "vs last close 2026-10-15", the words a board shows beside the number. */
  readonly label: string | null;
  /** Carried from the reference: widen any threshold by this. */
  readonly uncertaintyBps: number;
}

/**
 * How far the depth-size prices moved from the probe-size prices, the larger side, in bps (>= 0).
 * A bigger buy pays more per token and a bigger sell gets less; a move the other way (rounding,
 * a better tier at size) counts by its size too, so an odd quote is never waved through. Pure.
 */
export function depthMoveBps(buyUsd: number, sellUsd: number, depthBuyUsd: number, depthSellUsd: number): number {
  const b = Math.abs(depthBuyUsd / buyUsd - 1);
  const s = Math.abs(depthSellUsd / sellUsd - 1);
  return Math.round(Math.max(b, s) * 10_000);
}

export interface PremiumOptions {
  readonly now?: number;
  readonly maxSpreadBps?: number;
  /** Refuse as too thin above this depth move. Default `PREMIUM_MAX_DEPTH_MOVE_BPS`. */
  readonly maxDepthMoveBps?: number;
  readonly maxOnchainAgeSeconds?: number;
}

/** The New York date of a unix instant. */
function nyDateOf(seconds: number): string {
  return usEquitySession(seconds).nyDate;
}

/** The signed gap between an on-chain price and its reference, or why there is none. Pure. */
export function premium(ref: ReferencePrice, onchain: OnchainPrice, opts: PremiumOptions = {}): StockPremium {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const refuse = (reason: PremiumReason, detail: string | null): StockPremium => ({
    bps: null,
    percent: null,
    direction: null,
    comparable: false,
    reason,
    detail,
    basis: ref.basis,
    label: null,
    uncertaintyBps: ref.basisUncertaintyBps,
  });
  if (!ref.comparable || ref.usd === null) return refuse(ref.reason ?? "no-reference", ref.detail);
  if (onchain.usd === null || !(onchain.usd > 0)) return refuse("no-onchain-price", onchain.reason);
  if (now - onchain.at > (opts.maxOnchainAgeSeconds ?? PREMIUM_MAX_ONCHAIN_AGE_SECONDS)) return refuse("onchain-stale", `the on-chain price is ${now - onchain.at}s old`);
  /* One side alone is not a price: a pool $100 can drain buys at many times the value and sells at a
     fraction of it, and only the spread between the two says so. A Gully Core spot price is a price. */
  if (onchain.kind === "executable-buy" || onchain.kind === "executable-sell") return refuse("onchain-one-sided", onchain.reason);
  if (onchain.spreadBps !== null && Math.abs(onchain.spreadBps) > (opts.maxSpreadBps ?? PREMIUM_MAX_SPREAD_BPS)) {
    return refuse("onchain-spread-too-wide", `buy ${onchain.buyUsd} / sell ${onchain.sellUsd}: spread ${onchain.spreadBps} bps`);
  }
  /* Depth: a price that a trade a few times the probe moves by more than the bound is not a market
     price. A depth check that could not be completed refuses too: thinness unconfirmed is not depth. */
  const depth = onchain.depth;
  if (onchain.kind === "executable-mid" && depth) {
    const limit = opts.maxDepthMoveBps ?? PREMIUM_MAX_DEPTH_MOVE_BPS;
    if (depth.moveBps === null) return refuse("onchain-too-thin", `the ${depth.multiple}x depth quote could not be completed: ${depth.reason ?? "no fill"}`);
    if (depth.moveBps > limit) {
      return refuse("onchain-too-thin", `at ${depth.multiple}x the probe the price moves ${depth.moveBps} bps (limit ${limit}): buy ${depth.buyUsd} / sell ${depth.sellUsd}`);
    }
  }
  const bps = Math.round((onchain.usd / ref.usd - 1) * 10_000);
  return {
    bps,
    percent: bps / 100,
    direction: bps > 0 ? "premium" : bps < 0 ? "discount" : "flat",
    comparable: true,
    reason: null,
    detail: null,
    basis: ref.basis,
    label: ref.basis === "last-close" && ref.lastCloseAt !== null ? `vs last close ${nyDateOf(ref.lastCloseAt - 1)}` : "vs live price",
    uncertaintyBps: ref.basisUncertaintyBps,
  };
}
