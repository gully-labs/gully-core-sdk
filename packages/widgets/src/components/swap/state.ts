// SPDX-License-Identifier: MIT
/**
 * The swap widget's state, as pure functions.
 *
 * `SwapWidget` renders; everything it decides lives here so it can be tested
 * without a DOM (the unit suite renders through `react-dom/server`, where no
 * effect runs and no button can be pressed). The shape:
 *
 * - A **pair** is unordered but anchored: `token` is the thing being traded,
 *   `quote` what it is priced in. A **side** orients it - `buy` pays the quote
 *   and receives the token, `sell` the reverse. The Sell / Buy panels always
 *   show the oriented view; the anchor is what a host pins with `pair` and what
 *   `side` flips over, so a side change never touches the selection itself.
 * - The flip button turns the trade around: the amount the current quote
 *   would have delivered becomes the amount you pay (the widget is exact-input
 *   only, so the typed number cannot stay on the panel it was typed for), and
 *   with no quote in hand the field is cleared. A side change that did not
 *   come from the flip (a host's controlled `side`) keeps the typed amount.
 *   Either way the quote re-reads and nothing of the old one is shown. The
 *   price-impact acknowledgement is reset because it was given for a
 *   different trade.
 * - Portions are fractions of the input balance. There is no balance without
 *   a wallet, so a portion without one is refused, never estimated.
 */

import type { RouteStep, SwapQuoteResult, TokenInfo } from "../../adapters/protocol.js";
import { formatUnits } from "viem";
import { formatPercentFromPips } from "../../core/format.js";
import { feeLine } from "../../core/launchCharges.js";
import type { PriceImpactSeverity, QuoteBreakdown } from "../../core/math.js";
import type { AsyncStatus } from "../../hooks/useAsyncResource.js";

/** Which way a pinned pair is traded: `buy` pays the quote for the token. */
export type SwapSide = "buy" | "sell";

/**
 * A pair for {@link SwapWidget}'s `pair` prop, by address or by `TokenInfo`.
 * `{ token, quote }` is the anchored form; `{ tokenIn, tokenOut }` is the same
 * pair given in its `buy` orientation (`tokenIn` is the quote).
 */
export type SwapPair =
  | { readonly token: string | TokenInfo; readonly quote: string | TokenInfo }
  | { readonly tokenIn: string | TokenInfo; readonly tokenOut: string | TokenInfo };

/** A pair reduced to its anchored form. */
export interface AnchoredPair<T> {
  readonly token: T;
  readonly quote: T;
}

/** The two panels' tokens. */
export interface OrientedPair<T> {
  readonly tokenIn: T;
  readonly tokenOut: T;
}

/** Reduces either `SwapPair` shape to `{ token, quote }`. */
export function normalizePair(pair: SwapPair): AnchoredPair<string | TokenInfo> {
  return "token" in pair ? { token: pair.token, quote: pair.quote } : { token: pair.tokenOut, quote: pair.tokenIn };
}

/** The address of a pair entry, lower-cased. */
export function pairEntryAddress(entry: string | TokenInfo): string {
  return (typeof entry === "string" ? entry : entry.address).toLowerCase();
}

/** A stable key for a pair prop, so a re-render with an equal pair is not a re-pin. */
export function pairKey(pair: SwapPair | undefined): string | null {
  if (pair === undefined) return null;
  const anchored = normalizePair(pair);
  return `${pairEntryAddress(anchored.token)}:${pairEntryAddress(anchored.quote)}`;
}

/** Finds a token in a list by address, case-insensitively. */
export function findToken(tokens: readonly TokenInfo[], address: string | undefined): TokenInfo | null {
  if (address === undefined) return null;
  const wanted = address.toLowerCase();
  return tokens.find((token) => token.address.toLowerCase() === wanted) ?? null;
}

/**
 * Resolves a pair entry: a `TokenInfo` is taken as given; an address is looked
 * up in the list. `null` means the list does not carry it (the widget then asks
 * the adapter for the token contract).
 */
export function resolvePairEntry(entry: string | TokenInfo, tokens: readonly TokenInfo[]): TokenInfo | null {
  if (typeof entry !== "string") return entry;
  return findToken(tokens, entry);
}

/** Orients an anchored pair for the panels: `buy` pays the quote. */
export function orientPair<T>(anchor: AnchoredPair<T>, side: SwapSide): OrientedPair<T> {
  return side === "buy" ? { tokenIn: anchor.quote, tokenOut: anchor.token } : { tokenIn: anchor.token, tokenOut: anchor.quote };
}

/** The inverse of {@link orientPair}: what the panels show, as an anchor. */
export function unorientPair<T>(oriented: OrientedPair<T>, side: SwapSide): AnchoredPair<T> {
  return side === "buy" ? { token: oriented.tokenOut, quote: oriented.tokenIn } : { token: oriented.tokenIn, quote: oriented.tokenOut };
}

