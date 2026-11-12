import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { MarketPool, Trade } from "@gullylabs/core-sdk";

import {
  alertView,
  apiBaseFor,
  binStepFromParameters,
  buysSnippet,
  emojiCount,
  fmtAmount,
  fmtUsd,
  followedPoolFromApi,
  keylessRpcFor,
  mergeTape,
  parseBuysAttributes,
  pricesFromApi,
  relativeTime,
  tokenPageUrl,
  tradeFromApiSwap,
  txUrl,
  type ApiPoolRow,
  type TapeTrade,
} from "../src/buys/model.js";
import { BuysSource } from "../src/buys/source.js";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const ETH = "0x0000000000000000000000000000000000000000" as Address;
const POOL = `0x${"11".repeat(32)}` as Hex;
const attrs = (o: Record<string, string>) => (n: string) => o[n] ?? null;

describe("attributes", () => {
  it("defaults: feed, dark, buys only, $10 per emoji, keyless RPC, the chain's API and app", () => {
    const p = parseBuysAttributes(attrs({ chain: "8453", token: TOKEN }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.attrs).toMatchObject({ chainId: 8453, layout: "feed", theme: "dark", sells: false, stepUsd: 10, emoji: "🟢", limit: 10, rpc: null, api: "https://app.gullycore.xyz/v1", site: "https://app.gullycore.xyz", pollSeconds: 15 });
    expect(p.attrs.target).toEqual({ kind: "token", token: TOKEN });
  });
  it("testnet reads the testnet API and app; a pool attribute wins over token", () => {
    const p = parseBuysAttributes(attrs({ chain: "485590", token: TOKEN, pool: POOL, layout: "STRIP", theme: "system", sells: "", step: "2.5", emoji: "🐸🐸🐸", limit: "99", corner: "top-left", poll: "1" }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.attrs.target).toEqual({ kind: "pool", poolId: POOL });
    expect(p.attrs).toMatchObject({ layout: "strip", theme: "auto", sells: true, stepUsd: 2.5, emoji: "🐸🐸", limit: 50, corner: "top-left", pollSeconds: 5, api: "https://testnet.gullycore.xyz/v1", site: "https://testnet.gullycore.xyz" });
  });
  it("refuses a missing chain, an unknown chain, a bad token, a bad pool, and nothing to follow", () => {
    expect(parseBuysAttributes(attrs({ token: TOKEN })).ok).toBe(false);
    expect(parseBuysAttributes(attrs({ chain: "1", token: TOKEN })).ok).toBe(false);
    expect(parseBuysAttributes(attrs({ chain: "8453", token: "0x12" })).ok).toBe(false);
    expect(parseBuysAttributes(attrs({ chain: "8453", pool: "0x12" })).ok).toBe(false);
    expect(parseBuysAttributes(attrs({ chain: "8453" })).ok).toBe(false);
  });
  it("sells='false' keeps buys only; overrides are trimmed", () => {
    const p = parseBuysAttributes(attrs({ chain: "56", token: TOKEN, sells: "false", api: " https://x.example/v1/ ", rpc: " https://r.example " }));
    expect(p.ok && p.attrs.sells).toBe(false);
    expect(p.ok && p.attrs.api).toBe("https://x.example/v1");
    expect(p.ok && p.attrs.rpc).toBe("https://r.example");
  });
  it("every served chain has an API, an app and a keyless RPC", () => {
    for (const id of [8453, 56, 4663, 99901, 6714, 485590]) {
      expect(parseBuysAttributes(attrs({ chain: String(id), token: TOKEN })).ok).toBe(true);
      expect(keylessRpcFor(id)).toBe(`https://rpc.gullyrpc.xyz/gullychain/evm/${id}`);
      expect(apiBaseFor(id)).toMatch(/^https:\/\/(app|testnet)\.gullycore\.xyz\/v1$/);
      expect(txUrl(id, `0x${"ab".repeat(32)}`)).toMatch(/^https:\/\/.+\/tx\/0xab/);
    }
    expect(txUrl(99901, `0x${"ab".repeat(32)}`)).toBe(`https://elysium.kinetiq.xyz/explorer/tx/0x${"ab".repeat(32)}`);
  });
});

const row = (over: Partial<ApiPoolRow> = {}): ApiPoolRow => ({
  poolId: POOL,
  poolType: "CL",
  poolManager: "0x6d0721230b6bed4bc9eeb65e200b6f90c2c9aee6",
  token0: { address: ETH, symbol: "ETH", decimals: 18 },
  token1: { address: TOKEN, symbol: "ECHO", decimals: 18 },
  config: { feeRaw: 8388608, parameters: "0x00000000000000000000000000000000000000000000000000000000003c0cc1" },
  hook: { address: "0x0cf9a6a75f7c83ddb8b22b59757d71189aaaaaaa" },
  ...over,
});

describe("pools from the API", () => {
  it("orients the pool on the token, with the other side as the quote", () => {
    const fp = followedPoolFromApi(row(), 8453, TOKEN, new Set([ETH]));
    expect(fp).not.toBeNull();
    expect(fp!.pool.baseIsCurrency0).toBe(false);
    expect(fp!.base.symbol).toBe("ECHO");
    expect(fp!.quote).toEqual({ address: ETH, symbol: "ETH", decimals: 18 });
    expect(fp!.pool.key).toMatchObject({ currency0: ETH, currency1: TOKEN, fee: 8388608, poolManager: "0x6d0721230b6bed4bc9eeb65e200b6f90c2c9aee6" });
  });
  it("a pool that does not hold the token is dropped; a pool attribute picks the unpriced side as base", () => {
    expect(followedPoolFromApi(row(), 8453, "0x00000000000000000000000000000000000000bb" as Address, new Set())).toBeNull();
    const fp = followedPoolFromApi(row(), 8453, null, new Set([ETH]));
    expect(fp!.base.address).toBe(TOKEN);
    const fp2 = followedPoolFromApi(row({ token0: { address: TOKEN, symbol: "ECHO", decimals: 18 }, token1: { address: ETH, symbol: "ETH", decimals: 18 } }), 8453, null, new Set([ETH]));
    expect(fp2!.base.address).toBe(TOKEN);
    expect(fp2!.pool.baseIsCurrency0).toBe(true);
  });
  it("the native side takes the chain's own symbol and decimals; a hookless pool has the zero hook; Bin is Bin", () => {
    const fp = followedPoolFromApi(row({ token0: { address: ETH, symbol: null, decimals: null }, hook: null, poolType: "Bin" }), 99901, TOKEN, new Set());
    expect(fp!.quote.symbol).toBe("HYPE");
    expect(fp!.pool.key.hooks).toBe(ETH);
    expect(fp!.pool.kind).toBe("Bin");
  });
  it("binStep comes from bits 16..31 of the parameters", () => {
    expect(binStepFromParameters("0x" + "0".repeat(56) + "00190000")).toBe(25);
  });
});

describe("swaps from the API", () => {
  const pool: MarketPool = { poolId: POOL, kind: "CL", key: { currency0: ETH, currency1: TOKEN, hooks: ETH, poolManager: ETH, fee: 0, parameters: "0x00" as Hex }, baseIsCurrency0: false, baseDecimals: 18, quoteDecimals: 18 };
  const swap = (amount0: string, amount1: string) => ({ txHash: `0x${"cd".repeat(32)}`, blockNumber: "100", blockTimestamp: "2026-11-12T16:00:00.000Z", logIndex: 7, sender: ETH, amount0, amount1, sqrtPriceX96: (2n ** 96n).toString(), activeId: null });
  it("a trade that received the token is a buy, priced with the SDK's function, timed from the index", () => {
    const t = tradeFromApiSwap(swap("-1000", "5000"), pool)!;
    expect(t.side).toBe("buy");
    expect(t.baseAmount).toBe(5000n);
    expect(t.quoteAmount).toBe(1000n);
    expect(t.price).toBe(1);
    expect(t.timestamp).toBe(Math.floor(Date.parse("2026-11-12T16:00:00.000Z") / 1000));
    expect(tradeFromApiSwap(swap("1000", "-5000"), pool)!.side).toBe("sell");
  });
  it("a CL swap without a price is dropped", () => {
    expect(tradeFromApiSwap({ ...swap("-1", "1"), sqrtPriceX96: null }, pool)).toBeNull();
  });
});

const trade = (block: bigint, logIndex: number, side: "buy" | "sell" = "buy", quote = 10n ** 16n): TapeTrade => ({
  poolId: POOL,
  trade: { blockNumber: block, txHash: `0x${block.toString(16).padStart(64, "0")}` as Hex, logIndex, sender: ETH, side, baseAmount: 10n ** 21n, quoteAmount: quote, price: 1e-5, timestamp: 1_000_000 + Number(block) } satisfies Trade,
});

describe("poll merge", () => {
  it("deduplicates by tx hash and log index, newest first, and names what is new", () => {
    const first = mergeTape([], [trade(1n, 0), trade(2n, 0)], 10);
    expect(first.tape.map((t) => t.trade.blockNumber)).toEqual([2n, 1n]);
    const next = mergeTape(first.tape, [trade(2n, 0), trade(2n, 1), trade(3n, 0)], 10);
    expect(next.fresh).toEqual([`0x${"0".repeat(63)}2:1`, `0x${"0".repeat(63)}3:0`]);
    expect(next.tape.map((t) => `${t.trade.blockNumber}:${t.trade.logIndex}`)).toEqual(["3:0", "2:1", "2:0", "1:0"]);
  });
  it("cuts to the cap and never reports a cut trade as fresh", () => {
    const r = mergeTape([trade(5n, 0), trade(4n, 0)], [trade(1n, 0), trade(6n, 0)], 2);
    expect(r.tape.map((t) => t.trade.blockNumber)).toEqual([6n, 5n]);
    expect(r.fresh).toEqual([`0x${"0".repeat(63)}6:0`]);
  });
});

describe("figures", () => {
  it("emoji scale: the buy bot's rule, one per step, at least one, at most 40, unpriced one", () => {
    expect(emojiCount(0, 10)).toBe(1);
    expect(emojiCount(9.99, 10)).toBe(1);
    expect(emojiCount(10, 10)).toBe(2);
    expect(emojiCount(42, 10)).toBe(5);
    expect(emojiCount(1e9, 10)).toBe(40);
    expect(emojiCount(null, 10)).toBe(1);
    expect(emojiCount(50, 0)).toBe(1);
  });
  it("USD text", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(0.004)).toBe("$0.0040");
    expect(fmtUsd(0.05)).toBe("$0.05");
    expect(fmtUsd(42.1)).toBe("$42.10");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(12_345)).toBe("$12.3K");
    expect(fmtUsd(2_500_000)).toBe("$2.50M");
    expect(fmtUsd(-1)).toBe("—");
  });
  it("amounts", () => {
    expect(fmtAmount(21n * 10n ** 15n, 18, "ETH")).toBe("0.021 ETH");
    expect(fmtAmount(12_500n * 10n ** 18n, 18, "ECHO")).toBe("12.5K ECHO");
    expect(fmtAmount(0n, 18)).toBe("0");
    expect(fmtAmount(1_234_567n * 10n ** 18n, 18)).toBe("1.23M");
  });
  it("relative time", () => {
    expect(relativeTime(null, 100)).toBe("");
    expect(relativeTime(99, 100)).toBe("just now");
    expect(relativeTime(50, 100)).toBe("50s ago");
    expect(relativeTime(100 - 600, 100)).toBe("10m ago");
    expect(relativeTime(100 - 7200, 100)).toBe("2h ago");
    expect(relativeTime(100 - 86_400 * 3, 100)).toBe("3d ago");
  });
  it("links: the app's token page with the chain key, the chain's explorer", () => {
    expect(tokenPageUrl("https://app.gullycore.xyz/", 8453, TOKEN)).toBe(`https://app.gullycore.xyz/tokens/${TOKEN}?net=base`);
    expect(tokenPageUrl("https://testnet.gullycore.xyz", 485590, TOKEN)).toBe(`https://testnet.gullycore.xyz/tokens/${TOKEN}?net=gullyTestnet`);
  });
});

