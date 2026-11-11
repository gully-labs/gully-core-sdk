// SPDX-License-Identifier: MIT
/* ============================================================================
   The scaled-share band adapter's MIT half: `chainlinkScaledShareFeedConfig` builds the
   `ChainlinkScaledSharePriceBandAdapter.ScaledFeed` struct from REAL table rows (a BNB
   Chain share feed, a bStock, the chain's BNB/USD feed), and `stockPairCoverage` reports a
   share-priced ticker as pairable only once a scaled-share adapter is named.
   ============================================================================ */

import { describe, expect, it } from "vitest";

import { getDeployment, GULLYCORE_CHAIN_IDS } from "../src/deployments/index.js";
import { nativeFeedFor } from "../src/deployments/nativeFeeds.js";
import { stockFeedsFor } from "../src/deployments/stockFeeds.js";
import { stockTokensFor } from "../src/deployments/stocks.js";
import {
  bandFloorPpm,
  chainlinkScaledShareFeedConfig,
  crossBandFloorPpm,
  NATIVE_CURRENCY,
  stockPairCoverage,
} from "../src/rwa/index.js";
import * as root from "../src/index.js";

const NVDA_FEED_56 = stockFeedsFor(56).find((f) => f.ticker === "NVDA")!;
const NVDAB = stockTokensFor(56).find((t) => t.symbol === "NVDAB")!;
const BNB_USD = nativeFeedFor(56)!.chainlink!;
const STABLE = "0xffffffffffffffffffffffffffffffffffffffff" as const; // sorts after every token

describe("chainlinkScaledShareFeedConfig", () => {
  it("the rows it is built from are what the design says they are", () => {
    expect(NVDA_FEED_56.prices).toBe("underlying-share");
    expect(NVDAB.controls.uiMultiplier).toBe(true);
    expect(NVDAB.controls.rebasing).toBe(false);
    expect(NVDAB.decimals).toBe(18);
  });

  it("builds the ScaledFeed struct in the contract's declaration order, native quote", () => {
    const { config, bandFloorPpm: floor, refreshWithinSeconds, warnings } = chainlinkScaledShareFeedConfig({
      feed: NVDA_FEED_56,
      token: NVDAB,
      quoteToken: NATIVE_CURRENCY,
      quoteDecimals: 18,
      quoteFeed: BNB_USD,
    });
    expect(Object.keys(config)).toEqual([
      "shareAggregator",
      "shareHeartbeat",
      "quoteHeartbeat",
      "baseIsCurrency0",
      "baseDecimals",
      "quoteDecimals",
      "shareFeedDecimals",
      "quoteAggregator",
      "quoteFeedDecimals",
      "token",
    ]);
    expect(config.shareAggregator).toBe(NVDA_FEED_56.proxyAddress);
    expect(config.quoteAggregator).toBe(BNB_USD.proxyAddress);
    expect(config.token).toBe(NVDAB.address);
    expect(config.baseIsCurrency0).toBe(false); // native is address(0), always currency0
    expect(config.shareHeartbeat).toBe(NVDA_FEED_56.heartbeat);
    expect(config.quoteHeartbeat).toBe(BNB_USD.heartbeat);
    expect(config.shareFeedDecimals).toBe(NVDA_FEED_56.decimals);
    expect(config.quoteFeedDecimals).toBe(BNB_USD.decimals);
    expect(floor).toBe(crossBandFloorPpm(NVDA_FEED_56, BNB_USD));
    expect(refreshWithinSeconds).toBe(Math.min(NVDA_FEED_56.heartbeat, BNB_USD.heartbeat));
    expect(warnings.some((w) => /observeMultiplier/.test(w))).toBe(true);
    expect(warnings.some((w) => /trust root/.test(w))).toBe(true);
  });

  it("a dollar-stable quote has no quote leg", () => {
    const { config, bandFloorPpm: floor, refreshWithinSeconds } = chainlinkScaledShareFeedConfig({
      feed: NVDA_FEED_56,
      token: NVDAB,
      quoteToken: STABLE,
      quoteDecimals: 18,
    });
    expect(config.quoteAggregator).toBe(NATIVE_CURRENCY);
    expect(config.quoteHeartbeat).toBe(0);
    expect(config.quoteFeedDecimals).toBe(0);
    expect(config.baseIsCurrency0).toBe(true);
    expect(floor).toBe(bandFloorPpm(NVDA_FEED_56));
    expect(refreshWithinSeconds).toBe(NVDA_FEED_56.heartbeat);
  });

  it("refuses a native quote with no quote feed (it would price BNB at one dollar)", () => {
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: NVDA_FEED_56, token: NVDAB, quoteToken: NATIVE_CURRENCY, quoteDecimals: 18 }),
    ).toThrow(/not worth one dollar/);
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: NVDA_FEED_56, token: NVDAB, quoteToken: NATIVE_CURRENCY, quoteDecimals: 6, quoteFeed: BNB_USD }),
    ).toThrow(/18 decimals/);
  });

  it("refuses a feed that already prices the token, a token with no multiplier, a rebasing token and a ticker mismatch", () => {
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: { ...NVDA_FEED_56, prices: "tokenized-instrument" }, token: NVDAB, quoteToken: STABLE, quoteDecimals: 18 }),
    ).toThrow(/already prices the TOKEN/);
    expect(() =>
      chainlinkScaledShareFeedConfig({
        feed: NVDA_FEED_56,
        token: { ...NVDAB, controls: { ...NVDAB.controls, uiMultiplier: false } },
        quoteToken: STABLE,
        quoteDecimals: 18,
      }),
    ).toThrow(/no UI multiplier/);
    expect(() =>
      chainlinkScaledShareFeedConfig({
        feed: NVDA_FEED_56,
        token: { ...NVDAB, controls: { ...NVDAB.controls, rebasing: true } },
        quoteToken: STABLE,
        quoteDecimals: 18,
      }),
    ).toThrow(/rebases/);
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: NVDA_FEED_56, token: { ...NVDAB, ticker: "AAPL" }, quoteToken: STABLE, quoteDecimals: 18 }),
    ).toThrow(/feed prices NVDA/);
  });

  it("refuses what the contract refuses: decimals, heartbeats, the same aggregator twice", () => {
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: NVDA_FEED_56, token: { ...NVDAB, decimals: 19 }, quoteToken: STABLE, quoteDecimals: 18 }),
    ).toThrow(/InvalidDecimals/);
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: { ...NVDA_FEED_56, decimals: 19 }, token: NVDAB, quoteToken: STABLE, quoteDecimals: 18 }),
    ).toThrow(/InvalidFeedDecimals/);
    expect(() =>
      chainlinkScaledShareFeedConfig({ feed: { ...NVDA_FEED_56, heartbeat: 8 * 86_400 }, token: NVDAB, quoteToken: STABLE, quoteDecimals: 18 }),
    ).toThrow(/InvalidHeartbeat/);
    expect(() =>
      chainlinkScaledShareFeedConfig({
        feed: NVDA_FEED_56,
        token: NVDAB,
        quoteToken: NATIVE_CURRENCY,
        quoteDecimals: 18,
        quoteFeed: { ...BNB_USD, proxyAddress: NVDA_FEED_56.proxyAddress },
      }),
    ).toThrow(/SameAggregator/);
  });

  it("only the share leg is widened for the weekend", () => {
    const { config, warnings } = chainlinkScaledShareFeedConfig({
      feed: NVDA_FEED_56,
      token: NVDAB,
      quoteToken: NATIVE_CURRENCY,
      quoteDecimals: 18,
      quoteFeed: BNB_USD,
      weekendTolerant: true,
    });
    expect(config.shareHeartbeat).toBe(NVDA_FEED_56.heartbeat + 48 * 3600);
    expect(config.quoteHeartbeat).toBe(BNB_USD.heartbeat);
    expect(warnings.some((w) => /Friday/.test(w))).toBe(true);
  });

  it("is exported from the package root", () => {
    expect(root.chainlinkScaledShareFeedConfig).toBe(chainlinkScaledShareFeedConfig);
  });
});

