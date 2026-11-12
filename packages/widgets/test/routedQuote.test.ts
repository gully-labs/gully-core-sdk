// SPDX-License-Identifier: MIT
/**
 * Routed quotes (`core/routed.ts`): choose-better, the routing-fee line, the minimum received, and
 * every way the widget falls back to Gully Core pools. The HTTP layer is driven through an injected
 * `fetch`; the same client was exercised against the real API on a Base fork (see
 * docs/router-v1-roadmap.md, "What shipped").
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { SwapWidget } from "../src/components/SwapWidget.js";
import type { ChainConfig } from "../src/config/chain.js";
import { WidgetProvider } from "../src/context/WidgetProvider.js";
import {
  bestPriceLabel,
  buildRoutedSwap,
  chooseRoute,
  fetchRoutedQuote,
  fetchRouterSources,
  parseRoutedQuote,
  routedMinReceived,
  routingFeeLine,
  verifyBuiltRoutedSwap,
  type RoutedQuote,
  type RouterEndpointConfig,
} from "../src/core/routed.js";
import { createMockAdapter } from "./helpers/mockAdapter.js";

const FILL: Address = "0x00000000000000000000000000000000000dc0de"; // synthetic fill router
const W: Address = "0x4200000000000000000000000000000000000006";
const U: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NAMES = new Map([["UNISWAP_V3", "Uniswap v3"]]);
const REQ = { chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, slippageBps: 50 };

/** A `/quote` body as the API serialises a routed fill (numbers from a Base-fork run). */
function body(over: Record<string, unknown> = {}, fee: Record<string, unknown> = {}, route: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    tokenIn: W,
    tokenOut: U,
    amountIn: "1000000000000000000",
    amountOut: "2649623785",
    minAmountOut: "2636375666",
    priceImpactBps: 3,
    expiresAt: 1_790_575_936,
    blockNumber: "51893167",
    protocolFee: { bps: 15, amount: "1497753369945082", budget: "998502246630054917", refund: "1", currency: W, exempt: false, readFrom: FILL, ...fee },
    route: { execution: "gullycore-fill-router", to: FILL, source: "UNISWAP_V3", legs: [{ shareBps: 10_000 }], ...route },
    ...over,
  };
}
const CFG: RouterEndpointConfig = { baseUrl: "https://api.example/v1/chains", fillRouter: FILL };
const quote = (): RoutedQuote => parseRoutedQuote(CFG, REQ, body(), NAMES)!;

describe("chooseRoute: the better NET output for the user, fail closed to Gully Core", () => {
  it("routed only when strictly better than the Gully Core pool's net output", () => {
    const q = quote();
    expect(chooseRoute(q.amountOut - 1n, q)).toEqual({ kind: "routed", quote: q });
    expect(chooseRoute(q.amountOut, q)).toEqual({ kind: "gullycore" }); // a tie stays on the Gully Core pool (0 routing fee)
    expect(chooseRoute(q.amountOut + 1n, q)).toEqual({ kind: "gullycore" });
  });
  it("no router answer -> Gully Core; no Gully Core pool -> the routed fill (the cold-start case)", () => {
    expect(chooseRoute(123n, null)).toEqual({ kind: "gullycore" });
    expect(chooseRoute(null, null)).toEqual({ kind: "gullycore" });
    expect(chooseRoute(null, quote()).kind).toBe("routed");
  });
});

describe("the routing-fee line and the floor", () => {
  it("'Routing fee 0.15%' only on a routed fill, with the fee in the input token", () => {
    const line = routingFeeLine({ kind: "routed", quote: quote() });
    expect(line).toEqual({ label: "Routing fee 0.15%", bps: 15, amount: 1_497_753_369_945_082n });
    expect(routingFeeLine({ kind: "gullycore" })).toBeNull();
    expect(routingFeeLine({ kind: "routed", quote: { ...quote(), feeBps: 0, feeAmount: 0n } })).toBeNull(); // exempt venue: no line
    expect(routingFeeLine({ kind: "routed", quote: { ...quote(), feeBps: 10 } })!.label).toBe("Routing fee 0.1%");
  });
  it("names the venue factually, and only when routed", () => {
    expect(bestPriceLabel({ kind: "routed", quote: quote() })).toBe("Uniswap v3");
    expect(bestPriceLabel({ kind: "gullycore" })).toBeNull();
  });
  it("minimum received comes from the fee-net output, rounding down", () => {
    // 2649623785 * 9950 / 10000 = 2636375666.075 -> 2636375666, exactly the API's own minAmountOut
    expect(routedMinReceived(quote(), 50)).toBe(2_636_375_666n);
    expect(() => routedMinReceived(quote(), 5_001)).toThrow();
  });
});

