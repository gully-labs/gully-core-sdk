// SPDX-License-Identifier: MIT
/**
 * `buildLaunchAndBuyV2`: a launch and the creator's first buy through `GullyCoreLaunchAndBuy`.
 *
 * Driven with a fake client that answers exactly the reads the builder makes, with addresses
 * computed by the SDK's own CREATE2 rule. The checks: the token is the one the CONTRACT predicts
 * (the kit's caller is the contract, which folds the launcher into the salt), the launch half is
 * byte for byte what `buildLaunchParamsV2` builds for that token, the buy's bounds are the
 * limits' safe value and the schedule's opening fee, `msg.value` carries the buy only for a
 * native quote, and the contract's own refusals are reported as issues.
 */

import { decodeFunctionData, encodeFunctionResult, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_LAUNCH_AND_BUY_ABI,
  LAUNCH_GUARD_BITMAPS,
  NATIVE_ADDRESS,
  PRESET,
  buildLaunchAndBuyV2,
  buildLaunchParamsV2,
  decodeLaunchAndBuyResult,
  encodeLaunchAndBuyV2,
  kitV2LaunchSalt,
  openingFeePips,
  predictLaunchTokenAddress,
  type KitV2Limits,
  type LaunchDraftV2,
} from "../src/index.js";

const KIT: Address = "0x00000000000000000000000000000000000000e1";
const LNB: Address = "0x00000000000000000000000000000000000000e9";
const FACTORY: Address = "0x00000000000000000000000000000000000000f1";
const CREATOR: Address = "0x0000000000000000000000000000000000000c01";
const LAUNCHER: Address = "0x0000000000000000000000000000000000000c04";
const USD: Address = "0x8000000000000000000000000000000000000000";
const SALT: Hex = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const INIT_CODE_HASH: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111";
const E18 = 10n ** 18n;

function limits(): KitV2Limits {
  return {
    env: {
      kit: KIT,
      clHook: "0x00000000000000000000000000000000000000d1",
      binHook: "0x00000000000000000000000000000000000000d2",
      clPoolManager: "0x00000000000000000000000000000000000000a2",
      binPoolManager: "0x00000000000000000000000000000000000000a3",
      clPositionManager: "0x0000000000000000000000000000000000000d01",
      binPositionManager: "0x0000000000000000000000000000000000000d02",
      clLocker: "0x00000000000000000000000000000000000000b1",
      binLocker: "0x00000000000000000000000000000000000000b2",
      tokenFactory: FACTORY,
      launchRegistry: "0x00000000000000000000000000000000000000f2",
      protocolFeeRecipient: "0x00000000000000000000000000000000000000f3",
      clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL,
      binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin,
    },
    caps: { maxLegs: 4, maxBinsPerLeg: 20 },
    guard: { minDecaySeconds: 60, maxDecaySeconds: 2_592_000, maxInitialFeeBips: 500_000, maxFinalFeeBips: 100_000, maxStartDelaySeconds: 2_592_000 },
    locker: { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 },
    tax: { maxTaxBps: 1_000, minProtocolBps: 1_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000, maxTaxDurationSeconds: 15_552_000 },
    feeSplit: { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 },
    lpShareBps: { CL: 2_000, Bin: 2_000 },
    maxIntegratorLaunchFeeWei: 10n ** 16n,
    maxLaunchFeeWei: 10n ** 16n,
    token: { maxNameBytes: 64, maxSymbolBytes: 16, maxMetadataUriBytes: 256 },
    value: { launchFeeWei: 1_000n, integratorFeeWei: 0n, minimumValue: 1_000n, pending: { feeWei: 1_500n, effectiveAt: 99n }, safeValue: 1_500n },
    tenantAddress: null,
    tenant: null,
    tenantAllowedQuotes: [],
    integrator: { address: NATIVE_ADDRESS, bps: 0, launchFeeWei: 0n, taxBps: 0, source: "direct" },
  } as KitV2Limits;
}

