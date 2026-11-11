// SPDX-License-Identifier: MIT
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import * as premiumModule from "../src/stocks/premium.js";
import {
  executablePrices,
  feedSessionLive,
  lastFeedSessionEnd,
  onchainPrice,
  premium,
  premiumSubjectFor,
  premiumSubjects,
  referenceFromReads,
  usEquitySession,
  type FeedRoundRead,
  type PremiumQuoteFn,
  type PremiumUsdLeg,
} from "../src/stocks/premium.js";

/* Recorded fixtures. Token and feed rows are the SDK's own verified tables; the rounds and
   quotes below are fixtures (test-only), shaped like the reads `referencePrice` and the
   router make. */
const RH_NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // Robinhood NVDA, 4663
const CB_NVDA = "0xb20000000000000000000078ee7ce2fE4908108C"; // Coinbase NVDAc, 8453
const BNB_NVDA = "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436"; // Binance NVDAB, 56
const BNB_HIMS = "0xee6F4bcc88C2C8583d5a65c7D0C877b464100711"; // Binance HIMSB, 56
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** Thursday 2026-10-15 14:00 New York (EDT): regular session. */
const THU_OPEN = at("2026-10-15T18:00:00Z");
/** Saturday 2026-10-17 12:00 UTC: weekend. */
const SAT = at("2026-10-17T12:00:00Z");
/** Thanksgiving 2026-11-26 10:00 New York (EST). */
const THANKSGIVING = at("2026-11-26T15:00:00Z");

const round = (price: number, updatedAt: number, decimals = 8): FeedRoundRead => ({
  roundId: 18446744073709600000n,
  answer: BigInt(Math.round(price * 10 ** decimals)),
  startedAt: BigInt(updatedAt),
  updatedAt: BigInt(updatedAt),
  decimals,
  blockNumber: 1_000_000n,
});
const ONE = 10n ** 18n;
const mult = (m: number) => ({ value: BigInt(Math.round(m * 1e12)) * 1_000_000n, blockNumber: 1_000_000n });

const leg = (usd = 1, assumed = false): PremiumUsdLeg => ({
  token: USDG,
  symbol: "USDG",
  decimals: 6,
  usd,
  assumed,
  source: "chainlink:0x61B7e5650328764b076a108eff5fa7282a1b9ad2@1",
  sourceText: "Chainlink USDG / USD",
  at: THU_OPEN,
});

/** A router fixture: the token trades at `buyPx` on the way in and `sellPx` on the way out (dollars, 18-decimal token, 6-decimal stable). */
function router(buyPx: number, sellPx: number): PremiumQuoteFn {
  return async ({ tokenIn, amountIn }) => {
    if (tokenIn === USDG) {
      const dollars = Number(amountIn) / 1e6;
      return { amountIn, amountOut: BigInt(Math.round((dollars / buyPx) * 1e12)) * 1_000_000n, venue: "UNISWAP_V3", blockNumber: 42n };
    }
    const tokens = Number(amountIn / 1_000_000n) / 1e12;
    return { amountIn, amountOut: BigInt(Math.round(tokens * sellPx * 1e6)), venue: "UNISWAP_V3", blockNumber: 42n };
  };
}