describe("stockPairCoverage and the scaled-share adapter", () => {
  it("the address book names no scaled-share adapter on any chain yet, so nothing is reported pairable", () => {
    for (const id of GULLYCORE_CHAIN_IDS) {
      expect(getDeployment(id)!.rwa.chainlinkScaledSharePriceBandAdapter ?? null).toBeNull();
      expect(stockPairCoverage(id).pairableThroughScaledShare).toEqual([]);
    }
  });

  it("with an adapter named, every BNB share-priced ticker that has a bStock becomes pairable", () => {
    const c = stockPairCoverage(56, { scaledShareAdapter: "0x7878000000000000000000000000000000007878" });
    expect(c.pairableThroughScaledShare.length).toBeGreaterThan(0);
    expect(c.pairableThroughScaledShare).toContain("NVDA");
    expect(c.pairableThroughScaledShare).toEqual(c.bothButSharePriced); // every BNB token carries a multiplier
    // still not `both`: the conversion is a conversion
    expect(c.both).toEqual([]);
    for (const t of c.pairableThroughScaledShare) expect(c.bothButSharePriced).toContain(t);
  });

  it("a zero address or an explicit null is no adapter", () => {
    expect(stockPairCoverage(56, { scaledShareAdapter: NATIVE_CURRENCY }).pairableThroughScaledShare).toEqual([]);
    expect(stockPairCoverage(56, { scaledShareAdapter: null }).pairableThroughScaledShare).toEqual([]);
  });

  it("a share-priced ticker whose tokens carry no multiplier is never pairable through it", () => {
    for (const id of [1, 8453, 4663, 57073]) {
      const c = stockPairCoverage(id, { scaledShareAdapter: "0x7878000000000000000000000000000000007878" });
      for (const t of c.pairableThroughScaledShare) {
        const tokens = stockTokensFor(id).filter((s) => s.ticker.toUpperCase() === t && !s.controls.rebasing);
        expect(tokens.some((s) => s.controls.uiMultiplier), `${id} ${t}`).toBe(true);
      }
    }
  });
});