describe("alert view", () => {
  const fp = followedPoolFromApi(row(), 8453, TOKEN, new Set([ETH]))!;
  const pools = new Map([[POOL, fp]]);
  it("USD first with the quote in small print, the emoji scale, the tx link", () => {
    const v = alertView(trade(10n, 0, "buy", 21n * 10n ** 15n), pools, new Map([[ETH, 2000]]), { chainId: 8453, stepUsd: 10, emoji: "🟢", now: 1_000_010 + 90 })!;
    expect(v.usd).toBe("$42.00");
    expect(v.quoteText).toBe("0.021 ETH");
    expect(v.baseText).toBe("1,000 ECHO");
    expect(v.emojis).toBe("🟢".repeat(5));
    expect(v.ago).toBe("1m ago");
    expect(v.txUrl).toMatch(/^https:\/\/basescan\.org\/tx\/0x/);
  });
  it("unpriced quote: no dollar figure, one emoji; a sell is the red circle", () => {
    const v = alertView(trade(10n, 0, "sell"), pools, new Map(), { chainId: 8453, stepUsd: 10, emoji: "🟢", now: 0 })!;
    expect(v.usd).toBeNull();
    expect(v.emojis).toBe("🔴");
    expect(alertView(trade(10n, 0), new Map(), new Map(), { chainId: 8453, stepUsd: 10, emoji: "🟢", now: 0 })).toBeNull();
  });
  it("reads the API's price list", () => {
    const m = pricesFromApi({ tokens: [{ address: "0xABC", usdPerUnit: "1999.1" }, { address: "0xdef", usdPerUnit: "0" }, { address: 1 }] });
    expect([...m]).toEqual([["0xabc", 1999.1]]);
    expect(pricesFromApi(null).size).toBe(0);
  });
  it("snippet", () => {
    expect(buysSnippet({ chainId: 8453, token: TOKEN, layout: "strip" })).toBe(`<script src="https://gullycore.xyz/buys.js" defer></script>\n<gully-buys chain="8453" token="${TOKEN}" layout="strip"></gully-buys>`);
    expect(buysSnippet({ chainId: 56, token: TOKEN, layout: "toast", theme: "light", sells: true })).toContain('theme="light" sells>');
  });
});

