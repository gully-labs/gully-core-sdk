// SPDX-License-Identifier: MIT
/**
 * The swap widget's state machine and the props it serves (`side`, `pair`,
 * `portions`, the `ref` handle, `onQuote`), tested as the pure functions they
 * are in `src/components/swap/state.ts`. The unit suite has no DOM, so the
 * behaviour a click or a prop change produces is asserted on the reducer and
 * the helpers the component calls, one action per user step.
 */

import { describe, expect, it } from "vitest";

import type { RouteStep, SwapQuoteResult, TokenInfo } from "../src/adapters/protocol.js";
import { resolveIntegratorConfig } from "../src/config/integrator.js";
import { buildQuoteBreakdown } from "../src/core/math.js";
import { parseAmount } from "../src/core/format.js";
import {
  DEFAULT_PORTIONS,
  INITIAL_SWAP_STATE,
  balancePortion,
  buildSwapQuoteView,
  findToken,
  initialSwapState,
  normalizePair,
  normalizePortions,
  oppositeSide,
  orientPair,
  pairKey,
  portionAmountText,
  portionLabel,
  resolvePairEntry,
  routeSymbols,
  swapWidgetReducer,
  unorientPair,
  type SwapWidgetState,
} from "../src/components/swap/state.js";

const GAS: TokenInfo = { address: "0x0000000000000000000000000000000000000000", symbol: "GAS", name: "Native", decimals: 18, isNative: true };
const USD: TokenInfo = { address: "0x00000000000000000000000000000000000000B1", symbol: "USD", name: "Stable", decimals: 6 };
const TKN: TokenInfo = { address: "0x00000000000000000000000000000000000000C1", symbol: "TKN", name: "Launch token", decimals: 18 };
const OTHER: TokenInfo = { address: "0x00000000000000000000000000000000000000D1", symbol: "OTH", name: "Other", decimals: 18 };
const TOKENS = [GAS, USD, TKN];

const seeded = (side: "buy" | "sell" = "buy", defaults: { defaultTokenIn?: string; defaultTokenOut?: string | null } = {}): SwapWidgetState =>
  swapWidgetReducer({ ...INITIAL_SWAP_STATE, side }, { type: "seed", tokens: TOKENS, side, ...defaults });

describe("pair shapes", () => {
  it("normalises both shapes to the anchored form, {tokenIn, tokenOut} being the buy orientation", () => {
    expect(normalizePair({ token: TKN, quote: GAS })).toEqual({ token: TKN, quote: GAS });
    expect(normalizePair({ tokenIn: GAS.address, tokenOut: TKN.address })).toEqual({ token: TKN.address, quote: GAS.address });
  });

  it("keys a pair by its addresses, case-insensitively, whichever shape and type it came as", () => {
    const a = pairKey({ token: TKN, quote: GAS });
    const b = pairKey({ tokenIn: GAS.address.toUpperCase().replace("0X", "0x"), tokenOut: TKN.address.toLowerCase() });
    expect(a).toBe(b);
    expect(pairKey(undefined)).toBeNull();
  });

  it("resolves an address against the list and passes a TokenInfo through", () => {
    expect(resolvePairEntry(TKN.address.toLowerCase(), TOKENS)).toBe(TKN);
    expect(resolvePairEntry(OTHER.address, TOKENS)).toBeNull();
    expect(resolvePairEntry(OTHER, TOKENS)).toBe(OTHER);
    expect(findToken(TOKENS, undefined)).toBeNull();
  });

  it("orients: buy pays the quote, sell pays the token; unorient inverts", () => {
    const anchor = { token: TKN, quote: GAS };
    expect(orientPair(anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: TKN });
    expect(orientPair(anchor, "sell")).toEqual({ tokenIn: TKN, tokenOut: GAS });
    for (const side of ["buy", "sell"] as const) expect(unorientPair(orientPair(anchor, side), side)).toEqual(anchor);
    expect(oppositeSide("buy")).toBe("sell");
    expect(oppositeSide("sell")).toBe("buy");
  });
});