/** The other side. */
export function oppositeSide(side: SwapSide): SwapSide {
  return side === "buy" ? "sell" : "buy";
}

// --- portions ---------------------------------------------------------------

/** The widget's default portion chips: 25%, 50%, 75% and Max (the design's four quick amounts). */
export const DEFAULT_PORTIONS: readonly number[] = [0.25, 0.5, 0.75, 1];

/** A sliver of the native asset kept back for gas when "Max" is pressed. */
const NATIVE_GAS_RESERVE = 10n ** 15n;

/**
 * Validates a `portions` prop. Every entry must be a finite fraction in
 * `(0, 1]`; the order given is the order rendered. An empty list hides the
 * chips. Throws, like every other bad widget config, rather than rendering a
 * chip that would compute a nonsense amount.
 */
export function normalizePortions(portions: readonly number[] | undefined): readonly number[] {
  if (portions === undefined) return DEFAULT_PORTIONS;
  for (const fraction of portions) {
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new RangeError(`[@gullylabs/core-widgets] portions must be fractions in (0, 1]: ${String(fraction)}`);
    }
  }
  return portions;
}

/** The chip label for a fraction: `1` is "Max", the rest a percentage. */
export function portionLabel(fraction: number): string {
  if (fraction === 1) return "Max";
  const percent = fraction * 100;
  return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}

/**
 * A fraction of a balance, in the token's smallest unit. On the native asset
 * the whole balance keeps a sliver for gas; any smaller fraction, and any
 * ERC-20, is exact. Uses basis-point precision so `0.333` is not lost.
 */
export function balancePortion(balance: bigint, fraction: number, token: TokenInfo): bigint {
  const bps = BigInt(Math.round(fraction * 10_000));
  const raw = (balance * bps) / 10_000n;
  if (token.isNative === true && fraction === 1) return raw > NATIVE_GAS_RESERVE ? raw - NATIVE_GAS_RESERVE : 0n;
  return raw;
}

/**
 * The amount text a portion chip writes into the input, or `null` when there
 * is nothing to take a portion of: no input token, or no balance because no
 * wallet is connected. `null` is a refusal - the widget never guesses a
 * balance - and the caller decides whether to ask for a wallet.
 *
 * Plain decimal text, exact to the token's decimals and never grouped: it is
 * parsed back by `parseAmount`, which takes no thousands separator.
 */
export function portionAmountText(token: TokenInfo | null, balance: bigint | null, fraction: number): string | null {
  if (token === null || balance === null) return null;
  return formatUnits(balancePortion(balance, fraction, token), token.decimals);
}

// --- the state machine ------------------------------------------------------

/** What the widget holds between renders. */
export interface SwapWidgetState {
  /** The anchored selection; `null` entries mean nothing chosen yet. */
  readonly anchor: AnchoredPair<TokenInfo | null>;
  /** The widget's own side. Ignored while the host controls `side`. */
  readonly side: SwapSide;
  /** The typed input amount, verbatim. */
  readonly amountText: string;
  /** Whether the user acknowledged the current trade's price impact. */
  readonly impactAck: boolean;
}

/** Every transition the widget makes. */
export type SwapWidgetAction =
  /** The token list arrived (or the defaults changed) and nothing is selected yet. */
  | { readonly type: "seed"; readonly tokens: readonly TokenInfo[]; readonly defaultTokenIn?: string; readonly defaultTokenOut?: string | null; readonly side: SwapSide }
  /** The host's `pair` resolved. Overrides the selection; keeps the amount. */
  | { readonly type: "pin"; readonly anchor: AnchoredPair<TokenInfo | null> }
  /** The Sell panel's selector picked a token. */
  | { readonly type: "select-in"; readonly token: TokenInfo; readonly side: SwapSide }
  /** The Buy panel's selector picked a token. */
  | { readonly type: "select-out"; readonly token: TokenInfo; readonly side: SwapSide }
  /** The direction flipped (flip button, `flip()` or a controlled `side` change). */
  | { readonly type: "set-side"; readonly side: SwapSide; readonly amountText?: string }
  | { readonly type: "amount"; readonly text: string }
  | { readonly type: "ack"; readonly value: boolean };

/** The state before anything is known. */
export const INITIAL_SWAP_STATE: SwapWidgetState = {
  anchor: { token: null, quote: null },
  side: "buy",
  amountText: "",
  impactAck: false,
};

/**
 * The initial state for a mount: a pair given as `TokenInfo`s is selected
 * synchronously, so a locked pair renders its chips on the first frame (and in
 * a server render); an address waits for the list.
 */
