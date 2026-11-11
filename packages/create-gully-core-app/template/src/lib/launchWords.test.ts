// SPDX-License-Identifier: MIT
/**
 * The words for a launch's fee. Two rules: a launch whose own contract takes
 * the fee says so and names the currency; every other launch keeps the wording
 * this template always had, which claims nothing about the currency.
 */

import { describe, expect, it } from "vitest";

import { creditLabel, feeDividedLine, feeIsInQuote, feeSplitOf, kitFeeWords, legFeeWords, lockedEarnsWords, lpShareOfPools, potLabel, potShare } from "./launchWords";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const part = (bps: number) => ({ pot: 100n, share: 10n, bps });

describe("launchWords", () => {
  it("only a launch whose own contract takes the fee is 'in the quote'", () => {
    expect(feeIsInQuote("quote-fee")).toBe(true);
    expect(feeIsInQuote("lp-fee")).toBe(false);
    /* Unread is not a kind: nothing is assumed for it. */
    expect(feeIsInQuote("unknown")).toBe(false);
  });

  it("names the trading fee and its currency where the launch takes it", () => {
    const w = legFeeWords("quote-fee", "ETH");
    expect(w.feeLabel).toBe("Trading fee now");
    expect(w.paidIn).toBe("paid in ETH");
    expect(w.splitLabel).toBe("Trading fee split");
    expect(w.splitCaption).toBe("Trading fees, paid in ETH, split fixed at launch");
    expect(w.plainFee).toBe("plain trading fee applies");
    expect(legFeeWords("quote-fee", "NVDA").paidIn).toBe("paid in NVDA");
    for (const v of Object.values(w)) expect(/LP fee/.test(String(v))).toBe(false);
  });

  it("keeps the wording it always had for every other launch, and names no currency", () => {
    for (const g of ["lp-fee", "unknown"] as const) {
      const w = legFeeWords(g, "ETH");
      expect(w.feeLabel).toBe("Fee now");
      expect(w.paidIn).toBeNull();
      expect(w.splitLabel).toBe("LP fee split");
      expect(w.splitCaption).toBe("Locked LP fees, split frozen at launch");
      expect(w.plainFee).toBe("plain LP fee applies");
    }
  });

  it("reads the split from whoever charges the fee, and never swaps in the other", () => {
    const lock = { creator: a(1), integrator: a(2), creatorBps: 7000, protocolBps: 2000, integratorBps: 1000 };
    const feeSplit = { creator: a(3), integrator: a(4), creatorBps: 6000, protocolBps: 2500, integratorBps: 1500, pendingCreator: a(0) };
    expect(feeSplitOf({ guardGeneration: "lp-fee", lock, feeSplit: null } as never)).toEqual({ creatorBps: 7000, protocolBps: 2000, integratorBps: 1000, integrator: a(2) });
    expect(feeSplitOf({ guardGeneration: "quote-fee", lock, feeSplit } as never)).toEqual({ creatorBps: 6000, protocolBps: 2500, integratorBps: 1500, integrator: a(4) });
    /* The launch takes the fee but its split could not be read: the lock's is NOT the answer. */
    expect(feeSplitOf({ guardGeneration: "quote-fee", lock, feeSplit: null } as never)).toBeNull();
    expect(feeSplitOf({ guardGeneration: "lp-fee", lock: null, feeSplit } as never)).toBeNull();
    expect(feeSplitOf({ guardGeneration: "unknown", lock, feeSplit } as never)).toEqual({ creatorBps: 7000, protocolBps: 2000, integratorBps: 1000, integrator: a(2) });
  });

  it("labels each credit by where it sits and what it holds", () => {
    expect(creditLabel({ from: "kit", pools: null, holds: "launch-fees" })).toBe("Launch fees (kit)");
    expect(creditLabel({ from: "locker", pools: "CL", holds: "lp-fees" })).toBe("CL locker · LP fees");
    expect(creditLabel({ from: "locker", pools: "Bin", holds: "lp-fees" })).toBe("Bin locker · LP fees");
    expect(creditLabel({ from: "guard", pools: "CL", holds: "creator-tax" })).toBe("CL guard · creator tax");
    expect(creditLabel({ from: "guard", pools: "Bin", holds: "trading-fees-and-tax" })).toBe("Bin launch contract · trading fees and creator tax");
    /* A guard that could not be classified is named, and nothing is said about what it holds. */
    expect(creditLabel({ from: "guard", pools: "CL", holds: "unknown" })).toBe("CL guard");
  });

  it("says what a pot is made of and the share of each part", () => {
    expect(potLabel({ fee: part(7000), tax: null })).toBe("trading fee");
    expect(potLabel({ fee: null, tax: { ...part(9000), live: true } })).toBe("creator tax");
    expect(potLabel({ fee: part(7000), tax: { ...part(9000), live: false } })).toBe("trading fee + creator tax");
    expect(potShare({ fee: part(7000), tax: null })).toBe("70% of the fee");
    expect(potShare({ fee: part(1250), tax: { ...part(9000), live: true } })).toBe("12.5% of the fee · 90% of the tax");
    expect(potShare({ fee: null, tax: { ...part(8000), live: true } })).toBe("80% of the tax");
  });

  it("gives a launch form the words of the kit it launches through", () => {
    const older = kitFeeWords(false);
    expect(older.fee).toBe("pool fee");
    expect(older.splitLegend).toBe("LP fee split (frozen at lock time)");
    expect(older.splitRule).toBe("The lockers split every position’s LP fees three ways with these numbers, forever.");
    expect(older.revenue).toBe("the LP fee split above is the only ongoing revenue anyone has from this launch");

    const q = kitFeeWords(true, 0);
    expect(q.fee).toBe("trading fee");
    expect(q.fees).toBe("trading fees");
    expect(q.splitLegend).toBe("Trading fee split (fixed when the launch is created)");
    expect(q.splitRule).toContain("in the pool’s quote currency, buys and sells alike");
    expect(q.splitRule).toContain("earns no trading fee");
    for (const v of Object.values(q)) expect(/LP fee|pool fee/.test(String(v))).toBe(false);
  });

  it("says who receives a fee paid in the quote from the share that was read, and only from that", () => {
    const shared = kitFeeWords(true, 2500).splitRule;
    expect(shared).toBe(
      "Every trade pays the trading fee in the pool’s quote currency, buys and sells alike. On a buy, 25% of the trading fee goes to the pool’s liquidity providers; the launch contract takes the rest. On a sell the launch contract takes all of it. What the launch contract takes is split three ways with these numbers, forever. The liquidity stays locked, and its part of what buys pay is split the same way.",
    );
    expect(shared).not.toContain("earns no trading fee");

    /* Not read: said as not read, never as nothing. */
    for (const rule of [kitFeeWords(true).splitRule, kitFeeWords(true, null).splitRule]) {
      expect(rule).toContain("could not be read");
      expect(/earns no|nothing|zero|0%/.test(rule)).toBe(false);
    }
    expect(kitFeeWords(true, "differs").splitRule).toContain("On a buy, part of the trading fee goes to the pool’s liquidity providers");

    /* A share read beside a kit whose pools charge the fee changes nothing. */
    expect(kitFeeWords(false, 2500)).toEqual(kitFeeWords(false));
  });

  it("says what the locked liquidity earns, exactly", () => {
    expect(lockedEarnsWords(0)).toBe("earns no trading fee");
    expect(lockedEarnsWords(2500)).toBe("earns 25% of the trading fee on buys");
    expect(lockedEarnsWords(1250)).toBe("earns 12.5% of the trading fee on buys");
    expect(lockedEarnsWords(1)).toBe("earns 0.01% of the trading fee on buys");
    expect(lockedEarnsWords("differs")).toBe("earns a part of the trading fee on buys");
    expect(lockedEarnsWords(null)).toBe("what it earns could not be read");
    expect(feeDividedLine(0)).toBe("The launch contract takes all of the trading fee, on buys and on sells.");
    expect(feeDividedLine(null)).toBe("How the trading fee is divided between the pool’s liquidity providers and the launch contract could not be read.");
  });

  it("the share of a draft is its own pool types', and unknown as soon as one was not read", () => {
    expect(lpShareOfPools({ CL: 2500, Bin: 2500 }, ["CL", "Bin"])).toBe(2500);
    expect(lpShareOfPools({ CL: 2500, Bin: 0 }, ["CL"])).toBe(2500);
    expect(lpShareOfPools({ CL: 2500, Bin: 0 }, ["Bin", "Bin"])).toBe(0);
    expect(lpShareOfPools({ CL: 2500, Bin: 0 }, ["CL", "Bin"])).toBe("differs");
    expect(lpShareOfPools({ CL: 2500, Bin: null }, ["CL", "Bin"])).toBeNull();
    expect(lpShareOfPools({ CL: 2500, Bin: null }, ["CL"])).toBe(2500);
    expect(lpShareOfPools({ CL: 2500, Bin: null }, [])).toBeNull();
    expect(lpShareOfPools(null, ["CL"])).toBeNull();
    expect(lpShareOfPools(undefined, [])).toBeNull();
  });
});
