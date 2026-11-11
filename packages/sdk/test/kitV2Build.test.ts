// SPDX-License-Identifier: MIT
/**
 * `buildLaunchParamsV2` / `buildLaunchV2`: a form draft to `createLaunch`.
 *
 * The pure builder is driven with a HAND-MADE `KitV2Limits` - no client, no
 * chain. Every number asserted here is one this file put into the draft or the
 * limits, or one the SDK's own price and tick helpers derive from them; the
 * checks are that the builder wires those helpers together the way the kit
 * expects (side rule, snapping, split, preset zeroing, tenant terms) and that
 * the calldata is exactly what viem encodes for the same `params`.
 *
 * `buildLaunchV2` is exercised with a three-read fake client that answers the
 * checked predictor with an address computed by the SDK's own CREATE2 rule, so
 * the cross-check passes and the calldata can be compared byte for byte.
 */

import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  BIN_SHAPE,
  LAUNCHPAD_KIT_V2_ABI,
  LAUNCH_GUARD_BITMAPS,
  LAUNCH_TOKEN_DECIMALS,
  LEG_KIND,
  NATIVE_ADDRESS,
  PRESET,
  binActiveIdForLaunch,
  binLaunchPriceAtId,
  buildLaunchParamsV2,
  buildLaunchV2,
  checkKitV2CLLeg,
  computeKitV2LegKey,
  encodeCreateLaunchV2,
  getHooksRegistrationBitmap,
  kitV2CLLaunchRange,
  predictLaunchTokenAddress,
  sqrtPriceForLaunch,
  tickAtSqrtRatio,
  type KitV2Limits,
  type LaunchDraftV2,
  type LegDraftV2,
} from "../src/index.js";

/* ------------------------------------------------------------ fixtures --- */

const KIT: Address = "0x00000000000000000000000000000000000000e1";
const CL_HOOK: Address = "0x00000000000000000000000000000000000000d1";
const BIN_HOOK: Address = "0x00000000000000000000000000000000000000d2";
const CL_PM: Address = "0x00000000000000000000000000000000000000a2";
const BIN_PM: Address = "0x00000000000000000000000000000000000000a3";
const CL_LOCKER: Address = "0x00000000000000000000000000000000000000b1";
const BIN_LOCKER: Address = "0x00000000000000000000000000000000000000b2";
const FACTORY: Address = "0x00000000000000000000000000000000000000f1";
const REGISTRY: Address = "0x00000000000000000000000000000000000000f2";
const TREASURY: Address = "0x00000000000000000000000000000000000000f3";
const CREATOR: Address = "0x0000000000000000000000000000000000000c01";
const OPERATOR: Address = "0x0000000000000000000000000000000000000c02";
const STEWARD: Address = "0x0000000000000000000000000000000000000c03";
const LAUNCHER: Address = "0x0000000000000000000000000000000000000c04";
const INTEGRATOR: Address = "0x0000000000000000000000000000000000000c05";
const TENANT: Address = "0x0000000000000000000000000000000000000c06";
/** An ERC-20 quote in the MIDDLE of the address space, so a token can sort either side of it. */
const USD: Address = "0x8000000000000000000000000000000000000000";
/** Sorts BELOW `USD`: the launch token is currency0. */
const TOKEN_LOW: Address = "0x1000000000000000000000000000000000000001";
/** Sorts ABOVE `USD` (and above native): the launch token is currency1. */
const TOKEN_HIGH: Address = "0xf000000000000000000000000000000000000001";
const SALT: Hex = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const INIT_CODE_HASH: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111";

const E18 = 10n ** 18n;