describe("the US equity clock", () => {
  it("names the session from New York time and the published calendar", () => {
    expect(usEquitySession(THU_OPEN).state).toBe("open");
    expect(usEquitySession(at("2026-10-15T12:00:00Z")).state).toBe("pre"); // 08:00 ET
    expect(usEquitySession(at("2026-10-15T21:00:00Z")).state).toBe("after"); // 17:00 ET
    expect(usEquitySession(at("2026-10-16T02:00:00Z")).state).toBe("overnight"); // Thu 22:00 ET
    expect(usEquitySession(at("2026-10-17T01:00:00Z")).state).toBe("closed"); // Fri 21:00 ET
    expect(usEquitySession(SAT).state).toBe("closed");
    expect(usEquitySession(at("2026-10-19T00:30:00Z")).state).toBe("overnight"); // Sun 20:30 ET
    const t = usEquitySession(THANKSGIVING);
    expect(t.state).toBe("holiday");
    expect(t.holidayName).toBe("Thanksgiving Day");
    expect(t.utcOffsetHours).toBe(-5);
    // The day after Thanksgiving closes at 13:00 New York.
    expect(usEquitySession(at("2026-11-27T18:30:00Z")).state).toBe("after");
    expect(usEquitySession(at("2026-11-27T18:30:00Z")).earlyClose).toBe("13:00");
  });

  it("finds the last session end per feed profile, and none while live", () => {
    expect(feedSessionLive("us_equities_24/5", SAT)).toBe(false);
    expect(lastFeedSessionEnd("us_equities_24/5", THU_OPEN)).toBeNull();
    expect(lastFeedSessionEnd("us_equities_24/5", SAT)).toBe(at("2026-10-17T00:00:00Z")); // Fri 20:00 ET
    expect(lastFeedSessionEnd("NYSE", SAT)).toBe(at("2026-10-16T20:00:00Z")); // Fri 16:00 ET
    // Thanksgiving: the 24/5 stream stopped Wednesday 20:00 ET (Thursday is not a trading day).
    expect(lastFeedSessionEnd("us_equities_24/5", THANKSGIVING)).toBe(at("2026-11-26T01:00:00Z"));
    expect(lastFeedSessionEnd("NYSE", THANKSGIVING)).toBe(at("2026-11-25T21:00:00Z"));
    expect(feedSessionLive("LSE", SAT)).toBeNull();
  });
});

describe("which feed prices which token", () => {
  it("matches a token-priced feed only to the same issuer's token", () => {
    const rh = premiumSubjectFor(4663, RH_NVDA)!;
    expect(rh.kind).toBe("token-priced");
    expect(rh.feed?.feedName).toBe("Robinhood NVDA / USD");
    const cb = premiumSubjectFor(8453, CB_NVDA)!;
    expect(cb.kind).toBe("token-priced");
    expect(cb.feed?.feedName).toBe("Coinbase NVDA");
  });

  it("never offers a rebasing token, and pairs a share feed only with a UI-multiplier token", () => {
    expect(premiumSubjects(8453).every((s) => !s.token.controls.rebasing)).toBe(true);
    const bnb = premiumSubjectFor(56, BNB_NVDA)!;
    expect(bnb.kind).toBe("share-priced");
    const hims = premiumSubjectFor(56, BNB_HIMS)!;
    expect(hims.kind).toBeNull();
    expect(hims.why).toMatch(/no verified price feed for HIMS/);
    // HyperEVM has stock tokens and no equity feed.
    expect(premiumSubjects(999).length).toBeGreaterThan(0);
    expect(premiumSubjects(999).every((s) => s.feed === null)).toBe(true);
  });
});

