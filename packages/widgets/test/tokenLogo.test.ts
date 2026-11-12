// SPDX-License-Identifier: MIT
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TokenInfo } from "../src/adapters/protocol.js";
import { TokenLogo, TokenLogoLookup } from "../src/components/swap/TokenSelect.js";
import { WidgetContext, type WidgetContextValue } from "../src/context/WidgetProvider.js";

const DTC: TokenInfo = { address: "0x8D901a1b3f3a57f9C36A71382Fa183476C41545b", symbol: "DTC", name: "DTC", decimals: 18 };
const host = (tokenLogo: WidgetContextValue["tokenLogo"]) => ({ tokenLogo }) as unknown as WidgetContextValue;
const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

describe("TokenLogo: the host's logo, then the token's own, then the lists', then a monogram", () => {
  it("draws a monogram when nobody names a logo", () => {
    const html = render(createElement(TokenLogo, { token: DTC }));
    expect(html).toContain("gullycore-token-logo--initials");
    expect(html).not.toContain("<img");
  });
  it("draws the host's answer before the token's own logo, and the token's own when the host has none", () => {
    const own = { ...DTC, logoUrl: "https://x.test/dtc.png" };
    expect(render(createElement(WidgetContext.Provider, { value: host(() => "blob:https://gullychain.xyz/core/v") }, createElement(TokenLogo, { token: own })))).toContain('src="blob:https://gullychain.xyz/core/v"');
    expect(render(createElement(WidgetContext.Provider, { value: host(() => null) }, createElement(TokenLogo, { token: own })))).toContain('src="https://x.test/dtc.png"');
  });
  it("takes the lists' logo for a token handed over without one", () => {
    const html = render(createElement(TokenLogoLookup.Provider, { value: () => "https://x.test/listed.png" }, createElement(TokenLogo, { token: DTC })));
    expect(html).toContain('src="https://x.test/listed.png"');
  });
  it("takes the host's logo (a launch icon as a blob, a native mark as a same-origin path)", () => {
    expect(render(createElement(WidgetContext.Provider, { value: host(() => "blob:https://gullychain.xyz/core/abc") }, createElement(TokenLogo, { token: DTC })))).toContain('src="blob:https://gullychain.xyz/core/abc"');
    expect(render(createElement(WidgetContext.Provider, { value: host(() => "/chains/ethereum.svg") }, createElement(TokenLogo, { token: DTC })))).toContain('src="/chains/ethereum.svg"');
  });
  it("refuses a host answer that is not https, ipfs, same-origin or blob (monogram)", () => {
    const html = render(createElement(WidgetContext.Provider, { value: host(() => "http://evil.test/a.png") }, createElement(TokenLogo, { token: DTC })));
    expect(html).not.toContain("<img");
  });
});