function limits(overrides: Partial<KitV2Limits> = {}): KitV2Limits {
  return {
    env: {
      kit: KIT,
      clHook: CL_HOOK,
      binHook: BIN_HOOK,
      clPoolManager: CL_PM,
      binPoolManager: BIN_PM,
      clPositionManager: "0x0000000000000000000000000000000000000d01",
      binPositionManager: "0x0000000000000000000000000000000000000d02",
      clLocker: CL_LOCKER,
      binLocker: BIN_LOCKER,
      tokenFactory: FACTORY,
      launchRegistry: REGISTRY,
      protocolFeeRecipient: TREASURY,
      clHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].CL,
      binHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].Bin,
    },
    caps: { maxLegs: 4, maxBinsPerLeg: 20 },
    guard: { minDecaySeconds: 60, maxDecaySeconds: 2_592_000, maxInitialFeeBips: 500_000, maxFinalFeeBips: 100_000, maxStartDelaySeconds: 2_592_000 },
    locker: { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 },
    tax: { maxTaxBps: 1_000, minProtocolBps: 1_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000, maxTaxDurationSeconds: 15_552_000 },
    feeSplit: null,
    lpShareBps: { CL: null, Bin: null },
    maxIntegratorLaunchFeeWei: 10n ** 16n,
    maxLaunchFeeWei: 10n ** 16n,
    token: { maxNameBytes: 64, maxSymbolBytes: 16, maxMetadataUriBytes: 256 },
    value: { launchFeeWei: 1_000n, integratorFeeWei: 0n, minimumValue: 1_000n, pending: null, safeValue: 1_000n },
    tenantAddress: null,
    tenant: null,
    tenantAllowedQuotes: [],
    integrator: { address: NATIVE_ADDRESS, bps: 0, launchFeeWei: 0n, taxBps: 0, source: "direct" },
    ...overrides,
  };
}

function clLeg(overrides: Partial<LegDraftV2> = {}): LegDraftV2 {
  return {
    kind: "CL",
    quote: NATIVE_ADDRESS,
    quoteDecimals: 18,
    weightBps: 10_000,
    quotePerLaunchToken: "0.0001",
    maxBuyPerTx: 0n,
    tickSpacing: 60,
    widthInSpacings: 100,
    binStep: 0,
    shape: "Custom",
    binCount: 0,
    ...overrides,
  };
}

function binLeg(overrides: Partial<LegDraftV2> = {}): LegDraftV2 {
  return {
    kind: "Bin",
    quote: NATIVE_ADDRESS,
    quoteDecimals: 18,
    weightBps: 10_000,
    quotePerLaunchToken: "0.0001",
    maxBuyPerTx: 0n,
    tickSpacing: 0,
    widthInSpacings: 0,
    binStep: 25,
    shape: "Linear",
    binCount: 10,
    ...overrides,
  };
}

function draft(overrides: Partial<LaunchDraftV2> = {}): LaunchDraftV2 {
  return {
    name: "Test Token",
    symbol: "TT",
    metadataURI: "ipfs://meta",
    totalSupply: 1_000_000_000n * E18,
    seedSupply: 800_000_000n * E18,
    allocationRecipient: CREATOR,
    creator: CREATOR,
    operator: OPERATOR,
    steward: STEWARD,
    protocolBps: 2_000,
    schedule: { preset: PRESET.FairLaunch, initialFeeBips: 0, finalFeeBips: 0, decaySeconds: 0, startDelaySeconds: 0 },
    legs: [clLeg()],
    listing: { description: "d", websiteURI: "https://example.invalid", xHandle: "", telegramHandle: "" },
    userSalt: SALT,
    launcher: LAUNCHER,
    ...overrides,
  };
}

const errors = (issues: readonly { severity: string; contractError?: string }[]): string[] =>
  issues.filter((i) => i.severity === "error").map((i) => i.contractError ?? "?");

/* ------------------------------------------------------------- listing --- */