describe("the reference price", () => {
  const rh = premiumSubjectFor(4663, RH_NVDA)!;

  it("is live in session when the round is inside its heartbeat", () => {
    const r = referenceFromReads(rh, round(182.5, THU_OPEN - 120), mult(1.000775), THU_OPEN);
    expect(r.comparable).toBe(true);
    expect(r.basis).toBe("live");
    expect(r.usd).toBeCloseTo(182.5, 9);
    expect(r.basisUncertaintyBps).toBe(8); // |1.000775 - 1| = 7.75 bps, rounded up
    expect(r.source).toMatch(/^chainlink:0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15@1000000$/);
  });

  it("is stale in session past the heartbeat", () => {
    const r = referenceFromReads(rh, round(182.5, THU_OPEN - 2 * 86_400), mult(1), THU_OPEN);
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe("reference-stale");
  });

  it("compares with the last close on a weekend, and refuses a print older than the close's heartbeat", () => {
    const friLast = at("2026-10-16T23:55:00Z");
    const ok = referenceFromReads(rh, round(180, friLast), mult(1), SAT);
    expect(ok.comparable).toBe(true);
    expect(ok.basis).toBe("last-close");
    expect(ok.lastCloseAt).toBe(at("2026-10-17T00:00:00Z"));
    const old = referenceFromReads(rh, round(180, at("2026-10-14T20:00:00Z")), mult(1), SAT);
    expect(old.comparable).toBe(false);
    expect(old.reason).toBe("reference-older-than-last-close");
  });

  it("on a holiday compares with the print before the holiday's close", () => {
    const r = referenceFromReads(rh, round(181, at("2026-11-26T00:30:00Z")), mult(1), THANKSGIVING);
    expect(r.session.state).toBe("holiday");
    expect(r.basis).toBe("last-close");
    expect(r.comparable).toBe(true);
  });

  it("converts a share-priced feed with the multiplier READ, and refuses without it", () => {
    const bnb = premiumSubjectFor(56, BNB_NVDA)!;
    const r = referenceFromReads(bnb, round(180, THU_OPEN - 600), mult(1.000778), THU_OPEN);
    expect(r.kind).toBe("share-priced");
    expect(r.shareUsd).toBeCloseTo(180, 9);
    expect(r.usd).toBeCloseTo(180 * 1.000778, 6);
    expect(r.source).toContain("×uiMultiplier:");
    const none = referenceFromReads(bnb, round(180, THU_OPEN - 600), null, THU_OPEN);
    expect(none.comparable).toBe(false);
    expect(none.reason).toBe("share-priced-no-multiplier");
    expect(none.usd).toBeNull();
    expect(none.multiplier).toBeNull();
  });

  it("refuses a token-priced feed when the multiplier makes its unit ambiguous", () => {
    const r = referenceFromReads(rh, round(90, THU_OPEN - 60), { value: 2n * ONE, blockNumber: 1n }, THU_OPEN);
    expect(r.reason).toBe("multiplier-basis-ambiguous");
    expect(referenceFromReads(rh, round(90, THU_OPEN - 60), null, THU_OPEN).reason).toBe("multiplier-unread");
  });

  it("refuses unreadable, future and changed-decimals rounds, and dates past the calendar", () => {
    expect(referenceFromReads(rh, new Error("execution reverted"), null, THU_OPEN).reason).toBe("reference-unreadable");
    expect(referenceFromReads(rh, round(1, THU_OPEN, 18), mult(1), THU_OPEN).reason).toBe("reference-unreadable");
    expect(referenceFromReads(rh, round(1, THU_OPEN + 600), mult(1), THU_OPEN).reason).toBe("reference-future");
    const y2028 = at("2028-03-15T18:00:00Z");
    expect(referenceFromReads(rh, round(1, y2028 - 60), mult(1), y2028).reason).toBe("calendar-unknown");
  });
});

