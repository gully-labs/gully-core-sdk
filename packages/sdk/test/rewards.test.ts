// SPDX-License-Identifier: MIT
import { decodeAbiParameters, decodeFunctionData, keccak256, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  LP_REWARDS_ABI,
  LP_REWARDS_BITMAP,
  LP_REWARDS_KIND,
  RewardsInputError,
  buildAllowRewardToken,
  buildBurnCreditingRewards,
  buildClaim,
  buildClaimCredit,
  buildConfigureRewards,
  buildExtendStream,
  buildStartStream,
  buildTopUp,
  isRewardsPool,
  isWideEnough,
  lpRewardsHookOf,
  nftPositionKey,
  positionRewardsPerDay,
  rewardsPerDay,
  rewardsRecipientHookData,
  secondsLeft,
  type RewardStream,
} from "../src/rewards/index.js";
import { encodeCLPoolParameters } from "../src/types/parameters.js";
import type { PoolKey } from "../src/types/poolKey.js";

const HOOK = "0x7878000000000000000000000000000000000078" as Address;
const POSM = "0x2D608934De0684B151261cbdd71A9134bE349F9d" as Address;
const T0 = "0x1000000000000000000000000000000000000001" as Address;
const T1 = "0x2000000000000000000000000000000000000002" as Address;
const RWD = "0x3000000000000000000000000000000000000003" as Address;
const USER = "0x4000000000000000000000000000000000000004" as Address;

const key: PoolKey = {
  currency0: T0,
  currency1: T1,
  hooks: HOOK,
  poolManager: "0x5000000000000000000000000000000000000005" as Address,
  fee: 3000,
  parameters: encodeCLPoolParameters(LP_REWARDS_BITMAP, 10) as Hex,
};

const stream = (o: Partial<RewardStream> = {}): RewardStream => ({
  token: RWD,
  rateX64: (990n * 10n ** 18n << 64n) / 864_000n,
  periodFinish: 2_000_000n,
  lastUpdate: 1_000_000n,
  undistributed: 990n * 10n ** 18n,
  accruedUnpaid: 0n,
  refundRecipient: USER,
  ...o,
});

describe("rewards: identity", () => {
  it("kind is the contract's domain-separated constant", () => {
    expect(LP_REWARDS_KIND).toBe(keccak256(stringToHex("gullycore.liquidity-rewards.cl.v1")));
  });
  it("bitmap is beforeInitialize | beforeAdd | beforeRemove | afterSwap", () => {
    expect(LP_REWARDS_BITMAP).toBe((1 << 0) | (1 << 2) | (1 << 4) | (1 << 7));
  });
  it("reads the hook from a record, null when absent or zero", () => {
    expect(lpRewardsHookOf({ lpRewardsHook: HOOK })).toBe(HOOK);
    expect(lpRewardsHookOf({ lpRewardsHook: null })).toBeNull();
    expect(lpRewardsHookOf({})).toBeNull();
    expect(lpRewardsHookOf({ lpRewardsHook: zeroAddress })).toBeNull();
    expect(lpRewardsHookOf(undefined)).toBeNull();
  });
  it("recognises a rewards pool by address AND bitmap", () => {
    expect(isRewardsPool(key, HOOK)).toBe(true);
    expect(isRewardsPool(key, null)).toBe(false);
    expect(isRewardsPool({ ...key, hooks: USER }, HOOK)).toBe(false);
    expect(isRewardsPool({ ...key, parameters: encodeCLPoolParameters(0x0043, 10) as Hex }, HOOK)).toBe(false);
  });
});

describe("rewards: math in token units", () => {
  it("per day to the whole range", () => {
    expect(rewardsPerDay(stream().rateX64)).toBe(((990n * 10n ** 18n << 64n) / 864_000n * 86_400n) >> 64n);
    // 990e18 over 10 days is 99e18 a day, short of it by rounding only
    expect(99n * 10n ** 18n - rewardsPerDay(stream().rateX64) < 10n).toBe(true);
  });
  it("a position's share, and null when nothing is in range", () => {
    const r = stream().rateX64;
    expect(positionRewardsPerDay(r, 4n, 1n)).toBe((r * 86_400n) / (4n << 64n));
    expect(positionRewardsPerDay(r, 3n, 1n, false)).toBe((r * 86_400n) / (4n << 64n));
    expect(positionRewardsPerDay(r, 0n, 1n)).toBeNull();
    expect(positionRewardsPerDay(r, 5n, 0n)).toBeNull();
  });
  it("time left and width", () => {
    expect(secondsLeft(stream(), 1_999_000n)).toBe(1_000n);
    expect(secondsLeft(stream(), 3_000_000n)).toBe(0n);
    expect(isWideEnough(-100, 100, 200)).toBe(true);
    expect(isWideEnough(-100, 99, 200)).toBe(false);
    expect(isWideEnough(100, 100, 0)).toBe(false);
  });
  it("NFT position key: salt = bytes32(tokenId)", () => {
    const k = nftPositionKey(POSM, 255n, -10, 10);
    expect(k.salt).toBe(`0x${"0".repeat(62)}ff`);
    expect(k.sender).toBe(POSM);
    expect(() => nftPositionKey(POSM, -1n, 0, 1)).toThrow(RewardsInputError);
  });
});

