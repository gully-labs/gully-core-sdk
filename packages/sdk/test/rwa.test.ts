// SPDX-License-Identifier: MIT
/* ============================================================================
   Guards on the RWA wiring: Chainlink's session profile -> the hook's schedule, and
   a verified feed -> the two `configureX` calls.

   The session tests do not assert the three numbers. Numbers are what a reviewer
   cannot check. They reimplement `MarketHoursModule._sessionOpen` exactly — the
   wrapping-window branch and the previous-day branch included — and then ask it about
   real instants: is this pool open at Friday 19:59 in New York, and shut at 20:01?
   That is the question the configuration exists to answer, and it is the one a wrong
   daylight-saving phase or an inverted wrap gets wrong.
   ============================================================================ */

import { describe, expect, it } from "vitest";

import {
  bandFloorPpm,
  baseIsCurrency0For,
  chainlinkFeedConfig,
  dayIndexOf,
  daylightPhaseFor,
  holidayRecipe,
  isKnownMarketHoursProfile,
  KNOWN_MARKET_HOURS_PROFILES,
  marketSessionFor,
  marketSettingsFor,
  nextSessionChange,
  stockPairCoverage,
  stockPairReadiness,
  ukIsDaylight,
  usEasternIsDaylight,
  weekdayOf,
  WEEKDAYS_MON_FRI,
  type MarketSession,
} from "../src/rwa/index.js";
import { stockFeedsFor, stockFeedsForTicker } from "../src/deployments/stockFeeds.js";
import { nativeFeedFor } from "../src/deployments/nativeFeeds.js";
import { chainlinkCrossFeedConfig, crossBandFloorPpm, NATIVE_CURRENCY } from "../src/rwa/bandOracle.js";

/* ------------------------------------------------------------------------ */
/* `MarketHoursModule._sessionOpen`, reimplemented from the Solidity.         */
/* ------------------------------------------------------------------------ */

function scheduleForDay(s: MarketSession, dayIndex: number) {
  const weekday = (dayIndex + 4) % 7;
  if ((s.weekdayMask & (1 << weekday)) === 0) return null;
  return { open: s.openSecondOfDay, close: s.closeSecondOfDay };
}

/** The contract's algorithm, branch for branch. No holidays: those are the issuer's. */
function sessionOpenAt(s: MarketSession, whenUtc: Date): boolean {
  const ts = Math.floor(whenUtc.getTime() / 1000);
  const dayIndex = Math.floor(ts / 86400);
  const sec = ts % 86400;

  const today = scheduleForDay(s, dayIndex);
  if (today && today.open !== today.close) {
    if (today.open < today.close) {
      if (sec >= today.open && sec < today.close) return true;
    } else if (sec >= today.open) {
      return true; // wrapping session, opened today, still running
    }
  }
  const yesterday = scheduleForDay(s, dayIndex - 1);
  if (yesterday && yesterday.open > yesterday.close && sec < yesterday.close) return true;
  return false;
}

/** A UTC instant from a New York wall-clock time, given the phase's offset. */
function fromEastern(s: MarketSession, iso: string): Date {
  return new Date(Date.parse(`${iso}Z`) - s.utcOffsetSeconds * 1000);
}

/* ------------------------------------------------------------------------ */