describe("the on-chain price and the premium", () => {
  const rh = premiumSubjectFor(4663, RH_NVDA)!;

  it("takes the mid of an executable buy and sell, venue in and venue out", () => {
    const p = executablePrices(
      { amountIn: 100_000_000n, amountOut: 2n * ONE, venue: "V", blockNumber: 1n },
      { amountIn: 2n * ONE, amountOut: 98_000_000n, venue: "V", blockNumber: 1n },
      { usd: 1, decimals: 6 },
      18,
    );
    expect(p.buyUsd).toBe(50);
    expect(p.sellUsd).toBe(49);
    expect(p.usd).toBe(49.5);
    expect(p.spreadBps).toBe(202);
  });

  it("flags a HIMS-like gap: $61 on chain against a $29 close is +110.34%", async () => {
    const friClose = at("2026-10-16T23:59:00Z");
    const ref = referenceFromReads(rh, round(29, friClose), mult(1), SAT);
    const on = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: router(61.2, 60.8), leg: leg(), now: SAT });
    expect(on.kind).toBe("executable-mid");
    expect(on.usd).toBeCloseTo(61, 3);
    expect(on.venue).toBe("UNISWAP_V3");
    const p = premium(ref, on, { now: SAT });
    expect(p.comparable).toBe(true);
    expect(p.bps).toBe(11034);
    expect(p.percent).toBeCloseTo(110.34, 2);
    expect(p.direction).toBe("premium");
    expect(p.label).toBe("vs last close 2026-10-16");
  });

  it("reports a discount, prices the stable through its feed, and labels a live comparison", async () => {
    const ref = referenceFromReads(rh, round(100, THU_OPEN - 30), mult(1), THU_OPEN);
    const on = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: router(95.5, 94.5), leg: leg(0.9999), now: THU_OPEN });
    const p = premium(ref, on, { now: THU_OPEN });
    expect(p.direction).toBe("discount");
    expect(p.bps).toBe(Math.round(((95 * 0.9999) / 100 - 1) * 10_000));
    expect(p.label).toBe("vs live price");
  });

  it("is not comparable with no route, a stale on-chain read, a wide spread or a stale reference", async () => {
    const ref = referenceFromReads(rh, round(100, THU_OPEN - 30), mult(1), THU_OPEN);
    const noRoute = await onchainPrice({
      chainId: 4663,
      token: RH_NVDA,
      tokenDecimals: 18,
      quote: async () => {
        throw new Error("NO_ROUTE");
      },
      leg: leg(),
      now: THU_OPEN,
    });
    expect(noRoute.usd).toBeNull();
    expect(premium(ref, noRoute, { now: THU_OPEN }).reason).toBe("no-onchain-price");
    const on = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: router(100, 100), leg: leg(), now: THU_OPEN });
    expect(premium(ref, on, { now: THU_OPEN + 3_600 }).reason).toBe("onchain-stale");
    const wide = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: router(130, 90), leg: leg(), now: THU_OPEN });
    expect(premium(ref, wide, { now: THU_OPEN }).reason).toBe("onchain-spread-too-wide");
    const oneSided = await onchainPrice({
      chainId: 4663,
      token: RH_NVDA,
      tokenDecimals: 18,
      quote: async (req) => {
        if (req.tokenIn === USDG) return router(4_899, 4)(req);
        throw new Error("NO_ROUTE");
      },
      leg: leg(),
      now: THU_OPEN,
    });
    expect(oneSided.kind).toBe("executable-buy");
    expect(premium(ref, oneSided, { now: THU_OPEN }).reason).toBe("onchain-one-sided");
    const stale = referenceFromReads(rh, round(100, THU_OPEN - 3 * 86_400), mult(1), THU_OPEN);
    const p = premium(stale, on, { now: THU_OPEN });
    expect(p.comparable).toBe(false);
    expect(p.bps).toBeNull();
    expect(p.reason).toBe("reference-stale");
  });

  it("carries an unreadable stable leg into the reason instead of guessing $1", async () => {
    const on = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: router(1, 1), leg: new Error("USDG / USD is stale"), now: THU_OPEN });
    expect(on.usd).toBeNull();
    expect(on.reason).toMatch(/stale/);
  });
});

describe("the exchange calendar's horizon", () => {
  it("is transcribed at least 60 days ahead (fails loudly so the next NYSE year is added in time)", () => {
    const last = Date.parse(`${premiumModule.US_EQUITY_CALENDAR_LAST_DATE}T00:00:00Z`);
    const daysLeft = Math.floor((last - Date.now()) / 86_400_000);
    expect(
      daysLeft,
      `US_EQUITY_CALENDAR ends ${premiumModule.US_EQUITY_CALENDAR_LAST_DATE} (${daysLeft} days away): transcribe the next year's NYSE holidays and early closes from https://www.nyse.com/markets/hours-calendars into packages/sdk/src/stocks/usCalendar.ts`,
    ).toBeGreaterThanOrEqual(60);
  });

  it("reads uncovered past the last date, and covered on it", () => {
    const last = premiumModule.US_EQUITY_CALENDAR_LAST_DATE;
    expect(premiumModule.usEquityCalendarCovers(last)).toBe(true);
    const next = `${Number(last.slice(0, 4)) + 1}-01-04`;
    expect(premiumModule.usEquityCalendarCovers(next)).toBe(false);
    expect(usEquitySession(at(`${next}T15:00:00Z`)).calendarCovered).toBe(false);
  });
});

