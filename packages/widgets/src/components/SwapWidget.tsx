// SPDX-License-Identifier: MIT
/**
 * Drop-in swap widget.
 *
 * Everything below the presentation is the headless layer: `useSwapQuote` and
 * `useSwapExecute` do the work, this file only renders it. An integrator who
 * wants their own look imports those two hooks and deletes this component from
 * their bundle.
 *
 * The presentation is the one people expect from a swap: two large amount
 * panels (You pay / You receive) with a token selector dialog each, a flip button between
 * them, one call-to-action that always says what the next step is (connect,
 * enter an amount, insufficient balance, approve, swap, confirming), and a
 * details disclosure with the rate, price impact, every fee, the guaranteed
 * minimum and the route. Overlays are Radix primitives (MIT) portalled into the
 * widget so they work inside the shadow-root embed.
 *
 * The integrator fee, when configured, is shown as its own line in the details.
 * That is a deliberate product decision, not a legal one: a fee the user can see
 * is a fee that does not become a scandal, and an integrator whose users trust
 * the widget keeps earning from it.
 *
 * A dollar figure ("≈ $12.40") appears only where the HOST passes `usdPrice` and it answers for that
 * token from a real read; nothing in the adapter prices a token in USD, and a number that looks
 * priced and is not would be an invented one.
 *
 * A host that frames the widget - a token page with Buy / Sell tabs, a swap
 * page that deep-links a pair - drives it through props rather than remounts:
 * `pair` pins the pair (`lockPair` makes the selectors read-only chips), `side`
 * orients it, `onQuote` reports every quote, `slots` add the host's own chrome,
 * and a `ref` gives an imperative handle for the host's own percent chips. All
 * of it is opt-in; without those props the widget is the one it always was.
 *
 * ONE LAYOUT EVERYWHERE (owner, 2026-10-11: "the buy/sell widget needs to work like uniswap"): every
 * variant draws the same two wells, "You pay" (amount, token, ≈$ where the host reads a price,
 * balance, 25% / 50% / 75% / MAX) and "You receive" (token, amount, ≈$), with a ⇅ flip between them
 * (on a pinned launch pair the flip is buy ↔ sell), a collapsible summary ("1 A = x B · Fee · Tax" ▾,
 * then every charge on its own line, price impact separate and coloured, minimum received, slippage,
 * route), and a "Review swap" step in a dialog before the wallet. Typing in "You receive" back-solves
 * the amount to pay from quotes (core/backsolve.ts) and the swap still runs as an exact input.
 * `variant` survives for hosts that pass it ("compact" / "panel" change nothing structural now).
 * The state behind them is pure (`swap/state.ts`) and tested without a DOM.
 *
 * `router` (optional) adds ROUTED fills: the widget also asks a Gully Core router API for its best
 * third-party fill and uses it only when it pays the user strictly more than the best Gully Core pool.
 * Then the quote shows a "Routing fee" line (the on-chain `GullyCoreFillRouter` rate, as read) and a
 * "Best price: <venue>" line, separate from price impact, and the minimum received is taken from
 * the fee-net output. A Gully Core pool pays no routing fee and shows no such line. Router absent,
 * unreachable or answering anything that does not verify: the Gully Core path, exactly as before.
 */

import type { ReactElement } from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { formatUnits, isAddressEqual, type Address } from "viem";
import { bestPriceLabel, fetchRoutedQuote, fetchRouterSources, isTransientRouterError, routingFeeLine, ROUTED_NATIVE, type RouterEndpointConfig } from "../core/routed.js";
import { MAX_SLIPPAGE_BPS, buildQuoteBreakdown, exchangeRate, priceImpactSeverity } from "../core/math.js";
import { solveAmountIn } from "../core/backsolve.js";
import { usePortalContainer } from "./portal.js";
import { useRoutedExecute, useRoutedQuote } from "../hooks/useRoutedSwap.js";
import { SwapTooLargeError, type TokenInfo } from "../adapters/protocol.js";
import { feeLine as chargeFeeLine, taxLine } from "../core/launchCharges.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import { explorerTxUrl } from "../config/chain.js";
import { formatBps } from "../config/integrator.js";
import { combineTokens, type TokenListInput } from "../core/tokenLists.js";
import {
  formatAmount,
  formatPercentFromBps,
  formatRate,
  groupAmountText,
  normalizeAmountText,
  parseAmount,
  shortAddress,
} from "../core/format.js";
import { describeError } from "../core/errors.js";
import { useSwapExecute } from "../hooks/useSwapExecute.js";
import { useSwapQuote } from "../hooks/useSwapQuote.js";
import { useTokenLists } from "../hooks/useTokenLists.js";
import { useAccount, useTokenBalance, useTokenList } from "../hooks/useTokens.js";
import { ErrorPanel, StatusRegion, WidgetShell, connectCtaProps } from "./primitives.js";
import { SwapSettings } from "./swap/SwapSettings.js";
import {
  autoQuoteCoin,
  buildSwapQuoteView,
  initialSwapState,
  normalizePair,
  normalizePortions,
  normalizeSlippageOptions,
  oppositeSide,
  orientPair,
  pairKey,
  portionAmountText,
  portionLabel,
  resolvePairEntry,
  routeSymbols,
  slippageOptionLabel,
  swapWidgetReducer,
  type AnchoredPair,
  type SwapPair,
  type SwapQuoteView,
  type SwapSide,
} from "./swap/state.js";
import { TokenChip, TokenLogo, TokenLogoLookup, TokenSelect } from "./swap/TokenSelect.js";


/** Props for {@link SwapWidget}. */
export interface SwapWidgetProps {
  /** Pre-selects the input token by address. */
  readonly defaultTokenIn?: string;
  /**
   * Pre-selects the output token by address. `null` leaves the output empty ("Select a token") rather
   * than falling back to the list's second token: for a host that has no sensible default to offer.
   */
  readonly defaultTokenOut?: string | null;
  readonly title?: string;
  /** Show the slippage control. Defaults to `true`. */
  readonly showSlippageControl?: boolean;
  readonly onSwapConfirmed?: (hash: string) => void;
  /**
   * Token lists (Uniswap Token Lists standard) to offer beside the adapter's
   * own tokens: documents already in hand, or URLs fetched and schema-validated
   * through the SDK. Order is precedence - the first list to name an address
   * wins - and the picker groups entries by list and badges tokenised stocks.
   * The adapter's tokens (the pools this site routes through) always come first.
   */
  readonly tokenLists?: readonly TokenListInput[];
  /**
   * Makes the "Connect wallet" call to action a working button that opens
   * the host's connect flow. Absent (and absent on the provider too), the CTA
   * is a disabled label and the visitor connects through the host's control.
   */
  readonly onConnectRequest?: () => void;