export function initialSwapState(options: { readonly pair?: SwapPair; readonly side?: SwapSide }): SwapWidgetState {
  const side = options.side ?? "buy";
  if (options.pair === undefined) return { ...INITIAL_SWAP_STATE, side };
  const anchored = normalizePair(options.pair);
  return {
    ...INITIAL_SWAP_STATE,
    side,
    anchor: {
      token: typeof anchored.token === "string" ? null : anchored.token,
      quote: typeof anchored.quote === "string" ? null : anchored.quote,
    },
  };
}

/** Applies one action. Pure; the component wraps it in `useReducer`. */
export function swapWidgetReducer(state: SwapWidgetState, action: SwapWidgetAction): SwapWidgetState {
  switch (action.type) {
    case "seed": {
      if (action.tokens.length === 0) return state;
      const shown = orientPair(state.anchor, action.side);
      const tokenIn = shown.tokenIn ?? findToken(action.tokens, action.defaultTokenIn) ?? action.tokens[0] ?? null;
      /* `null` asks for an empty output: the host has no default to offer, so none is guessed. */
      const tokenOut = shown.tokenOut ?? (action.defaultTokenOut === null ? null : (findToken(action.tokens, action.defaultTokenOut) ?? action.tokens[1] ?? null));
      if (tokenIn === shown.tokenIn && tokenOut === shown.tokenOut) return state;
      return { ...state, anchor: unorientPair({ tokenIn, tokenOut }, action.side) };
    }
    case "pin": {
      if (action.anchor.token === state.anchor.token && action.anchor.quote === state.anchor.quote) return state;
      return { ...state, anchor: action.anchor, impactAck: false };
    }
    case "select-in": {
      const shown = orientPair(state.anchor, action.side);
      return { ...state, anchor: unorientPair({ tokenIn: action.token, tokenOut: shown.tokenOut }, action.side), impactAck: false };
    }
    case "select-out": {
      const shown = orientPair(state.anchor, action.side);
      return { ...state, anchor: unorientPair({ tokenIn: shown.tokenIn, tokenOut: action.token }, action.side), impactAck: false };
    }
    case "set-side":
      if (action.side === state.side) return state;
      /* With a carried amount (the flip button), it replaces the typed one; without, the amount stays. */
      return { ...state, side: action.side, impactAck: false, ...(action.amountText === undefined ? {} : { amountText: action.amountText }) };
    case "amount":
      if (action.text === state.amountText) return state;
      return { ...state, amountText: action.text, impactAck: false };
    case "ack":
      return state.impactAck === action.value ? state : { ...state, impactAck: action.value };
    default:
      return state;
  }
}

// --- the quote view ---------------------------------------------------------

/** One quote as a host sees it through `onQuote`. Smallest units throughout. */
export interface SwapQuoteView {
  readonly tokenIn: TokenInfo;
  readonly tokenOut: TokenInfo;
  readonly amountIn: bigint;
  /** What the user receives after the integrator fee. */
  readonly amountOut: bigint;
  /** Output before the integrator fee, as the pool quotes it. */
  readonly grossAmountOut: bigint;
  /** The floor after slippage and the integrator fee - what the transaction enforces. */
  readonly minReceived: bigint;
  readonly integratorFee: bigint;
  readonly slippageBps: number;
  /** `null` when the pool's fee is hook-set: an impact that silently included it would be an invented number. */
  readonly priceImpactBps: number | null;
  readonly priceImpactSeverity: PriceImpactSeverity;
  readonly lpFee: {
    readonly pips: number;
    readonly unknown: boolean;
    /** Ready to print: a percentage, or `dynamic (hook-set)`. */
    readonly label: string;
  };
  /**
   * The trading-fee line as the widget prints it: `"Pool fee"` or, where a
   * launch takes the fee itself in its quote currency, `"Trading fee"` with a
   * value that says the currency ("1% · paid in ETH"). A host that restates
   * the fee in its own voice prints these, never `lpFee` under its own label.
   */
  readonly fee: { readonly label: string; readonly value: string };
  /** The creator tax THIS trade pays now, in bps, as the quote read it; `null` when the pool has none to read. */
  readonly creatorTaxBps: number | null;
  readonly route: readonly RouteStep[];
  /** The route's token symbols, input first. */
  readonly routeSymbols: readonly string[];
  /** Output units per input unit, for display. */
  readonly rate: number | null;
  readonly status: AsyncStatus;
  /** `true` while a newer quote is being read over this one. */
  readonly isRefreshing: boolean;
  readonly isMock: boolean;
  readonly updatedAt: number | null;
  /**
   * Set when the widget will fill this trade on a third-party venue through `GullyCoreFillRouter`
   * (it beat every Gully Core pool for the user). `null` on a Gully Core pool, which pays no routing fee.
   * The fee is its own number, never part of `priceImpactBps`; `amountOut` is already net of it.
   */
  readonly routing?: {
    /** Factual venue name for a "Best price" line. */
    readonly venue: string;
    /** Routing fee in force, as READ from `GullyCoreFillRouter`. */
    readonly feeBps: number;
    /** Fee in `tokenIn` units. */
    readonly feeAmount: bigint;
  } | null;
}

