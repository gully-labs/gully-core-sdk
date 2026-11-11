// SPDX-License-Identifier: MIT
/**
 * LaunchpadKitV2 helpers against GOLDEN VECTORS read off the Solidity.
 *
 * `fixtures/kitV2Vectors.json` is printed by
 * `packages/launchpad/test/kitv2/SdkVectors.t.sol` (forge, default profile): the
 * real `BinLaunchShapes.build` / `validate`, `LaunchpadKitV2.predictLaunchToken`
 * and `computeLegKey` on a deployed test stack, and core's `TickMath` and
 * periphery's `LiquidityAmounts`. If a vector test fails, the Solidity is right
 * and the SDK is wrong - regenerate the fixture only when the Solidity changed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeErrorResult, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  BIN_SHAPE,
  KIT_V2_BIN_HOOK_BITMAP,
  KIT_V2_CL_HOOK_BITMAP,
  KIT_V2_DEPLOY_SCRIPT_CAPS,
  GULLYCORE_DEPLOYMENTS,
  GULLYCORE_CHAIN_IDS,
  LAUNCH_GUARD_BITMAPS,
  LAUNCHPAD_KIT_V2_REVERT_ABI,
  LAUNCH_LEGS_ABI,
  LEG_KIND,
  PRESET,
  binLegIds,
  buildBinShape,
  checkKitV2CLLeg,
  computeKitV2LegKey,
  computeLaunchValue,
  decodePendingLaunchFee,
  decodeTenantConfig,
  getHooksRegistrationBitmap,
  guardGenerationOf,
  kitV2CLLaunchRange,
  kitV2LegSupplies,
  poolKeyToId,
  predictLaunchTokenAddress,
  predictLaunchTokenChecked,
  readLaunchValue,
  requireLaunchpadV2,
  singleSidedLiquidity,
  sqrtRatioAtTick,
  tickAtSqrtRatio,
  validateBinDistribution,
  validateLaunchParamsV2,
  type GullyCoreDeployment,
  type LaunchParamsV2,
  type LegParamsV2,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Vectors {
  shapes: { shape: number; binCount: number; offsets: number[]; weights: string[]; floorBins: number }[];
  validate: { offsets: number[]; weights: string[]; floorBins: number; maxBins: number; amount: string; revertData: Hex }[];
  predict: { kit: Address; factory: Address; initCodeHash: Hex; cases: { launcher: Address; userSalt: Hex; token: Address }[] };
  legKeys: {
    clHook: Address;
    binHook: Address;
    clPoolManager: Address;
    binPoolManager: Address;
    cases: {
      token: Address;
      quote: Address;
      kind: number;
      tickSpacingOrBinStep: number;
      currency0: Address;
      currency1: Address;
      hooks: Address;
      poolManager: Address;
      fee: number;
      parameters: Hex;
      poolId: Hex;
      launchTokenIsCurrency0: boolean;
    }[];
  };
  tickMath: {
    sqrtAtTick: [number, string][];
    tickAtSqrt: [string, number][];
    liquidity: { sqrtPriceX96: string; tickLower: number; tickUpper: number; amount0: string; amount1: string; liquidity: string }[];
  };
}

const V = JSON.parse(readFileSync(join(HERE, "fixtures", "kitV2Vectors.json"), "utf8")) as Vectors;
const lc = (a: string): string => a.toLowerCase();

/* ------------------------------------------------------------------------- */

describe("launch token address", () => {
  it("off-chain CREATE2 equals the kit's predictLaunchToken for every vector", () => {
    expect(V.predict.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of V.predict.cases) {
      const got = predictLaunchTokenAddress({
        kit: V.predict.kit,
        factory: V.predict.factory,
        initCodeHash: V.predict.initCodeHash,
        launcher: c.launcher,
        userSalt: c.userSalt,
      });
      expect(lc(got)).toBe(lc(c.token));
    }
  });

  it("depends on the launcher: the same salt from another sender is another address", () => {
    const [a, b] = V.predict.cases;
    const base = { kit: V.predict.kit, factory: V.predict.factory, initCodeHash: V.predict.initCodeHash };
    expect(predictLaunchTokenAddress({ ...base, launcher: a!.launcher, userSalt: b!.userSalt })).not.toBe(
      predictLaunchTokenAddress({ ...base, launcher: b!.launcher, userSalt: b!.userSalt }),
    );
  });

  /** A PublicClient stand-in answering exactly the three reads the checked predictor makes. */
  function fakeClient(onChainToken: Address): PublicClient {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "tokenFactory") return V.predict.factory;
        if (functionName === "launchTokenInitCodeHash") return V.predict.initCodeHash;
        if (functionName === "predictLaunchToken") return onChainToken;
        throw new Error(`unexpected read ${functionName}`);
      },
    } as unknown as PublicClient;
  }

  it("predictLaunchTokenChecked returns the address when both routes agree", async () => {
    const c = V.predict.cases[1]!;
    await expect(predictLaunchTokenChecked(fakeClient(c.token), V.predict.kit, c.launcher, c.userSalt)).resolves.toBe(c.token);
  });

  it("predictLaunchTokenChecked throws when the kit and the SDK disagree", async () => {
    const c = V.predict.cases[1]!;
    const wrong = V.predict.cases[0]!.token;
    await expect(predictLaunchTokenChecked(fakeClient(wrong), V.predict.kit, c.launcher, c.userSalt)).rejects.toThrow(/disagree/);
  });
});

