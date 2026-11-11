import { describe, expect, it } from "vitest";

import {
  BUILDER_POOL_RULES,
  DEFAULT_TOTAL_FEE_BPS,
  GULLY_LAUNCH_RULES,
  PRESET_PARAMS,
  TOTAL_FEE_CHOICES_BPS,
  builderPoolFees,
  centiBpsPercentText,
  isTotalFeeChoice,
  launchFeeBreakdown,
  pipsPercentText,
  taxBpsForTotalFee,
  taxNeverExpires,
  validateLaunchParamsV2,
} from "../src/index.js";

describe("Gully Core launch rules", () => {
  it("the numbers the release 2 kit enforces", () => {
    expect(GULLY_LAUNCH_RULES.MIN_TRADE_FEE_PIPS).toBe(10_000);
    expect(GULLY_LAUNCH_RULES.PROTOCOL_TRADE_SHARE_BPS).toBe(5_000);
    expect(GULLY_LAUNCH_RULES.TAX_SECONDS_FOREVER).toBe(2 ** 32 - 1);
    expect(GULLY_LAUNCH_RULES.LAUNCH_TOTAL_SUPPLY).toBe(10n ** 27n);
  });

  it("every preset settles at 1%, never at the upstream kit's 0.30%", () => {
    for (const [name, p] of Object.entries(PRESET_PARAMS)) {
      expect(p.finalFeeBips, name).toBeGreaterThanOrEqual(GULLY_LAUNCH_RULES.MIN_TRADE_FEE_PIPS);
      expect(p.finalFeeBips, name).not.toBe(3_000);
    }
  });

  it("the fee picker: 1% to 11% in 0.5% steps, default 2%", () => {
    expect(TOTAL_FEE_CHOICES_BPS[0]).toBe(100);
    expect(TOTAL_FEE_CHOICES_BPS[TOTAL_FEE_CHOICES_BPS.length - 1]).toBe(1_100);
    expect(TOTAL_FEE_CHOICES_BPS).toHaveLength(21);
    for (let i = 1; i < TOTAL_FEE_CHOICES_BPS.length; i++) expect(TOTAL_FEE_CHOICES_BPS[i]! - TOTAL_FEE_CHOICES_BPS[i - 1]!).toBe(50);
    expect(isTotalFeeChoice(DEFAULT_TOTAL_FEE_BPS)).toBe(true);
    expect(isTotalFeeChoice(125)).toBe(false);
    expect(isTotalFeeChoice(1_150)).toBe(false);
  });

  it("the total is inclusive of the 1% trade fee: '3% tax' is 3% total, a 2% creator tax", () => {
    expect(taxBpsForTotalFee(100)).toBe(0);
    expect(taxBpsForTotalFee(300)).toBe(200);
    expect(taxBpsForTotalFee(1_100)).toBe(GULLY_LAUNCH_RULES.MAX_TAX_BPS);
    expect(() => taxBpsForTotalFee(1_200)).toThrow(/not a fee choice/);
  });

  it("worked example: total 3%, holders 1% -> creator 1.3%, holders 1.0%, Gully 0.7%", () => {
    const b = launchFeeBreakdown({ totalBps: 300, holdersBps: 100 });
    expect(centiBpsPercentText(b.creatorCentiBps)).toBe("1.30%");
    expect(centiBpsPercentText(b.holdersCentiBps)).toBe("1.00%");
    expect(centiBpsPercentText(b.protocolCentiBps)).toBe("0.70%");
    expect(b.creatorCentiBps + b.holdersCentiBps + b.integratorCentiBps + b.protocolCentiBps).toBe(300 * 100);
  });

  it("Gully's part is fixed whatever the creator gives away: 0.50% at a 1% total", () => {
    for (const holdersBps of [0, 50]) {
      expect(launchFeeBreakdown({ totalBps: 100, holdersBps }).protocolCentiBps).toBe(5_000);
    }
    const withPad = launchFeeBreakdown({ totalBps: 100, integratorShareBps: 2_000 });
    expect(withPad.protocolCentiBps).toBe(5_000);
    expect(withPad.integratorCentiBps).toBe(2_000);
    expect(withPad.creatorCentiBps).toBe(3_000);
  });

  it("every choice sums to the total, and nothing can take more than the creator's side", () => {
    for (const totalBps of TOTAL_FEE_CHOICES_BPS) {
      const b = launchFeeBreakdown({ totalBps, integratorShareBps: 2_000 });
      expect(b.creatorCentiBps + b.holdersCentiBps + b.integratorCentiBps + b.protocolCentiBps).toBe(totalBps * 100);
      expect(b.creatorCentiBps).toBeGreaterThanOrEqual(0);
    }
    expect(() => launchFeeBreakdown({ totalBps: 100, holdersBps: 100 })).toThrow(/creator's side/);
    expect(() => launchFeeBreakdown({ totalBps: 300, holdersBps: 75 })).toThrow(/0\.5% steps/);
  });

  it("a forever tax is the guard's uint40 max", () => {
    expect(taxNeverExpires(2n ** 40n - 1n)).toBe(true);
    expect(taxNeverExpires(1_800_000_000)).toBe(false);
  });

  it("validateLaunchParamsV2 is exported with the kit rules context", () => {
    expect(typeof validateLaunchParamsV2).toBe("function");
  });
});

describe("builder and partner pools", () => {
  it("Gully takes 0.30% by default, under the core's 0.40% cap; kit launches carry none", () => {
    expect(BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS).toBe(3_000);
    expect(BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS).toBeLessThanOrEqual(BUILDER_POOL_RULES.MAX_PROTOCOL_FEE_PIPS);
    expect(BUILDER_POOL_RULES.KIT_LAUNCH_PROTOCOL_FEE_PIPS).toBe(0);
  });

  it("the builder's fee sits on top: a 0.25% pool costs a trader 0.30% + 0.25% less their product", () => {
    const v = builderPoolFees({ lpFeePips: 2_500 });
    expect(v.protocolPips).toBe(3_000);
    expect(v.totalPips).toBe(3_000 + 2_500 - Math.floor((3_000 * 2_500) / 1_000_000));
    expect(v.lpPips).toBe(v.totalPips - 3_000);
    expect(pipsPercentText(v.protocolPips)).toBe("0.30%");
  });

  it("the Safe can lower it per pool; nothing raises it past the cap", () => {
    expect(builderPoolFees({ lpFeePips: 3_000, protocolFeePips: 0 }).totalPips).toBe(3_000);
    expect(builderPoolFees({ lpFeePips: 3_000, protocolFeePips: 1_000 }).protocolPips).toBe(1_000);
    expect(() => builderPoolFees({ lpFeePips: 3_000, protocolFeePips: 4_001 })).toThrow(/cap/);
  });
});
