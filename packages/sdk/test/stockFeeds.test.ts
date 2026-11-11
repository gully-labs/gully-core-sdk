// SPDX-License-Identifier: MIT
/* ============================================================================
   Guards on the GENERATED Chainlink equity-feed table.

   The generator reads the chain, so these tests cannot re-verify what it verified;
   what they can do is make the table's own claims consistent, and pin the facts a
   careless regeneration would quietly change — a chain losing all its feeds because
   a directory file moved, a rejected feed reappearing without its reason, an address
   that is not an address.

   The counts below are deliberately exact. A directory that grows is a diff somebody
   should read, not a number a test rounds off.
   ============================================================================ */

import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";

import {
  FUTURE_SKEW_SECONDS,
  HEAD_WALL_TOLERANCE_SECONDS,
  judgeRoundFreshness,
} from "../scripts/lib/feedFreshness.mjs";
import {
  STOCK_FEEDS,
  STOCK_FEED_CHAIN_IDS,
  STOCK_FEED_REJECTIONS,
  STOCK_FEED_SURVEY,
  STOCK_FEEDS_VERIFIED_AT,
  STOCK_FEEDS_VERIFIED_INSTANT,
  STOCK_FEEDS_VERIFIED_WEEKDAY,
  stockFeedByAddress,
  stockFeedRejectionsFor,
  stockFeedsFor,
  stockFeedsForTicker,
} from "../src/deployments/stockFeeds.js";

const ALL = Object.entries(STOCK_FEEDS).flatMap(([id, feeds]) => feeds.map((f) => ({ chainId: Number(id), f })));

