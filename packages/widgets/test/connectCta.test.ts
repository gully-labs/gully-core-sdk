// SPDX-License-Identifier: MIT
/**
 * The "Connect wallet" call to action (stack audit 2026-09-18, F-5).
 *
 * With `onConnectRequest` - on the widget or on the provider - the primary
 * button is a real button that asks the host to open its connect flow. Without
 * it, the button stays the disabled label it always was. Rendered through
 * `react-dom/server`: the unit suite runs in a plain node environment (no DOM
 * package is installed, and none is being added for this), and the markup is
 * what carries `disabled`, `type` and the label. The click path is exercised
 * on `ActionButton` directly, which has no hooks and returns the element whose
 * `onClick` the DOM would invoke.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createMockAdapter } from "./helpers/mockAdapter.js";
import type { ChainConfig } from "../src/config/chain.js";
import { LaunchWidget } from "../src/components/LaunchWidget.js";
import { LiquidityWidget } from "../src/components/LiquidityWidget.js";
import { ActionButton, connectCtaProps } from "../src/components/primitives.js";
import { SwapWidget } from "../src/components/SwapWidget.js";
import { WidgetProvider } from "../src/context/WidgetProvider.js";

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

/** Every `<button …>` tag whose text is "Connect wallet", with its attributes. */
function connectButtons(html: string): string[] {
  return [...html.matchAll(/<button([^>]*)>Connect wallet<\/button>/g)].map((m) => m[1] ?? "");
}

function mount(child: ReactElement, provider: { onConnectRequest?: () => void } = {}): string {
  const adapter = createMockAdapter({ chain: CHAIN, account: null });
  return renderToStaticMarkup(createElement(WidgetProvider, { adapter, theme: "light", ...provider, children: child }));
}

describe("connectCtaProps", () => {
  it("is a disabled, non-submitting button without a handler", () => {
    expect(connectCtaProps(undefined)).toEqual({ type: "button", disabled: true, onClick: undefined });
  });

  it("is an enabled button that calls the handler with one", () => {
    const open = vi.fn();
    const props = connectCtaProps(open);
    expect(props.type).toBe("button");
    expect(props.disabled).toBe(false);
    props.onClick?.();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("ActionButton needsConnect", () => {
  it("renders disabled when the host gave no way to connect", () => {
    const html = renderToStaticMarkup(createElement(ActionButton, { needsConnect: true, type: "submit", children: "Connect wallet" }));
    const [attrs] = connectButtons(html);
    expect(attrs).toContain("disabled");
    expect(attrs).toContain('type="button"');
  });

  it("renders enabled and calls back when it can", () => {
    const open = vi.fn();
    const html = renderToStaticMarkup(createElement(ActionButton, { needsConnect: true, type: "submit", onConnectRequest: open, children: "Connect wallet" }));
    const [attrs] = connectButtons(html);
    expect(attrs).not.toContain("disabled");
    /* Never a submit: pressing it must not run the form's handler. */
    expect(attrs).toContain('type="button"');

    const element = ActionButton({ needsConnect: true, type: "submit", onConnectRequest: open, children: "Connect wallet" });
    (element.props as { onClick: () => void }).onClick();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("leaves a connected button alone", () => {
    const onClick = vi.fn();
    const element = ActionButton({ needsConnect: false, type: "submit", disabled: false, onClick, onConnectRequest: vi.fn(), children: "Swap" });
    const props = element.props as { type: string; disabled: boolean; onClick: () => void };
    expect(props.type).toBe("submit");
    expect(props.disabled).toBe(false);
    props.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("SwapWidget connect CTA", () => {
  it("is a disabled label with no handler anywhere", () => {
    const [attrs, ...rest] = connectButtons(mount(createElement(SwapWidget, {})));
    expect(rest).toEqual([]);
    expect(attrs).toContain("disabled");
  });

  it("is an enabled button with the widget's own handler", () => {
    const [attrs] = connectButtons(mount(createElement(SwapWidget, { onConnectRequest: () => undefined })));
    expect(attrs).toBeDefined();
    expect(attrs).not.toContain("disabled");
    expect(attrs).toContain('type="button"');
  });

  it("inherits the provider's handler", () => {
    const [attrs] = connectButtons(mount(createElement(SwapWidget, {}), { onConnectRequest: () => undefined }));
    expect(attrs).toBeDefined();
    expect(attrs).not.toContain("disabled");
  });
});

describe("LiquidityWidget and LaunchWidget", () => {
  /* Their connect CTA is `ActionButton needsConnect`, covered above; a server
     render never loads pools or launches, so the panels that carry the button
     are not reached here. What can be checked is that both mount under a
     provider carrying the handler and that nothing else is a live button. */
  it("mount with the provider handler and expose no enabled submit", () => {
    for (const child of [createElement(LiquidityWidget, {}), createElement(LaunchWidget, {})]) {
      const html = mount(child, { onConnectRequest: () => undefined });
      expect(html).toContain("gullycore-widget");
      expect(html).not.toMatch(/<button[^>]*type="submit"(?![^>]*disabled)[^>]*>/);
    }
  });
});
