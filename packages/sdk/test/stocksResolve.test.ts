// SPDX-License-Identifier: MIT
/* ============================================================================
   `resolveStockTokens`: the published list over the built-in registry.

   What is guarded here is the merge's contract, not the chain: the list wins
   on conflict and both sources are recorded; a list-only stock is taken as
   the list states it, with every power on when it carries no controls; a
   built-in stock the list lacks is kept; and `rebasing` can be turned ON by
   either source and OFF by neither. Every list failure degrades to the
   built-in table with the reason recorded, never to a throw.
   ============================================================================ */

import { describe, expect, it } from "vitest";

import { STOCK_TOKENS } from "../src/deployments/stocks.js";
import * as sdk from "../src/index.js";
import {
  ASSUME_ALL_CONTROLS,
  builtinStockTokens,
  describeStockSource,
  mergeStockTokens,
  quotableStockTokens,
  resolveStockTokens,
  resolvedStockByAddress,
} from "../src/tokenlists/stocks.js";
import type { TokenList, TokenListToken } from "../src/tokenlists/types.js";

const NVDA = STOCK_TOKENS[4663]!.find((r) => r.symbol === "NVDA")!;
const LIST_ONLY = "0x1111111111111111111111111111111111111111";
const REBASING_LIST_ONLY = "0x2222222222222222222222222222222222222222";

function stock(address: string, symbol: string, ext: Record<string, unknown>, chainId = 4663): TokenListToken {
  return { chainId, address, decimals: 18, name: `${symbol} name`, symbol, tags: ["stock"], extensions: { stock: ext as never } };
}

function list(tokens: readonly TokenListToken[], version = { major: 1, minor: 2, patch: 0 }): TokenList {
  return { name: "Gully Core", timestamp: "2026-09-18T00:00:00Z", version, tokens, tags: { stock: { name: "Tokenised stock", description: "see extensions.stock" } } };
}

const fullControls = { pause: true, blocklist: true, allowlist: false, issuerBurn: true, upgradeable: true, uiMultiplier: true, rebasing: false };