/* ------------------------------------------------------------------------- */

describe("leg keys", () => {
  const addresses = {
    clHook: V.legKeys.clHook,
    binHook: V.legKeys.binHook,
    clPoolManager: V.legKeys.clPoolManager,
    binPoolManager: V.legKeys.binPoolManager,
  };
  /* What the guards of the kit that printed the vectors register, read off the vectors' own keys.
     The fixture is regenerated when the Solidity changes, and the guards have two generations:
     whichever printed it, the bitmap must be a launch guard's, of the leg's own pool type, and one
     generation for both guards. */
  const bitmapOf = (kind: number): number => {
    const found = V.legKeys.cases.find((c) => c.kind === kind);
    if (found === undefined) throw new Error(`the vectors carry no leg of kind ${kind}`);
    return getHooksRegistrationBitmap(found.parameters);
  };
  const env = { ...addresses, clHookBitmap: bitmapOf(LEG_KIND.CL), binHookBitmap: bitmapOf(LEG_KIND.Bin) };

  it("the vectors were printed by a kit on launch guards of ONE generation", () => {
    const cl = guardGenerationOf(env.clHookBitmap, "CL");
    const bin = guardGenerationOf(env.binHookBitmap, "Bin");
    expect(cl).not.toBe("unknown");
    expect(bin).toBe(cl);
    for (const c of V.legKeys.cases) {
      expect(getHooksRegistrationBitmap(c.parameters)).toBe(c.kind === LEG_KIND.CL ? env.clHookBitmap : env.binHookBitmap);
    }
  });

  it("computeKitV2LegKey equals the kit's computeLegKey (CL and Bin, both token sides, native quote)", () => {
    const sides = new Set<boolean>();
    for (const c of V.legKeys.cases) {
      const r = computeKitV2LegKey({ env, token: c.token, quote: c.quote, kind: c.kind, tickSpacingOrBinStep: c.tickSpacingOrBinStep });
      expect(lc(r.key.currency0)).toBe(lc(c.currency0));
      expect(lc(r.key.currency1)).toBe(lc(c.currency1));
      expect(lc(r.key.hooks)).toBe(lc(c.hooks));
      expect(lc(r.key.poolManager)).toBe(lc(c.poolManager));
      expect(r.key.fee).toBe(c.fee);
      expect(r.key.parameters).toBe(c.parameters);
      expect(r.poolId).toBe(c.poolId);
      expect(r.launchTokenIsCurrency0).toBe(c.launchTokenIsCurrency0);
      sides.add(c.launchTokenIsCurrency0);
    }
    expect(sides.size).toBe(2); // the vectors exercise both orientations
    expect(V.legKeys.cases.map((c) => c.kind).sort()).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("refuses a quote equal to the token", () => {
    const t = V.legKeys.cases[0]!.token;
    expect(() => computeKitV2LegKey({ env, token: t, quote: t, kind: LEG_KIND.CL, tickSpacingOrBinStep: 60 })).toThrow(/QuoteIsLaunchToken/);
  });

  describe("the bitmap in the key is the guard's own", () => {
    const cl = V.legKeys.cases.find((c) => c.kind === LEG_KIND.CL)!;
    const bin = V.legKeys.cases.find((c) => c.kind === LEG_KIND.Bin)!;
    const keyFor = (c: typeof cl, bitmaps: { clHookBitmap?: number | null; binHookBitmap?: number | null }) =>
      computeKitV2LegKey({ env: { ...addresses, ...bitmaps }, token: c.token, quote: c.quote, kind: c.kind, tickSpacingOrBinStep: c.tickSpacingOrBinStep });

    it.each([
      ["lp-fee", LAUNCH_GUARD_BITMAPS["lp-fee"]],
      ["quote-fee", LAUNCH_GUARD_BITMAPS["quote-fee"]],
    ] as const)("%s guards: parameters carry that generation's bitmap and the id is the hash of that key", (_, bitmaps) => {
      for (const [c, expected] of [[cl, bitmaps.CL], [bin, bitmaps.Bin]] as const) {
        const r = keyFor(c, { clHookBitmap: bitmaps.CL, binHookBitmap: bitmaps.Bin });
        expect(getHooksRegistrationBitmap(r.key.parameters)).toBe(expected);
        /* The spacing sits above the bitmap and is untouched by it. */
        expect(BigInt(r.key.parameters) >> 16n).toBe(BigInt(c.tickSpacingOrBinStep));
        expect(r.poolId).toBe(poolKeyToId(r.key));
        expect(lc(r.key.hooks)).toBe(lc(c.hooks));
      }
    });

    it("the two generations name DIFFERENT pools for the same token, quote and spacing", () => {
      for (const c of [cl, bin]) {
        const lp = keyFor(c, { clHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].CL, binHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].Bin });
        const quote = keyFor(c, { clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL, binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin });
        expect(quote.poolId).not.toBe(lp.poolId);
        expect(quote.key.parameters).not.toBe(lp.key.parameters);
      }
    });

    it("an env that never read the bitmaps is taken to describe the lp-fee guards", () => {
      for (const c of [cl, bin]) {
        expect(keyFor(c, {})).toEqual(keyFor(c, { clHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].CL, binHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].Bin }));
      }
    });

    it("refuses to compute a key for a guard that did not answer, and only for that guard's legs", () => {
      expect(() => keyFor(cl, { clHookBitmap: null, binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin })).toThrow(/CL guard did not answer/);
      expect(() => keyFor(bin, { clHookBitmap: null, binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin })).not.toThrow();
      expect(() => keyFor(bin, { clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL, binHookBitmap: null })).toThrow(/Bin guard did not answer/);
      expect(() => keyFor(cl, { clHookBitmap: 0x1_0000 })).toThrow(/not a hook registration bitmap/);
    });
  });
});