describe("initial state", () => {
  it("starts empty on the widget's own side", () => {
    expect(initialSwapState({})).toEqual(INITIAL_SWAP_STATE);
    expect(initialSwapState({ side: "sell" }).side).toBe("sell");
  });

  it("selects a TokenInfo pair on the first frame and leaves an address for the list", () => {
    expect(initialSwapState({ pair: { token: TKN, quote: GAS } }).anchor).toEqual({ token: TKN, quote: GAS });
    expect(initialSwapState({ pair: { token: TKN.address, quote: GAS } }).anchor).toEqual({ token: null, quote: GAS });
  });
});

describe("seeding (no pair)", () => {
  it("leaves the output empty when the host passes defaultTokenOut: null (no second token is guessed)", () => {
    expect(orientPair(seeded("buy", { defaultTokenIn: GAS.address, defaultTokenOut: null }).anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: null });
    expect(orientPair(seeded("buy", { defaultTokenIn: GAS.address }).anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: USD });
  });
  it("takes the defaults by address, else the first two tokens - today's behaviour", () => {
    expect(orientPair(seeded().anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: USD });
    const withDefaults = seeded("buy", { defaultTokenIn: USD.address.toLowerCase(), defaultTokenOut: TKN.address });
    expect(orientPair(withDefaults.anchor, "buy")).toEqual({ tokenIn: USD, tokenOut: TKN });
  });

  it("reads the defaults as what the panels show on the initial side", () => {
    const sell = seeded("sell", { defaultTokenIn: TKN.address, defaultTokenOut: GAS.address });
    expect(orientPair(sell.anchor, "sell")).toEqual({ tokenIn: TKN, tokenOut: GAS });
    expect(sell.anchor).toEqual({ token: TKN, quote: GAS });
  });

  it("never overrides a selection already made, and is a no-op on an empty list", () => {
    const chosen = seeded();
    expect(swapWidgetReducer(chosen, { type: "seed", tokens: [TKN, USD], side: "buy" })).toBe(chosen);
    expect(swapWidgetReducer(INITIAL_SWAP_STATE, { type: "seed", tokens: [], side: "buy" })).toBe(INITIAL_SWAP_STATE);
  });
});

describe("side (flip)", () => {
  it("keeps the typed amount as the amount you pay and resets the impact acknowledgement", () => {
    let state = seeded();
    state = swapWidgetReducer(state, { type: "amount", text: "1.5" });
    state = swapWidgetReducer(state, { type: "ack", value: true });
    const flipped = swapWidgetReducer(state, { type: "set-side", side: "sell" });
    expect(flipped.amountText).toBe("1.5");
    expect(flipped.impactAck).toBe(false);
    expect(orientPair(flipped.anchor, flipped.side)).toEqual({ tokenIn: USD, tokenOut: GAS });
    expect(flipped.anchor).toBe(state.anchor);
  });

  it("is idempotent: the same side again changes nothing", () => {
    const state = seeded();
    expect(swapWidgetReducer(state, { type: "set-side", side: "buy" })).toBe(state);
  });

  it("flipping twice returns to the original panels with the amount intact", () => {
    let state = swapWidgetReducer(seeded(), { type: "amount", text: "42" });
    state = swapWidgetReducer(state, { type: "set-side", side: "sell" });
    state = swapWidgetReducer(state, { type: "set-side", side: "buy" });
    expect(orientPair(state.anchor, state.side)).toEqual({ tokenIn: GAS, tokenOut: USD });
    expect(state.amountText).toBe("42");
  });
});