describe("daylight-saving rules", () => {
  /* Computed from the statute, not tabulated, so these dates are a check on the
     computation rather than a copy of it. */
  it("US Eastern: second Sunday in March to first Sunday in November", () => {
    expect(usEasternIsDaylight(new Date("2026-03-08T06:59:00Z"))).toBe(false);
    expect(usEasternIsDaylight(new Date("2026-03-08T07:00:00Z"))).toBe(true);
    expect(usEasternIsDaylight(new Date("2026-11-01T05:59:00Z"))).toBe(true);
    expect(usEasternIsDaylight(new Date("2026-11-01T06:00:00Z"))).toBe(false);
    // 2027's second Sunday is the 14th, a week later — a tabulated rule would be wrong.
    expect(usEasternIsDaylight(new Date("2027-03-08T12:00:00Z"))).toBe(false);
    expect(usEasternIsDaylight(new Date("2027-03-14T12:00:00Z"))).toBe(true);
  });

  it("UK: last Sunday in March to last Sunday in October, both at 01:00 UTC", () => {
    expect(ukIsDaylight(new Date("2026-03-29T00:59:00Z"))).toBe(false);
    expect(ukIsDaylight(new Date("2026-03-29T01:00:00Z"))).toBe(true);
    expect(ukIsDaylight(new Date("2026-10-25T00:59:00Z"))).toBe(true);
    expect(ukIsDaylight(new Date("2026-10-25T01:00:00Z"))).toBe(false);
  });

  it("picks the phase per exchange, not per calendar", () => {
    // Between 25 and 29 March 2026 the UK is on GMT and New York is already on EDT.
    const between = new Date("2026-03-20T12:00:00Z");
    expect(daylightPhaseFor("us_equities_24/5", between)).toBe("daylight");
    expect(daylightPhaseFor("LSE", between)).toBe("standard");
  });

  it("nextSessionChange lands on the boundary hour and names both phases", () => {
    const next = nextSessionChange("NYSE", new Date("2026-09-20T00:00:00Z"))!;
    expect(next.from).toBe("daylight");
    expect(next.to).toBe("standard");
    expect(next.at.toISOString().slice(0, 10)).toBe("2026-11-01");
  });
});

describe("us_equities_24/5 -> the module's weekly schedule", () => {
  for (const phase of ["standard", "daylight"] as const) {
    describe(phase, () => {
      const s = marketSessionFor("us_equities_24/5", phase);

      /* Chainlink's own schedule: weekend is Fri 20:00 - Sun 20:00 Eastern. The whole
         point of two phases is that these four instants stay put in New York. */
      it("closes at Friday 20:00 Eastern and opens at Sunday 20:00 Eastern", () => {
        expect(sessionOpenAt(s, fromEastern(s, "2026-09-18T19:59:58"))).toBe(true);
        expect(sessionOpenAt(s, fromEastern(s, "2026-09-18T20:00:00"))).toBe(false);
        expect(sessionOpenAt(s, fromEastern(s, "2026-09-19T12:00:00"))).toBe(false); // Saturday
        expect(sessionOpenAt(s, fromEastern(s, "2026-09-20T19:59:00"))).toBe(false); // Sunday, before the open
        expect(sessionOpenAt(s, fromEastern(s, "2026-09-20T20:00:00"))).toBe(true); // Sunday open
        expect(sessionOpenAt(s, fromEastern(s, "2026-09-22T03:00:00"))).toBe(true); // Tuesday overnight
      });

      /* The encoding's one artefact, asserted rather than left to be discovered: the
         module refuses open == close, so a 24-hour day is one second short. */
      it("shuts for exactly one second a day, at the daily rollover", () => {
        expect(s.gapSeconds).toBe(1);
        const gap = new Date(Date.UTC(2026, 8, 22, 0, 0, 0) + s.gapAtSecondOfDay! * 1000);
        expect(sessionOpenAt(s, gap)).toBe(false);
        expect(sessionOpenAt(s, new Date(gap.getTime() - 1000))).toBe(true);
        expect(sessionOpenAt(s, new Date(gap.getTime() + 1000))).toBe(true);
        // and it is 19:59:59 in New York, i.e. the daily rollover, not an arbitrary time
        expect(new Date(gap.getTime() + s.utcOffsetSeconds * 1000).toISOString()).toContain("19:59:59");
      });

      it("is open for all but one second of every weekday", () => {
        let open = 0;
        const start = Date.UTC(2026, 8, 22); // a Tuesday
        for (let i = 0; i < 86400; i++) if (sessionOpenAt(s, new Date(start + i * 1000))) open++;
        expect(open).toBe(86399);
      });
    });
  }

  it("the two phases differ by exactly the daylight-saving hour", () => {
    const std = marketSessionFor("us_equities_24/5", "standard");
    const dst = marketSessionFor("us_equities_24/5", "daylight");
    expect(std.wraps).toBe(true);
    expect(dst.wraps).toBe(false);
    expect(std.openSecondOfDay - dst.openSecondOfDay).toBe(3600);
    expect(std.utcOffsetSeconds - dst.utcOffsetSeconds).toBe(-3600);
  });
});