describe("rewards: builders", () => {
  it("configure validates and encodes", () => {
    const tx = buildConfigureRewards(HOOK, key, { rewardTokens: [RWD], minWidthTicks: 100 });
    const d = decodeFunctionData({ abi: LP_REWARDS_ABI, data: tx.data });
    expect(d.functionName).toBe("configureRewards");
    expect(tx.value).toBe(0n);
    expect(() => buildConfigureRewards(HOOK, key, { rewardTokens: [RWD, RWD], minWidthTicks: 0 })).toThrow(/twice/);
    expect(() => buildConfigureRewards(HOOK, key, { rewardTokens: [T0, T1, RWD, USER], minWidthTicks: 0 })).toThrow(/at most 3/);
    expect(() => buildConfigureRewards(HOOK, key, { rewardTokens: [], minWidthTicks: -1 })).toThrow(RewardsInputError);
    expect(() => buildConfigureRewards(USER, key, { rewardTokens: [], minWidthTicks: 0 })).toThrow(/does not name/);
  });
  it("start: duration bounds, refund recipient, native value", () => {
    const base = { token: RWD, amount: 10n, durationSeconds: 86_400, refundRecipient: USER };
    expect(buildStartStream(HOOK, key, base).value).toBe(0n);
    expect(buildStartStream(HOOK, key, { ...base, token: zeroAddress }).value).toBe(10n);
    expect(() => buildStartStream(HOOK, key, { ...base, durationSeconds: 86_399 })).toThrow(/between/);
    expect(() => buildStartStream(HOOK, key, { ...base, durationSeconds: 365 * 86_400 + 1 })).toThrow(/between/);
    expect(() => buildStartStream(HOOK, key, { ...base, amount: 0n })).toThrow(RewardsInputError);
    expect(() => buildStartStream(HOOK, key, { ...base, refundRecipient: zeroAddress })).toThrow(/refund/);
  });
  it("extend: never moves the finish in, never lowers the rate", () => {
    const s = stream();
    const now = 1_500_000n;
    expect(() => buildExtendStream(HOOK, key, { token: RWD, amount: 1n, newFinish: 1_900_000n, now, stream: s })).toThrow(/move out/);
    expect(() => buildExtendStream(HOOK, key, { token: RWD, amount: 1n, newFinish: 3_000_000n, now, stream: s })).toThrow(/rate/);
    expect(() => buildExtendStream(HOOK, key, { token: RWD, amount: 1n, newFinish: 2_000_000n, now: 2_100_000n, stream: s })).toThrow(/no stream/);
    const tx = buildExtendStream(HOOK, key, { token: RWD, amount: 10n ** 24n, newFinish: 2_500_000n, now, stream: s });
    expect(decodeFunctionData({ abi: LP_REWARDS_ABI, data: tx.data }).functionName).toBe("extendStream");
  });
  it("top-up: refuses the last hour", () => {
    expect(() => buildTopUp(HOOK, key, RWD, 1n, stream(), 2_000_000n - 3_599n)).toThrow(/one hour/);
    expect(buildTopUp(HOOK, key, zeroAddress, 5n, stream({ token: zeroAddress }), 1_000_000n).value).toBe(5n);
  });
  it("claim and credit refuse a zero recipient", () => {
    const pos = nftPositionKey(POSM, 1n, -10, 10);
    expect(() => buildClaim(HOOK, "0x00", pos, zeroAddress)).toThrow(RewardsInputError);
    expect(() => buildClaimCredit(HOOK, RWD, zeroAddress)).toThrow(RewardsInputError);
    const d = decodeFunctionData({ abi: LP_REWARDS_ABI, data: buildClaim(HOOK, `0x${"11".repeat(32)}`, pos, USER).data });
    expect(d.functionName).toBe("claim");
    expect(buildAllowRewardToken(HOOK, key, RWD).to).toBe(HOOK);
  });
  it("burn crediting rewards: one position-manager call, hookData = the recipient word", () => {
    expect(rewardsRecipientHookData(USER)).toBe(`0x${"0".repeat(24)}${USER.slice(2).toLowerCase()}`);
    const tx = buildBurnCreditingRewards(POSM, { key, tokenId: 7n, recipient: USER, takeTo: USER, deadline: 99n });
    expect(tx.to).toBe(POSM);
    const [payload, deadline] = decodeAbiParameters([{ type: "bytes" }, { type: "uint256" }], `0x${tx.data.slice(10)}` as Hex);
    expect(deadline).toBe(99n);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], payload);
    expect(actions).toBe("0x0311");
    const [tokenId, , , hookData] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0] as Hex,
    );
    expect(tokenId).toBe(7n);
    expect(hookData).toBe(rewardsRecipientHookData(USER));
  });
});