  /**
   * The pair to trade, pinned: by address (resolved against the token list,
   * then read off the contract when the list lacks it) or as `TokenInfo`s
   * (selected on the first frame). `{ token, quote }` is anchored - `side`
   * says which way it is traded; `{ tokenIn, tokenOut }` is the same pair in
   * its buy orientation. A change of `pair` re-pins without a remount, so the
   * typed amount survives a host switching legs. Without `lockPair` the
   * visitor may still pick other tokens; the pin returns when the prop changes.
   */
  readonly pair?: SwapPair;
  /**
   * With `pair`: the token selectors become read-only chips (the token, no
   * dropdown) and the pair cannot be changed from inside the widget. The flip
   * button stays - it flips the side, not the pair. Defaults to `false`.
   */
  readonly lockPair?: boolean;
  /**
   * The direction, controlled: `buy` pays the quote and receives the token,
   * `sell` the reverse. When set, the widget's flip button only reports through
   * `onSideChange` and the host decides; when absent the widget owns its side
   * and still reports. A side change keeps the typed amount as the amount you
   * pay and re-quotes - it never clears the field.
   */
  readonly side?: SwapSide;
  /** Fired by the flip button and by `flip()`, with the side the widget wants to be on. */
  readonly onSideChange?: (side: SwapSide) => void;
  /**
   * The balance portions offered as chips under the input, as fractions in
   * `(0, 1]`; `1` renders as "Max". Defaults to `[0.25, 0.5, 0.75, 1]`; an empty
   * list hides the chips. The chips only show once a balance has been read -
   * without a wallet there is no balance to take a portion of.
   */
  readonly portions?: readonly number[];
  /**
   * Called when a portion is asked for (a chip, or `setPortion` on the handle)
   * and there is no balance to take it from because no wallet is connected.
   * The widget never estimates a balance; the host may open its connect flow
   * here. Absent, the request is a no-op.
   */
  readonly onNeedsWallet?: () => void;
  /**
   * Reports every quote the widget holds - the net output, the guaranteed
   * minimum, the price impact (`null` when the pool's fee is hook-set), the LP
   * fee label and the route - and `null` when there is none (empty amount, no
   * route, unmounted). Fires when the quote changes, including on refresh.
   */
  readonly onQuote?: (quote: SwapQuoteView | null) => void;
  /**
   * Reports the selected pair whenever either token changes (a selector, a pasted address, a pin
   * resolving), in its BUY orientation: `tokenIn` is the anchor's quote and `tokenOut` the token, so a
   * side flip, which does not change the pair, is not reported. `unlisted` names the tokens of the two
   * that are in none of the widget's lists nor the adapter's tokens (a pasted address): a host warns
   * about those. Meant for a host that keeps the pair in its address bar and feeds it back through
   * `pair` (an equal pair is not a re-pin, so the two never loop).
   */
  readonly onPairChange?: (pair: { readonly tokenIn: TokenInfo; readonly tokenOut: TokenInfo; readonly unlisted: readonly TokenInfo[] }) => void;
  /**
   * USD per WHOLE token, from a real read the host made (an oracle, a stable's peg it vouches for), or
   * `null` when it has none for that token. Only then does a well show "≈ $x". Never estimated here.
   */
  readonly usdPrice?: (token: TokenInfo) => number | null;
  /**
   * The host's own chrome, rendered inside the widget: `header` between the
   * title row and the panels (a leg switcher, a note), `aboveButton` between
   * the panels and the call to action, `footer` after the details and before
   * the brand line. The brand line itself is not a slot.
   */
  readonly slots?: {
    readonly header?: ReactNode;
    readonly aboveButton?: ReactNode;
    readonly footer?: ReactNode;
  };
  /**
   * Kept for hosts that pass it; since 2026-10-11 every variant draws the same layout (the two wells,
   * the ⇅ flip, the collapsible summary, the review step). `"panel"` hides the title row when there is
   * no settings control; `"compact"` only changes the confirmed label ("Bought ✓" / "Sold ✓"). The value
   * is exposed as `data-gullycore-variant` on the form for a host's own styling.
   */
  readonly variant?: "default" | "compact" | "panel";
  /**
   * When the portion chips show. Absent: as they always did, once a balance
   * has been read. `true`: always (the trade panel's 25% / 50% / 75% / MAX row);
   * a chip pressed with no wallet calls `onNeedsWallet` and writes nothing.
   * `false`: never. The chip last used reads as pressed until the amount is
   * typed over. In the `compact` and `panel` variants the chips are their own
   * row under the amount well.
   */
  readonly showPortions?: boolean;
  /**
   * Where the slippage is chosen: `"settings"` (the header's popover, the
   * default), `"inline"` (a "Slippage" row of choices in the panel, the
   * trade panel's), or `"none"`. `showSlippageControl={false}` is `"none"`
   * when this is absent.
   */
  readonly slippageControl?: "settings" | "inline" | "none";
  /** The inline slippage control's choices, in bps. Defaults to `[10, 50, 100]` (0.1%, 0.5%, 1%). */
  readonly slippageOptions?: readonly number[];
  /**
   * `true`: the widget draws no frame of its own (padding, border,
   * background, max width), for a host that already puts it in a panel.
   */
  readonly bare?: boolean;
  /**
   * The pool's creator tax as the host read it from the launch guard: the rate
   * a buy and a sell pay NOW, in bps (pass 0 once the tax has expired - it
   * ends with no transaction). Rendered as its own line for the current side,
   * never folded into the pool fee or the price impact. `null` says the pool
   * takes none. Absent, the line is drawn from the quote's own reading of the
   * launch pool it goes through (`SwapQuoteResult.launch`), and there is no
   * line for any other pool.
   */
  readonly creatorTax?: { readonly buyBps: number; readonly sellBps: number } | null;
  /**
   * Routed fills (optional). The router API's chain-scoped base URL and this chain's
   * `GullyCoreFillRouter` from the SDK address book. Absent, the widget swaps through Gully Core pools only,
   * exactly as without this prop. Ignored while an integrator fee is active (a routed fill has no
   * integrator step, so routing would silently drop the host's fee) and under the mock adapter.
   */
  readonly router?: RouterEndpointConfig;
}

/**
 * What a `ref` on {@link SwapWidget} gives the host: the amount, the balance
 * portions and the direction, so a page can draw its own percent chips or
 * Buy / Sell tabs and still leave the trade to the widget.
 */
export interface SwapWidgetHandle {
  /** Writes the input amount, as the user would type it (`"1.5"`). */
  setAmountIn(text: string): void;
  /**
   * Writes a fraction of the input balance (`0.75`, `1` for Max with the
   * native gas sliver kept back). Returns `false` - and calls `onNeedsWallet` -
   * when there is no balance to take it from; nothing is written then.
   */
  setPortion(fraction: number): boolean;
  /** Flips the direction, exactly like the widget's own flip button. */
  flip(): void;
  /** Re-reads the quote now rather than on the next interval. */
  refreshQuote(): void;
}

/** Price impact above which the user must acknowledge before the button arms. */
const IMPACT_ACK_BPS = 1_500;

/** How long a confirmed swap stays on the button ("Swapped ✓") before it says the next step again. */
const DONE_MS = 1_800;

/** Price impact's colour: amber above 1%, red above 5% (owner, 2026-10-11). `undefined` when unknown. */
export function impactTone(bps: number | null): "ok" | "warn" | "bad" | undefined {
  if (bps === null) return undefined;
  if (bps > 500) return "bad";
  if (bps > 100) return "warn";
  return "ok";
}

/** "≈ $1,234.56"; "<$0.01" for dust. Only ever called with a host-read price. */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "";
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Resolves a `pair` prop to tokens. Entries given as `TokenInfo` are taken as
 * is; addresses are looked up in the list and, when the list lacks one, read
 * off the token contract through the adapter (the same path the selector uses
 * for a pasted address). `null` entries are still loading or unreadable.
 */
function usePinnedPair(pair: SwapPair | undefined, tokens: readonly TokenInfo[]): AnchoredPair<TokenInfo | null> | null {
  const { adapter } = useWidgetContext();
  const key = pairKey(pair);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the pair's addresses, not the object
  const anchored = useMemo(() => (pair === undefined ? null : normalizePair(pair)), [key]);
  const [fetched, setFetched] = useState<Record<string, TokenInfo | null>>({});
  /* Each address is asked for once per adapter; a result landing after unmount is dropped. */
  const requested = useRef<{ adapter: unknown; addresses: Set<string> }>({ adapter, addresses: new Set() });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fromList = useMemo(() => {
    if (anchored === null) return null;
    return { token: resolvePairEntry(anchored.token, tokens), quote: resolvePairEntry(anchored.quote, tokens) };
  }, [anchored, tokens]);

  useEffect(() => {
    if (anchored === null || fromList === null) return;
    if (requested.current.adapter !== adapter) requested.current = { adapter, addresses: new Set() };
    for (const k of ["token", "quote"] as const) {
      const entry = anchored[k];
      if (fromList[k] !== null || typeof entry !== "string") continue;
      const address = entry.toLowerCase();
      if (requested.current.addresses.has(address)) continue;
      requested.current.addresses.add(address);
      void adapter
        .getToken(address as Address)
        .then((token) => mounted.current && setFetched((current) => ({ ...current, [address]: token })))
        .catch(() => mounted.current && setFetched((current) => ({ ...current, [address]: null })));
    }
  }, [adapter, anchored, fromList]);

  return useMemo(() => {
    if (anchored === null || fromList === null) return null;
    const pick = (k: "token" | "quote"): TokenInfo | null => fromList[k] ?? (typeof anchored[k] === "string" ? (fetched[(anchored[k] as string).toLowerCase()] ?? null) : null);
    return { token: pick("token"), quote: pick("quote") };
  }, [anchored, fromList, fetched]);
}