describe("NYSE -> the module's weekly schedule", () => {
  for (const phase of ["standard", "daylight"] as const) {
    it(`opens 09:30 and closes 16:00 New York (${phase})`, () => {
      const s = marketSessionFor("NYSE", phase);
      expect(s.wraps).toBe(false);
      expect(s.gapSeconds).toBe(0);
      expect(sessionOpenAt(s, fromEastern(s, "2026-09-22T09:29:59"))).toBe(false);
      expect(sessionOpenAt(s, fromEastern(s, "2026-09-22T09:30:00"))).toBe(true);
      expect(sessionOpenAt(s, fromEastern(s, "2026-09-22T15:59:59"))).toBe(true);
      expect(sessionOpenAt(s, fromEastern(s, "2026-09-22T16:00:00"))).toBe(false);
      expect(sessionOpenAt(s, fromEastern(s, "2026-09-19T12:00:00"))).toBe(false); // Saturday
    });
  }
});

describe("profiles", () => {
  it("every profile known to the mapping is Monday to Friday", () => {
    for (const p of KNOWN_MARKET_HOURS_PROFILES) {
      const s = marketSessionFor(p, "standard");
      expect(s.weekdayMask).toBe(WEEKDAYS_MON_FRI);
      for (const d of [1, 2, 3, 4, 5]) expect(s.weekdayMask & (1 << d)).not.toBe(0);
      for (const d of [0, 6]) expect(s.weekdayMask & (1 << d)).toBe(0);
      expect(s.weekdayMask & ~0x7f).toBe(0); // the module refuses bit 7
      expect(s.openSecondOfDay).toBeLessThan(86400);
      expect(s.closeSecondOfDay).toBeLessThan(86400);
      expect(s.openSecondOfDay).not.toBe(s.closeSecondOfDay); // InvalidSessionWindow
    }
  });

  /* Chainlink can publish a profile this SDK has never met. Guessing a schedule for it
     would configure somebody's pool to trade at hours nobody checked. */
  it("refuses an unknown profile instead of guessing one", () => {
    expect(isKnownMarketHoursProfile("us_equities_24/5")).toBe(true);
    expect(isKnownMarketHoursProfile("Precious_Metals")).toBe(false);
    expect(() => marketSessionFor("Precious_Metals", "standard")).toThrow(/unknown market-hours profile/);
  });

  it("dayIndexOf and weekdayOf match the module's arithmetic", () => {
    // 1970-01-01 was a Thursday, and the module's weekday is (dayIndex + 4) % 7.
    expect(dayIndexOf(0)).toBe(0);
    expect(weekdayOf(0)).toBe(4);
    expect(weekdayOf(dayIndexOf(new Date("2026-09-20T12:00:00Z")))).toBe(0); // a Sunday
    expect(weekdayOf(dayIndexOf(new Date("2026-09-18T23:59:59Z")))).toBe(5); // a Friday
  });
});