describe("the depth check: too thin to price", () => {
  const rh = premiumSubjectFor(4663, RH_NVDA)!;
  /* A pool whose price moves `impactPerProbe` (a fraction) per probe-size of trade, on both sides. */
  function thin(px: number, impactPerProbe: number): PremiumQuoteFn {
    return async ({ tokenIn, amountIn }) => {
      if (tokenIn === USDG) {
        const dollars = Number(amountIn) / 1e6;
        const p = px * (1 + impactPerProbe * (dollars / 100));
        return { amountIn, amountOut: BigInt(Math.round((dollars / p) * 1e12)) * 1_000_000n, venue: "THIN", blockNumber: 7n };
      }
      const tokens = Number(amountIn / 1_000_000n) / 1e12;
      const p = px * (1 - impactPerProbe * ((tokens * px) / 100));
      return { amountIn, amountOut: BigInt(Math.round(tokens * p * 1e6)), venue: "THIN", blockNumber: 7n };
    };
  }

  it("quotes 5x the probe on both sides and refuses a move past 5% as too thin", async () => {
    const ref = referenceFromReads(rh, round(100, THU_OPEN - 30), mult(1), THU_OPEN);
    const calls: bigint[] = [];
    const counting: PremiumQuoteFn = async (r) => (calls.push(r.amountIn), thin(100, 0.02)(r));
    const on = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: counting, leg: leg(), now: THU_OPEN });
    expect(calls).toHaveLength(4);
    expect(calls[2]).toBe(calls[0]! * 5n);
    expect(on.depth?.multiple).toBe(5);
    expect(on.depth!.moveBps).toBeGreaterThan(500);
    const p = premium(ref, on, { now: THU_OPEN });
    expect(p.comparable).toBe(false);
    expect(p.reason).toBe("onchain-too-thin");
    expect(p.detail).toMatch(/at 5x the probe the price moves \d+ bps \(limit 500\)/);
    expect(premiumModule.PREMIUM_REASON_TEXT["onchain-too-thin"]).toMatch(/^too thin to price/);
    // the bound is configurable
    expect(premium(ref, on, { now: THU_OPEN, maxDepthMoveBps: 2_000 }).comparable).toBe(true);
  });

  it("passes a pool deep enough at 5x, and skips the check when asked", async () => {
    const ref = referenceFromReads(rh, round(100, THU_OPEN - 30), mult(1), THU_OPEN);
    const deep = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: thin(100, 0.002), leg: leg(), now: THU_OPEN });
    expect(deep.depth!.moveBps).toBeLessThanOrEqual(500);
    expect(premium(ref, deep, { now: THU_OPEN }).comparable).toBe(true);
    const calls: bigint[] = [];
    const skipped = await onchainPrice({ chainId: 4663, token: RH_NVDA, tokenDecimals: 18, quote: async (r) => (calls.push(r.amountIn), thin(100, 0.02)(r)), leg: leg(), depthMultiple: 1, now: THU_OPEN });
    expect(calls).toHaveLength(2);
    expect(skipped.depth).toBeNull();
    expect(premium(ref, skipped, { now: THU_OPEN }).comparable).toBe(true);
  });

  it("refuses when the depth quote cannot be completed: unconfirmed depth is not depth", async () => {
    const ref = referenceFromReads(rh, round(100, THU_OPEN - 30), mult(1), THU_OPEN);
    let n = 0;
    const on = await onchainPrice({
      chainId: 4663,
      token: RH_NVDA,
      tokenDecimals: 18,
      quote: async (r) => {
        if (++n > 2) throw new Error("NO_ROUTE: insufficient liquidity");
        return router(100, 100)(r);
      },
      leg: leg(),
      now: THU_OPEN,
    });
    expect(on.kind).toBe("executable-mid");
    expect(on.depth!.moveBps).toBeNull();
    const p = premium(ref, on, { now: THU_OPEN });
    expect(p.reason).toBe("onchain-too-thin");
    expect(p.detail).toMatch(/could not be completed.*insufficient liquidity/);
  });
});

describe("the probe stables", () => {
  it("names checksummed addresses on every live chain", () => {
    for (const id of [56, 999, 4663, 8453]) {
      const s = premiumModule.PREMIUM_QUOTE_STABLES[id]!;
      expect(getAddress(s.address)).toBe(s.address);
      if (s.feed) expect(getAddress(s.feed.proxy)).toBe(s.feed.proxy);
    }
  });
});

describe("root export", () => {
  it("binds every premium export at the package root to the module's own binding", () => {
    for (const [name, value] of Object.entries(premiumModule)) expect((sdk as Record<string, unknown>)[name], name).toBe(value);
  });
});