describe("buildLaunchParamsV2: the registry listing", () => {
  it("passes the four LaunchMetadata strings through untouched and reports nothing for well-formed handles", () => {
    const listing = { description: "d", websiteURI: "https://example.invalid", xHandle: "gullycorefun", telegramHandle: "gullycore_chat" };
    const built = buildLaunchParamsV2(draft({ listing }), { token: TOKEN_HIGH, limits: limits() });
    expect(built.params.listing).toEqual(listing);
    expect(built.issues.filter((i) => i.field.startsWith("listing."))).toEqual([]);
  });

  it.each([
    ["a leading @", "@gullycorefun", "xHandle"],
    ["a URL", "https://x.com/gullycorefun", "xHandle"],
    ["a character outside [A-Za-z0-9_]", "gullycore-protocol", "telegramHandle"],
    ["more bytes than X allows", "a".repeat(16), "xHandle"],
    ["more bytes than Telegram allows", "a".repeat(33), "telegramHandle"],
  ])("reports %s as an InvalidHandle error on the field, instead of letting the registry revert", (_, bad, field) => {
    const listing = { description: "", websiteURI: "", xHandle: "", telegramHandle: "", [field]: bad };
    const built = buildLaunchParamsV2(draft({ listing }), { token: TOKEN_HIGH, limits: limits() });
    const hits = built.issues.filter((i) => i.field === `listing.${field}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe("error");
    expect(hits[0]!.contractError).toBe("InvalidHandle");
  });
});

/* ------------------------------------------------------------------ CL --- */

describe("buildLaunchParamsV2: CL legs", () => {
  it.each([
    ["token below the quote (currency0)", TOKEN_LOW, USD, true],
    ["token above the quote (currency1)", TOKEN_HIGH, USD, false],
    ["native quote (token is always currency1)", TOKEN_HIGH, NATIVE_ADDRESS, false],
  ])("%s: snaps the price onto the range edge and the leg passes the side rule", (_, token, quote, expectIs0) => {
    const d = draft({ legs: [clLeg({ quote, quoteDecimals: 18 })] });
    const built = buildLaunchParamsV2(d, { token, limits: limits() });

    expect(built.legs).toHaveLength(1);
    const resolved = built.legs[0]!;
    expect(resolved.kind).toBe("CL");
    expect(resolved.key.launchTokenIsCurrency0).toBe(expectIs0);
    expect(resolved.key).toEqual(computeKitV2LegKey({ env: limits().env, token, quote, kind: LEG_KIND.CL, tickSpacingOrBinStep: 60 }));

    const leg = built.params.legs[0]!;
    expect(leg.kind).toBe(LEG_KIND.CL);
    expect(leg.quote).toBe(quote);
    expect(leg.bin.binCount).toBe(0);

    /* The snapped price is what the SDK's own range helper produces with snapPrice on. */
    const typed = sqrtPriceForLaunch({ launchToken: token, quoteToken: quote, launchDecimals: 18, quoteDecimals: 18, quotePerLaunchToken: "0.0001" });
    const expected = kitV2CLLaunchRange({ launchTokenIsCurrency0: expectIs0, sqrtPriceX96: typed.sqrtPriceX96, tickSpacing: 60, widthInSpacings: 100, snapPrice: true });
    expect(leg.cl).toEqual(expected);
    expect(leg.cl.sqrtPriceX96).not.toBe(typed.sqrtPriceX96);
    expect(leg.cl.tickUpper - leg.cl.tickLower).toBe(6_000);

    /* The side rule, strictly: currency0 ranges start ABOVE the price's tick; currency1 ranges end AT OR BELOW it. */
    const tick = tickAtSqrtRatio(leg.cl.sqrtPriceX96);
    if (expectIs0) expect(leg.cl.tickLower).toBeGreaterThan(tick);
    else expect(leg.cl.tickUpper).toBeLessThanOrEqual(tick);
    expect(checkKitV2CLLeg({ cl: leg.cl, launchTokenIsCurrency0: expectIs0, supply: d.seedSupply }).problem).toBeNull();

    expect(errors(built.issues)).not.toContain("RangeNotSingleSided");
    expect(errors(built.issues)).toEqual([]);

    /* The snap moved the price by less than one spacing (60 ticks = 0.6%), and the reported price is the snapped one. */
    expect(resolved.snapFraction).toBeGreaterThan(0);
    expect(resolved.snapFraction).toBeLessThan(0.006);
    const opening = Number(resolved.openingPrice);
    expect(Math.abs(opening - 0.0001) / 0.0001).toBeCloseTo(resolved.snapFraction, 6);
    /* The seeded range sits on the side buyers push the price to, so snapping onto its edge moves the
       opening price UP toward the range - in both token orders. The first buy meets liquidity at once. */
    expect(opening).toBeGreaterThan(0.0001);
  });

  it("folds the quote's decimals in: a 6-decimal quote at the same typed price lands on the same human price", () => {
    const built = buildLaunchParamsV2(draft({ legs: [clLeg({ quote: USD, quoteDecimals: 6 })] }), { token: TOKEN_LOW, limits: limits() });
    expect(errors(built.issues)).toEqual([]);
    expect(Number(built.legs[0]!.openingPrice)).toBeCloseTo(0.0001, 6);
  });

  it("throws, rather than encoding, a price the range cannot hold", () => {
    expect(() => buildLaunchParamsV2(draft({ legs: [clLeg({ quotePerLaunchToken: "0" })] }), { token: TOKEN_HIGH, limits: limits() })).toThrow();
  });
});

/* ----------------------------------------------------------------- Bin --- */

describe("buildLaunchParamsV2: Bin legs", () => {
  it.each([
    ["token is currency0", TOKEN_LOW, USD, true],
    ["token is currency1", TOKEN_HIGH, USD, false],
    ["native quote", TOKEN_HIGH, NATIVE_ADDRESS, false],
  ])("%s: activeId and the reported opening price round-trip through the bin price helpers", (_, token, quote, expectIs0) => {
    const d = draft({ legs: [binLeg({ quote, quotePerLaunchToken: "0.00025" })] });
    const built = buildLaunchParamsV2(d, { token, limits: limits() });
    expect(errors(built.issues)).toEqual([]);

    const leg = built.params.legs[0]!;
    const resolved = built.legs[0]!;
    expect(leg.kind).toBe(LEG_KIND.Bin);
    expect(leg.cl.tickSpacing).toBe(0);
    expect(leg.bin.shape).toBe(BIN_SHAPE.Linear);
    expect(leg.bin.binCount).toBe(10);
    expect(leg.bin.offsets).toEqual([]);
    expect(leg.bin.weights).toEqual([]);
    expect(resolved.key.launchTokenIsCurrency0).toBe(expectIs0);

    const price = { launchTokenIsCurrency0: expectIs0, launchDecimals: LAUNCH_TOKEN_DECIMALS, quoteDecimals: 18, binStep: 25 };
    expect(leg.bin.activeId).toBe(binActiveIdForLaunch({ ...price, quotePerLaunchToken: 0.00025 }));
    const opening = binLaunchPriceAtId(leg.bin.activeId, price);
    expect(resolved.openingPrice).toBe(opening.toPrecision(8));
    /* The bin the opening price defines is the bin that was chosen. */
    expect(binActiveIdForLaunch({ ...price, quotePerLaunchToken: opening })).toBe(leg.bin.activeId);
    /* Snapping onto a bin moves the price by less than one bin step (0.25%). */
    expect(resolved.snapFraction).toBeLessThan(0.0025);
    expect(Math.abs(opening - 0.00025) / 0.00025).toBeCloseTo(resolved.snapFraction, 9);
  });

  it("refuses a schedule opening above 10% on a launch with a Bin leg", () => {
    const built = buildLaunchParamsV2(draft({ legs: [binLeg()], schedule: { ...draft().schedule, preset: PRESET.Stealth } }), {
      token: TOKEN_HIGH,
      limits: limits(),
    });
    expect(errors(built.issues)).toContain("PresetUnavailableOnBin");
  });

  it("throws on a non-numeric Bin price", () => {
    expect(() => buildLaunchParamsV2(draft({ legs: [binLeg({ quotePerLaunchToken: "abc" })] }), { token: TOKEN_HIGH, limits: limits() })).toThrow(
      /positive number/,
    );
  });
});

/* ------------------------------------------------------------ schedule --- */

describe("buildLaunchParamsV2: the guards' generation", () => {
  const quoteFeeEnv = { ...limits().env, clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL, binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin };
  const twoLegs = draft({ legs: [clLeg({ weightBps: 6_000 }), binLeg({ weightBps: 4_000 })] });

  it("every leg's key carries the bitmap of the guards the limits were read for", () => {
    const lpFee = buildLaunchParamsV2(twoLegs, { token: TOKEN_HIGH, limits: limits() });
    expect(lpFee.legs.map((l) => getHooksRegistrationBitmap(l.key.key.parameters))).toEqual([0x08c1, 0x08c5]);
    const quoteFee = buildLaunchParamsV2(twoLegs, { token: TOKEN_HIGH, limits: limits({ env: quoteFeeEnv }) });
    expect(quoteFee.legs.map((l) => getHooksRegistrationBitmap(l.key.key.parameters))).toEqual([0x0cc1, 0x0cc5]);
    /* A different key is a different pool; the call itself does not change, the kit computes its own keys. */
    expect(quoteFee.legs.map((l) => l.key.poolId)).not.toEqual(lpFee.legs.map((l) => l.key.poolId));
    expect(quoteFee.params).toEqual(lpFee.params);
  });
});

describe("buildLaunchParamsV2: schedule", () => {
  const custom = { preset: PRESET.Custom, initialFeeBips: 200_000, finalFeeBips: 5_000, decaySeconds: 600, startDelaySeconds: 120 };

  it("zeroes the custom fee fields for a named preset and keeps the start delay", () => {
    const built = buildLaunchParamsV2(draft({ schedule: { ...custom, preset: PRESET.FairLaunch } }), { token: TOKEN_HIGH, limits: limits() });
    expect(built.params.schedule).toEqual({ preset: PRESET.FairLaunch, initialFeeBips: 0, finalFeeBips: 0, decaySeconds: 0, enabled: true, startDelaySeconds: 120 });
    expect(errors(built.issues)).toEqual([]);
  });

  it("keeps the custom fields for PRESET.Custom", () => {
    const built = buildLaunchParamsV2(draft({ schedule: custom }), { token: TOKEN_HIGH, limits: limits() });
    expect(built.params.schedule).toEqual({ ...custom, enabled: true });
    expect(errors(built.issues)).toEqual([]);
  });
});

/* --------------------------------------------------------------- split --- */

describe("buildLaunchParamsV2: the split and the tenant", () => {
  it("creatorBps is the remainder after protocol and integrator; direct launches carry the supplied integrator", () => {
    const l = limits({ integrator: { address: INTEGRATOR, bps: 500, launchFeeWei: 7n, taxBps: 0, source: "direct" }, value: { ...limits().value, integratorFeeWei: 7n, minimumValue: 1_007n, safeValue: 1_007n } });
    const built = buildLaunchParamsV2(draft({ protocolBps: 2_500 }), { token: TOKEN_HIGH, limits: l });
    expect(built.params.creatorBps).toBe(7_000);
    expect(built.params.protocolBps).toBe(2_500);
    expect(built.params.integratorBps).toBe(500);
    expect(built.params.integrator).toBe(INTEGRATOR);
    expect(built.params.integratorLaunchFeeWei).toBe(7n);
    expect(built.params.tenant).toBe(NATIVE_ADDRESS);
    expect(built.value).toBe(1_007n);
    expect(errors(built.issues)).toEqual([]);
  });

  it("clamps a negative remainder to 0 and reports BpsDoNotSumToDenominator instead of encoding a wrapped number", () => {
    const l = limits({ integrator: { address: INTEGRATOR, bps: 2_000, launchFeeWei: 0n, taxBps: 0, source: "direct" } });
    const built = buildLaunchParamsV2(draft({ protocolBps: 9_000 }), { token: TOKEN_HIGH, limits: l });
    expect(built.params.creatorBps).toBe(0);
    expect(errors(built.issues)).toContain("BpsDoNotSumToDenominator");
    expect(errors(built.issues)).toContain("ProtocolBpsOutOfRange");
  });

  it("reports a protocol share below the lockers' floor", () => {
    const built = buildLaunchParamsV2(draft({ protocolBps: 1_000 }), { token: TOKEN_HIGH, limits: limits() });
    expect(built.params.creatorBps).toBe(9_000);
    expect(errors(built.issues)).toEqual(["ProtocolBpsOutOfRange"]);
  });

  describe("on quote-fee guards the one split is checked by the locker AND by the guard", () => {
    /* A locker with looser bounds than the guard's, so each figure shows which of the two applied. */
    const looseLocker = { minProtocolBps: 1_000, maxProtocolBps: 6_000, maxIntegratorBps: 3_000 };
    const guardBounds = { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 };
    const direct = (bps: number) => ({ address: INTEGRATOR, bps, launchFeeWei: 0n, taxBps: 0, source: "direct" as const });

    it("the guard's floor refuses a protocol share the locker alone would take", () => {
      const lpFee = buildLaunchParamsV2(draft({ protocolBps: 1_500 }), { token: TOKEN_HIGH, limits: limits({ locker: looseLocker, feeSplit: null }) });
      expect(errors(lpFee.issues)).toEqual([]);
      const quoteFee = buildLaunchParamsV2(draft({ protocolBps: 1_500 }), { token: TOKEN_HIGH, limits: limits({ locker: looseLocker, feeSplit: guardBounds }) });
      expect(errors(quoteFee.issues)).toEqual(["ProtocolBpsOutOfRange"]);
    });

    it("the guard's caps refuse a protocol or integrator share above them", () => {
      const tooMuchProtocol = buildLaunchParamsV2(draft({ protocolBps: 5_500 }), { token: TOKEN_HIGH, limits: limits({ locker: looseLocker, feeSplit: guardBounds }) });
      expect(errors(tooMuchProtocol.issues)).toEqual(["ProtocolBpsOutOfRange"]);
      const l = limits({ locker: looseLocker, feeSplit: guardBounds, integrator: direct(2_500) });
      expect(errors(buildLaunchParamsV2(draft(), { token: TOKEN_HIGH, limits: l }).issues)).toEqual(["IntegratorBpsTooHigh"]);
      expect(errors(buildLaunchParamsV2(draft(), { token: TOKEN_HIGH, limits: { ...l, feeSplit: null } }).issues)).toEqual([]);
    });

    it("a tighter LOCKER still applies: the bounds are the tighter of each pair, never the guard's alone", () => {
      const tightLocker = { minProtocolBps: 3_000, maxProtocolBps: 4_000, maxIntegratorBps: 1_000 };
      const under = buildLaunchParamsV2(draft({ protocolBps: 2_500 }), { token: TOKEN_HIGH, limits: limits({ locker: tightLocker, feeSplit: guardBounds }) });
      expect(errors(under.issues)).toEqual(["ProtocolBpsOutOfRange"]);
      const over = buildLaunchParamsV2(draft({ protocolBps: 4_500 }), { token: TOKEN_HIGH, limits: limits({ locker: tightLocker, feeSplit: guardBounds }) });
      expect(errors(over.issues)).toEqual(["ProtocolBpsOutOfRange"]);
      const l = limits({ locker: tightLocker, feeSplit: guardBounds, integrator: direct(1_500) });
      expect(errors(buildLaunchParamsV2(draft({ protocolBps: 3_500 }), { token: TOKEN_HIGH, limits: l }).issues)).toEqual(["IntegratorBpsTooHigh"]);
    });
  });

  it("reports leg weights that do not sum to 10000", () => {
    const built = buildLaunchParamsV2(draft({ legs: [clLeg({ weightBps: 6_000 }), binLeg({ weightBps: 3_000 })] }), { token: TOKEN_HIGH, limits: limits() });
    expect(errors(built.issues)).toContain("LegWeightsDoNotSum");
  });

  it("uses the tenant's stored terms and names the tenant; a quote off the tenant's list is refused", () => {
    const tenant = {
      integrator: INTEGRATOR,
      integratorBps: 1_000,
      integratorLaunchFeeWei: 5n,
      allowedPresets: ["FairLaunch", "NoTax"] as const,
      allowedBinShapes: ["Flat", "Linear"] as const,
      restrictQuotes: true,
      active: true,
      maxTaxBps: 500,
      taxIntegratorBps: 1_500,
      gullyTerms: false,
      configured: true,
    };
    const l = limits({
      tenantAddress: TENANT,
      tenant,
      tenantAllowedQuotes: [NATIVE_ADDRESS],
      integrator: { address: INTEGRATOR, bps: 1_000, launchFeeWei: 5n, taxBps: 0, source: "tenant" },
      value: { launchFeeWei: 1_000n, integratorFeeWei: 5n, minimumValue: 1_005n, pending: { feeWei: 2_000n, effectiveAt: 99n }, safeValue: 2_005n },
    });
    const ok = buildLaunchParamsV2(draft(), { token: TOKEN_HIGH, limits: l });
    expect(ok.params.tenant).toBe(TENANT);
    expect(ok.params.integrator).toBe(INTEGRATOR);
    expect(ok.params.integratorBps).toBe(1_000);
    expect(ok.params.integratorLaunchFeeWei).toBe(5n);
    expect(ok.params.creatorBps).toBe(7_000);
    expect(ok.value).toBe(2_005n);
    expect(errors(ok.issues)).toEqual([]);
    expect(ok.issues.some((i) => i.field === "tenant")).toBe(false);

    const offList = buildLaunchParamsV2(draft({ legs: [clLeg({ quote: USD })] }), { token: TOKEN_HIGH, limits: l });
    expect(errors(offList.issues)).toEqual(["QuoteNotAllowed"]);

    const wrongPreset = buildLaunchParamsV2(draft({ schedule: { ...draft().schedule, preset: PRESET.AntiSniperAggressive }, legs: [clLeg({ maxBuyPerTx: 1n })] }), {
      token: TOKEN_HIGH,
      limits: l,
    });
    expect(errors(wrongPreset.issues)).toEqual(["PresetNotAllowed"]);
  });

  it("sends the zero allocation recipient when the whole supply is seeded, and the named one otherwise", () => {
    const all = buildLaunchParamsV2(draft({ seedSupply: draft().totalSupply }), { token: TOKEN_HIGH, limits: limits() });
    expect(all.params.allocationRecipient).toBe(NATIVE_ADDRESS);
    expect(errors(all.issues)).toEqual([]);
    const part = buildLaunchParamsV2(draft(), { token: TOKEN_HIGH, limits: limits() });
    expect(part.params.allocationRecipient).toBe(CREATOR);
  });

  it("copies the identity fields through unchanged", () => {
    const d = draft();
    const { params } = buildLaunchParamsV2(d, { token: TOKEN_HIGH, limits: limits() });
    expect(params.name).toBe(d.name);
    expect(params.symbol).toBe(d.symbol);
    expect(params.metadataURI).toBe(d.metadataURI);
    expect(params.userSalt).toBe(d.userSalt);
    expect(params.totalSupply).toBe(d.totalSupply);
    expect(params.seedSupply).toBe(d.seedSupply);
    expect(params.creator).toBe(CREATOR);
    expect(params.launchOperator).toBe(OPERATOR);
    expect(params.launchSteward).toBe(STEWARD);
    expect(params.listing).toEqual(d.listing);
  });
});

/* ------------------------------------------------------------ calldata --- */

describe("buildLaunchV2", () => {
  const token = predictLaunchTokenAddress({ kit: KIT, factory: FACTORY, initCodeHash: INIT_CODE_HASH, launcher: LAUNCHER, userSalt: SALT });

  /** Answers exactly the three reads `predictLaunchTokenChecked` makes; anything else throws. */
  function client(onChain: Address): PublicClient {
    return {
      async readContract(req: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> {
        if (req.address === KIT && req.functionName === "tokenFactory") return FACTORY;
        if (req.address === FACTORY && req.functionName === "launchTokenInitCodeHash") return INIT_CODE_HASH;
        if (req.address === KIT && req.functionName === "predictLaunchToken") {
          expect(req.args).toEqual([LAUNCHER, SALT]);
          return onChain;
        }
        throw new Error(`fake: unexpected readContract ${req.functionName} at ${req.address}`);
      },
    } as unknown as PublicClient;
  }

  it("predicts the token, builds the params and encodes byte-identical createLaunch calldata", async () => {
    const d = draft({ legs: [clLeg({ weightBps: 7_000 }), binLeg({ weightBps: 3_000, quote: USD })] });
    const built = await buildLaunchV2(client(token), KIT, d, limits());

    expect(built.to).toBe(KIT);
    expect(built.token).toBe(token);
    expect(built.value).toBe(1_000n);
    expect(errors(built.issues)).toEqual([]);
    expect(built.legs.map((l) => l.kind)).toEqual(["CL", "Bin"]);

    const pure = buildLaunchParamsV2(d, { token, limits: limits() });
    expect(built.params).toEqual(pure.params);
    expect(built.data).toBe(encodeFunctionData({ abi: LAUNCHPAD_KIT_V2_ABI, functionName: "createLaunch", args: [built.params] }));
    expect(built.data).toBe(encodeCreateLaunchV2(pure.params));
    expect(built.data.startsWith("0x")).toBe(true);
    expect(built.data.length).toBeGreaterThan(10);
  });

  it("refuses limits read for a different kit", async () => {
    const other: Address = "0x00000000000000000000000000000000000000e2";
    await expect(buildLaunchV2(client(token), other, draft(), limits())).rejects.toThrow(/read them for the kit/);
  });

  it("propagates the predictor's cross-check failure rather than building against a disputed address", async () => {
    await expect(buildLaunchV2(client(TOKEN_LOW), KIT, draft(), limits())).rejects.toThrow(/disagree/);
  });
});
