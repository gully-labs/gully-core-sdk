import { describe, expect, it } from "vitest";

import { buildCandles, marketStats, priceFromBinId, priceFromSqrt, type Trade } from "../src/market/index.js";
import { sqrtPriceX96FromPrice } from "../src/launchpad/price.js";
import { binIdFromRawPrice } from "../src/launchpad/kitV2/binPrice.js";

const Q96 = 2n ** 96n;

function trade(over: Partial<Trade> & { price: number; timestamp: number }): Trade {
  return {
    blockNumber: BigInt(over.timestamp),
    txHash: "0x01",
    logIndex: 0,
    sender: "0x0000000000000000000000000000000000000001",
    side: "buy",
    baseAmount: 1n,
    quoteAmount: 10n,
    ...over,
  };
}

describe("price orientation", () => {
  it("a 1:1 pool of equal decimals is price 1 either way", () => {
    expect(priceFromSqrt(Q96, { baseIsCurrency0: true, baseDecimals: 18, quoteDecimals: 18 })).toBeCloseTo(1, 12);
    expect(priceFromSqrt(Q96, { baseIsCurrency0: false, baseDecimals: 18, quoteDecimals: 18 })).toBeCloseTo(1, 12);
  });
  it("round-trips a launch price through sqrtPriceX96FromPrice, both orientations", () => {
    /* 0.000001 quote (18 dec) per token (18 dec), token = currency0 */
    const s0 = sqrtPriceX96FromPrice({ price: "0.000001", decimals0: 18, decimals1: 18 });
    expect(priceFromSqrt(s0, { baseIsCurrency0: true, baseDecimals: 18, quoteDecimals: 18 })).toBeCloseTo(1e-6, 12);
    /* token = currency1 quoted in a 6-decimal stable at 0.003: currency1 per currency0 is 1/0.003 in human terms */
    const s1 = sqrtPriceX96FromPrice({ price: (1 / 0.003).toString(), decimals0: 6, decimals1: 18 });
    expect(priceFromSqrt(s1, { baseIsCurrency0: false, baseDecimals: 18, quoteDecimals: 6 })).toBeCloseTo(0.003, 6);
  });
  it("a Bin id prices like the launch helper", () => {
    /* token = currency1, 6-dec quote: raw currency1 per currency0 = (1/0.003) * 1e12 */
    const raw = (1 / 0.003) * 1e12;
    const id = binIdFromRawPrice(raw, 100);
    const p = priceFromBinId(id, 100, { baseIsCurrency0: false, baseDecimals: 18, quoteDecimals: 6 });
    expect(p).toBeGreaterThan(0.0029);
    expect(p).toBeLessThan(0.0031);
  });
});

describe("buildCandles", () => {
  it("buckets by timestamp, open = first, close = last, sums quote volume", () => {
    const trades = [
      trade({ price: 1, timestamp: 100, quoteAmount: 5n, logIndex: 0 }),
      trade({ price: 3, timestamp: 110, quoteAmount: 7n, logIndex: 1 }),
      trade({ price: 2, timestamp: 119, quoteAmount: 1n, logIndex: 2 }),
      trade({ price: 4, timestamp: 125, quoteAmount: 2n, logIndex: 3 }),
    ];
    const c = buildCandles(trades, 60);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ time: 60, open: 1, high: 3, low: 1, close: 2, volumeQuote: 13n, trades: 3 });
    expect(c[1]).toMatchObject({ time: 120, open: 4, high: 4, low: 4, close: 4, volumeQuote: 2n, trades: 1 });
  });
  it("orders by block then log index regardless of input order, and skips untimestamped trades", () => {
    const a = trade({ price: 1, timestamp: 100, blockNumber: 1n, logIndex: 5 });
    const b = trade({ price: 2, timestamp: 100, blockNumber: 1n, logIndex: 2 });
    const none = { ...trade({ price: 99, timestamp: 100 }), timestamp: null };
    const c = buildCandles([a, none, b], 3600);
    expect(c).toHaveLength(1);
    expect(c[0]?.open).toBe(2);
    expect(c[0]?.close).toBe(1);
    expect(c[0]?.trades).toBe(2);
  });
  it("emits no candle for an empty bucket", () => {
    const c = buildCandles([trade({ price: 1, timestamp: 0 }), trade({ price: 1, timestamp: 7200 })], 3600);
    expect(c.map((x) => x.time)).toEqual([0, 7200]);
  });
  it("rejects a non-positive bucket", () => {
    expect(() => buildCandles([], 0)).toThrow(RangeError);
  });
});

describe("marketStats", () => {
  it("counts sides, sums volume and computes change over the window", () => {
    const trades = [
      trade({ price: 1, timestamp: 10, side: "buy", quoteAmount: 3n, logIndex: 0 }),
      trade({ price: 2, timestamp: 20, side: "sell", quoteAmount: 4n, logIndex: 1 }),
      trade({ price: 3, timestamp: 30, side: "buy", quoteAmount: 5n, logIndex: 2 }),
    ];
    const all = marketStats(trades);
    expect(all).toMatchObject({ trades: 3, buys: 2, sells: 1, volumeQuote: 12n, first: 1, last: 3, change: 2 });
    const recent = marketStats(trades, 20);
    expect(recent).toMatchObject({ trades: 2, first: 2, last: 3, volumeQuote: 9n });
    expect(recent.change).toBeCloseTo(0.5);
  });
  it("is honest about nothing", () => {
    expect(marketStats([])).toMatchObject({ trades: 0, first: null, last: null, change: null, lastTrade: null, volumeQuote: 0n });
  });
});