/** Symbols along a route, input first, blanks dropped. */
export function routeSymbols(route: readonly RouteStep[]): readonly string[] {
  if (route.length === 0) return [];
  const symbols = [route[0]?.tokenIn.symbol ?? ""];
  for (const step of route) symbols.push(step.tokenOut.symbol);
  return symbols.filter((symbol) => symbol !== "");
}

/** Builds the `onQuote` payload, or `null` while there is no quote to report. */
export function buildSwapQuoteView(input: {
  readonly tokenIn: TokenInfo | null;
  readonly tokenOut: TokenInfo | null;
  readonly quote: SwapQuoteResult | null;
  readonly breakdown: QuoteBreakdown | null;
  readonly rate: number | null;
  readonly status: AsyncStatus;
  readonly isRefreshing: boolean;
  readonly isMock: boolean;
  readonly updatedAt: number | null;
}): SwapQuoteView | null {
  const { tokenIn, tokenOut, quote, breakdown } = input;
  if (tokenIn === null || tokenOut === null || quote === null || breakdown === null) return null;
  return {
    tokenIn,
    tokenOut,
    amountIn: breakdown.amountIn,
    amountOut: breakdown.netAmountOut,
    grossAmountOut: breakdown.grossAmountOut,
    minReceived: breakdown.minAmountOutNet,
    integratorFee: breakdown.integratorFee,
    slippageBps: breakdown.slippageBps,
    priceImpactBps: breakdown.priceImpactBps,
    priceImpactSeverity: breakdown.priceImpactSeverity,
    lpFee: {
      pips: breakdown.lpFeePips,
      unknown: breakdown.lpFeeUnknown,
      label: breakdown.lpFeeUnknown ? "dynamic (hook-set)" : formatPercentFromPips(breakdown.lpFeePips),
    },
    fee: (({ label, value }) => ({ label, value }))(feeLine(breakdown, quote.launch, "details")),
    creatorTaxBps: quote.launch?.taxBps ?? null,
    route: quote.route,
    routeSymbols: routeSymbols(quote.route),
    rate: input.rate,
    status: input.status,
    isRefreshing: input.isRefreshing,
    isMock: input.isMock,
    updatedAt: input.updatedAt,
    routing: null,
  };
}

/** The inline slippage control's choices when the host names none, in bps: 0.1%, 0.5%, 1%. */
export const DEFAULT_SLIPPAGE_OPTIONS: readonly number[] = [10, 50, 100];

/**
 * Validates the inline slippage choices (`slippageOptions`): integers in bps,
 * from 0 to the widget's ceiling, at least one. A bad list throws at render,
 * like every other bad widget config.
 */
export function normalizeSlippageOptions(options: readonly number[] | undefined, maxBps: number): readonly number[] {
  if (options === undefined) return DEFAULT_SLIPPAGE_OPTIONS;
  if (options.length === 0) throw new RangeError("[@gullylabs/core-widgets] slippageOptions must name at least one value");
  for (const bps of options) {
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > maxBps) {
      throw new RangeError(`[@gullylabs/core-widgets] slippageOptions must be integer bps in [0, ${maxBps}]: ${String(bps)}`);
    }
  }
  return options;
}

/**
 * Which coin a pinned pair quoted in the chain's WRAPPED native pays (buy) or pays out (sell) when the
 * visitor has not chosen: the native coin, unless the wallet's wrapped balance already covers the buy
 * (with no amount typed, any wrapped balance counts) or the wallet holds no native coin at all. A sell
 * pays out the native coin unless the wallet holds wrapped and no native. Balances not read yet (no
 * wallet) read as the native coin: what most wallets hold.
 */
export function autoQuoteCoin(o: {
  readonly side: SwapSide;
  readonly wrappedBalance: bigint | null;
  readonly nativeBalance: bigint | null;
  /** The amount typed on a buy, in the wrapped native's units; `null` when none. */
  readonly buyAmount: bigint | null;
}): "native" | "wrapped" {
  const wrapped = o.wrappedBalance ?? 0n;
  const native = o.nativeBalance;
  if (wrapped === 0n) return "native";
  if (native === 0n) return "wrapped";
  if (o.side === "sell") return "native";
  return o.buyAmount === null || o.buyAmount === 0n || wrapped >= o.buyAmount ? "wrapped" : "native";
}

/** A slippage choice's label: `10` is "0.1%", `50` "0.5%", `100` "1%" - no trailing zeros. */
export function slippageOptionLabel(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
