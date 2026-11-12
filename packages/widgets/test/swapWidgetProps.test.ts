// SPDX-License-Identifier: MIT
/**
 * The host-facing props of `SwapWidget` - `pair` / `lockPair`, `side`,
 * `portions`, `slots` - and the exported context, rendered through
 * `react-dom/server` like the rest of the suite. A server render runs no
 * effect, so what it can prove is the first frame: a pair given as
 * `TokenInfo`s is selected synchronously and, locked, renders as chips; a
 * slot lands where the README says; a bad `portions` throws before anything
 * renders; and the context is reachable without a provider. The transitions
 * behind those props are covered in `swapWidgetState.test.ts`.
 */

import { createElement, useContext, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createMockAdapter } from "./helpers/mockAdapter.js";
import type { TokenInfo } from "../src/adapters/protocol.js";
import type { ChainConfig } from "../src/config/chain.js";
import { SwapWidget } from "../src/components/SwapWidget.js";
import { WidgetContext, WidgetProvider, useOptionalWidgetContext, useWidgetContext } from "../src/context/WidgetProvider.js";
import * as widgets from "../src/index.js";
import * as headless from "../src/headless.js";

const CHAIN: ChainConfig = {
  chainId: 31337,
  name: "Mock chain",
  nativeCurrency: { name: "Mock gas", symbol: "MOCK-GAS", decimals: 18 },
  contracts: {
    vault: "0x00000000000000000000000000000000000000a1",
    clPoolManager: "0x00000000000000000000000000000000000000a2",
    binPoolManager: "0x00000000000000000000000000000000000000a3",
    universalRouter: "0x00000000000000000000000000000000000000a4",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    launchGuardHook: "0x00000000000000000000000000000000000000a8",
  },
};

const GAS: TokenInfo = { address: "0x0000000000000000000000000000000000000000", symbol: "GAS", name: "Native", decimals: 18, isNative: true };
const TKN: TokenInfo = { address: "0x00000000000000000000000000000000000000C1", symbol: "TKN", name: "Launch token", decimals: 18 };

function mount(child: ReactElement): string {
  const adapter = createMockAdapter({ chain: CHAIN, account: null });
  return renderToStaticMarkup(createElement(WidgetProvider, { adapter, theme: "light", children: child }));
}

/** The `aria-label`s of the locked chips, in DOM order. */
function chipLabels(html: string): string[] {
  return [...html.matchAll(/<span class="gullycore-token-button gullycore-token-button--locked"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("pair + lockPair", () => {
  it("without lockPair the selectors are the dialog triggers they always were", () => {
    const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS } }));
    expect(html).toContain("gullycore-token-button__chevron");
    expect(html).not.toContain("gullycore-token-button--locked");
    expect(html).toContain('aria-label="You pay: GAS"');
    expect(html).toContain('aria-label="You receive: TKN"');
  });

  it("locked, the pair renders as read-only chips on the first frame: the token, no chevron, no trigger", () => {
    const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS }, lockPair: true }));
    expect(chipLabels(html)).toEqual(["You pay: GAS (fixed)", "You receive: TKN (fixed)"]);
    expect(html).not.toContain("gullycore-token-button__chevron");
    expect(html).not.toMatch(/<button[^>]*class="gullycore-token-button"/);
    expect(html).toContain('data-gullycore-pair-locked="true"');
    expect(html).toContain('<span class="gullycore-token-button__symbol">GAS</span>');
    expect(html).toContain('<span class="gullycore-token-button__symbol">TKN</span>');
    /* The flip stays on a locked pair: there it is buy <-> sell. */
    expect(html).toContain('aria-label="Switch to selling"');
  });

  it("{tokenIn, tokenOut} is the buy orientation of the same pair", () => {
    const html = mount(createElement(SwapWidget, { pair: { tokenIn: GAS, tokenOut: TKN }, lockPair: true }));
    expect(chipLabels(html)).toEqual(["You pay: GAS (fixed)", "You receive: TKN (fixed)"]);
  });

  it("an address entry waits for the list rather than showing a wrong token", () => {
    const html = mount(createElement(SwapWidget, { pair: { token: TKN.address, quote: GAS }, lockPair: true }));
    expect(chipLabels(html)).toEqual(["You pay: GAS (fixed)", "You receive: loading (fixed)"]);
  });

  it("lockPair without a pair is nothing to lock: the selectors stay", () => {
    const html = mount(createElement(SwapWidget, { lockPair: true }));
    expect(html).not.toContain("gullycore-token-button--locked");
    expect(html).not.toContain("data-gullycore-pair-locked");
  });
});