describe("stock feed table — shape", () => {
  it("every address is a checksummed 20-byte address", () => {
    for (const { chainId, f } of ALL) {
      expect(isAddress(f.proxyAddress), `${chainId} ${f.ticker} ${f.proxyAddress}`).toBe(true);
      expect(f.proxyAddress).toBe(getAddress(f.proxyAddress));
      if (f.secondaryProxyAddress) {
        expect(isAddress(f.secondaryProxyAddress)).toBe(true);
        expect(f.secondaryProxyAddress).toBe(getAddress(f.secondaryProxyAddress));
        expect(f.secondaryProxyAddress.toLowerCase()).not.toBe(f.proxyAddress.toLowerCase());
      }
    }
  });

  it("no address appears twice on the same chain", () => {
    for (const chainId of STOCK_FEED_CHAIN_IDS) {
      const seen = new Set<string>();
      for (const f of stockFeedsFor(chainId)) {
        for (const a of [f.proxyAddress, f.secondaryProxyAddress].filter(Boolean) as string[]) {
          const k = a.toLowerCase();
          expect(seen.has(k), `${chainId} ${a} appears twice`).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  /* A ticker is what the UI prints and what `stockPairReadiness` joins on. An empty or
     lowercase one is a join that silently finds nothing. */
  it("every ticker is upper-case and non-empty, and the derivation rule is recorded", () => {
    for (const { f } of ALL) {
      expect(f.ticker).toMatch(/^[A-Z0-9.]{1,10}$/);
      expect(["verbatim", "ondo-suffix", "backed-wrapper", "rh-prefix"]).toContain(f.tickerRule);
      if (f.tickerRule === "verbatim") expect(f.ticker).toBe(f.baseAsset.toUpperCase());
      else expect(f.ticker.length).toBeLessThan(f.baseAsset.length);
    }
  });

  it("decimals and heartbeat are inside what ChainlinkPriceBandAdapter accepts", () => {
    for (const { chainId, f } of ALL) {
      expect(f.decimals, `${chainId} ${f.ticker}`).toBeGreaterThan(0);
      expect(f.decimals).toBeLessThanOrEqual(36); // MAX_DECIMALS
      expect(f.heartbeat).toBeGreaterThan(0);
      expect(f.heartbeat).toBeLessThanOrEqual(7 * 24 * 60 * 60); // MAX_HEARTBEAT
    }
  });

  it("every asset class is one the generator admits", () => {
    for (const { f } of ALL) expect(["Equity", "TokenizedEquities", "ETF"]).toContain(f.assetClass);
  });

  /* The whole point of reading the chain. A record whose `description` does not name its
     own asset is a record claiming to price something it does not. */
  it("every description names its base asset or its ticker", () => {
    for (const { chainId, f } of ALL) {
      const d = f.description.toUpperCase();
      const named = d.includes(f.baseAsset.toUpperCase()) || new RegExp(`(^|[^A-Z0-9])${f.ticker}([^A-Z0-9]|$)`).test(d);
      expect(named, `${chainId} ${f.ticker}: "${f.description}"`).toBe(true);
    }
  });

  it("every verified answer is positive", () => {
    for (const { f } of ALL) expect(BigInt(f.verifiedAnswer) > 0n).toBe(true);
  });
});

describe("stock feed table — provenance", () => {
  it("records the day, the instant and the weekday of the run", () => {
    expect(STOCK_FEEDS_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STOCK_FEEDS_VERIFIED_INSTANT.startsWith(STOCK_FEEDS_VERIFIED_AT)).toBe(true);
    expect(
      ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    ).toContain(STOCK_FEEDS_VERIFIED_WEEKDAY);
  });

  /* `freshAtVerification: false` is normal outside a session, so it must never be the
     silent default of a run that could not read anything. If a whole chain reads stale,
     the weekday has to explain it. */
  it("a stale row carries the age that makes it stale", () => {
    for (const { chainId, f } of ALL) {
      if (f.freshAtVerification) expect(f.verifiedAgeSeconds, `${chainId} ${f.ticker}`).toBeLessThanOrEqual(f.heartbeat);
      else expect(f.verifiedAgeSeconds, `${chainId} ${f.ticker}`).toBeGreaterThan(f.heartbeat);
    }
  });

  /* The reference clock is the chain head read beside the round, never the wall clock
     at process start (which under-reported every age by the run's elapsed time until
     2026-10-15). Recording the head is what makes the verdict reproducible from the row:
     a row that does not re-derive from its own head was written down unchecked. */
  it("every row re-derives from its own recorded head: not future, age as stated, head inside the wall tolerance", () => {
    for (const { chainId, f } of ALL) {
      const label = `${chainId} ${f.ticker}`;
      expect(f.verifiedHeadBlock, label).toBeGreaterThan(0);
      expect(f.verifiedHeadTimestamp, label).toBeGreaterThan(0);
      const v = judgeRoundFreshness({
        updatedAt: f.verifiedUpdatedAt,
        referenceTimestamp: f.verifiedHeadTimestamp,
        heartbeatSeconds: f.heartbeat,
      });
      // Equity policy: `future` and `noHeartbeat` reject, `stale` is recorded, so a shipped
      // row may be stale (a closed market) but is never ahead of its head or heartbeat-less.
      expect(v.future, `${label}: ${v.reasons.join("; ")}`).toBe(false);
      expect(v.noHeartbeat, label).toBe(false);
      expect(v.ageSeconds, label).toBe(f.verifiedAgeSeconds);
      expect(f.verifiedAgeSeconds, label).toBeGreaterThanOrEqual(-FUTURE_SKEW_SECONDS);
      expect(f.verifiedUpdatedAt + f.verifiedAgeSeconds, label).toBe(f.verifiedHeadTimestamp);
      // The generator refuses a head further than this from the wall clock, so a row
      // outside it was judged against a clock the rule does not allow.
      expect(Math.abs(f.verifiedHeadWallOffsetSeconds), `${label} head-wall`).toBeLessThanOrEqual(
        HEAD_WALL_TOLERANCE_SECONDS,
      );
    }
  });

  it("every chain's heads were read in one run, so they sit inside the run's own span", () => {
    // A head timestamp before the run started, or days after it, is a head from some
    // other run pasted in. One hour of slack covers a slow run and Ethereum's 12 s slots.
    const runStart = Math.floor(Date.parse(STOCK_FEEDS_VERIFIED_INSTANT) / 1000);
    for (const { chainId, f } of ALL) {
      expect(f.verifiedHeadTimestamp, `${chainId} ${f.ticker}`).toBeGreaterThanOrEqual(runStart - HEAD_WALL_TOLERANCE_SECONDS);
      expect(f.verifiedHeadTimestamp, `${chainId} ${f.ticker}`).toBeLessThanOrEqual(runStart + 3_600);
    }
  });

  it("the survey covers every chain with feeds, and counts agree with the table", () => {
    for (const chainId of STOCK_FEED_CHAIN_IDS) {
      const row = STOCK_FEED_SURVEY.find((r) => r.chainId === chainId);
      expect(row, `chain ${chainId} missing from the survey`).toBeDefined();
      expect(row!.verified).toBe(stockFeedsFor(chainId).length);
      expect(row!.rejected).toBe(stockFeedRejectionsFor(chainId).length);
      expect(row!.equityCandidates).toBe(row!.verified + row!.rejected);
    }
  });

  /* A chain with a directory file and no equity feed, and a chain nobody looked at, are
     different facts. The survey is the only place that distinguishes them. */
  it("records the chains that were surveyed and found empty", () => {
    for (const chainId of [59144, 196, 999, 143, 9745]) {
      const row = STOCK_FEED_SURVEY.find((r) => r.chainId === chainId);
      expect(row, `chain ${chainId} must be in the survey even with no feeds`).toBeDefined();
      expect(row!.directoryStatus).toBe(200);
      expect(row!.equityCandidates).toBe(0);
      expect(stockFeedsFor(chainId)).toHaveLength(0);
    }
  });

  it("a rejected address is never also a shipped feed", () => {
    for (const [id, rejections] of Object.entries(STOCK_FEED_REJECTIONS)) {
      const chainId = Number(id);
      for (const r of rejections) {
        expect(r.reason.length, `${chainId} ${r.ticker} rejected with no reason`).toBeGreaterThan(10);
        const shipped = stockFeedsFor(chainId).some((f) => f.proxyAddress.toLowerCase() === r.proxyAddress.toLowerCase());
        expect(shipped, `${chainId} ${r.proxyAddress} is both shipped and rejected`).toBe(false);
      }
    }
  });
});

describe("stock feed table — the facts, pinned", () => {
  /* Robinhood Chain having a Chainlink directory at all was the finding that started
     this table: the brief said there was none. If a regeneration ever drops it back to
     zero, that is a directory move to investigate, not a silent loss. */
  it("Robinhood Chain (4663) carries equity feeds", () => {
    expect(stockFeedsFor(4663).length).toBe(33);
    expect(stockFeedsForTicker(4663, "nvda")).toHaveLength(1);
    expect(stockFeedsForTicker(4663, "NVDA")[0]!.proxyAddress).toBe("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15");
  });

  it("the other chains carry what was verified", () => {
    expect(stockFeedsFor(56).length).toBe(16);
    expect(stockFeedsFor(8453).length).toBe(13);
    expect(stockFeedsFor(57073).length).toBe(3);
    expect(stockFeedsFor(1).length).toBe(24);
  });

  /* Ink files the same instrument under a class the brief's filter did not include.
     Finding it cost a re-read of the directory; losing it again should cost a test. */
  it("Ink's feeds are classed TokenizedEquities, not Equity", () => {
    const ink = stockFeedsFor(57073);
    expect(ink.map((f) => f.assetClass)).toEqual(["TokenizedEquities", "TokenizedEquities", "TokenizedEquities"]);
    expect(ink.map((f) => f.ticker).sort()).toEqual(["NVDA", "QQQ", "SPY"]);
    expect(ink.every((f) => f.tickerRule === "backed-wrapper")).toBe(true);
  });

  it("the three deprecating LSE feeds on Ethereum are rejected, with a reason", () => {
    const rejected = stockFeedRejectionsFor(1);
    expect(rejected.map((r) => r.ticker).sort()).toEqual(["CSPX", "IB01", "IBTA"]);
    for (const r of rejected) expect(r.reason).toContain("reverted");
  });
});

describe("stock feed lookups", () => {
  it("finds a feed by either published proxy", () => {
    const f = stockFeedsForTicker(4663, "NVDA")[0]!;
    expect(stockFeedByAddress(4663, f.proxyAddress)).toBe(f);
    expect(stockFeedByAddress(4663, f.proxyAddress.toLowerCase())).toBe(f);
    if (f.secondaryProxyAddress) expect(stockFeedByAddress(4663, f.secondaryProxyAddress)).toBe(f);
  });

  it("returns empty, never undefined, for a chain or ticker with nothing", () => {
    expect(stockFeedsFor(999)).toEqual([]);
    expect(stockFeedsForTicker(4663, "NOTATICKER")).toEqual([]);
    expect(stockFeedRejectionsFor(4663)).toEqual([]);
    expect(stockFeedByAddress(4663, "0x0000000000000000000000000000000000000001")).toBeUndefined();
  });

  /* Ethereum publishes two aggregators for several Ondo tickers. Returning one of them
     would be picking between them, which is a deployment decision. */
  it("returns every aggregator for a ticker that has more than one", () => {
    const tsla = stockFeedsForTicker(1, "TSLA");
    expect(tsla.length).toBeGreaterThan(1);
    expect(new Set(tsla.map((f) => f.proxyAddress)).size).toBe(tsla.length);
  });
});