/* ------------------------------------------------------------------------- */

describe("tick math", () => {
  it("sqrtRatioAtTick matches TickMath.getSqrtRatioAtTick", () => {
    for (const [tick, sqrt] of V.tickMath.sqrtAtTick) expect(sqrtRatioAtTick(tick)).toBe(BigInt(sqrt));
  });

  it("tickAtSqrtRatio matches TickMath.getTickAtSqrtRatio, including one-unit boundaries", () => {
    for (const [sqrt, tick] of V.tickMath.tickAtSqrt) expect(tickAtSqrtRatio(BigInt(sqrt))).toBe(tick);
  });

  it("singleSidedLiquidity matches LiquidityAmounts.getLiquidityForAmounts", () => {
    for (const l of V.tickMath.liquidity) {
      const amount = BigInt(l.amount0) + BigInt(l.amount1);
      expect(
        singleSidedLiquidity({ sqrtPriceX96: BigInt(l.sqrtPriceX96), tickLower: l.tickLower, tickUpper: l.tickUpper, amount }),
      ).toBe(BigInt(l.liquidity));
    }
  });

  it("refuses the ends core refuses", () => {
    expect(() => sqrtRatioAtTick(887273)).toThrow(RangeError);
    expect(() => tickAtSqrtRatio(4295128738n)).toThrow(RangeError);
    expect(() => tickAtSqrtRatio(1461446703485210103287273052203988822378723970342n)).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------------- */

describe("CL single-sided rule", () => {
  const P1 = 1n << 96n; // price 1, tick 0

  it("chooses the range the kit's own tests use at price 1, spacing 60", () => {
    expect(kitV2CLLaunchRange({ launchTokenIsCurrency0: true, sqrtPriceX96: P1, tickSpacing: 60, widthInSpacings: 999 })).toEqual({
      tickSpacing: 60,
      sqrtPriceX96: P1,
      tickLower: 60,
      tickUpper: 60_000,
    });
    expect(kitV2CLLaunchRange({ launchTokenIsCurrency0: false, sqrtPriceX96: P1, tickSpacing: 60, widthInSpacings: 1000 })).toEqual({
      tickSpacing: 60,
      sqrtPriceX96: P1,
      tickLower: -60_000,
      tickUpper: 0,
    });
  });

  it("is STRICT for currency0: tickLower equal to the price's tick is refused", () => {
    const atBoundary = sqrtRatioAtTick(60); // tick exactly 60
    const r = checkKitV2CLLeg({
      cl: { tickSpacing: 60, sqrtPriceX96: atBoundary, tickLower: 60, tickUpper: 600 },
      launchTokenIsCurrency0: true,
    });
    expect(r.currentTick).toBe(60);
    expect(r.problem?.error).toBe("RangeNotSingleSided");
    // One unit lower is tick 59, and the same range is accepted.
    expect(
      checkKitV2CLLeg({ cl: { tickSpacing: 60, sqrtPriceX96: atBoundary - 1n, tickLower: 60, tickUpper: 600 }, launchTokenIsCurrency0: true }).problem,
    ).toBeNull();
    // The range builder never produces the refused boundary.
    expect(kitV2CLLaunchRange({ launchTokenIsCurrency0: true, sqrtPriceX96: atBoundary, tickSpacing: 60, widthInSpacings: 1 }).tickLower).toBe(120);
  });

  it("allows tickUpper EQUAL to the tick for currency1, and refuses one spacing above", () => {
    const base = { tickSpacing: 60, sqrtPriceX96: P1, tickLower: -600 };
    expect(checkKitV2CLLeg({ cl: { ...base, tickUpper: 0 }, launchTokenIsCurrency0: false }).problem).toBeNull();
    expect(checkKitV2CLLeg({ cl: { ...base, tickUpper: 60 }, launchTokenIsCurrency0: false }).problem?.error).toBe("RangeNotSingleSided");
  });

  it("snapPrice puts the price on the range edge and stays on the accepted side", () => {
    for (const is0 of [true, false]) {
      const cl = kitV2CLLaunchRange({ launchTokenIsCurrency0: is0, sqrtPriceX96: P1 + 12345n, tickSpacing: 60, widthInSpacings: 10, snapPrice: true });
      expect(checkKitV2CLLeg({ cl, launchTokenIsCurrency0: is0, supply: 10n ** 24n }).problem).toBeNull();
      expect(tickAtSqrtRatio(cl.sqrtPriceX96)).toBe(is0 ? cl.tickLower - 1 : cl.tickUpper);
    }
  });

  it("reports misaligned ticks and zero liquidity", () => {
    expect(checkKitV2CLLeg({ cl: { tickSpacing: 60, sqrtPriceX96: P1, tickLower: 61, tickUpper: 600 }, launchTokenIsCurrency0: true }).problem?.error).toBe("TickMisaligned");
    expect(
      // 1 unit of currency1 over a range wider than 2^96 in sqrt-price terms is zero liquidity.
      checkKitV2CLLeg({
        cl: { tickSpacing: 60, sqrtPriceX96: sqrtRatioAtTick(887220), tickLower: 60, tickUpper: 887220 },
        launchTokenIsCurrency0: false,
        supply: 1n,
      }).problem?.error,
    ).toBe("SeedProducesNoLiquidity");
  });
});

/* ------------------------------------------------------------------------- */

describe("Bin shapes", () => {
  it("buildBinShape reproduces BinLaunchShapes.build for all four named shapes at ten sizes", () => {
    expect(V.shapes.length).toBe(40);
    for (const s of V.shapes) {
      const d = buildBinShape(s.shape, s.binCount, 256);
      expect({ shape: s.shape, n: s.binCount, offsets: d.offsets, weights: d.weights.map(String), floorBins: d.floorBins }).toEqual({
        shape: s.shape,
        n: s.binCount,
        offsets: s.offsets,
        weights: s.weights,
        floorBins: s.floorBins,
      });
    }
  });

  it("every named shape passes the validator at the deploy caps", () => {
    for (const shape of [BIN_SHAPE.Flat, BIN_SHAPE.Linear, BIN_SHAPE.Exponential, BIN_SHAPE.Stepped]) {
      for (let n = 1; n <= KIT_V2_DEPLOY_SCRIPT_CAPS.maxBinsPerLeg; n++) {
        expect(validateBinDistribution(buildBinShape(shape, n, 20), 20, 10n ** 24n)).toBeNull();
      }
    }
  });

  it("refuses Custom and out-of-range counts in the builder", () => {
    expect(() => buildBinShape("Custom", 3, 20)).toThrow(/Custom/);
    expect(() => buildBinShape("Flat", 21, 20)).toThrow(/BinShapeBadCount/);
  });

  it("the pre-validator names the SAME error, at the same index, as BinLaunchShapes.validate", () => {
    const expectedRule: Record<string, string> = {
      BinShapeBadCount: "R4",
      BinShapeLengthMismatch: "R4",
      BinShapeInvalidFloor: "R3",
      BinShapeGapBelowFloor: "R3",
      BinShapeNotSingleSided: "R1",
      BinShapeNotMonotonic: "R2",
      BinShapeWeightsDoNotSum: "R5",
      BinShapeZeroWeight: "R6",
      BinShapeDustBin: "R6",
    };
    const seenRules = new Set<string>();
    for (const c of V.validate) {
      const got = validateBinDistribution(
        { offsets: c.offsets, weights: c.weights.map(BigInt), floorBins: c.floorBins },
        c.maxBins,
        BigInt(c.amount),
      );
      if (c.revertData === "0x") {
        expect(got).toBeNull();
        continue;
      }
      const decoded = decodeErrorResult({ abi: LAUNCH_LEGS_ABI, data: c.revertData });
      expect(got?.error).toBe(decoded.errorName);
      expect(got?.rule).toBe(expectedRule[decoded.errorName]);
      seenRules.add(got!.rule);
      const perBin = ["BinShapeNotSingleSided", "BinShapeNotMonotonic", "BinShapeGapBelowFloor", "BinShapeZeroWeight", "BinShapeDustBin"];
      if (perBin.includes(decoded.errorName)) expect(BigInt(got!.index!)).toBe((decoded.args as readonly bigint[])[0]);
    }
    expect([...seenRules].sort()).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
  });

  it("maps offsets to ascending ids on the launch token's side, and catches BinIdOutOfRange", () => {
    expect(binLegIds({ activeId: 100, offsets: [1, 2, 5], launchTokenIsCurrency0: true })).toEqual({ binIds: [101, 102, 105], outOfRangeIndex: null });
    expect(binLegIds({ activeId: 100, offsets: [1, 2, 5], launchTokenIsCurrency0: false })).toEqual({ binIds: [95, 98, 99], outOfRangeIndex: null });
    expect(binLegIds({ activeId: 3, offsets: [1, 2, 3], launchTokenIsCurrency0: false }).outOfRangeIndex).toBe(2);
    expect(binLegIds({ activeId: 0xfffffe, offsets: [1, 2], launchTokenIsCurrency0: true }).outOfRangeIndex).toBe(1);
  });

  it("the kit revert ABI decodes every BinShape error from the kit's address", () => {
    for (const c of V.validate.filter((x) => x.revertData !== "0x")) {
      expect(decodeErrorResult({ abi: LAUNCHPAD_KIT_V2_REVERT_ABI, data: c.revertData }).errorName).toMatch(/^BinShape/);
    }
  });
});

/* ------------------------------------------------------------------------- */

describe("leg supplies", () => {
  it("floors each leg and gives the last one the remainder", () => {
    const r = kitV2LegSupplies(1000n, [3333, 3333, 3334]);
    expect(r.problem).toBeNull();
    expect(r.supplies).toEqual([333n, 333n, 334n]);
  });
  it("reports the kit's errors", () => {
    expect(kitV2LegSupplies(1000n, [5000, 4000]).problem).toEqual({ error: "LegWeightsDoNotSum", sum: 9000 });
    expect(kitV2LegSupplies(5n, [1, 9999]).problem).toEqual({ error: "EmptyLeg", index: 0 });
  });
});

/* ------------------------------------------------------------------------- */

describe("launch value", () => {
  it("minimum is fee + integrator fee; safeValue covers an announced increase", () => {
    const q = computeLaunchValue({ launchFeeWei: 10n, integratorFeeWei: 3n, pending: { feeWei: 25n, effectiveAt: 1_800_000_000n } });
    expect(q.minimumValue).toBe(13n);
    expect(q.safeValue).toBe(28n);
    expect(computeLaunchValue({ launchFeeWei: 10n, integratorFeeWei: 0n, pending: null }).safeValue).toBe(10n);
  });

  it("decodes pendingLaunchFee's (0, 0) as none", () => {
    expect(decodePendingLaunchFee([0n, 0n])).toBeNull();
    expect(decodePendingLaunchFee([5n, 9n])).toEqual({ feeWei: 5n, effectiveAt: 9n });
  });

  const TENANT = "0x00000000000000000000000000000000000071E7" as Address;
  const INTEGRATOR = "0x0000000000000000000000000000000000001478" as Address;
  const cfg = {
    integrator: INTEGRATOR,
    integratorBps: 1000,
    integratorLaunchFeeWei: 7n,
    allowedPresets: 0b10011, // Custom, FairLaunch, NoTax
    allowedBinShapes: 0b00110, // Flat, Linear
    restrictQuotes: true,
    active: true,
    maxTaxBps: 0,
    taxIntegratorBps: 0,
  };

  it("decodes a tenant config's masks into names", () => {
    const d = decodeTenantConfig(cfg);
    expect(d.allowedPresets).toEqual(["Custom", "FairLaunch", "NoTax"]);
    expect(d.allowedBinShapes).toEqual(["Flat", "Linear"]);
    expect(d.configured).toBe(true);
    expect(decodeTenantConfig({ ...cfg, allowedPresets: 0 }).configured).toBe(false);
  });

  function kitClient(tenant: typeof cfg): PublicClient {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "launchFeeWei":
            return 1_000n;
          case "pendingLaunchFee":
            return [0n, 0n];
          case "tenantConfig":
            return tenant;
          case "maxIntegratorLaunchFeeWei":
            return 500n;
          case "gullyDesignated":
            throw Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
          default:
            throw new Error(functionName);
        }
      },
    } as unknown as PublicClient;
  }

  it("reads the tenant's stored integrator fee instead of trusting a typed one", async () => {
    const q = await readLaunchValue(kitClient(cfg), TENANT, { tenant: TENANT });
    expect(q.minimumValue).toBe(1_007n);
    await expect(readLaunchValue(kitClient(cfg), TENANT, { tenant: TENANT, integratorLaunchFeeWei: 8n })).rejects.toThrow(/TenantConfigMismatch/);
    await expect(readLaunchValue(kitClient({ ...cfg, active: false }), TENANT, { tenant: TENANT })).rejects.toThrow(/TenantNotActive/);
  });

  it("enforces the integrator fee cap on a direct launch", async () => {
    await expect(readLaunchValue(kitClient(cfg), TENANT, { integratorLaunchFeeWei: 501n })).rejects.toThrow(/IntegratorFeeAboveCap/);
    expect((await readLaunchValue(kitClient(cfg), TENANT, { integratorLaunchFeeWei: 500n })).minimumValue).toBe(1_500n);
  });
});

/* ------------------------------------------------------------------------- */

describe("validateLaunchParamsV2", () => {
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const QUOTE = "0x796f2974e3C1af763252512dd6d521E9E984726C" as Address;
  const token = V.legKeys.cases.find((c) => lc(c.quote) === lc(QUOTE))!.token;
  const is0 = BigInt(token) < BigInt(QUOTE);
  const caps = KIT_V2_DEPLOY_SCRIPT_CAPS;

  function clLeg(weightBps: number): LegParamsV2 {
    return {
      kind: LEG_KIND.CL,
      quote: QUOTE,
      weightBps,
      maxBuyPerTx: 0n,
      cl: kitV2CLLaunchRange({ launchTokenIsCurrency0: is0, sqrtPriceX96: 1n << 96n, tickSpacing: 60, widthInSpacings: 999 }),
      bin: { binStep: 0, activeId: 0, shape: 0, binCount: 0, offsets: [], weights: [], floorBins: 0 },
    };
  }
  function binLeg(weightBps: number, binCount: number, quote: Address = QUOTE): LegParamsV2 {
    return {
      kind: LEG_KIND.Bin,
      quote,
      weightBps,
      maxBuyPerTx: 0n,
      cl: { tickSpacing: 0, sqrtPriceX96: 0n, tickLower: 0, tickUpper: 0 },
      bin: { binStep: 10, activeId: 2 ** 23, shape: BIN_SHAPE.Linear, binCount, offsets: [], weights: [], floorBins: 0 },
    };
  }
  /** The fixture's CL + Bin launch, which the kit's own tests execute successfully. */
  function params(legs: LegParamsV2[], preset: number = PRESET.FairLaunch): LaunchParamsV2 {
    return {
      name: "Launch",
      symbol: "LNCH",
      metadataURI: "ipfs://example",
      userSalt: "0xdb897edfdb12f72177388a05c0542889bdcd83477bed12e3d1fff16d5ca91830",
      totalSupply: 1_000_000_000n * 10n ** 18n,
      seedSupply: 800_000_000n * 10n ** 18n,
      allocationRecipient: "0x00000000000000000000000000000000000A110C",
      creator: "0x000000000000000000000000000000000000C4EA",
      launchOperator: "0x0000000000000000000000000000000000000B0B",
      launchSteward: "0x00000000000000000000000000000000000057E3",
      tenant: ZERO,
      integrator: "0x0000000000000000000000000000000000001478",
      integratorBps: 1000,
      integratorLaunchFeeWei: 0n,
      creatorBps: 7000,
      protocolBps: 2000,
      schedule: { preset, initialFeeBips: 0, finalFeeBips: 0, decaySeconds: 0, enabled: false, startDelaySeconds: 120 },
      tax: { buyBps: 0, sellBps: 0, taxSeconds: 0, creatorBps: 0, protocolBps: 0, integratorBps: 0 },
      legs,
      listing: { description: "A kit v2 test launch.", websiteURI: "https://example.invalid", xHandle: "", telegramHandle: "" },
    };
  }
  const errors = (p: LaunchParamsV2, extra = {}) =>
    validateLaunchParamsV2(p, { caps, token, ...extra }).filter((i) => i.severity === "error");

  it("accepts the kit test suite's CL + Bin launch", () => {
    expect(errors(params([clLeg(6000), binLeg(4000, 10)]))).toEqual([]);
  });

  it("caps legs at maxLegs (4 from the deploy script)", () => {
    const five = [clLeg(2000), binLeg(2000, 5), binLeg(2000, 5, ZERO), clLeg(2000), clLeg(2000)];
    expect(errors(params(five)).map((e) => e.contractError)).toContain("InvalidLegCount");
  });

  it("caps bins per leg at maxBinsPerLeg (20 from the deploy script)", () => {
    const e = errors(params([binLeg(10_000, 21)]));
    expect(e.map((x) => x.contractError)).toContain("BinShapeBadCount");
    expect(e.find((x) => x.contractError === "BinShapeBadCount")?.rule).toBe("R4");
    expect(errors(params([binLeg(10_000, 20)]))).toEqual([]);
  });

  it("refuses 50% presets on any launch with a Bin leg, and allows them CL-only", () => {
    for (const preset of [PRESET.Stealth, PRESET.AntiSniperAggressive]) {
      expect(errors(params([clLeg(6000), binLeg(4000, 10)], preset)).map((x) => x.contractError)).toContain("PresetUnavailableOnBin");
    }
    expect(errors(params([clLeg(10_000)], PRESET.Stealth))).toEqual([]);
    expect(errors(params([binLeg(10_000, 10)], PRESET.NoTax))).toEqual([]);
  });

  it("requires a buy cap on CL legs under AntiSniperAggressive", () => {
    expect(errors(params([clLeg(10_000)], PRESET.AntiSniperAggressive)).map((x) => x.contractError)).toEqual(["MaxBuyRequiredByPreset"]);
  });

  it("names the Bin rule for a custom distribution, and the CL side rule", () => {
    const custom = binLeg(4000, 0);
    const bad: LegParamsV2 = { ...custom, bin: { ...custom.bin, shape: BIN_SHAPE.Custom, offsets: [1, 3], weights: [5n * 10n ** 17n, 5n * 10n ** 17n], floorBins: 2 } };
    const e = errors(params([clLeg(6000), bad]));
    expect(e.map((x) => [x.contractError, x.rule])).toEqual([["BinShapeGapBelowFloor", "R3"]]);

    const wrongSide: LegParamsV2 = { ...clLeg(10_000), cl: kitV2CLLaunchRange({ launchTokenIsCurrency0: !is0, sqrtPriceX96: 1n << 96n, tickSpacing: 60, widthInSpacings: 5 }) };
    expect(errors(params([wrongSide])).map((x) => x.contractError)).toEqual(["RangeNotSingleSided"]);
  });

  it("applies a supplied tenant config", () => {
    const tenant = decodeTenantConfig({
      integrator: "0x0000000000000000000000000000000000001478",
      integratorBps: 1000,
      integratorLaunchFeeWei: 0n,
      allowedPresets: 1 << PRESET.NoTax,
      allowedBinShapes: 1 << BIN_SHAPE.Flat,
      restrictQuotes: true,
      active: true,
      maxTaxBps: 0,
      taxIntegratorBps: 0,
    });
    const p = { ...params([clLeg(6000), binLeg(4000, 10)]), tenant: "0x00000000000000000000000000000000000071E7" as Address };
    const codes = errors(p, { tenantConfig: tenant, tenantAllowedQuotes: [] }).map((x) => x.contractError);
    expect(codes).toEqual(expect.arrayContaining(["PresetNotAllowed", "BinShapeNotAllowed", "QuoteNotAllowed"]));
  });
});

/* ------------------------------------------------------------------------- */

describe("address book", () => {
  it("records kit v2 wholly where the kit is deployed - never a kit without its stack", () => {
    /* A kit with a PARTIAL stack is the dangerous state. Every consumer
       reads several of these addresses in one flow, so a chain with a kit but no locker
       passes a null check on the field it happens to test and fails at the next.

       The other half is real and recorded as it is: BNB, Robinhood and Base (2026-10-10) carry
       the launch token factory, both lockers and the guard(s) but NO kit. With the kit null,
       `requireLaunchpadV2` refuses the group, so nothing can launch through it. */
    const book: Readonly<Record<number, GullyCoreDeployment>> = GULLYCORE_DEPLOYMENTS;
    for (const id of GULLYCORE_CHAIN_IDS as readonly number[]) {
      const g = book[id]!.launchpadV2;
      expect(Object.keys(g).sort()).toEqual(
        ["binLPLocker", "binLaunchGuardHook", "clLPLocker", "clLaunchGuardHook", "launchLegs", "launchTokenFactory", "launchpadKitV2", "padFactory"],
      );
      const values = Object.values(g);
      const deployed = values.filter((v) => v !== null);
      if (g.launchpadKitV2 !== null) {
        expect(deployed.length, `chain ${id} has a kit with ${deployed.length} of ${values.length} kit v2 addresses - a half stack`).toBe(values.length);
      }
      for (const v of deployed) expect(v).toMatch(/^0x[0-9a-fA-F]{40}$/);
      if (deployed.length !== values.length) {
        expect(() => requireLaunchpadV2(book[id]!)).toThrow(/not deployed/);
      } else {
        expect(() => requireLaunchpadV2(book[id]!)).not.toThrow();
      }
    }
  });
});

/* ------------------------------------------------------------------------- */

const LAUNCHPAD = join(HERE, "..", "..", "launchpad");
const SHAPES_SOL = join(LAUNCHPAD, "src", "libraries", "BinLaunchShapes.sol");
const KIT_SOL = join(LAUNCHPAD, "src", "LaunchpadKitV2.sol");
const DEPLOY_SOL = join(LAUNCHPAD, "script", "DeployLaunchpadKitV2.s.sol");

/* Monorepo-only; the public mirror has no Solidity. See launchpadPrice.test.ts. */
describe.skipIf(!existsSync(SHAPES_SOL) || !existsSync(KIT_SOL) || !existsSync(DEPLOY_SOL))(
  "constants match the Solidity",
  () => {
    const num = (src: string, re: RegExp): number => {
      const m = re.exec(src);
      if (!m) throw new Error(`pattern not found: ${re}`);
      return Number((m[1] as string).replace(/_/g, ""));
    };

    it("BinLaunchShapes parameters", () => {
      const src = readFileSync(SHAPES_SOL, "utf8");
      expect(num(src, /EXP_RATIO_NUM = (\d+);/)).toBe(9);
      expect(num(src, /EXP_RATIO_DEN = (\d+);/)).toBe(10);
      expect(num(src, /STEP_TIER_BINS = (\d+);/)).toBe(4);
      expect(num(src, /STEP_GAP_BINS = (\d+);/)).toBe(2);
    });

    it("kit bitmaps and bounds", () => {
      const src = readFileSync(KIT_SOL, "utf8");
      /* The kit in this tree is built for ONE generation of guard, and which one changes when
         the guards do. Whichever it is, both constants must be launch-guard bitmaps the SDK
         carries, each of its own pool type, and of the same generation. */
      const hex = (re: RegExp): number => {
        const all = [...src.matchAll(re)];
        if (all.length !== 1) throw new Error(`${re} matched ${all.length} times, expected one declaration`);
        return Number((all[0] as RegExpMatchArray)[1]);
      };
      const cl = hex(/uint16 public constant CL_HOOK_BITMAP = (0x[0-9A-Fa-f]{4});/g);
      const bin = hex(/uint16 public constant BIN_HOOK_BITMAP = (0x[0-9A-Fa-f]{4});/g);
      const generation = guardGenerationOf(cl, "CL");
      expect(generation).not.toBe("unknown");
      expect(guardGenerationOf(bin, "Bin")).toBe(generation);
      if (generation !== "unknown") expect({ CL: cl, Bin: bin }).toEqual(LAUNCH_GUARD_BITMAPS[generation]);
      /* The published constants are the lp-fee generation's, and stay that. */
      expect(KIT_V2_CL_HOOK_BITMAP).toBe(0x08c1);
      expect(KIT_V2_BIN_HOOK_BITMAP).toBe(0x08c5);
      expect(LAUNCH_GUARD_BITMAPS).toEqual({ "lp-fee": { CL: 0x08c1, Bin: 0x08c5 }, "quote-fee": { CL: 0x0cc1, Bin: 0x0cc5 } });
      expect(/MAX_START_DELAY_SECONDS = 30 days;/.test(src)).toBe(true);
      expect(/s\.initialFeeBips > LPFeeLibrary\.TEN_PERCENT_FEE\) revert PresetUnavailableOnBin/.test(src)).toBe(true);
    });

    it("KIT_V2_DEPLOY_SCRIPT_CAPS is what DeployLaunchpadKitV2 deploys", () => {
      const src = readFileSync(DEPLOY_SOL, "utf8");
      expect(num(src, /uint8 internal constant MAX_LEGS = (\d+);/)).toBe(KIT_V2_DEPLOY_SCRIPT_CAPS.maxLegs);
      expect(num(src, /uint16 internal constant MAX_BINS_PER_LEG = (\d+);/)).toBe(KIT_V2_DEPLOY_SCRIPT_CAPS.maxBinsPerLeg);
    });
  },
);