describe("pin (the pair prop)", () => {
  it("overrides the selection, keeps the amount, resets the acknowledgement", () => {
    let state = swapWidgetReducer(seeded(), { type: "amount", text: "7" });
    state = swapWidgetReducer(state, { type: "ack", value: true });
    const pinned = swapWidgetReducer(state, { type: "pin", anchor: { token: TKN, quote: GAS } });
    expect(orientPair(pinned.anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: TKN });
    expect(orientPair(pinned.anchor, "sell")).toEqual({ tokenIn: TKN, tokenOut: GAS });
    expect(pinned.amountText).toBe("7");
    expect(pinned.impactAck).toBe(false);
  });

  it("re-pinning the same tokens is a no-op, so a re-render never disturbs the field", () => {
    const state = swapWidgetReducer(seeded(), { type: "pin", anchor: { token: TKN, quote: GAS } });
    expect(swapWidgetReducer(state, { type: "pin", anchor: { token: TKN, quote: GAS } })).toBe(state);
  });

  it("a half-resolved pin shows only what resolved; the rest waits", () => {
    const state = swapWidgetReducer(INITIAL_SWAP_STATE, { type: "pin", anchor: { token: null, quote: GAS } });
    expect(orientPair(state.anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: null });
  });
});

describe("selecting tokens", () => {
  it("writes the Sell panel's pick into the anchor slot the current side shows there", () => {
    const buy = swapWidgetReducer(seeded(), { type: "select-in", token: TKN, side: "buy" });
    expect(buy.anchor).toEqual({ token: USD, quote: TKN });
    const sell = swapWidgetReducer(seeded("sell"), { type: "select-in", token: TKN, side: "sell" });
    expect(sell.anchor).toEqual({ token: TKN, quote: USD });
  });

  it("writes the Buy panel's pick likewise and resets the acknowledgement", () => {
    const acked = swapWidgetReducer(seeded(), { type: "ack", value: true });
    const next = swapWidgetReducer(acked, { type: "select-out", token: TKN, side: "buy" });
    expect(orientPair(next.anchor, "buy")).toEqual({ tokenIn: GAS, tokenOut: TKN });
    expect(next.impactAck).toBe(false);
  });
});

describe("amount and acknowledgement", () => {
  it("a new amount resets the acknowledgement; the same amount is a no-op", () => {
    const acked = swapWidgetReducer(swapWidgetReducer(seeded(), { type: "amount", text: "1" }), { type: "ack", value: true });
    expect(swapWidgetReducer(acked, { type: "amount", text: "1" })).toBe(acked);
    expect(swapWidgetReducer(acked, { type: "amount", text: "2" }).impactAck).toBe(false);
    expect(swapWidgetReducer(acked, { type: "ack", value: true })).toBe(acked);
  });
});

describe("portions", () => {
  it("defaults to 25%, 50%, 75% and Max, and labels them so", () => {
    expect(normalizePortions(undefined)).toBe(DEFAULT_PORTIONS);
    expect(DEFAULT_PORTIONS.map(portionLabel)).toEqual(["25%", "50%", "75%", "Max"]);
    expect(portionLabel(0.75)).toBe("75%");
    expect(portionLabel(0.333)).toBe("33.3%");
  });

  it("accepts any fractions in (0, 1] in the order given, and an empty list", () => {
    expect(normalizePortions([0.1, 0.75, 1])).toEqual([0.1, 0.75, 1]);
    expect(normalizePortions([])).toEqual([]);
  });

  it("refuses a fraction outside (0, 1], NaN, or a non-number", () => {
    for (const bad of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "50" as unknown as number]) {
      expect(() => normalizePortions([bad])).toThrow(RangeError);
    }
  });

  it("takes an exact fraction of an ERC-20 balance and keeps a gas sliver only for Max on the native asset", () => {
    expect(balancePortion(1_000_000n, 0.25, USD)).toBe(250_000n);
    expect(balancePortion(1_000_000n, 1, USD)).toBe(1_000_000n);
    expect(balancePortion(10n ** 18n, 1, GAS)).toBe(10n ** 18n - 10n ** 15n);
    expect(balancePortion(10n ** 18n, 0.5, GAS)).toBe(5n * 10n ** 17n);
    expect(balancePortion(10n ** 14n, 1, GAS)).toBe(0n);
  });

  it("writes text the amount parser reads back exactly, ungrouped, at the token's precision", () => {
    const text = portionAmountText(USD, 1_234_567_890n, 1);
    expect(text).toBe("1234.56789");
    const parsed = parseAmount(text ?? "", USD.decimals);
    expect(parsed.ok && parsed.value).toBe(1_234_567_890n);
    const gas = portionAmountText(GAS, 3n * 10n ** 18n + 1n, 0.5);
    expect(gas).toBe("1.5");
  });

  it("refuses without a token or a balance - a portion is never estimated", () => {
    expect(portionAmountText(null, 100n, 1)).toBeNull();
    expect(portionAmountText(USD, null, 1)).toBeNull();
  });
});