describe("holidays", () => {
  /* The module's documented attribution rule: an override on day D stops a session
     OPENING on D and does nothing to one that opened on D-1 and is still running. */
  it("a wrapping schedule needs two calls to shut a whole UTC day", () => {
    const s = marketSessionFor("us_equities_24/5", "standard");
    const r = holidayRecipe(s, new Date("2026-11-26T12:00:00Z"));
    expect(r.setHolidays).toHaveLength(1);
    expect(r.setSpecialSessions).toHaveLength(1);
    expect(r.setSpecialSessions[0]!.dayIndex).toBe(r.setHolidays[0]! - 1);
    expect(r.note).toContain("still runs into D");
  });

  it("a non-wrapping schedule needs one", () => {
    const r = holidayRecipe(marketSessionFor("NYSE", "standard"), new Date("2026-11-26T12:00:00Z"));
    expect(r.setHolidays).toHaveLength(1);
    expect(r.setSpecialSessions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */

const NVDA_4663 = stockFeedsForTicker(4663, "NVDA")[0]!;
const ISSUER = "0x1111111111111111111111111111111111111111" as const;
const ADAPTER = "0x2222222222222222222222222222222222222222" as const;

describe("configureFeed arguments", () => {
  /* A PoolKey sorts its currencies, so this is decidable and must never be asserted by
     hand — the adapter's own comment calls it the field that inverts the band. */
  it("derives baseIsCurrency0 from the pool's currency ordering", () => {
    const low = "0x0000000000000000000000000000000000000aaa" as const;
    const high = "0x0000000000000000000000000000000000000bbb" as const;
    expect(baseIsCurrency0For(low, high)).toBe(true);
    expect(baseIsCurrency0For(high, low)).toBe(false);
    // case must not decide it
    expect(baseIsCurrency0For(low.toUpperCase() as typeof low, high)).toBe(true);
    expect(() => baseIsCurrency0For(low, low)).toThrow(/cannot pair/);
  });

  it("builds the Feed struct from a verified record", () => {
    const { config } = chainlinkFeedConfig({
      feed: NVDA_4663,
      baseToken: "0x0000000000000000000000000000000000000aaa",
      quoteToken: "0x0000000000000000000000000000000000000bbb",
      baseDecimals: 18,
      quoteDecimals: 6,
    });
    expect(config.aggregator).toBe(NVDA_4663.proxyAddress);
    expect(config.feedDecimals).toBe(NVDA_4663.decimals);
    expect(config.heartbeat).toBe(NVDA_4663.heartbeat);
    expect(config.baseIsCurrency0).toBe(true);
  });

  it("refuses decimals and heartbeats configureFeed would refuse", () => {
    const base = {
      feed: NVDA_4663,
      baseToken: "0x0000000000000000000000000000000000000aaa" as const,
      quoteToken: "0x0000000000000000000000000000000000000bbb" as const,
      quoteDecimals: 6,
    };
    expect(() => chainlinkFeedConfig({ ...base, baseDecimals: 37 })).toThrow(/InvalidDecimals/);
    expect(() => chainlinkFeedConfig({ ...base, baseDecimals: -1 })).toThrow(/InvalidDecimals/);
  });

  /* The weekend trade-off, made explicit in both directions. */
  it("warns about the weekend at the feed's own heartbeat, and warns harder when widened", () => {
    const base = {
      feed: NVDA_4663,
      baseToken: "0x0000000000000000000000000000000000000aaa" as const,
      quoteToken: "0x0000000000000000000000000000000000000bbb" as const,
      baseDecimals: 18,
      quoteDecimals: 6,
    };
    const tight = chainlinkFeedConfig(base);
    expect(tight.warnings.join(" ")).toContain("AnswerTooOld");

    const loose = chainlinkFeedConfig({ ...base, weekendTolerant: true });
    expect(loose.config.heartbeat).toBe(NVDA_4663.heartbeat + 48 * 3600);
    expect(loose.config.heartbeat).toBeLessThanOrEqual(7 * 24 * 3600); // MAX_HEARTBEAT
    expect(loose.warnings.join(" ")).toMatch(/invalidated/);
  });

  it("records which proxy was chosen when the directory publishes two", () => {
    const r = chainlinkFeedConfig({
      feed: NVDA_4663,
      baseToken: "0x0000000000000000000000000000000000000aaa",
      quoteToken: "0x0000000000000000000000000000000000000bbb",
      baseDecimals: 18,
      quoteDecimals: 6,
    });
    expect(r.aggregatorNote).toContain(NVDA_4663.proxyAddress);
    if (NVDA_4663.secondaryProxyAddress) expect(r.aggregatorNote).toContain(NVDA_4663.secondaryProxyAddress);
  });
});

describe("configureMarket arguments", () => {
  it("the band floor is the feed's own deviation threshold", () => {
    expect(NVDA_4663.thresholdPercent).toBe(0.5);
    expect(bandFloorPpm(NVDA_4663)).toBe(5000);
  });

  /* Nothing on chain refuses a band under the threshold. It just halts the pool for a
     reason no operator will diagnose, which is exactly the kind of failure that belongs
     in a refusal rather than a comment. */
  it("refuses a band narrower than the threshold, and explains why", () => {
    const opts = { feed: NVDA_4663, issuer: ISSUER, oracle: ADAPTER, phase: "standard" as const };
    expect(() => marketSettingsFor({ ...opts, maxUpPpm: 3000, maxDownPpm: 3000 })).toThrow(/deviation threshold/);
    const ok = marketSettingsFor({ ...opts, maxUpPpm: 20000, maxDownPpm: 20000 });
    expect(ok.settings.maxUpPpm).toBe(20000);
    expect(ok.bandFloorPpm).toBe(5000);
  });

  it("refuses the zero issuer and a band the module would refuse", () => {
    const opts = { feed: NVDA_4663, oracle: ADAPTER, phase: "standard" as const, maxUpPpm: 20000, maxDownPpm: 20000 };
    expect(() => marketSettingsFor({ ...opts, issuer: "0x0000000000000000000000000000000000000000" })).toThrow(/MarketZeroAddress/);
    expect(() => marketSettingsFor({ ...opts, issuer: ISSUER, maxDownPpm: 1_000_001 })).toThrow(/InvalidBandWidth/);
  });

  it("carries the session, the defaults and the caveats a runbook needs", () => {
    const r = marketSettingsFor({
      feed: NVDA_4663,
      issuer: ISSUER,
      oracle: ADAPTER,
      maxUpPpm: 50000,
      maxDownPpm: 50000,
      phase: new Date("2026-09-20T00:00:00Z"),
    });
    expect(r.settings.sessionEnabled).toBe(true);
    expect(r.settings.bandEnabled).toBe(true);
    expect(r.settings.gateLiquidity).toBe(true); // a pool must not take liquidity while its price source is shut
    expect(r.settings.maxPriceAge).toBe(NVDA_4663.heartbeat);
    expect(r.session.phase).toBe("daylight"); // 20 September is inside US daylight time
    expect(r.warnings.join(" ")).toContain("holidays are NOT in this configuration");
    expect(r.warnings.join(" ")).toContain("setSessionHours");
  });
});

describe("the join between feeds and tokens", () => {
  /* The two tables are about different things and on most chains only one of them has
     the ticker. That gap is the report, not a bug to hide. */
  it("Robinhood NVDA has both halves", () => {
    const r = stockPairReadiness(4663, "NVDA");
    expect(r.feeds).toHaveLength(1);
    expect(r.tokens.length).toBeGreaterThan(0);
    expect(r.blockers).not.toContain("no-feed");
    expect(r.blockers).not.toContain("no-token");
  });

  it("Ink has both halves, and only the non-rebasing wrapper counts", () => {
    const r = stockPairReadiness(57073, "NVDA");
    expect(r.feeds).toHaveLength(1);
    expect(r.feeds[0]!.prices).toBe("tokenized-instrument");
    expect(r.tokens.map((t) => t.symbol)).toEqual(["wNVDAx"]);
    expect(r.blockers).not.toContain("no-token");
  });

  it("a feed with no token in the address book says so", () => {
    const r = stockPairReadiness(1, "SHV"); // an Ethereum ETF feed with no token sourced
    expect(r.feeds.length).toBeGreaterThan(0);
    expect(r.tokens).toHaveLength(0);
    expect(r.blockers).toContain("no-token");
    expect(r.notes.join(" ")).toContain("issuer's own source");
  });

  /* Base lists CRCL only as a Dinari dShare, whose `balanceOf` the issuer rescales. A
     feed exists; a pool must still not. */
  it("a ticker whose only token rebases reports no usable token and names it", () => {
    const r = stockPairReadiness(8453, "CRCL");
    expect(r.feeds.length).toBeGreaterThan(0);
    expect(r.tokens).toHaveLength(0);
    expect(r.rebasingTokens.length).toBeGreaterThan(0);
    expect(r.blockers).toContain("no-token");
    expect(r.notes.join(" ")).toContain("REBASING");
  });

  /* The hazard with both halves present. Every BNB Chain equity feed prices the share;
     the tokens listed there are UI-multiplier bStocks. Nothing on chain reports the gap. */
  it("refuses to call a share-priced feed a match for an issuer token", () => {
    for (const [chainId, ticker] of [
      [56, "NVDA"],
      [1, "NVDA"],
    ] as const) {
      const r = stockPairReadiness(chainId, ticker);
      expect(r.feeds.every((f) => f.prices === "underlying-share")).toBe(true);
      expect(r.tokens.length).toBeGreaterThan(0);
      expect(r.blockers).toContain("feed-prices-the-underlying-share");
      expect(r.notes.join(" ")).toContain("UNDERLYING SHARE");
    }
    // and the coverage summary keeps them out of `both`
    expect(stockPairCoverage(56).both).toEqual([]);
    expect(stockPairCoverage(56).bothButSharePriced).toContain("NVDA");
    expect(stockPairCoverage(1).bothButSharePriced).toEqual(["GOOGL", "NVDA", "SPCX"]);
  });

  it("a ticker with neither half reports both", () => {
    const r = stockPairReadiness(143, "NVDA"); // Monad: no equity feed, no stock token
    expect(r.blockers).toEqual(expect.arrayContaining(["no-feed", "no-token"]));
  });

  /* A rebasing balance breaks the Vault's amount-based reserve accounting, so it can
     never be a pool currency however good its feed is. */
  it("never counts a rebasing token as a usable half", () => {
    for (const chainId of [1, 56, 8453, 4663, 57073, 999]) {
      const c = stockPairCoverage(chainId);
      for (const t of c.both) {
        const r = stockPairReadiness(chainId, t);
        expect(r.tokens.every((s) => !s.controls.rebasing)).toBe(true);
      }
    }
  });

  /* `both`, `bothButSharePriced` and `feedOnly` must partition the chain's feed tickers
     exactly. A ticker counted twice, or dropped, is a coverage number that overstates or
     understates what can be built — which is the only thing this summary is for. */
  it("coverage partitions every feed ticker exactly once", () => {
    for (const chainId of [1, 56, 8453, 4663, 57073]) {
      const c = stockPairCoverage(chainId);
      const feedTickers = new Set(stockFeedsFor(chainId).map((f) => f.ticker));
      const partition = [...c.both, ...c.bothButSharePriced, ...c.feedOnly];
      expect(new Set(partition).size, `chain ${chainId} double-counts a ticker`).toBe(partition.length);
      expect(new Set(partition)).toEqual(feedTickers);
      for (const t of c.tokenOnly) expect(feedTickers.has(t)).toBe(false);
    }
  });
});

/* A stock paired with the NATIVE currency. The one-feed adapter treats the quote as one dollar,
   so its builder must refuse a native quote, and the two-feed builder must produce the
   `ChainlinkCrossPriceBandAdapter.CrossFeed` struct from two verified records. */
describe("a stock pool quoted in the native currency", () => {
  const STOCK = "0x0000000000000000000000000000000000000aaa" as const;
  const ETH_USD_4663 = nativeFeedFor(4663)!.chainlink!;

  it("the one-feed builder refuses a native quote instead of emitting a config wrong by the ETH price", () => {
    expect(() =>
      chainlinkFeedConfig({ feed: NVDA_4663, baseToken: STOCK, quoteToken: NATIVE_CURRENCY, baseDecimals: 18, quoteDecimals: 18 }),
    ).toThrow(/native currency.*chainlinkCrossFeedConfig/s);
  });

  it("builds the CrossFeed struct, in the contract's declaration order, from two verified records", () => {
    const { config, bandFloorPpm, refreshWithinSeconds, warnings } = chainlinkCrossFeedConfig({
      feed: NVDA_4663,
      quoteFeed: ETH_USD_4663,
      baseToken: STOCK,
      quoteToken: NATIVE_CURRENCY,
      baseDecimals: 18,
      quoteDecimals: 18,
    });
    expect(Object.keys(config)).toEqual([
      "quoteAggregator",
      "baseHeartbeat",
      "quoteHeartbeat",
      "baseIsCurrency0",
      "baseDecimals",
      "quoteDecimals",
      "baseFeedDecimals",
      "baseAggregator",
      "quoteFeedDecimals",
    ]);
    expect(config.baseAggregator).toBe(NVDA_4663.proxyAddress);
    expect(config.quoteAggregator).toBe(ETH_USD_4663.proxyAddress);
    expect(config.baseFeedDecimals).toBe(NVDA_4663.decimals);
    expect(config.quoteFeedDecimals).toBe(ETH_USD_4663.decimals);
    expect(config.baseHeartbeat).toBe(NVDA_4663.heartbeat);
    expect(config.quoteHeartbeat).toBe(ETH_USD_4663.heartbeat);
    // The native currency is address(0) and always currency0, so the stock is currency1.
    expect(config.baseIsCurrency0).toBe(false);
    expect(refreshWithinSeconds).toBe(Math.min(NVDA_4663.heartbeat, ETH_USD_4663.heartbeat));
    expect(bandFloorPpm).toBe(crossBandFloorPpm(NVDA_4663, ETH_USD_4663));
    expect(warnings.some((w) => /around the clock/.test(w))).toBe(true);
  });

  it("the band floor is the SUM of the two feeds' thresholds, and unknown when either is unpublished", () => {
    const sum = crossBandFloorPpm(NVDA_4663, ETH_USD_4663);
    if (NVDA_4663.thresholdPercent !== null && ETH_USD_4663.thresholdPercent !== null) {
      expect(sum).toBe(Math.ceil(((NVDA_4663.thresholdPercent + ETH_USD_4663.thresholdPercent) / 100) * 1_000_000));
      expect(sum!).toBeGreaterThan(bandFloorPpm(NVDA_4663)!);
    } else {
      expect(sum).toBeNull();
    }
    expect(crossBandFloorPpm({ ...NVDA_4663, thresholdPercent: null }, ETH_USD_4663)).toBeNull();
    expect(crossBandFloorPpm(NVDA_4663, { ...ETH_USD_4663, thresholdPercent: null })).toBeNull();
  });

  it("only the stock leg is widened for the weekend", () => {
    const { config } = chainlinkCrossFeedConfig({
      feed: NVDA_4663,
      quoteFeed: ETH_USD_4663,
      baseToken: STOCK,
      quoteToken: NATIVE_CURRENCY,
      baseDecimals: 18,
      quoteDecimals: 18,
      weekendTolerant: true,
    });
    expect(config.baseHeartbeat).toBe(NVDA_4663.heartbeat + 48 * 60 * 60);
    expect(config.quoteHeartbeat).toBe(ETH_USD_4663.heartbeat);
  });

  it("refuses what configureFeed would refuse", () => {
    const base = { feed: NVDA_4663, quoteFeed: ETH_USD_4663, baseToken: STOCK, quoteToken: NATIVE_CURRENCY, baseDecimals: 18, quoteDecimals: 18 } as const;
    expect(() => chainlinkCrossFeedConfig({ ...base, baseDecimals: 19 })).toThrow(/InvalidDecimals/);
    expect(() => chainlinkCrossFeedConfig({ ...base, quoteDecimals: 6 })).toThrow(/18 decimals/);
    expect(() => chainlinkCrossFeedConfig({ ...base, feed: { ...NVDA_4663, decimals: 19 } })).toThrow(/InvalidFeedDecimals/);
    expect(() => chainlinkCrossFeedConfig({ ...base, quoteFeed: { ...ETH_USD_4663, heartbeat: 8 * 24 * 60 * 60 } })).toThrow(/InvalidHeartbeat/);
    expect(() => chainlinkCrossFeedConfig({ ...base, quoteFeed: { ...ETH_USD_4663, proxyAddress: NVDA_4663.proxyAddress } })).toThrow(/SameAggregator/);
  });
});