describe("parseRoutedQuote: a response that does not verify is not a price", () => {
  it("a Gully Core-pool best route is null: the widget keeps its own Gully Core path", () => {
    expect(parseRoutedQuote(CFG, REQ, body({}, {}, { execution: "gullycore-universal-router" }), NAMES)).toBeNull();
  });
  it.each([
    ["another fill router", body({}, {}, { to: "0x0000000000000000000000000000000000000001" }), "FILL_ROUTER_MISMATCH"],
    ["fee read from elsewhere", body({}, { readFrom: "0x0000000000000000000000000000000000000001" }), "FILL_ROUTER_MISMATCH"],
    ["fee above the 50 bps cap", body({}, { bps: 51 }), "BAD_RESPONSE"],
    ["fee that does not add up", body({}, { amount: "1497753369945083" }), "BAD_RESPONSE"],
    ["budget + fee + refund != amountIn", body({}, { refund: "2" }), "BAD_RESPONSE"],
    ["another amount", body({ amountIn: "999" }), "BAD_RESPONSE"],
    ["another pair", body({ tokenOut: W }), "BAD_RESPONSE"],
    ["another chain", body({ chainId: 1 }), "BAD_RESPONSE"],
    ["a split (flag is off)", body({}, {}, { legs: [{}, {}] }), "UNSUPPORTED"],
    ["an unnamed venue", body({}, {}, { source: "SOMETHING_ELSE" }), "BAD_RESPONSE"],
  ])("refuses %s", (_name, b, code) => {
    expect(() => parseRoutedQuote(CFG, REQ, b as Record<string, unknown>, NAMES)).toThrow(expect.objectContaining({ code }));
  });
});

function fakeFetch(routes: Record<string, { status: number; json: unknown }>): typeof fetch {
  return (async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const r = routes[key]!;
    return { ok: r.status < 400, status: r.status, json: async () => r.json } as Response;
  }) as unknown as typeof fetch;
}

describe("the HTTP client", () => {
  it("NO_ROUTE is 'no routed option' (null), a 404 router tier is an error (caller falls back)", async () => {
    const none = { ...CFG, fetch: fakeFetch({ "/quote": { status: 404, json: { error: { code: "NO_ROUTE", message: "x" } } } }) };
    await expect(fetchRoutedQuote(none, REQ, NAMES)).resolves.toBeNull();
    const off = { ...CFG, fetch: fakeFetch({ "/quote": { status: 404, json: { error: { code: "NOT_FOUND", message: "The router does not serve chain 8453" } } } }) };
    await expect(fetchRoutedQuote(off, REQ, NAMES)).rejects.toMatchObject({ status: 404 });
    const down = { ...CFG, fetch: (async () => { throw new TypeError("network"); }) as unknown as typeof fetch };
    await expect(fetchRoutedQuote(down, REQ, NAMES)).rejects.toMatchObject({ code: "UNREACHABLE" });
  });
  it("sources: refuses an API that names a different fill router than the address book", async () => {
    const other = { ...CFG, fetch: fakeFetch({ "/sources": { status: 200, json: { data: { routers: { fillRouter: "0x0000000000000000000000000000000000000001" }, sources: [] } } } }) };
    await expect(fetchRouterSources(other, 8453)).rejects.toMatchObject({ code: "FILL_ROUTER_MISMATCH" });
    const ok = { ...CFG, fetch: fakeFetch({ "/sources": { status: 200, json: { data: { routers: { fillRouter: FILL }, sources: [{ id: "UNISWAP_V3", name: "Uniswap v3", enabled: true }, { id: "OFF", name: "Off", enabled: false }] } } } }) };
    expect([...(await fetchRouterSources(ok, 8453))]).toEqual([["UNISWAP_V3", "Uniswap v3"]]);
  });
});

/* ---- the built transaction, decoded against what the user saw ---- */

