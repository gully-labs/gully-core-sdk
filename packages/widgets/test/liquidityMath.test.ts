// SPDX-License-Identifier: MIT
/**
 * The liquidity arithmetic the live adapter quotes with, and the two encoder
 * details a native-side deposit depends on: the SWEEP that returns unspent
 * value, and a bin distribution whose rounding dust lands in a bin that can
 * take it.
 */

import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import { createCLPoolKey, NATIVE_CURRENCY } from "@gullylabs/core-sdk";
import { ACTIONS, BIN_DISTRIBUTION_SCALE, MSG_SENDER, POSITION_MANAGER_ABI } from "../src/callpath/constants.js";
import { buildCLMintCall } from "../src/callpath/liquidity.js";
import { buildUniformBinDistribution } from "../src/adapters/binDistribution.js";
import {
  amountsForLiquidity,
  assertTickMathSelfConsistent,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  Q96,
  uncollectedFees,
} from "../src/core/clMath.js";
import { binShareAmounts, binTokenId } from "../src/core/pool.js";
import { decodeFunctionData } from "viem";

const TOKEN_B = "0x000000000000000000000000000000000000000b" as const;
const MANAGER = "0x00000000000000000000000000000000000000a2" as const;
const POSITION_MANAGER = "0x00000000000000000000000000000000000000a5" as const;
const OWNER = "0x00000000000000000000000000000000000000ff" as const;

function actionsOf(data: `0x${string}`): number[] {
  const decoded = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data });
  const [actions] = decodeAbiParameters(
    [
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" },
    ],
    decoded.args[0] as `0x${string}`,
  );
  return (actions.slice(2).match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16));
}

describe("clMath", () => {
  it("reproduces TickMath's published bounds", () => {
    expect(() => assertTickMathSelfConsistent()).not.toThrow();
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
  });

  it("rounds an add up and a remove down, never crossing", () => {
    const sqrtPrice = getSqrtRatioAtTick(15);
    const liquidity = getLiquidityForAmounts(sqrtPrice, getSqrtRatioAtTick(-60), getSqrtRatioAtTick(60), 10n ** 18n, 10n ** 18n);
    expect(liquidity).toBeGreaterThan(0n);
    const add = amountsForLiquidity(sqrtPrice, -60, 60, liquidity, true);
    const remove = amountsForLiquidity(sqrtPrice, -60, 60, liquidity, false);
    expect(add.amount0).toBeGreaterThanOrEqual(remove.amount0);
    expect(add.amount1).toBeGreaterThanOrEqual(remove.amount1);
    expect(add.amount0 - remove.amount0).toBeLessThanOrEqual(2n);
    expect(add.amount1 - remove.amount1).toBeLessThanOrEqual(2n);
    // A range entirely above the price holds only currency0.
    expect(amountsForLiquidity(sqrtPrice, 60, 120, liquidity, false).amount1).toBe(0n);
  });

  it("credits fees from growth inside the range, wrapping like the pool's unchecked maths", () => {
    const zero = { feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n };
    const inside = 3n << 128n; // three units of currency0 per unit of liquidity
    const fees = uncollectedFees({
      liquidity: 5n,
      tickLower: -60,
      tickUpper: 60,
      currentTick: 0,
      feeGrowthGlobal0X128: inside,
      feeGrowthGlobal1X128: 0n,
      lower: zero,
      upper: zero,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    });
    expect(fees.fees0).toBe(15n);
    expect(fees.fees1).toBe(0n);
    // A "last" checkpoint ahead of global (a wrapped counter) still yields the modular difference.
    const wrapped = uncollectedFees({
      liquidity: 1n,
      tickLower: -60,
      tickUpper: 60,
      currentTick: 0,
      feeGrowthGlobal0X128: 1n << 128n,
      feeGrowthGlobal1X128: 0n,
      lower: zero,
      upper: zero,
      feeGrowthInside0LastX128: (1n << 256n) - (1n << 128n),
      feeGrowthInside1LastX128: 0n,
    });
    expect(wrapped.fees0).toBe(2n);
  });
});

describe("bin helpers", () => {
  it("derives the position manager's token id as keccak256(abi.encode(poolId, binId))", () => {
    const poolId = `0x${"11".repeat(32)}` as const;
    expect(binTokenId(poolId, 8_388_608)).toBe(binTokenId(poolId, 8_388_608));
    expect(binTokenId(poolId, 8_388_608)).not.toBe(binTokenId(poolId, 8_388_609));
  });

  it("values shares as the pool burns them: reserve * shares / totalShares, rounded down", () => {
    expect(binShareAmounts({ shares: 1n, totalShares: 3n, reserveX: 10n, reserveY: 7n })).toEqual({ amount0: 3n, amount1: 2n });
    expect(binShareAmounts({ shares: 0n, totalShares: 3n, reserveX: 10n, reserveY: 7n })).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("puts the Y rounding dust in the active bin, not in a bin that takes no Y", () => {
    // Three Y bins (-2, -1, 0): 1e18 / 3 leaves dust, which must land on bin 0.
    const shares = buildUniformBinDistribution(-2, 3, 0);
    const totalY = shares.reduce((sum, share) => sum + share.distributionY, 0n);
    const totalX = shares.reduce((sum, share) => sum + share.distributionX, 0n);
    expect(totalY).toBe(BIN_DISTRIBUTION_SCALE);
    expect(totalX).toBe(BIN_DISTRIBUTION_SCALE);
    for (const share of shares) {
      if (share.deltaId > 0) expect(share.distributionY).toBe(0n);
      if (share.deltaId < 0) expect(share.distributionX).toBe(0n);
    }
  });
});

describe("native-side deposits", () => {
  const key = createCLPoolKey({
    currency0: NATIVE_CURRENCY,
    currency1: TOKEN_B,
    hooks: "0x0000000000000000000000000000000000000000",
    poolManager: MANAGER,
    fee: 3_000,
    tickSpacing: 60,
  });
  const base = {
    positionManager: POSITION_MANAGER,
    poolKey: key,
    tickLower: -120,
    tickUpper: 120,
    liquidity: 1_000n,
    amount0Max: 10n ** 18n,
    amount1Max: 10n ** 18n,
    owner: OWNER,
    deadline: 1n,
  };

  it("sweeps unspent native value back to the sender when value is attached", () => {
    const call = buildCLMintCall({ ...base, value: 10n ** 18n });
    expect(actionsOf(call.data)).toEqual([ACTIONS.CL_MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP]);
    const decoded = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data: call.data });
    const [, params] = decodeAbiParameters(
      [
        { name: "actions", type: "bytes" },
        { name: "params", type: "bytes[]" },
      ],
      decoded.args[0] as `0x${string}`,
    );
    const [currency, to] = decodeAbiParameters(
      [
        { name: "currency", type: "address" },
        { name: "to", type: "address" },
      ],
      params[2] as `0x${string}`,
    );
    expect(currency).toBe(NATIVE_CURRENCY);
    expect(to).toBe(MSG_SENDER);
  });

  it("adds no sweep to an ERC-20-only deposit", () => {
    const call = buildCLMintCall(base);
    expect(actionsOf(call.data)).toEqual([ACTIONS.CL_MINT_POSITION, ACTIONS.SETTLE_PAIR]);
  });
});