describe("mergeStockTokens", () => {
  it("with no list is the built-in table in the resolved shape, every token builtin-sourced", () => {
    const out = mergeStockTokens(4663, null);
    expect(out.map((t) => t.symbol).sort()).toEqual(STOCK_TOKENS[4663]!.map((r) => r.symbol).sort());
    for (const t of out) {
      expect(t.sources).toEqual(["builtin"]);
      expect(t.record).not.toBeNull();
      expect(t.isTestToken).toBe(false);
      expect(t.stock.ticker).toBe(t.record!.ticker);
    }
  });

  it("lets the list win on conflict and records both sources", () => {
    const l = list([stock(NVDA.address.toLowerCase(), "NVDA-L", { issuer: "Robinhood (list)", ticker: "NVDA", rebasing: false, controls: fullControls, verifiedAt: "2026-09-18" })]);
    const t = resolvedStockByAddress({ tokens: mergeStockTokens(4663, l) }, NVDA.address)!;
    expect(t.symbol).toBe("NVDA-L");
    expect(t.stock.issuer).toBe("Robinhood (list)");
    expect(t.sources).toEqual(["list", "builtin"]);
    expect(t.address).toBe(NVDA.address); /* the checksummed built-in address, whatever case the list used */
    expect(t.verifiedAt).toBe("2026-09-18");
    expect(t.record).toBe(NVDA);
  });

  it("takes a list-only stock as the list states it, and assumes every power when it carries no controls", () => {
    const l = list([stock(LIST_ONLY, "NEWCO", { issuer: "Someone", ticker: "NEW", rebasing: false })]);
    const t = resolvedStockByAddress({ tokens: mergeStockTokens(4663, l) }, LIST_ONLY)!;
    expect(t.sources).toEqual(["list"]);
    expect(t.record).toBeNull();
    expect(t.verifiedAt).toBeNull();
    expect(t.controls).toEqual(ASSUME_ALL_CONTROLS);
    /* every power on includes rebasing, so a controls-less entry is NOT quotable */
    expect(t.rebasing).toBe(true);
    expect(quotableStockTokens({ tokens: [t] })).toEqual([]);
  });

  it("uses the list's controls when it carries them", () => {
    const l = list([stock(LIST_ONLY, "NEWCO", { issuer: "Someone", ticker: "NEW", rebasing: false, controls: fullControls })]);
    const t = resolvedStockByAddress({ tokens: mergeStockTokens(4663, l) }, LIST_ONLY)!;
    expect(t.controls).toEqual(fullControls);
    expect(t.rebasing).toBe(false);
    expect(quotableStockTokens({ tokens: [t] }).length).toBe(1);
  });

  it("keeps a built-in stock the list lacks", () => {
    const l = list([stock(LIST_ONLY, "NEWCO", { issuer: "Someone", ticker: "NEW", rebasing: false, controls: fullControls })]);
    const out = mergeStockTokens(4663, l);
    expect(out.length).toBe(STOCK_TOKENS[4663]!.length + 1);
    expect(resolvedStockByAddress({ tokens: out }, NVDA.address)!.sources).toEqual(["builtin"]);
  });

  it("never lets the list turn rebasing OFF, on any path", () => {
    const dinari = STOCK_TOKENS[8453]!.find((r) => r.controls.rebasing)!;
    /* entry says false, controls say false, built-in says true */
    const l1 = list([stock(dinari.address, dinari.symbol, { issuer: dinari.issuer, ticker: dinari.ticker, rebasing: false, controls: { ...fullControls, rebasing: false } }, 8453)]);
    const t1 = resolvedStockByAddress({ tokens: mergeStockTokens(8453, l1) }, dinari.address)!;
    expect(t1.rebasing).toBe(true);
    expect(t1.controls.rebasing).toBe(true);
    /* entry says false, no controls, built-in says true */
    const l2 = list([stock(dinari.address, dinari.symbol, { issuer: dinari.issuer, ticker: dinari.ticker, rebasing: false }, 8453)]);
    expect(resolvedStockByAddress({ tokens: mergeStockTokens(8453, l2) }, dinari.address)!.rebasing).toBe(true);
    /* entry says true, built-in says false: the list may ADD the flag */
    const l3 = list([stock(NVDA.address, "NVDA", { issuer: "Robinhood", ticker: "NVDA", rebasing: true, controls: fullControls })]);
    const t3 = resolvedStockByAddress({ tokens: mergeStockTokens(4663, l3) }, NVDA.address)!;
    expect(t3.rebasing).toBe(true);
    expect(t3.controls.rebasing).toBe(true);
    expect(quotableStockTokens({ tokens: [t3] })).toEqual([]);
    /* controls.rebasing true with entry false: also true */
    const l4 = list([stock(REBASING_LIST_ONLY, "RB", { issuer: "X", ticker: "RB", rebasing: false, controls: { ...fullControls, rebasing: true } })]);
    expect(resolvedStockByAddress({ tokens: mergeStockTokens(4663, l4) }, REBASING_LIST_ONLY)!.rebasing).toBe(true);
  });

  it("ignores tokens on other chains, tokens without a stock extension, malformed extensions and the zero address", () => {
    const l = list([
      stock(LIST_ONLY, "OTHER", { issuer: "X", ticker: "X", rebasing: false, controls: fullControls }, 56),
      { chainId: 4663, address: "0x3333333333333333333333333333333333333333", decimals: 18, name: "plain", symbol: "PLAIN" },
      stock("0x4444444444444444444444444444444444444444", "BAD", { issuer: "X" }),
      stock("0x0000000000000000000000000000000000000000", "ETH", { issuer: "X", ticker: "ETH", rebasing: false, controls: fullControls }),
    ]);
    const out = mergeStockTokens(4663, l);
    expect(out.length).toBe(STOCK_TOKENS[4663]!.length);
    expect(out.every((t) => t.sources.includes("builtin"))).toBe(true);
  });
});