function draft(overrides: Partial<LaunchDraftV2> = {}): LaunchDraftV2 {
  return {
    name: "Test Token",
    symbol: "TT",
    metadataURI: "ipfs://meta",
    totalSupply: 1_000_000_000n * E18,
    seedSupply: 1_000_000_000n * E18,
    allocationRecipient: NATIVE_ADDRESS,
    creator: CREATOR,
    operator: LAUNCHER,
    steward: LAUNCHER,
    protocolBps: 2_000,
    schedule: { preset: PRESET.Custom, initialFeeBips: 100_000, finalFeeBips: 10_000, decaySeconds: 300, startDelaySeconds: 0 },
    legs: [
      {
        kind: "CL",
        quote: NATIVE_ADDRESS,
        quoteDecimals: 18,
        weightBps: 10_000,
        quotePerLaunchToken: "0.0000001",
        maxBuyPerTx: 0n,
        tickSpacing: 60,
        widthInSpacings: 200,
        binStep: 0,
        shape: "Custom",
        binCount: 0,
      },
    ],
    listing: { description: "", websiteURI: "", xHandle: "", telegramHandle: "" },
    userSalt: SALT,
    launcher: LAUNCHER,
    ...overrides,
  };
}

const folded = kitV2LaunchSalt(LAUNCHER, SALT);
const viaContract = predictLaunchTokenAddress({ kit: KIT, factory: FACTORY, initCodeHash: INIT_CODE_HASH, launcher: LNB, userSalt: folded });
const direct = predictLaunchTokenAddress({ kit: KIT, factory: FACTORY, initCodeHash: INIT_CODE_HASH, launcher: LAUNCHER, userSalt: SALT });