describe("source", () => {
  const pricesAnswer = { footnote: "", tokens: [{ address: ETH, usdPerUnit: "2000" }] };
  const apiOf = (routes: Record<string, unknown>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.replace(/^https:\/\/[^/]+\/v1/, "");
      const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
      if (hit === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  const base = parseBuysAttributes(attrs({ chain: "8453", token: TOKEN }));
  it("resolves the token's pools and history from the API before any chain read, newest first", async () => {
    if (!base.ok) throw new Error("attrs");
    const src = new BuysSource({ ...base.attrs, rpc: "http://127.0.0.1:9" }, {
      fetchImpl: apiOf({
        "/prices": pricesAnswer,
        "/chains/8453/pools?token": { data: { items: [row()] } },
        "/tokens/8453/": { data: { symbol: "ECHO", name: "Echo Mic", logoUrl: "/v1/tokens/8453/x/logo" } },
        [`/chains/8453/pools/${POOL}/swaps`]: { data: [{ txHash: `0x${"cd".repeat(32)}`, blockNumber: "100", blockTimestamp: "2026-11-12T16:00:00.000Z", logIndex: 7, sender: ETH, amount0: "-1000", amount1: "5000", sqrtPriceX96: (2n ** 96n).toString(), activeId: null }], provenance: { toBlock: "100" } },
      }),
      visible: () => false,
    });
    src.start();
    await new Promise((r) => setTimeout(r, 50));
    const s = src.state;
    expect(s.status).toBe("ready");
    expect(s.token).toMatchObject({ symbol: "ECHO", name: "Echo Mic", logoUrl: "https://app.gullycore.xyz/v1/tokens/8453/x/logo" });
    expect(s.pools.size).toBe(1);
    expect(s.tape.length).toBe(1);
    expect(s.tape[0]!.trade.side).toBe("buy");
    expect(s.head).toBe(100n);
    expect(s.usdPerQuote.get(ETH)).toBe(2000);
    src.stop();
  });
  it("a token with no pool says so, and a dead API is an error with words", async () => {
    if (!base.ok) throw new Error("attrs");
    const none = new BuysSource(base.attrs, { fetchImpl: apiOf({ "/prices": pricesAnswer, "/chains/8453/pools?token": { data: { items: [] } } }), visible: () => false });
    none.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(none.state.status).toBe("error");
    expect(none.state.message).toMatch(/No Gully Core pool/);
    const dead = new BuysSource(base.attrs, { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, visible: () => false });
    dead.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(dead.state.status).toBe("error");
    expect(dead.state.message).toMatch(/Gully Core API/);
  });
});