describe("the quote view (onQuote)", () => {
  const step: RouteStep = { poolId: "0x01", poolType: "CL", tokenIn: GAS, tokenOut: TKN, lpFeePips: 3_000, hooks: "0x0000000000000000000000000000000000000000" };
  const quote: SwapQuoteResult = {
    route: [step],
    amountIn: 10n ** 18n,
    grossAmountOut: 1_000n * 10n ** 18n,
    spotAmountOut: 1_010n * 10n ** 18n,
    lpFeeAmount: 3n * 10n ** 15n,
    lpFeePips: 3_000,
    estimatedGas: null,
    source: "mock",
  };
  const integrator = resolveIntegratorConfig(null);
  const breakdown = buildQuoteBreakdown({ amountIn: quote.amountIn, grossAmountOut: quote.grossAmountOut, spotAmountOut: quote.spotAmountOut, lpFeeAmount: quote.lpFeeAmount, lpFeePips: quote.lpFeePips, slippageBps: 50, integrator });
  const base = { tokenIn: GAS, tokenOut: TKN, quote, breakdown, rate: 1000, status: "success" as const, isRefreshing: false, isMock: true, updatedAt: 1 };

  it("is null until there is a quote and both tokens", () => {
    expect(buildSwapQuoteView({ ...base, quote: null })).toBeNull();
    expect(buildSwapQuoteView({ ...base, breakdown: null })).toBeNull();
    expect(buildSwapQuoteView({ ...base, tokenOut: null })).toBeNull();
  });

  it("carries the net output, the guaranteed minimum, the impact, the fee label and the route", () => {
    const view = buildSwapQuoteView(base);
    expect(view).not.toBeNull();
    if (view === null) return;
    expect(view.amountOut).toBe(breakdown.netAmountOut);
    expect(view.minReceived).toBe(breakdown.minAmountOutNet);
    expect(view.minReceived).toBeLessThan(view.amountOut);
    expect(view.priceImpactBps).toBe(breakdown.priceImpactBps);
    expect(view.priceImpactBps).toBeGreaterThan(0);
    expect(view.priceImpactSeverity).toBe(breakdown.priceImpactSeverity);
    expect(view.lpFee).toEqual({ pips: 3_000, unknown: false, label: "0.3%" });
    expect(view.routeSymbols).toEqual(["GAS", "TKN"]);
    expect(view.route).toBe(quote.route);
    expect(view.rate).toBe(1000);
    expect(view.isRefreshing).toBe(false);
    expect(view.isMock).toBe(true);
    expect(view.slippageBps).toBe(50);
  });

  it("reports no impact and a 'dynamic (hook-set)' fee when the pool's fee is hook-set - never a number that includes it", () => {
    const hookSet = buildQuoteBreakdown({ amountIn: quote.amountIn, grossAmountOut: quote.grossAmountOut, spotAmountOut: null, lpFeeAmount: 0n, lpFeePips: 0, lpFeeUnknown: true, slippageBps: 50, integrator });
    const view = buildSwapQuoteView({ ...base, breakdown: hookSet });
    expect(view?.priceImpactBps).toBeNull();
    expect(view?.priceImpactSeverity).toBe("unknown");
    expect(view?.lpFee).toEqual({ pips: 0, unknown: true, label: "dynamic (hook-set)" });
  });

  it("lists a route's symbols input-first and drops blanks", () => {
    expect(routeSymbols([])).toEqual([]);
    expect(routeSymbols([step, { ...step, tokenIn: TKN, tokenOut: { ...USD, symbol: "" } }])).toEqual(["GAS", "TKN"]);
  });
});
