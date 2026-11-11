// SPDX-License-Identifier: MIT
/* A launch's market cap per pool: spot × supply, dollars only where the quote is native/wrapped
   and the native/USD read answered, nothing for a pool whose price could not be read. */
import { describe, expect, it } from "vitest";
import type { LaunchLegV2, LaunchRecordV2, MarketPool, NativeUsdQuote } from "@gullylabs/core-sdk";
import type { Hex, PublicClient } from "viem";

import { capFromSpot, capUsd, formatQuoteCap, marketCapText, marketPoolOf, readLaunchMarketCaps } from "./launchMarketCap";

const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const SUPPLY = 1_000_000_000n * 10n ** 18n; // 1e9 tokens
const eth2000: NativeUsdQuote = { answer: 2000_00000000n, answerDecimals: 8, nativeSymbol: "ETH", provenance: { tier: 1, source: "Chainlink", ageSeconds: 10 } } as unknown as NativeUsdQuote;

describe("capFromSpot", () => {
  it("is price × whole supply", () => {
    expect(capFromSpot(0.000000005, SUPPLY, 18)).toBeCloseTo(5, 9); // 5e-9 ETH per token × 1e9 tokens = 5 ETH
    expect(capFromSpot(2, 10n ** 18n, 18)).toBe(2);
  });
  it("is null for a price or supply that is not a positive finite number", () => {
    expect(capFromSpot(0, SUPPLY, 18)).toBeNull();
    expect(capFromSpot(-1, SUPPLY, 18)).toBeNull();
    expect(capFromSpot(NaN, SUPPLY, 18)).toBeNull();
    expect(capFromSpot(Infinity, SUPPLY, 18)).toBeNull();
    expect(capFromSpot(1, 0n, 18)).toBeNull();
  });
});

describe("capUsd: dollars only where the quote is native/wrapped and the rate is known", () => {
  it("native and the wrapped native get dollars", () => {
    expect(capUsd(5, NATIVE, WETH, eth2000)).toBe(10_000);
    expect(capUsd(5, WETH, WETH, eth2000)).toBe(10_000);
  });
  it("any other quote, or no rate, is null (never a converted figure)", () => {
    expect(capUsd(5, USDC, WETH, eth2000)).toBeNull();
    expect(capUsd(5, NATIVE, WETH, null)).toBeNull();
    expect(capUsd(5, WETH, null, eth2000)).toBeNull();
  });
});

describe("formatting", () => {
  it("formatQuoteCap keeps the digits that matter at each size", () => {
    expect(formatQuoteCap(5, "ETH")).toBe("5 ETH");
    expect(formatQuoteCap(12.3456, "ETH")).toBe("12.35 ETH");
    expect(formatQuoteCap(1_250_000.4, "USDC")).toBe("1,250,000 USDC");
    expect(formatQuoteCap(0.0421337, "ETH")).toBe("0.0421 ETH");
    expect(formatQuoteCap(0, "ETH")).toBe("0 ETH");
  });
  it("marketCapText leads with dollars where read and always carries the quote figure", () => {
    const cap = { poolId: "0x01" as Hex, price: 0.000000005, capQuote: 5 };
    expect(marketCapText(cap, NATIVE, "ETH", WETH, eth2000)).toBe("$10K · 5 ETH");
    expect(marketCapText(cap, NATIVE, "ETH", WETH, null)).toBe("5 ETH");
    expect(marketCapText({ ...cap, capQuote: 1790.5 }, USDC, "USDC", WETH, eth2000)).toBe("1,791 USDC");
  });
});

function leg(over: Partial<LaunchLegV2>): LaunchLegV2 {
  return {
    poolId: "0xaa" as Hex,
    kind: "CL",
    key: { currency0: NATIVE, currency1: "0x8d901a1b3f3a57f9c36a71382fa183476c41545b", hooks: "0x7878000000000000000000000000000000000078", poolManager: "0x7878000000000000000000000000000000000001", fee: 0x800000, parameters: "0x00" },
    quote: NATIVE,
    quoteMeta: null,
    lockId: 1n,
    weightBps: 10_000,
    launchTokenSeeded: SUPPLY,
    launchTokenIsCurrency0: false,
    guardGeneration: "quote-fee",
    currentFeePips: 10_000,
    feeParts: null,
    lpShareBps: 2000,
    guard: null,
    tax: null,
    ...over,
  } as unknown as LaunchLegV2;
}
const record = (legs: LaunchLegV2[], token = "0x8d901a1b3f3a57f9c36a71382fa183476c41545b"): LaunchRecordV2 => ({ token, totalSupply: SUPPLY, legs }) as unknown as LaunchRecordV2;

describe("marketPoolOf", () => {
  it("builds the SDK pool from the leg: native quote takes the chain's decimals, a token quote its own", () => {
    const native = marketPoolOf(leg({}), 18, 18);
    expect(native).toMatchObject({ poolId: "0xaa", kind: "CL", baseIsCurrency0: false, baseDecimals: 18, quoteDecimals: 18 });
    const usdc = marketPoolOf(leg({ quote: USDC, quoteMeta: { address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 } }), 18, 18);
    expect(usdc?.quoteDecimals).toBe(6);
  });
  it("is null without a key, or without the quote's decimals", () => {
    expect(marketPoolOf(leg({ key: null }), 18, 18)).toBeNull();
    expect(marketPoolOf(leg({ quote: USDC, quoteMeta: null }), 18, 18)).toBeNull();
  });
});

describe("readLaunchMarketCaps", () => {
  const client = {} as PublicClient;
  it("one price read per readable leg; an unreadable leg is absent, never zero", async () => {
    const reads: MarketPool[] = [];
    const launches = [record([leg({ poolId: "0xaa" as Hex }), leg({ poolId: "0xbb" as Hex, key: null }), leg({ poolId: "0xcc" as Hex })])];
    const caps = await readLaunchMarketCaps(client, launches, {
      tokenDecimals: 18,
      nativeDecimals: 18,
      readPrice: async (pool) => {
        reads.push(pool);
        if (pool.poolId === "0xcc") throw new Error("getSlot0 reverted");
        return 0.000000005;
      },
    });
    expect(reads.map((p) => p.poolId)).toEqual(["0xaa", "0xcc"]);
    expect([...caps.keys()]).toEqual(["0xaa"]);
    expect(caps.get("0xaa" as Hex)?.capQuote).toBeCloseTo(5, 9);
    expect(caps.get("0xaa" as Hex)?.price).toBe(0.000000005);
  });
  it("a zero price is no cap (a pool born at a price of zero is not a thing)", async () => {
    const caps = await readLaunchMarketCaps(client, [record([leg({})])], { tokenDecimals: 18, nativeDecimals: 18, readPrice: async () => 0 });
    expect(caps.size).toBe(0);
  });
});