/** The styled swap widget. */
export const SwapWidget = forwardRef(function SwapWidget(props: SwapWidgetProps, ref: ForwardedRef<SwapWidgetHandle>): ReactElement {
  const { integrator, defaultSlippageBps, chain, onConnectRequest: providerConnect, router: providerRouter } = useWidgetContext();
  /* The widget's own `router` wins; the provider's applies to every widget beneath it. */
  const router = props.router ?? providerRouter;
  const onConnectRequest = props.onConnectRequest ?? providerConnect;
  const tokenList = useTokenList();
  const lists = useTokenLists(props.tokenLists);
  const accountResource = useAccount();
  const tokens = useMemo(() => combineTokens(tokenList.data ?? [], lists.tokens), [tokenList.data, lists.tokens]);
  const portions = normalizePortions(props.portions);
  const locked = props.pair !== undefined && props.lockPair === true;
  const compact = props.variant === "compact";
  const panel = props.variant === "panel";
  const variant = compact ? "compact" : panel ? "panel" : "default";
  const slippageControl = props.slippageControl ?? (props.showSlippageControl === false ? "none" : "settings");
  const slippageOptions = normalizeSlippageOptions(props.slippageOptions, MAX_SLIPPAGE_BPS);

  const [state, dispatch] = useReducer(swapWidgetReducer, { ...(props.pair === undefined ? {} : { pair: props.pair }), ...(props.side === undefined ? {} : { side: props.side }) }, initialSwapState);
  /* Controlled when the host gives `side`; the widget's own otherwise. */
  const side: SwapSide = props.side ?? state.side;
  const { amountText } = state;

  /* A pinned pair quoted in the chain's WRAPPED native also trades against the native coin: the router
     wraps it in, or unwraps it out, inside the swap (no approval, no Permit2 on that side). The visitor
     picks ETH or WETH under the amount; until they do, `autoQuoteCoin` picks from the wallet's balances. */
  const wrappedAddress = chain.contracts.wrappedNative;
  const anchorQuote = state.anchor.quote;
  /* Only a LOCKED pair needs this: its quote side's chip becomes a two-entry picker (ETH | WETH). A
     free box lists the native coin beside the wrapped one in its own picker, so what the visitor
     picked there stays what they picked. */
  const wrappedQuote: TokenInfo | null =
    props.pair !== undefined && locked && wrappedAddress !== undefined && anchorQuote !== null && anchorQuote.isNative !== true && isAddressEqual(anchorQuote.address, wrappedAddress) ? anchorQuote : null;
  const nativeCoin: TokenInfo = useMemo(
    () => ({ address: "0x0000000000000000000000000000000000000000", symbol: chain.nativeCurrency.symbol, name: chain.nativeCurrency.name, decimals: chain.nativeCurrency.decimals, isNative: true }),
    [chain.nativeCurrency.symbol, chain.nativeCurrency.name, chain.nativeCurrency.decimals],
  );
  const [chosenCoin, setChosenCoin] = useState<"native" | "wrapped" | null>(null);
  const wrappedBalance = useTokenBalance(wrappedQuote, accountResource.data ?? null);
  const nativeBalance = useTokenBalance(wrappedQuote === null ? null : nativeCoin, accountResource.data ?? null);
  const buyAmountForCoin = useMemo(() => {
    if (wrappedQuote === null || side !== "buy" || amountText.trim() === "") return null;
    const r = parseAmount(amountText, wrappedQuote.decimals);
    return r.ok ? r.value : null;
  }, [wrappedQuote, side, amountText]);
  const quoteCoin: "native" | "wrapped" | null =
    wrappedQuote === null
      ? null
      : (chosenCoin ??
        autoQuoteCoin({ side, wrappedBalance: wrappedBalance.data ?? null, nativeBalance: nativeBalance.data ?? null, buyAmount: buyAmountForCoin }));
  const anchor = quoteCoin === "native" ? { ...state.anchor, quote: nativeCoin } : state.anchor;
  const { tokenIn, tokenOut } = orientPair(anchor, side);
  const [slippageBps, setSlippageBps] = useState(defaultSlippageBps);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rateFlipped, setRateFlipped] = useState(false);
  /* The portion chip last used, pressed until the amount is typed over or the side changes. */
  const [pickedPortion, setPickedPortion] = useState<number | null>(null);
  const slippageLabelId = `${useId()}-slippage`;

  // A controlled side change resets the impact acknowledgement like a flip does.
  useEffect(() => {
    if (props.side === undefined) return;
    /* A host that accepted our own flip gets the carried amount; a side the
       host changed on its own keeps the typed amount (documented behaviour). */
    const carry = carryRef.current;
    carryRef.current = null;
    dispatch({ type: "set-side", side: props.side, ...(carry !== null && carry.side === props.side ? { amountText: carry.text } : {}) });
  }, [props.side]);

  // The pinned pair, once its tokens resolve; re-pins when the prop changes.
  const pinned = usePinnedPair(props.pair, tokens);
  useEffect(() => {
    if (pinned !== null) dispatch({ type: "pin", anchor: pinned });
  }, [pinned]);

  /* The pair, reported once per change of either address (buy orientation: a flip is not a change). */
  const onPairChangeRef = useRef(props.onPairChange);
  onPairChangeRef.current = props.onPairChange;
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const anchorToken = state.anchor.token;
  const anchorQuoteToken = state.anchor.quote;
  const anchorKey = anchorToken === null || anchorQuoteToken === null ? "" : `${anchorQuoteToken.address.toLowerCase()}:${anchorToken.address.toLowerCase()}`;
  /* Which of the two no list names, re-read as lists arrive (a list that loads late lifts the warning). */
  const isKnown = (t: TokenInfo | null) => t === null || t.isNative === true || tokens.some((k) => k.address.toLowerCase() === t.address.toLowerCase());
  const unlistedKey = `${isKnown(anchorQuoteToken) ? 1 : 0}${isKnown(anchorToken) ? 1 : 0}`;
  useEffect(() => {
    if (anchorKey === "" || anchorToken === null || anchorQuoteToken === null) return;
    const known = (t: TokenInfo) => t.isNative === true || tokensRef.current.some((k) => k.address.toLowerCase() === t.address.toLowerCase());
    onPairChangeRef.current?.({ tokenIn: anchorQuoteToken, tokenOut: anchorToken, unlisted: [anchorQuoteToken, anchorToken].filter((t) => !known(t)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two addresses and their listing, not the objects
  }, [anchorKey, unlistedKey]);

  // Initial selection, once the token list arrives. A pinned pair never seeds:
  // the wrong token must not show while the pin is still resolving.
  useEffect(() => {
    if (props.pair !== undefined || tokens.length === 0) return;
    dispatch({
      type: "seed",
      tokens,
      side,
      ...(props.defaultTokenIn === undefined ? {} : { defaultTokenIn: props.defaultTokenIn }),
      ...(props.defaultTokenOut === undefined ? {} : { defaultTokenOut: props.defaultTokenOut }),
    });
  }, [tokens, props.pair, props.defaultTokenIn, props.defaultTokenOut, side]);

  /* "You receive" typed: the target the amount to pay is solved for (core/backsolve.ts). `null` while
     the visitor types what they PAY, which is every other case. */
  const [exactOut, setExactOut] = useState<{ readonly text: string; readonly status: "solving" | "solved" | "unreachable" | "invalid"; readonly message?: string } | null>(null);
  const setAmountText = useCallback((text: string) => {
    setPickedPortion(null);
    setExactOut(null);
    dispatch({ type: "amount", text });
  }, []);

  /* Any locale's separators, read by one documented rule (normalizeAmountText) and echoed back under
     the field whenever the reading differs from what was typed: a paste never changes magnitude silently. */
  const normalized = useMemo(() => normalizeAmountText(amountText), [amountText]);
  const parsed = useMemo(() => {
    if (tokenIn === null || amountText.trim() === "") return null;
    if (!normalized.ok) return { ok: false as const, reason: "not-a-number" as const, message: normalized.message };
    return parseAmount(normalized.canonical, tokenIn.decimals);
  }, [amountText, normalized, tokenIn]);

  const amountIn = parsed !== null && parsed.ok ? parsed.value : null;
  const amountError = parsed !== null && !parsed.ok ? parsed.message : null;
  const amountEcho = normalized.ok && normalized.changed && amountIn !== null && tokenIn !== null ? `= ${groupAmountText(normalized.canonical)} ${tokenIn.symbol}` : null;

  const balanceIn = useTokenBalance(tokenIn, accountResource.data);
  const balanceOut = useTokenBalance(tokenOut, accountResource.data);

  const quote = useSwapQuote({ tokenIn, tokenOut, amountIn, slippageBps });
  /* The resource keeps its last data once the request is disabled (amount
     cleared, same token both sides). An idle quote is no quote: nothing of
     the old one is shown or reported. */
  const quoteLive = quote.status !== "idle";
  const breakdown = quoteLive ? quote.breakdown : null;
  const quoted = quoteLive ? quote.quote : null;

  const execution = useSwapExecute({
    tokenIn,
    tokenOut,
    amountIn,
    quote: quoted,
    breakdown,
    ...(props.onSwapConfirmed ? { onSuccess: props.onSwapConfirmed } : {}),
  });

  /* Routed fills: compared only once the Gully Core side has settled for THIS request (`undefined`
     while it loads), and only ever chosen when strictly better for the user. */
  const gullycoreNetOut: bigint | null | undefined = !quoteLive
    ? undefined
    : quote.status === "success"
      ? (breakdown?.netAmountOut ?? null)
      : quote.status === "error"
        ? null
        : undefined;
  const routed = useRoutedQuote({
    router: router,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    gullycoreNetOut,
    enabled: router !== undefined && !integrator.active && !quote.isMock,
  });
  const routedQuote = routed.choice.kind === "routed" ? routed.choice.quote : null;
  const isRouted = routedQuote !== null;
  const routedExec = useRoutedExecute({
    router: router,
    choice: routed.choice,
    minReceived: routed.minReceived,
    slippageBps,
    ...(props.onSwapConfirmed ? { onSuccess: props.onSwapConfirmed } : {}),
  });
  const feeLine = routingFeeLine(routed.choice);
  const bestPrice = bestPriceLabel(routed.choice);

  /* The best output any path quotes for `x` of the input, for the back-solve: the Gully Core pools (net of
     an integrator fee) and, where a router serves, the routed fill (net of the routing fee). A path
     that cannot fill `x` is no answer, never a guess. */
  const { adapter: quoteAdapter } = useWidgetContext();
  const sourcesRef = useRef<{ key: string; map: ReadonlyMap<string, string> } | null>(null);
  const quoteBest = useCallback(
    async (x: bigint): Promise<bigint | null> => {
      if (tokenIn === null || tokenOut === null) return null;
      const deep = quoteAdapter
        .quoteSwap({ tokenIn, tokenOut, amountIn: x })
        .then(
          (q) =>
            buildQuoteBreakdown({
              amountIn: q.amountIn,
              grossAmountOut: q.grossAmountOut,
              spotAmountOut: q.spotAmountOut,
              lpFeeAmount: q.lpFeeAmount,
              lpFeePips: q.lpFeePips,
              ...(q.lpFeeUnknown === undefined ? {} : { lpFeeUnknown: q.lpFeeUnknown }),
              slippageBps,
              integrator,
            }).netAmountOut,
        )
        .catch(() => null);
      const viaRouter =
        router === undefined || integrator.active
          ? Promise.resolve(null)
          : (async () => {
              const key = `${router.baseUrl}|${chain.chainId}`;
              if (sourcesRef.current === null || sourcesRef.current.key !== key) sourcesRef.current = { key, map: await fetchRouterSources(router, chain.chainId) };
              const addr = (t: TokenInfo) => (t.isNative === true ? ROUTED_NATIVE : t.address);
              const req = { chainId: chain.chainId, tokenIn: addr(tokenIn), tokenOut: addr(tokenOut), amountIn: x, slippageBps };
              const map = sourcesRef.current.map;
              /* A timeout is not "this amount cannot fill": asked once more before it counts as no answer. */
              const q = await fetchRoutedQuote(router, req, map).catch((err: unknown) => (isTransientRouterError(err) ? fetchRoutedQuote(router, req, map) : Promise.reject(err)));
              return q === null ? null : q.amountOut;
            })().catch(() => null);
      const [a, b] = await Promise.all([deep, viaRouter]);
      return a === null ? b : b === null ? a : a > b ? a : b;
    },
    [quoteAdapter, tokenIn, tokenOut, slippageBps, integrator, router, chain.chainId],
  );
  const solveSeq = useRef(0);
  useEffect(() => {
    if (exactOut === null || exactOut.status !== "solving" || tokenIn === null || tokenOut === null) return;
    const n = normalizeAmountText(exactOut.text);
    const target = n.ok ? parseAmount(n.canonical, tokenOut.decimals) : null;
    if (target === null || !target.ok) {
      setExactOut({ text: exactOut.text, status: "invalid", message: n.ok ? (target?.ok === false ? target.message : "Enter an amount") : n.message });
      return;
    }
    const seq = ++solveSeq.current;
    const seedIn = amountIn !== null && amountIn > 0n ? amountIn : 10n ** BigInt(Math.max(0, tokenIn.decimals - 2));
    const timer = setTimeout(() => {
      void solveAmountIn(target.value, quoteBest, { seed: seedIn, toleranceBps: 10 }).then((r) => {
        if (seq !== solveSeq.current) return;
        if (r === null) {
          setExactOut((e) => (e === null ? null : { text: e.text, status: "unreachable" }));
          return;
        }
        /* Rounded UP to six decimals, so the field reads like a typed amount and still reaches the target. */
        const step = tokenIn.decimals > 6 ? 10n ** BigInt(tokenIn.decimals - 6) : 1n;
        const pay = ((r.amountIn + step - 1n) / step) * step;
        dispatch({ type: "amount", text: formatUnits(pay, tokenIn.decimals) });
        setExactOut((e) => (e === null ? null : { text: e.text, status: "solved" }));
      });
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the typed target and the pair, not on every quote
  }, [exactOut?.text, exactOut?.status, tokenIn?.address, tokenOut?.address, quoteBest]);
  const typeReceive = useCallback(
    (raw: string) => {
      setPickedPortion(null);
      if (raw.trim() === "") {
        setExactOut(null);
        dispatch({ type: "amount", text: "" });
        return;
      }
      setExactOut({ text: raw, status: "solving" });
    },
    [],
  );

  /* A flip is a side change: the pair stays, the typed amount stays as the
     amount you pay. Controlled, the host is told and decides; otherwise the
     widget moves and tells. */
  const onSideChangeRef = useRef(props.onSideChange);
  onSideChangeRef.current = props.onSideChange;
  const controlledSide = props.side !== undefined;
  /* What the flip carries across: the amount you would have RECEIVED becomes
     the amount you pay, so the panels read as the same trade turned around
     (the widget is exact-input, so the typed number cannot stay on the side it
     was typed for). Without a current quote there is nothing honest to carry
     and the field is cleared; either way the old quote is never shown. */
  const carryRef = useRef<{ side: SwapSide; text: string } | null>(null);
  const switchTokens = useCallback(() => {
    const next = oppositeSide(side);
    const text = breakdown !== null && tokenOut !== null && breakdown.netAmountOut > 0n ? formatUnits(breakdown.netAmountOut, tokenOut.decimals) : "";
    if (!controlledSide) dispatch({ type: "set-side", side: next, amountText: text });
    else carryRef.current = { side: next, text };
    setExactOut(null);
    setRateFlipped(false);
    setPickedPortion(null);
    onSideChangeRef.current?.(next);
  }, [side, controlledSide, breakdown, tokenOut]);

  const onNeedsWalletRef = useRef(props.onNeedsWallet);
  onNeedsWalletRef.current = props.onNeedsWallet;
  const usePortion = useCallback(
    (fraction: number): boolean => {
      const text = portionAmountText(tokenIn, balanceIn.data, fraction);
      if (text === null) {
        onNeedsWalletRef.current?.();
        return false;
      }
      setAmountText(text);
      setPickedPortion(fraction);
      return true;
    },
    [tokenIn, balanceIn.data, setAmountText],
  );

  useImperativeHandle(
    ref,
    () => ({
      setAmountIn: setAmountText,
      setPortion: (fraction: number) => {
        normalizePortions([fraction]);
        return usePortion(fraction);
      },
      flip: switchTokens,
      refreshQuote: quote.refetch,
    }),
    [setAmountText, usePortion, switchTokens, quote.refetch],
  );

  /* The quote as the host sees it. Memoised on the quote's own identity so
     `onQuote` fires when the quote changes, not on every render. */
  const gullycoreQuoteView = useMemo(
    () =>
      buildSwapQuoteView({
        tokenIn,
        tokenOut,
        quote: quoted,
        breakdown,
        rate: quote.rate,
        status: quote.status,
        isRefreshing: quote.isRefreshing,
        isMock: quote.isMock,
        updatedAt: quote.updatedAt,
      }),
    [tokenIn, tokenOut, quoted, breakdown, quote.rate, quote.status, quote.isRefreshing, quote.isMock, quote.updatedAt],
  );
  /* A routed fill reports its own view: fee-net output, the floor from it, the venue's impact, and
     the routing fee as its own field. */
  const quoteView = useMemo<SwapQuoteView | null>(() => {
    if (routedQuote === null || routed.minReceived === null || tokenIn === null || tokenOut === null) return gullycoreQuoteView;
    return {
      tokenIn,
      tokenOut,
      amountIn: routedQuote.amountIn,
      amountOut: routedQuote.amountOut,
      grossAmountOut: routedQuote.amountOut,
      minReceived: routed.minReceived,
      integratorFee: 0n,
      slippageBps,
      priceImpactBps: routedQuote.priceImpactBps,
      priceImpactSeverity: priceImpactSeverity(routedQuote.priceImpactBps),
      lpFee: { pips: 0, unknown: true, label: "set by the venue" },
      fee: { label: "Venue fee", value: "set by the venue" },
      creatorTaxBps: null,
      route: [],
      routeSymbols: [tokenIn.symbol, tokenOut.symbol],
      rate: exchangeRate(routedQuote.amountIn, tokenIn.decimals, routedQuote.amountOut, tokenOut.decimals),
      status: "success",
      isRefreshing: false,
      isMock: false,
      updatedAt: quote.updatedAt,
      routing: { venue: routedQuote.venueName, feeBps: routedQuote.feeBps, feeAmount: routedQuote.feeAmount },
    };
  }, [gullycoreQuoteView, routedQuote, routed.minReceived, tokenIn, tokenOut, slippageBps, quote.updatedAt]);
  const onQuoteRef = useRef(props.onQuote);
  onQuoteRef.current = props.onQuote;
  useEffect(() => {
    onQuoteRef.current?.(quoteView);
  }, [quoteView]);
  useEffect(
    () => () => {
      onQuoteRef.current?.(null);
    },
    [],
  );

  const insufficientBalance = amountIn !== null && balanceIn.data !== null && amountIn > balanceIn.data;
  const impactBps = routedQuote !== null ? routedQuote.priceImpactBps : (breakdown?.priceImpactBps ?? null);
  /* Above 15% the review dialog's button reads "Swap anyway": a confirmation, not a checkbox. */
  const swapAnyway = impactBps !== null && impactBps >= IMPACT_ACK_BPS;

  const outputText =
    tokenOut === null ? "" : routedQuote !== null ? formatAmount(routedQuote.amountOut, tokenOut.decimals) : breakdown === null ? "" : formatAmount(breakdown.netAmountOut, tokenOut.decimals);

  const routeTokens = useMemo(() => (quoted === null ? [] : routeSymbols(quoted.route)), [quoted]);

  const routedStatus = describeRoutedStep(routedExec.step, routedExec.error, tokenIn?.symbol ?? "");
  /* A launch pool that would only fill part of the trade: a state with a way forward, not a failure. */
  const tooLarge = !isRouted && quote.status === "error" && quote.error instanceof SwapTooLargeError ? quote.error : null;
  /* The Gully Core path has no route but the router is still being asked: that is a quote in progress, not
     an error. Its answer decides; "No route" is said only once it, too, has none. */
  const routedPending = !isRouted && quote.status === "error" && tooLarge === null && routed.status === "loading" && !integrator.active;
  /* No Gully Core pool fills it and the router did not answer (timed out twice, unreachable): say THAT, not
     "no route". It is asked again on the next refresh. */
  const routerSilent = !isRouted && quote.status === "error" && tooLarge === null && routed.status === "unavailable" && router !== undefined && !integrator.active;
  const statusMessage =
    isRouted && routedStatus !== ""
      ? routedStatus
      : isRouted
        ? ""
        : execution.statusMessage !== ""
      ? execution.statusMessage
      : routedPending
        ? ""
      : routerSilent
        ? "Gully Core's router did not answer for this trade. It is asked again every 15 seconds."
      : quote.status === "error"
        ? (quote.error === null ? "No route for this pair." : describeError(quote.error, "quote"))
        : "";
  const statusTone = isRouted
    ? routedExec.step === "error"
      ? "error"
      : routedExec.step === "success"
        ? "success"
        : "neutral"
    : (tooLarge !== null || routedPending || routerSilent) && execution.step !== "error"
      ? "neutral"
      : execution.step === "error" || quote.status === "error"
        ? "error"
        : execution.step === "success"
        ? "success"
        : "neutral";

  const busy = isRouted
    ? routedExec.step === "approving" || routedExec.step === "building" || routedExec.step === "simulating" || routedExec.step === "awaiting-signature" || routedExec.step === "pending"
    : execution.step === "approving" || execution.step === "signing" || execution.step === "building" || execution.step === "awaiting-signature" || execution.step === "pending";
  const busyLabel = isRouted
    ? routedExec.step === "approving"
      ? `Allowing ${tokenIn?.symbol ?? ""}…`
      : routedExec.step === "pending"
        ? "Confirming on chain…"
        : routedExec.step === "awaiting-signature"
          ? "Confirm in your wallet…"
          : routedExec.step === "simulating"
            ? "Simulating…"
            : "Preparing…"
    : execution.step === "signing"
      ? "Sign in your wallet…"
      : execution.step === "approving"
        ? `Allowing ${tokenIn?.symbol ?? ""}…`
        : execution.step === "pending"
          ? "Confirming on chain…"
          : execution.step === "awaiting-signature"
            ? "Confirm in your wallet…"
            : "Preparing…";
  const doneLabel = compact ? (side === "buy" ? "Bought ✓" : "Sold ✓") : "Swapped ✓";

  let buttonLabel: string;
  let canSubmit = false;
  const needsConnect = accountResource.data === null || accountResource.data === undefined;
  if (needsConnect) {
    buttonLabel = "Connect wallet";
  } else if (tokenIn === null || tokenOut === null) {
    buttonLabel = "Select a token";
  } else if (busy) {
    buttonLabel = busyLabel;
  } else if (exactOut !== null && exactOut.status === "solving") {
    buttonLabel = "Finding the amount to pay…";
  } else if (exactOut !== null && exactOut.status === "unreachable") {
    buttonLabel = "Not enough liquidity for that amount";
  } else if (exactOut !== null && exactOut.status === "invalid") {
    buttonLabel = exactOut.message ?? "Enter an amount";
  } else if (amountIn === null || amountIn === 0n) {
    buttonLabel = "Enter an amount";
  } else if (amountError !== null) {
    buttonLabel = amountError;
  } else if (insufficientBalance) {
    buttonLabel = `Insufficient ${tokenIn.symbol}`;
  } else if (isRouted) {
    buttonLabel = "Review swap";
    canSubmit = true;
  } else if (((quote.status === "loading" || (quote.status === "idle" && quote.isRefreshing)) && breakdown === null) || routedPending) {
    /* `idle` + refreshing is the first read after the request was disabled (the amount was cleared and retyped). */
    buttonLabel = "Fetching quote…";
  } else if (tooLarge !== null) {
    buttonLabel = "Too large for this pool";
  } else if (routerSilent) {
    buttonLabel = "Waiting for a quote";
  } else if (quote.status === "error") {
    buttonLabel = "Cannot quote this trade";
  } else {
    buttonLabel = "Review swap";
    canSubmit = execution.canExecute && quote.status === "success";
  }

  /* The review dialog: opened by the call to action, it carries the exact amounts and the button that
     reaches the wallet. It stays open through the steps and closes itself once the swap confirms. */
  const [reviewOpen, setReviewOpen] = useState(false);
  const confirmSwap = useCallback(() => {
    if (isRouted) void routedExec.execute();
    else void execution.execute();
  }, [isRouted, routedExec, execution]);
  const confirmLabel = (() => {
    if (busy) return busyLabel;
    const verb = swapAnyway ? "Swap anyway" : "Confirm swap";
    if (isRouted) return verb;
    if (execution.needsApproval) return execution.batched ? (swapAnyway ? "Approve and swap anyway" : "Approve and swap") : `Allow ${tokenIn?.symbol ?? ""} and swap`;
    if (execution.plan.includes("sign")) return swapAnyway ? "Sign and swap anyway" : "Sign and swap";
    return verb;
  })();

  const rateLine = (() => {
    if (isRouted && tokenIn !== null && tokenOut !== null && quoteView !== null && quoteView.rate !== null && quoteView.rate !== 0) {
      return rateFlipped ? formatRate(1 / quoteView.rate, tokenOut.symbol, tokenIn.symbol) : formatRate(quoteView.rate, tokenIn.symbol, tokenOut.symbol);
    }
    if (quote.rate === null || tokenIn === null || tokenOut === null || quote.rate === 0) return null;
    return rateFlipped ? formatRate(1 / quote.rate, tokenOut.symbol, tokenIn.symbol) : formatRate(quote.rate, tokenIn.symbol, tokenOut.symbol);
  })();

  /* An empty explorer is no explorer (explorerTxUrl): a devnet has none, and a link to "" is a link to this page. */
  const txHash = isRouted ? routedExec.txHash : execution.txHash;
  const txSucceeded = isRouted ? routedExec.step === "success" : execution.step === "success";
  const txUrl = txHash === null ? null : explorerTxUrl(chain, txHash);

  /* A confirmed swap shows on the button for 1.8 s ("Swapped ✓", in the success fill), then the
     button says what the next step is again. */
  const [justDone, setJustDone] = useState(false);
  useEffect(() => {
    if (!txSucceeded || txHash === null) return;
    setJustDone(true);
    const timer = setTimeout(() => setJustDone(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [txSucceeded, txHash]);

  /* The trading fee and the creator tax, each on its own line (core/launchCharges.ts): the fee as
     the pool's, or as the launch's own where it takes the fee itself; the tax for the current side,
     as the host read it or as the quote did. Neither is ever part of the price impact. */
  const launchCharges = quoted?.launch;
  const taxRow = taxLine(side, props.creatorTax, launchCharges);

  const showDone = justDone && !busy && !needsConnect;
  const settings = slippageControl === "settings" ? <SwapSettings slippageBps={slippageBps} defaultSlippageBps={defaultSlippageBps} onSlippageChange={setSlippageBps} /> : undefined;

  /* Quick amounts: real fractions of the balance just read. By default they exist only once there
     is one; `showPortions` shows them always (a press without a wallet asks the host to connect). */
  const hasBalance = balanceIn.data !== null && tokenIn !== null;
  const portionsVisible = portions.length > 0 && props.showPortions !== false && (props.showPortions === true || hasBalance);
  const portionChips = portionsVisible ? (
    <div className="gullycore-portions" role="group" aria-label="Quick amounts">
      {portions.map((fraction) => {
        const label = portionLabel(fraction);
        return (
          <button
            key={fraction}
            type="button"
            className="gullycore-portion"
            aria-pressed={pickedPortion === fraction}
            aria-label={`${label} of your ${tokenIn?.symbol ?? "input token"} balance`}
            onClick={() => usePortion(fraction)}
          >
            {label}
          </button>
        );
      })}
    </div>
  ) : null;

  /* The trade panel's slippage row: one choice at a time, a radio group. */
  const inlineSlippage =
    slippageControl === "inline" ? (
      <div className="gullycore-slippage">
        <span id={slippageLabelId}>Slippage</span>
        <span className="gullycore-slippage__opts" role="radiogroup" aria-labelledby={slippageLabelId}>
          {slippageOptions.map((bps) => (
            <button key={bps} type="button" role="radio" aria-checked={slippageBps === bps} className="gullycore-slippage__btn" onClick={() => setSlippageBps(bps)}>
              {slippageOptionLabel(bps)}
            </button>
          ))}
        </span>
      </div>
    ) : null;

  /* ≈ $ only from the host's own read of a price. */
  const usdOf = (t: TokenInfo | null, v: bigint | null): number | null => {
    if (props.usdPrice === undefined || t === null || v === null) return null;
    const price = props.usdPrice(t);
    if (price === null || !Number.isFinite(price)) return null;
    return price * Number(formatUnits(v, t.decimals));
  };
  const outAmount: bigint | null = routedQuote !== null ? routedQuote.amountOut : breakdown !== null ? breakdown.netAmountOut : null;
  const usdIn = usdOf(tokenIn, amountIn);
  const usdOut = usdOf(tokenOut, outAmount);

  /* The pair's tokens. A free pair picks both; a locked pair shows chips, except that a pair quoted in
     the chain's wrapped native offers ETH | WETH (both entries of one picker) on its quote side. */
  const coinTokens: readonly TokenInfo[] = locked && wrappedQuote !== null ? [nativeCoin, wrappedQuote] : [];
  const pickCoin = (t: TokenInfo) => {
    if (t.isNative === true) setChosenCoin("native");
    else if (wrappedQuote !== null && isAddressEqual(t.address, wrappedQuote.address)) setChosenCoin("wrapped");
  };
  const selectorIn = !locked ? (
    <TokenSelect
      label="You pay"
      value={tokenIn}
      tokens={tokens}
      exclude={tokenOut}
      listFailures={lists.failures}
      listsLoading={lists.status === "loading"}
      onChange={(t) => {
        setExactOut(null);
        dispatch({ type: "select-in", token: t, side });
      }}
    />
  ) : coinTokens.length > 0 && side === "buy" ? (
    <TokenSelect label="Pay with" value={tokenIn} tokens={coinTokens} onChange={pickCoin} />
  ) : (
    <TokenChip label="You pay" value={tokenIn} />
  );
  const selectorOut = !locked ? (
    <TokenSelect
      label="You receive"
      value={tokenOut}
      tokens={tokens}
      exclude={tokenIn}
      listFailures={lists.failures}
      listsLoading={lists.status === "loading"}
      onChange={(t) => {
        setExactOut(null);
        dispatch({ type: "select-out", token: t, side });
      }}
    />
  ) : coinTokens.length > 0 && side === "sell" ? (
    <TokenSelect label="Receive" value={tokenOut} tokens={coinTokens} onChange={pickCoin} />
  ) : (
    <TokenChip label="You receive" value={tokenOut} />
  );

  const payWell = (
    <div className="gullycore-panel" data-gullycore-side="sell">
      <div className="gullycore-panel__top">
        <span className="gullycore-label">You pay</span>
        {balanceIn.data !== null && tokenIn !== null ? <span className="gullycore-panel__balance">Balance {formatAmount(balanceIn.data, tokenIn.decimals)}</span> : null}
      </div>
      <div className="gullycore-panel__main">
        <input
          className="gullycore-big-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.00"
          aria-label={`Amount of ${tokenIn?.symbol ?? "the input token"} to pay`}
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
        {selectorIn}
      </div>
      {usdIn !== null ? <span className="gullycore-panel__usd">≈ {formatUsd(usdIn)}</span> : null}
      {amountEcho !== null && exactOut === null ? (
        <p className="gullycore-panel__echo" aria-live="polite">
          {amountEcho}
        </p>
      ) : null}
      {portionChips}
      {amountError !== null && exactOut === null ? <p className="gullycore-panel__error">{amountError}</p> : null}
    </div>
  );

  const exactOutNote =
    exactOut === null
      ? null
      : exactOut.status === "solving"
        ? "Finding the amount to pay for this…"
        : exactOut.status === "unreachable"
          ? "No route fills that much right now. Try a smaller amount."
          : exactOut.status === "invalid"
            ? (exactOut.message ?? "Enter an amount")
            : `Solved: you pay ${amountText} ${tokenIn?.symbol ?? ""}. The swap runs as that exact input${outputText === "" ? "" : `; quoted now ${outputText} ${tokenOut?.symbol ?? ""}`}, at least the minimum below.`;

  const receiveWell = (
    <div className="gullycore-panel" data-gullycore-side="buy">
      <div className="gullycore-panel__top">
        <span className="gullycore-label">You receive</span>
        {balanceOut.data !== null && tokenOut !== null ? <span className="gullycore-panel__balance">Balance {formatAmount(balanceOut.data, tokenOut.decimals)}</span> : null}
      </div>
      <div className="gullycore-panel__main">
        <input
          className={`gullycore-big-input gullycore-big-input--out${exactOut === null && quote.isRefreshing ? " is-refreshing" : ""}`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.00"
          aria-label={`Amount of ${tokenOut?.symbol ?? "the output token"} to receive`}
          value={exactOut !== null ? exactOut.text : outputText}
          onChange={(e) => typeReceive(e.target.value)}
        />
        {selectorOut}
      </div>
      <output className="gullycore-visually-hidden" aria-live="polite">
        {outputText === "" || tokenOut === null ? "" : `You receive ${outputText} ${tokenOut.symbol}`}
      </output>
      {usdOut !== null ? <span className="gullycore-panel__usd">≈ {formatUsd(usdOut)}</span> : null}
      {exactOutNote !== null ? (
        <p className={`gullycore-panel__note${exactOut?.status === "unreachable" || exactOut?.status === "invalid" ? " gullycore-panel__note--bad" : ""}`} aria-live="polite">
          {exactOutNote}
        </p>
      ) : null}
      {quote.isMock ? <p className="gullycore-panel__note">Simulated by the mock adapter</p> : null}
    </div>
  );

  /* Every line of the trade, each on its own: the rate, the trading fee (or the routing fee), the creator
     tax, an integrator fee, price impact (separate, coloured), minimum received, slippage, route. */
  const minReceived: bigint | null = routedQuote !== null ? routed.minReceived : breakdown !== null ? breakdown.minAmountOutNet : null;
  const feeDetail = breakdown === null ? null : chargeFeeLine(breakdown, launchCharges, "details");
  const feeShort = routedQuote !== null ? formatPercentFromBps(routedQuote.feeBps) : breakdown === null ? null : (chargeFeeLine(breakdown, launchCharges, "compact").value.split(" · ")[0] ?? null);
  const taxShort = taxRow !== null && taxRow.value !== "none" ? (taxRow.value.split(" · ")[0] ?? null) : null;
  const hasTrade = tokenIn !== null && tokenOut !== null && (isRouted || breakdown !== null);
  const tone = impactTone(impactBps);
  const detailRows =
    hasTrade && tokenIn !== null && tokenOut !== null ? (
      <>
        <Row label="Rate">
          <button type="button" className="gullycore-details__flip" onClick={() => setRateFlipped((f) => !f)} title="Flip the rate">
            {rateLine ?? "—"}
          </button>
        </Row>
        {routedQuote !== null ? (
          feeLine !== null ? (
            <Row label={feeLine.label} hint="Taken by Gully Core's router from the amount you pay, read from the router contract. A Gully Core pool pays no routing fee.">
              {formatAmount(feeLine.amount, tokenIn.decimals)} {tokenIn.symbol}
            </Row>
          ) : null
        ) : feeDetail !== null ? (
          <Row label={feeDetail.label} hint={feeDetail.hint}>
            {feeDetail.value}
          </Row>
        ) : null}
        {routedQuote === null && taxRow !== null ? (
          <Row label={taxRow.label} hint={taxRow.hint}>
            {taxRow.value}
          </Row>
        ) : null}
        {routedQuote === null && integrator.active && breakdown !== null ? (
          <Row label={`${integrator.label ?? "Integrator"} fee (${formatBps(integrator.feeBps)})`} hint="Paid to the site hosting this widget, inside the same transaction.">
            {formatAmount(breakdown.integratorFee, tokenOut.decimals)} {tokenOut.symbol} → {shortAddress(integrator.referrer)}
          </Row>
        ) : null}
        <Row
          label="Price impact"
          hint={routedQuote !== null ? "How much worse this trade's rate is than the venue's current rate. The routing fee is a separate line." : "How much worse this trade's rate is than the pool's current rate. Fees and tax are separate lines."}
          {...(tone === undefined ? {} : { tone })}
        >
          {formatPercentFromBps(impactBps)}
        </Row>
        <Row label="Minimum received" hint="Guaranteed floor after slippage and every fee. The transaction reverts below it.">
          {minReceived === null ? "—" : `${formatAmount(minReceived, tokenOut.decimals)} ${tokenOut.symbol}`}
        </Row>
        <Row label="Max slippage" hint="The transaction reverts if the received amount falls below the minimum.">
          {formatPercentFromBps(slippageBps)}
        </Row>
        <Row label="Route" hint={routedQuote !== null ? "No Gully Core pool pays more for this trade, so Gully Core's router fills it on this venue." : "The Gully Core pools this swap goes through, in order. No routing fee."}>
          {routedQuote !== null ? `Best price: ${bestPrice ?? routedQuote.venueName}` : routeTokens.length > 1 ? `Gully Core pool · ${routeTokens.join(" → ")}` : "Gully Core pool"}
        </Row>
      </>
    ) : null;

  const summary =
    detailRows !== null ? (
      <div className="gullycore-details" data-open={detailsOpen ? "true" : "false"}>
        <button type="button" className="gullycore-details__toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((o) => !o)}>
          <span className="gullycore-details__rate">
            {rateLine ?? "Rate unavailable"}
            {feeShort !== null ? ` · Fee ${feeShort}` : ""}
            {taxShort !== null ? ` · Tax ${taxShort}` : ""}
          </span>
          <span className="gullycore-details__hint">
            {impactBps !== null ? <span data-gullycore-tone={tone}>{formatPercentFromBps(impactBps)} impact</span> : null}
            <span aria-hidden="true">{detailsOpen ? "▴" : "▾"}</span>
          </span>
        </button>
        {detailsOpen ? <dl className="gullycore-details__list">{detailRows}</dl> : null}
      </div>
    ) : null;

  /* The call to action. Busy, it reads "Confirming" beside three sounder bars; the finer step
     ("Confirm in your wallet…", "Confirming on chain…") is its accessible text. */
  const ctaContent = busy ? (
    <>
      <span className="gullycore-sounder" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span aria-hidden="true">Confirming</span>
      <span className="gullycore-visually-hidden">{buttonLabel}</span>
    </>
  ) : showDone ? (
    doneLabel
  ) : (
    buttonLabel
  );

  /* A token handed over without a logo (a pinned pair given as TokenInfo) takes the one the merged lists
     carry for its address; the native coin matches the lists' native entry. */
  const logoLookup = useMemo(() => {
    const byAddress = new Map<string, string>();
    for (const t of tokens) if (t.logoUrl !== undefined) byAddress.set(t.isNative === true ? "native" : t.address.toLowerCase(), t.logoUrl);
    return (t: TokenInfo) => byAddress.get(t.isNative === true || /^0x0{40}$/i.test(t.address) ? "native" : t.address.toLowerCase());
  }, [tokens]);

  const flipLabel = locked ? (side === "buy" ? "Switch to selling" : "Switch to buying") : "Swap the tokens you pay and receive";

  return (
    <TokenLogoLookup.Provider value={logoLookup}>
    <WidgetShell
      title={props.title ?? "Swap"}
      className="gullycore-swap"
      headerAction={settings}
      hideHeader={panel && settings === undefined}
      bare={props.bare === true}
    >
      {props.slots?.header !== undefined ? <div className="gullycore-slot gullycore-slot--header">{props.slots.header}</div> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) setReviewOpen(true);
        }}
        noValidate
        className="gullycore-swap__form"
        data-gullycore-swap-side={side}
        data-gullycore-variant={variant}
        data-gullycore-pair-locked={locked ? "true" : undefined}
      >
        {payWell}
        <div className="gullycore-flip">
          <button type="button" className="gullycore-flip__button" onClick={switchTokens} aria-label={flipLabel} title={flipLabel}>
            <span aria-hidden="true">⇅</span>
          </button>
        </div>
        {receiveWell}
        {inlineSlippage}
        {summary}

        {props.slots?.aboveButton !== undefined ? <div className="gullycore-slot gullycore-slot--above-button">{props.slots.aboveButton}</div> : null}

        {needsConnect ? (
          <button {...connectCtaProps(onConnectRequest)} className="gullycore-cta" data-gullycore-busy="false" aria-live="polite">
            {buttonLabel}
          </button>
        ) : (
          <button type="submit" className="gullycore-cta" disabled={!canSubmit && !busy} aria-disabled={!canSubmit} data-gullycore-busy={busy ? "true" : "false"} data-gullycore-done={showDone ? "true" : undefined} aria-live="polite" onClick={(e) => {
            if (busy) {
              e.preventDefault();
              setReviewOpen(true);
            }
          }}>
            {ctaContent}
          </button>
        )}

        <StatusRegion message={statusMessage} tone={statusTone} />
        {tooLarge !== null && tooLarge.largestAmountIn !== null && tokenIn !== null ? (
          <div className="gullycore-portions" role="group" aria-label="A smaller amount">
            <button
              type="button"
              className="gullycore-portion"
              onClick={() => {
                if (tooLarge.largestAmountIn !== null) setAmountText(formatUnits(tooLarge.largestAmountIn, tokenIn.decimals));
              }}
            >
              Use {formatAmount(tooLarge.largestAmountIn, tokenIn.decimals)} {tokenIn.symbol}
            </button>
          </div>
        ) : null}
      </form>

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        tokenIn={tokenIn}
        tokenOut={tokenOut}
        amountIn={amountIn}
        amountOut={outAmount}
        usdIn={usdIn}
        usdOut={usdOut}
        minReceived={minReceived}
        impactBps={impactBps}
        swapAnyway={swapAnyway}
        rows={detailRows}
        stages={isRouted ? [] : execution.plan}
        stage={isRouted ? null : execution.stage}
        batched={!isRouted && execution.batched}
        busy={busy}
        done={showDone}
        doneLabel={doneLabel}
        confirmLabel={confirmLabel}
        canConfirm={!busy && canSubmit}
        onConfirm={confirmSwap}
        status={statusMessage}
        statusTone={statusTone}
        txSucceeded={txSucceeded}
      />

      {/* The execution error is already the status line above, in its error tone. */}
      <ErrorPanel error={isRouted || routedPending || execution.error !== null || quote.status === "error" ? null : quote.error} context="quote" />

      {props.slots?.footer !== undefined ? <div className="gullycore-slot gullycore-slot--footer">{props.slots.footer}</div> : null}

      {txHash !== null ? (
        <p className="gullycore-footer">
          <span>{txSucceeded ? "Swapped" : "Transaction"}</span>
          {txUrl !== null ? (
            <a href={txUrl} target="_blank" rel="noopener noreferrer">
              {shortAddress(txHash)} ↗
            </a>
          ) : (
            <span>{shortAddress(txHash)}</span>
          )}
        </p>
      ) : null}
      <p className="gullycore-footer gullycore-footer--brand">
        <span>Gully Core · {chain.name}</span>
      </p>
    </WidgetShell>
    </TokenLogoLookup.Provider>
  );
});

function Row(props: { readonly label: string; readonly hint?: string; readonly severity?: string; readonly tone?: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="gullycore-details__row" title={props.hint}>
      <dt>{props.label}</dt>
      <dd data-gullycore-severity={props.severity} data-gullycore-tone={props.tone}>
        {props.children}
      </dd>
    </div>
  );
}

const STAGE_LABEL: Record<"allow" | "grant" | "sign" | "swap", (symbol: string) => string> = {
  allow: (s) => `Allow ${s} once`,
  grant: (s) => `Let the router use ${s} (once)`,
  sign: (s) => `Sign the ${s} allowance (no gas)`,
  swap: () => "Swap",
};

/** "Review swap": the exact amounts and every line, then the one button that reaches the wallet. */
function ReviewDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tokenIn: TokenInfo | null;
  readonly tokenOut: TokenInfo | null;
  readonly amountIn: bigint | null;
  readonly amountOut: bigint | null;
  readonly usdIn: number | null;
  readonly usdOut: number | null;
  readonly minReceived: bigint | null;
  readonly impactBps: number | null;
  readonly swapAnyway: boolean;
  readonly rows: ReactNode;
  readonly stages: readonly ("allow" | "grant" | "sign" | "swap")[];
  readonly stage: "allow" | "grant" | "sign" | "swap" | null;
  readonly batched: boolean;
  readonly busy: boolean;
  readonly done: boolean;
  readonly doneLabel: string;
  readonly confirmLabel: string;
  readonly canConfirm: boolean;
  readonly onConfirm: () => void;
  readonly status: string;
  readonly statusTone: string;
  readonly txSucceeded: boolean;
}): ReactElement {
  const container = usePortalContainer();
  const { onOpenChange, txSucceeded, open } = props;
  /* Closes itself a moment after the swap confirms (the main button keeps the "Swapped ✓"). */
  useEffect(() => {
    if (!open || !txSucceeded) return;
    const t = setTimeout(() => onOpenChange(false), 1_400);
    return () => clearTimeout(t);
  }, [open, txSucceeded, onOpenChange]);
  const sym = props.tokenIn?.symbol ?? "";
  const exact = (v: bigint | null, t: TokenInfo | null) => (v === null || t === null ? "—" : `${groupAmountText(formatUnits(v, t.decimals))} ${t.symbol}`);
  const showSteps = props.stages.length > 1;
  return (
    <Dialog.Root open={props.open} onOpenChange={(o) => (props.busy && !o ? undefined : props.onOpenChange(o))}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="gullycore-overlay" />
        <Dialog.Content className="gullycore-dialog gullycore-review" aria-describedby={undefined}>
          <div className="gullycore-dialog__head">
            <Dialog.Title className="gullycore-dialog__title">Review swap</Dialog.Title>
            <Dialog.Close className="gullycore-icon-button" aria-label="Close" disabled={props.busy}>
              ×
            </Dialog.Close>
          </div>
          <div className="gullycore-review__amounts">
            <div className="gullycore-review__amount">
              <span className="gullycore-label">You pay</span>
              <strong className="gullycore-review__value">
                <TokenLogo token={props.tokenIn} size={24} />
                {exact(props.amountIn, props.tokenIn)}
              </strong>
              {props.usdIn !== null ? <span className="gullycore-panel__usd">≈ {formatUsd(props.usdIn)}</span> : null}
            </div>
            <div className="gullycore-review__amount">
              <span className="gullycore-label">You receive</span>
              <strong className="gullycore-review__value">
                <TokenLogo token={props.tokenOut} size={24} />
                {exact(props.amountOut, props.tokenOut)}
              </strong>
              {props.usdOut !== null ? <span className="gullycore-panel__usd">≈ {formatUsd(props.usdOut)}</span> : null}
              <span className="gullycore-review__min">At least {exact(props.minReceived, props.tokenOut)}</span>
            </div>
          </div>
          {props.swapAnyway ? (
            <p className="gullycore-review__warn" role="alert">
              This trade moves the price by {formatPercentFromBps(props.impactBps)}. You receive much less than the current rate.
            </p>
          ) : null}
          {props.rows !== null ? <dl className="gullycore-details__list gullycore-review__lines">{props.rows}</dl> : null}
          {showSteps ? (
            <ol className="gullycore-review__steps" aria-label="Steps">
              {props.stages.map((st, i) => (
                <li key={st} data-gullycore-current={props.stage === st ? "true" : undefined}>
                  <span className="gullycore-review__step-n">{i + 1}</span> {STAGE_LABEL[st](sym)}
                </li>
              ))}
            </ol>
          ) : null}
          {showSteps ? (
            <p className="gullycore-review__note">
              {props.batched
                ? "Your wallet takes the approval and the swap as one confirmation."
                : props.stages.includes("allow")
                  ? `Allowing ${sym} is a one-time step per token for this wallet; after it, every swap of ${sym} is one transaction.`
                  : "The allowance is a signature, not a transaction: it costs no gas."}
            </p>
          ) : null}
          <button type="button" className="gullycore-cta" disabled={!props.canConfirm} data-gullycore-busy={props.busy ? "true" : "false"} data-gullycore-done={props.done ? "true" : undefined} data-gullycore-danger={props.swapAnyway ? "true" : undefined} aria-live="polite" onClick={props.onConfirm}>
            {props.done ? props.doneLabel : props.confirmLabel}
          </button>
          <StatusRegion message={props.status} tone={props.statusTone as "neutral" | "error" | "success"} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One-line state of a routed fill, for the status region. */
function describeRoutedStep(step: string, error: Error | null, symbol: string): string {
  switch (step) {
    case "needs-approval":
      return `Approve the exact ${symbol} amount for Gully Core's router before swapping`;
    case "approving":
      return "Waiting for the approval transaction to confirm";
    case "building":
      return "Preparing the routed swap";
    case "simulating":
      return "Simulating the exact transaction";
    case "awaiting-signature":
      return "Confirm the transaction in your wallet";
    case "pending":
      return "Swap submitted, waiting for confirmation";
    case "success":
      return "Swap confirmed";
    case "error":
      return error === null ? "Something went wrong" : describeError(error, "swap");
    default:
      return "";
  }
}