describe("side", () => {
  it("defaults to buy: the quote is paid, the token received", () => {
    const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS }, lockPair: true }));
    expect(html).toContain('data-gullycore-swap-side="buy"');
    expect(html).toContain('aria-label="Amount of GAS to pay"');
  });

  it("sell reverses the panels over the same pair without a remount key", () => {
    const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS }, lockPair: true, side: "sell" }));
    expect(html).toContain('data-gullycore-swap-side="sell"');
    expect(chipLabels(html)).toEqual(["You pay: TKN (fixed)", "You receive: GAS (fixed)"]);
    expect(html).toContain('aria-label="Amount of TKN to pay"');
    expect(html).toContain('aria-label="Amount of GAS to receive"');
    expect(html).toContain('aria-label="Switch to buying"');
  });

  it("the panel labels are about paying and receiving, whatever the side", () => {
    for (const side of ["buy", "sell"] as const) {
      const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS }, side }));
      expect(html).toContain('<span class="gullycore-label">You pay</span>');
      expect(html).toContain('<span class="gullycore-label">You receive</span>');
    }
  });
});

describe("one layout for every variant (owner 2026-10-11: work like uniswap)", () => {
  for (const variant of ["default", "compact", "panel"] as const) {
    it(`${variant}: two wells with a flip between them, the receive well editable, no Buy / Sell pill`, () => {
      const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS }, lockPair: true, variant, slippageControl: "none" }));
      expect(html).toContain(`data-gullycore-variant="${variant}"`);
      expect(html.match(/class="gullycore-panel"/g)?.length).toBe(2);
      expect(html).toContain("gullycore-flip__button");
      expect(html).not.toContain("gullycore-sides");
      expect(html).toMatch(/<input class="gullycore-big-input gullycore-big-input--out"[^>]*aria-label="Amount of TKN to receive"/);
      /* Before a quote there is no summary row: nothing to summarise, nothing invented. */
      expect(html).not.toContain("gullycore-details__toggle");
    });
  }

  it("a locked pair quoted in the wrapped native offers ETH | WETH as a picker on its quote side, not a toggle", () => {
    const WETH: TokenInfo = { address: "0x00000000000000000000000000000000000000E1", symbol: "WGAS", name: "Wrapped gas", decimals: 18 };
    const adapter = createMockAdapter({ chain: { ...CHAIN, contracts: { ...CHAIN.contracts, wrappedNative: WETH.address } }, account: null });
    const html = renderToStaticMarkup(createElement(WidgetProvider, { adapter, theme: "light", children: createElement(SwapWidget, { pair: { token: TKN, quote: WETH }, lockPair: true }) }));
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toMatch(/<button type="button" class="gullycore-token-button" aria-label="Pay with: (MOCK-GAS|WGAS)"/);
    expect(chipLabels(html)).toEqual(["You receive: TKN (fixed)"]);
  });
});

describe("portions", () => {
  it("a bad fraction throws at render, like every other bad widget config", () => {
    expect(() => mount(createElement(SwapWidget, { portions: [0.5, 2] }))).toThrow(RangeError);
    expect(() => mount(createElement(SwapWidget, { portions: [0] }))).toThrow(RangeError);
  });

  it("valid portions, the default and an empty list all render (the chips wait for a balance)", () => {
    for (const portions of [undefined, [0.1, 0.75, 1], []]) {
      const html = mount(createElement(SwapWidget, portions === undefined ? {} : { portions }));
      expect(html).toContain("gullycore-swap");
      /* No wallet, no balance, no chips: a portion of nothing is not offered. */
      expect(html).not.toContain("gullycore-portion");
    }
  });
});