describe("resolveStockTokens", () => {
  it("fetches the chain's list through the given fetch and reports the list version", async () => {
    const seen: string[] = [];
    const body = JSON.stringify(list([stock(LIST_ONLY, "NEWCO", { issuer: "Someone", ticker: "NEW", rebasing: false, controls: fullControls })]));
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await resolveStockTokens(4663, { fetch: fetchImpl, base: "https://example.test/lists" });
    expect(seen).toEqual(["https://example.test/lists/4663.tokenlist.json"]);
    expect(r.source).toBe("merged");
    expect(r.listVersion).toBe("1.2.0");
    expect(r.listUrl).toBe("https://example.test/lists/4663.tokenlist.json");
    expect(r.listError).toBeNull();
    expect(r.tokens.length).toBe(STOCK_TOKENS[4663]!.length + 1);
    expect(describeStockSource(r)).toBe("stock list: token list v1.2.0 + built-in registry");
  });

  it("degrades to the built-in table with the reason when the list cannot be read", async () => {
    const failing: typeof fetch = async () => new Response("nope", { status: 503 });
    const r = await resolveStockTokens(4663, { fetch: failing });
    expect(r.source).toBe("builtin");
    expect(r.listVersion).toBeNull();
    expect(r.listError).toMatch(/HTTP 503/);
    expect(r.tokens.map((t) => t.symbol).sort()).toEqual(STOCK_TOKENS[4663]!.map((x) => x.symbol).sort());
    expect(describeStockSource(r)).toMatch(/^stock list: built-in registry \(list unreachable: HTTP 503/);
  });

  it("degrades when the body is not a valid token list, and when there is no fetch at all", async () => {
    const invalid: typeof fetch = async () => new Response(JSON.stringify({ name: "x", tokens: "no" }), { status: 200 });
    const r = await resolveStockTokens(4663, { fetch: invalid });
    expect(r.source).toBe("builtin");
    expect(r.listError).not.toBeNull();

    const hadFetch = globalThis.fetch;
    // @ts-expect-error simulating a host without fetch
    globalThis.fetch = undefined;
    try {
      const r2 = await resolveStockTokens(4663);
      expect(r2.source).toBe("builtin");
      expect(r2.listError).toBe("no fetch available");
    } finally {
      globalThis.fetch = hadFetch;
    }
  });

  it("accepts a list already in hand and skips the fetch", async () => {
    let called = 0;
    const spy: typeof fetch = async () => {
      called++;
      return new Response("{}", { status: 200 });
    };
    const r = await resolveStockTokens(4663, { fetch: spy, list: list([]) });
    expect(called).toBe(0);
    expect(r.listUrl).toBeNull();
    expect(r.listVersion).toBe("1.2.0");
    /* a list that names no stock: the built-in table alone, and the line says so */
    expect(r.source).toBe("builtin");
    expect(describeStockSource(r)).toBe("stock list: built-in registry (token list v1.2.0 lists no stock here)");
  });

  it("says `list` when the list alone provides every stock on a chain the SDK has none for", async () => {
    const r = await resolveStockTokens(999999, { list: list([stock(LIST_ONLY, "NEWCO", { issuer: "Someone", ticker: "NEW", rebasing: false, controls: fullControls }, 999999)]) });
    expect(r.source).toBe("list");
    expect(r.tokens.length).toBe(1);
    expect(describeStockSource(r)).toBe("stock list: token list v1.2.0");
  });

  it("refuses a bad chain id and nothing else", async () => {
    await expect(resolveStockTokens(0, { list: list([]) })).rejects.toBeInstanceOf(RangeError);
    const b = builtinStockTokens(4663);
    expect(b.source).toBe("builtin");
    expect(b.tokens.length).toBe(STOCK_TOKENS[4663]!.length);
    expect(builtinStockTokens(999999).tokens).toEqual([]);
  });

  it("is reachable from the package root, and the registry stays synchronous", () => {
    expect(sdk.resolveStockTokens).toBe(resolveStockTokens);
    expect(sdk.builtinStockTokens).toBe(builtinStockTokens);
    expect(sdk.quotableStockTokens).toBe(quotableStockTokens);
    expect(Array.isArray(sdk.stockTokensFor(4663))).toBe(true);
  });
});