const FILL_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "target", type: "address" },
      { name: "currencyIn", type: "address" },
      { name: "currencyOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "maxFeeBps", type: "uint16" },
      { name: "wrapInput", type: "bool" },
      { name: "unwrapOutput", type: "bool" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;
const FILL_SELECTOR = "0x" + encodeFunctionData({ abi: [{ type: "function", name: "fill", stateMutability: "payable", inputs: FILL_PARAMS as never, outputs: [] }], functionName: "fill", args: [{ target: FILL, currencyIn: W, currencyOut: U, amountIn: 1n, minAmountOut: 1n, maxFeeBps: 1, wrapInput: false, unwrapOutput: false, recipient: USER, deadline: 1n, data: "0x" }] as never }).slice(2, 10);

function fillData(over: Partial<{ currencyIn: Address; currencyOut: Address; amountIn: bigint; minAmountOut: bigint; maxFeeBps: number; recipient: Address }> = {}): Hex {
  const p = { target: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address, currencyIn: W, currencyOut: U, amountIn: 10n ** 18n, minAmountOut: 2_636_375_666n, maxFeeBps: 15, wrapInput: false, unwrapOutput: false, recipient: USER, deadline: 1_790_577_186n, data: "0x" as Hex, ...over };
  return (FILL_SELECTOR + encodeAbiParameters(FILL_PARAMS, [p]).slice(2)) as Hex;
}
const SWAP_REQ = { ...REQ, sender: USER, recipient: USER, amountOutMinimum: 2_636_375_666n };
function built(data: Hex, to: Address = FILL, sim: Record<string, string> = { amountOut: "2649623785", spent: "998502246630054917", feeAmount: "1497753369945082", refund: "1" }) {
  return { tx: { from: USER, to, data, value: "0", gas: "441203" }, simulation: { ok: true, fill: sim } };
}

describe("verifyBuiltRoutedSwap: the calldata is the trade the user saw", () => {
  it("accepts the exact trade", () => {
    const b = verifyBuiltRoutedSwap(CFG, SWAP_REQ, built(fillData()), 15);
    expect(b.minAmountOut).toBe(2_636_375_666n);
    expect(b.simulated.feeAmount).toBe(1_497_753_369_945_082n);
  });
  it.each([
    ["addressed elsewhere", built(fillData(), "0x0000000000000000000000000000000000000001"), "FILL_ROUTER_MISMATCH"],
    ["a floor below the displayed minimum", built(fillData({ minAmountOut: 2_636_375_665n })), "BAD_RESPONSE"],
    ["another recipient", built(fillData({ recipient: "0x0000000000000000000000000000000000000002" })), "BAD_RESPONSE"],
    ["another amount", built(fillData({ amountIn: 2n })), "BAD_RESPONSE"],
    ["another pair", built(fillData({ currencyOut: W })), "BAD_RESPONSE"],
    ["a different fee than quoted", built(fillData({ maxFeeBps: 20 })), "FEE_CHANGED"],
    ["a simulated fee that is not the quoted rate", built(fillData(), FILL, { amountOut: "2649623785", spent: "998502246630054917", feeAmount: "1", refund: "1" }), "SIMULATION_FAILED"],
    ["a Gully Core route (no fill decoded)", { tx: { from: USER, to: FILL, data: fillData(), value: "0", gas: "1" }, simulation: { ok: true, fill: null } }, "NOT_ROUTED"],
  ])("refuses %s", (_n, b, code) => {
    expect(() => verifyBuiltRoutedSwap(CFG, SWAP_REQ, b as Record<string, unknown>, 15)).toThrow(expect.objectContaining({ code }));
  });

  it("approval step: accepted only as an EXACT-amount approve of the fill router on tokenIn", async () => {
    const approve = (spender: Address, amount: bigint) =>
      encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [spender, amount] });
    const answer = (data: Hex, to: Address = W) => ({ ...CFG, fetch: fakeFetch({ "/swap": { status: 409, json: { error: { code: "APPROVAL_REQUIRED", message: "x", details: { approvals: [{ kind: "erc20-approve", to, data }] } } } } }) });
    await expect(buildRoutedSwap(answer(approve(FILL, 10n ** 18n)), SWAP_REQ, 15)).resolves.toMatchObject({ kind: "approval", amount: 10n ** 18n, to: W });
    await expect(buildRoutedSwap(answer(approve(FILL, (1n << 256n) - 1n)), SWAP_REQ, 15)).rejects.toMatchObject({ code: "BAD_RESPONSE" }); // unlimited
    await expect(buildRoutedSwap(answer(approve(USER, 10n ** 18n)), SWAP_REQ, 15)).rejects.toMatchObject({ code: "BAD_RESPONSE" }); // another spender
    await expect(buildRoutedSwap(answer(approve(FILL, 10n ** 18n), U), SWAP_REQ, 15)).rejects.toMatchObject({ code: "BAD_RESPONSE" }); // another token
  });
});

describe("SwapWidget with `router`: the first frame is the Gully Core path, and the mock adapter never routes", () => {
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
    },
  };
  it("renders byte-identical markup with and without a router, and no routing lines", () => {
    const adapter = createMockAdapter({ chain: CHAIN, account: null });
    const render = (router?: RouterEndpointConfig) =>
      renderToStaticMarkup(createElement(WidgetProvider, { adapter, theme: "light", children: createElement(SwapWidget, router === undefined ? {} : { router }) }));
    const withRouter = render({ ...CFG, fetch: (async () => { throw new Error("must not be called during render"); }) as unknown as typeof fetch });
    expect(withRouter).toBe(render());
    expect(withRouter).not.toContain("Routing fee");
    expect(withRouter).not.toContain("Best price");
  });
});