/** Answers the reads the builder makes: the kit's checked predictor (for the contract as caller) and the contract's two views. */
function client(opts: { contractSays?: Address; contractKit?: Address } = {}): PublicClient {
  return {
    async readContract(req: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> {
      if (req.address === KIT && req.functionName === "tokenFactory") return FACTORY;
      if (req.address === FACTORY && req.functionName === "launchTokenInitCodeHash") return INIT_CODE_HASH;
      if (req.address === KIT && req.functionName === "predictLaunchToken") {
        expect(req.args).toEqual([LNB, folded]);
        return viaContract;
      }
      if (req.address === LNB && req.functionName === "predictLaunchToken") {
        expect(req.args).toEqual([LAUNCHER, SALT]);
        return opts.contractSays ?? viaContract;
      }
      if (req.address === LNB && req.functionName === "KIT") return opts.contractKit ?? KIT;
      throw new Error(`fake: unexpected readContract ${req.functionName} at ${req.address}`);
    },
  } as unknown as PublicClient;
}

const errors = (issues: readonly { severity: string; contractError?: string }[]): string[] => issues.filter((i) => i.severity === "error").map((i) => i.contractError ?? "?");

describe("openingFeePips: the contract's previewOpeningFee rule", () => {
  it("reads a named preset's own numbers, and a disabled one's final fee", () => {
    expect(openingFeePips({ preset: PRESET.FairLaunch, initialFeeBips: 0, finalFeeBips: 0 })).toBe(100_000);
    expect(openingFeePips({ preset: PRESET.AntiSniperAggressive, initialFeeBips: 0, finalFeeBips: 0 })).toBe(500_000);
    expect(openingFeePips({ preset: PRESET.Stealth, initialFeeBips: 0, finalFeeBips: 0 })).toBe(500_000);
    expect(openingFeePips({ preset: PRESET.NoTax, initialFeeBips: 0, finalFeeBips: 0 })).toBe(10_000);
  });
  it("takes a Custom schedule as sent", () => {
    expect(openingFeePips({ preset: PRESET.Custom, initialFeeBips: 100_000, finalFeeBips: 10_000, enabled: true })).toBe(100_000);
    expect(openingFeePips({ preset: PRESET.Custom, initialFeeBips: 100_000, finalFeeBips: 10_000, enabled: false })).toBe(10_000);
  });
});

describe("buildLaunchAndBuyV2", () => {
  it("launches at the address the contract predicts, which is not the direct launch's", async () => {
    const built = await buildLaunchAndBuyV2(client(), { launchAndBuy: LNB, kit: KIT }, draft(), limits(), { legIndex: 0, amountIn: E18, minAmountOut: 0n });
    expect(built.token).toBe(viaContract);
    expect(built.token).not.toBe(direct);
    expect(built.to).toBe(LNB);
    expect(built.kit).toBe(KIT);
    expect(errors(built.issues)).toEqual([]);
  });

  it("carries the launch exactly as buildLaunchParamsV2 builds it, with the RAW salt (the contract folds it)", async () => {
    const d = draft()
    const built = await buildLaunchAndBuyV2(client(), { launchAndBuy: LNB, kit: KIT }, d, limits(), { legIndex: 0, amountIn: E18, minAmountOut: 5n });
    const pure = buildLaunchParamsV2(d, { token: viaContract, limits: limits() });
    expect(built.params).toEqual(pure.params);
    expect(built.params.userSalt).toBe(SALT);
    const decoded = decodeFunctionData({ abi: GULLYCORE_LAUNCH_AND_BUY_ABI, data: built.data });
    expect(decoded.functionName).toBe("launchAndBuy");
    /* Byte for byte: the launch half re-encodes to the same calldata (decoding checksums addresses). */
    expect(built.data).toBe(encodeLaunchAndBuyV2(pure.params, built.buy));
    expect(decoded.args[1]).toEqual({
      legIndex: 0,
      amountIn: E18,
      minAmountOut: 5n,
      recipient: getAddress(LAUNCHER),
      expectedToken: viaContract,
      maxLaunchFeeWei: 1_500n,
      maxLpFeePips: 100_000,
    });
  });

  it("sends the safe launch value plus the buy for a native quote, and asks for no approval", async () => {
    const built = await buildLaunchAndBuyV2(client(), { launchAndBuy: LNB, kit: KIT }, draft(), limits(), { legIndex: 0, amountIn: 7n * E18, minAmountOut: 0n });
    expect(built.value).toBe(1_500n + 7n * E18);
    expect(built.approval).toBeNull();
  });

  it("sends only the launch value for an ERC-20 quote, and names the approval the contract pulls against", async () => {
    const d = draft({ legs: [{ ...draft().legs[0]!, quote: USD, quoteDecimals: 6 }] });
    const built = await buildLaunchAndBuyV2(client(), { launchAndBuy: LNB, kit: KIT }, d, limits(), { legIndex: 0, amountIn: 250_000_000n, minAmountOut: 0n });
    expect(built.value).toBe(1_500n);
    expect(built.approval).toEqual({ token: USD, spender: LNB, amount: 250_000_000n });
  });

  it("reports the contract's own refusals: a delayed start, a missing leg, an empty buy", async () => {
    const d = draft({ schedule: { ...draft().schedule, startDelaySeconds: 600 } });
    const built = await buildLaunchAndBuyV2(client(), { launchAndBuy: LNB, kit: KIT }, d, limits(), { legIndex: 3, amountIn: 0n, minAmountOut: 0n });
    expect(errors(built.issues)).toEqual(expect.arrayContaining(["StartDelayMustBeZero", "LegIndexOutOfRange", "ZeroBuyAmount"]));
  });

  it("refuses the contract as a payee", async () => {
    const built = await buildLaunchAndBuyV2(client(), { launchAndBuy: LNB, kit: KIT }, draft({ creator: LNB }), limits(), { legIndex: 0, amountIn: E18, minAmountOut: 0n });
    expect(errors(built.issues)).toContain("InvalidRecipient");
  });

  it("throws when the contract and the kit disagree about the address, or the contract launches through another kit", async () => {
    await expect(buildLaunchAndBuyV2(client({ contractSays: direct }), { launchAndBuy: LNB, kit: KIT }, draft(), limits(), { legIndex: 0, amountIn: E18, minAmountOut: 0n })).rejects.toThrow(/predicts/);
    await expect(
      buildLaunchAndBuyV2(client({ contractKit: "0x00000000000000000000000000000000000000e2" }), { launchAndBuy: LNB, kit: KIT }, draft(), limits(), { legIndex: 0, amountIn: E18, minAmountOut: 0n }),
    ).rejects.toThrow(/launches through/);
  });

  it("decodes what a simulation of the call returns", () => {
    const data = encodeFunctionResult({
      abi: GULLYCORE_LAUNCH_AND_BUY_ABI,
      functionName: "launchAndBuy",
      result: [{ token: viaContract, poolIds: ["0x" + "ab".repeat(32)] as Hex[], lockIds: [1n], startTime: 100, protocolFeeWei: 1_000n, integratorFeeWei: 0n }, 7n, 9n, 100_000],
    });
    expect(decodeLaunchAndBuyResult(data)).toEqual({ token: viaContract, poolIds: ["0x" + "ab".repeat(32)], quoteSpent: 7n, tokensBought: 9n, lpFeePips: 100_000 });
  });
});
