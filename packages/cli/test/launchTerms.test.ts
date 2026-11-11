import { describe, expect, it } from "vitest";

import { launchTerms } from "../src/commands/launch.js";

const FOREVER = 4_294_967_295;

/** A release 2 kit: fixed supply, a fixed 50% share, and a guard with no tax ceiling. */
const release2 = {
  rules: { minTradeFeePips: 10_000, protocolTradeShareBps: 5_000, launchTotalSupply: 10n ** 27n },
  tax: { maxTaxBps: 1_000, minProtocolBps: 1_000, maxProtocolBps: 5_000, maxTaxDurationSeconds: null },
  locker: { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 },
  feeSplit: null,
} as never;

/** A release 1 kit: any supply, a chosen share, a 180-day ceiling. */
const release1 = {
  rules: null,
  tax: { maxTaxBps: 1_000, minProtocolBps: 1_000, maxProtocolBps: 5_000, maxTaxDurationSeconds: 180 * 86_400 },
  locker: { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 },
  feeSplit: null,
} as never;

const input = { supply: "1000000000", taxBuy: "0", taxSell: "0", taxDays: "30", taxProtocol: "", lpProtocol: "" };

describe("--supply", () => {
  it("a release 2 kit takes its fixed supply, as the default does", () => {
    expect(launchTerms(release2, input).totalSupply).toBe(10n ** 27n);
  });
  it("a release 2 kit refuses any other, in words", () => {
    expect(() => launchTerms(release2, { ...input, supply: "5" })).toThrow(/mints exactly 1,000,000,000 tokens/);
    expect(() => launchTerms(release2, { ...input, supply: "1000000001" })).toThrow(/mints exactly/);
  });
  it("a release 1 kit takes any positive supply", () => {
    expect(launchTerms(release1, { ...input, supply: "5" }).totalSupply).toBe(5n * 10n ** 18n);
    expect(() => launchTerms(release1, { ...input, supply: "0" })).toThrow(/positive/);
  });
});

describe("--lp-protocol", () => {
  it("defaults to the kit's fixed 50%, not the locker's lower floor", () => {
    expect(launchTerms(release2, input).lpProtocolBps).toBe(5_000);
  });
  it("accepts 50 and refuses anything else on a release 2 kit", () => {
    expect(launchTerms(release2, { ...input, lpProtocol: "50" }).lpProtocolBps).toBe(5_000);
    expect(() => launchTerms(release2, { ...input, lpProtocol: "20" })).toThrow(/cannot be below 50%/);
    expect(() => launchTerms(release2, { ...input, lpProtocol: "51" })).toThrow(/maximum of 50%/);
  });
  it("a release 1 kit takes a share inside its bounds", () => {
    expect(launchTerms(release1, input).lpProtocolBps).toBe(2_000);
    expect(launchTerms(release1, { ...input, lpProtocol: "30" }).lpProtocolBps).toBe(3_000);
    expect(() => launchTerms(release1, { ...input, lpProtocol: "10" })).toThrow(/cannot be below 20%/);
  });
});

describe("a release 3 kit on outside terms", () => {
  /* reads.ts restates the share as 0 and pins both bounds there: Gully takes the flat 0.30% and no share. */
  const outside = { ...(release2 as object), rules: { minTradeFeePips: 10_000, protocolTradeShareBps: 0, launchTotalSupply: 10n ** 27n } } as never;
  it("plans no protocol share, and refuses one", () => {
    expect(launchTerms(outside, input).lpProtocolBps).toBe(0);
    expect(() => launchTerms(outside, { ...input, lpProtocol: "20" })).toThrow(/maximum of 0%/);
  });
  it("still fixes the supply", () => {
    expect(() => launchTerms(outside, { ...input, supply: "5" })).toThrow(/mints exactly/);
  });
});

describe("the creator tax", () => {
  const taxed = { ...input, taxBuy: "1", taxSell: "2" };

  it("no tax means no duration, whatever --tax-days says", () => {
    expect(launchTerms(release2, { ...input, taxDays: "forever" }).taxSeconds).toBe(0);
  });
  it("is not refused on a guard with no ceiling (the null that used to read as zero days)", () => {
    const t = launchTerms(release2, taxed);
    expect(t.taxSeconds).toBe(30 * 86_400);
    expect(t.taxBuy).toBe(100);
    expect(t.taxSell).toBe(200);
    expect(launchTerms(release2, { ...taxed, taxDays: "3650" }).taxSeconds).toBe(3_650 * 86_400);
  });
  it("may last forever on a release 2 kit, as the kit's own sentinel", () => {
    expect(launchTerms(release2, { ...taxed, taxDays: "forever" }).taxSeconds).toBe(FOREVER);
    expect(launchTerms(release2, { ...taxed, taxDays: " FOREVER " }).taxSeconds).toBe(FOREVER);
  });
  it("cannot on a release 1 kit, and stays under its ceiling", () => {
    expect(() => launchTerms(release1, { ...taxed, taxDays: "forever" })).toThrow(/does not allow a forever tax/);
    expect(launchTerms(release1, { ...taxed, taxDays: "180" }).taxSeconds).toBe(180 * 86_400);
    expect(() => launchTerms(release1, { ...taxed, taxDays: "181" })).toThrow(/between 1 and 180/);
  });
  it("holds the rate cap and the protocol's floor", () => {
    expect(() => launchTerms(release2, { ...taxed, taxBuy: "11" })).toThrow(/maximum of 10%/);
    expect(launchTerms(release2, taxed).taxProtocolBps).toBe(1_000);
    expect(() => launchTerms(release2, { ...taxed, taxProtocol: "5" })).toThrow(/cannot be below 10%/);
  });
});