describe("the trade panel (0.2): variant panel, showPortions, slippageControl, bare", () => {

  it("panel: two labelled wells, no visible header without a settings control", () => {
    const html = mount(createElement(SwapWidget, { pair: { tokenIn: GAS, tokenOut: TKN }, lockPair: true, variant: "panel", slippageControl: "none", title: "Swap" }));
    expect(html).toContain('data-gullycore-variant="panel"');
    expect(html.match(/class="gullycore-panel"/g)?.length).toBe(2);
    expect(html).not.toContain("<header");
    expect(html).toContain('<h2 class="gullycore-visually-hidden">Swap</h2>');
  });

  it("panel keeps the settings popover in a header when slippage is chosen there", () => {
    const html = mount(createElement(SwapWidget, { pair: { tokenIn: GAS, tokenOut: TKN }, variant: "panel" }));
    expect(html).toContain("<header");
    expect(html).toContain("gullycore-settings-trigger");
  });

  it("showPortions: true draws the chips before any balance; false never; absent waits for one", () => {
    const base = { pair: { token: TKN, quote: GAS }, lockPair: true, variant: "compact" as const };
    const always = mount(createElement(SwapWidget, { ...base, showPortions: true }));
    const chips = [...always.matchAll(/<button type="button" class="gullycore-portion" aria-pressed="false"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    expect(chips).toEqual(["25%", "50%", "75%", "Max"]);
    expect(mount(createElement(SwapWidget, { ...base, showPortions: false }))).not.toContain("gullycore-portion");
    expect(mount(createElement(SwapWidget, base))).not.toContain("gullycore-portion");
    expect(mount(createElement(SwapWidget, { ...base, showPortions: true, portions: [] }))).not.toContain("gullycore-portion");
  });

  it("slippageControl inline: a radio group of the choices, the provider's default checked; no popover", () => {
    const html = mount(createElement(SwapWidget, { pair: { token: TKN, quote: GAS }, variant: "compact", slippageControl: "inline" }));
    expect(html).toMatch(/<span class="gullycore-slippage__opts" role="radiogroup" aria-labelledby="[^"]+">/);
    const radios = [...html.matchAll(/role="radio" aria-checked="(true|false)" class="gullycore-slippage__btn">([^<]+)</g)].map((m) => `${m[2]}:${m[1]}`);
    expect(radios).toEqual(["0.1%:false", "0.5%:true", "1%:false"]);
    expect(html).not.toContain("gullycore-settings-trigger");
    const custom = mount(createElement(SwapWidget, { slippageControl: "inline", slippageOptions: [25, 300] }));
    expect([...custom.matchAll(/class="gullycore-slippage__btn">([^<]+)</g)].map((m) => m[1])).toEqual(["0.25%", "3%"]);
  });

  it("showSlippageControl={false} still means no control; slippageControl wins when both are given", () => {
    expect(mount(createElement(SwapWidget, { showSlippageControl: false }))).not.toContain("gullycore-settings-trigger");
    const inline = mount(createElement(SwapWidget, { showSlippageControl: false, slippageControl: "inline" }));
    expect(inline).toContain("gullycore-slippage__opts");
  });

  it("a bad slippage choice throws at render", () => {
    expect(() => mount(createElement(SwapWidget, { slippageControl: "inline", slippageOptions: [] }))).toThrow(RangeError);
    expect(() => mount(createElement(SwapWidget, { slippageControl: "inline", slippageOptions: [0.5] }))).toThrow(RangeError);
    expect(() => mount(createElement(SwapWidget, { slippageControl: "inline", slippageOptions: [9_000] }))).toThrow(RangeError);
  });

  it("bare marks the root so the frame comes off; absent, the widget keeps its own", () => {
    expect(mount(createElement(SwapWidget, { bare: true }))).toContain('data-gullycore-bare="true"');
    expect(mount(createElement(SwapWidget, {}))).not.toContain("data-gullycore-bare");
  });

  it("the call to action announces itself politely", () => {
    const html = mount(createElement(SwapWidget, {}));
    expect(html).toMatch(/<button[^>]*class="gullycore-cta"[^>]*aria-live="polite"[^>]*>Connect wallet<\/button>/);
  });
});

describe("slippage choice helpers", () => {
  it("labels without trailing zeros", () => {
    expect(widgets.slippageOptionLabel(10)).toBe("0.1%");
    expect(widgets.slippageOptionLabel(50)).toBe("0.5%");
    expect(widgets.slippageOptionLabel(100)).toBe("1%");
    expect(widgets.slippageOptionLabel(125)).toBe("1.25%");
  });
  it("defaults to 0.1 / 0.5 / 1 %", () => {
    expect(widgets.normalizeSlippageOptions(undefined, 5_000)).toEqual([10, 50, 100]);
  });
});

describe("slots", () => {
  const slots = {
    header: createElement("nav", { id: "leg-switcher" }, "legs"),
    aboveButton: createElement("p", { id: "note" }, "note"),
    footer: createElement("p", { id: "host-footer" }, "footer"),
  };

  it("render nothing extra when absent", () => {
    const html = mount(createElement(SwapWidget, {}));
    expect(html).not.toContain("gullycore-slot");
  });

  it("land in order: header after the title row, aboveButton before the call to action, footer before the brand line", () => {
    const html = mount(createElement(SwapWidget, { slots }));
    const at = (needle: string): number => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    const header = at('<div class="gullycore-slot gullycore-slot--header"><nav id="leg-switcher">');
    const form = at('<form');
    const above = at('<div class="gullycore-slot gullycore-slot--above-button"><p id="note">');
    const cta = at('class="gullycore-cta"');
    const footer = at('<div class="gullycore-slot gullycore-slot--footer"><p id="host-footer">');
    const brand = at('gullycore-footer--brand');
    expect(at("</header>")).toBeLessThan(header);
    expect(header).toBeLessThan(form);
    expect(above).toBeLessThan(cta);
    expect(cta).toBeLessThan(footer);
    expect(footer).toBeLessThan(brand);
    /* The brand line is not a slot and is still last. */
    expect(html.lastIndexOf("Gully Core · Mock chain")).toBeGreaterThan(footer);
  });

  it("each slot renders alone", () => {
    for (const key of ["header", "aboveButton", "footer"] as const) {
      const html = mount(createElement(SwapWidget, { slots: { [key]: slots[key] } }));
      expect((html.match(/gullycore-slot gullycore-slot--/g) ?? []).length).toBe(1);
    }
  });
});

describe("the context is public", () => {
  it("useOptionalWidgetContext is null without a provider and the value inside one", () => {
    let seen: unknown = "unset";
    function Probe(): null {
      seen = useOptionalWidgetContext();
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBeNull();
    const adapter = createMockAdapter({ chain: CHAIN, account: null });
    renderToStaticMarkup(createElement(WidgetProvider, { adapter, children: createElement(Probe) }));
    expect(seen).toMatchObject({ adapter, chain: CHAIN });
  });

  it("WidgetContext is the context useWidgetContext reads, so useContext alone detects a provider", () => {
    let raw: unknown = "unset";
    let strict: unknown = "unset";
    function Probe(): null {
      raw = useContext(WidgetContext);
      strict = useWidgetContext();
      return null;
    }
    const adapter = createMockAdapter({ chain: CHAIN, account: null });
    renderToStaticMarkup(createElement(WidgetProvider, { adapter, children: createElement(Probe) }));
    expect(raw).toBe(strict);
    expect(() => renderToStaticMarkup(createElement(() => useContext(WidgetContext) === null ? null : createElement("b")))).not.toThrow();
    expect(() => renderToStaticMarkup(createElement(() => (useWidgetContext(), null)))).toThrow(/no WidgetProvider/);
  });

  it("both entries export the context, the optional hook and the swap state helpers", () => {
    for (const entry of [widgets, headless] as Record<string, unknown>[]) {
      expect(entry["WidgetContext"]).toBe(WidgetContext);
      expect(typeof entry["useOptionalWidgetContext"]).toBe("function");
      expect(typeof entry["buildSwapQuoteView"]).toBe("function");
      expect(typeof entry["swapWidgetReducer"]).toBe("function");
      expect(entry["DEFAULT_PORTIONS"]).toEqual([0.25, 0.5, 0.75, 1]);
    }
    expect(typeof widgets.SwapWidget).toBe("object"); // a forwardRef exotic component
  });
});
