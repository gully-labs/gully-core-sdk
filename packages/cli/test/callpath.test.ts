import { positionAmounts } from "@gullylabs/core-sdk/lock";
import { sqrtRatioAtTick } from "@gullylabs/core-sdk";
import { verifySwapCalldata } from "@gullylabs/core-sdk/router";
import { decodeFunctionData, keccak256, encodeAbiParameters, zeroAddress } from "viem";
import { CL_POSITION_MANAGER_ABI, UNIVERSAL_ROUTER_ABI } from "@gullylabs/core-sdk/trading";
import { describe, expect, it } from "vitest";

import { binPositionId, buildBinAdd, buildClDecrease, buildClMint, buildPoolSwap, liquidityForAmounts, uniformBins } from "../src/lib/callpath.js";
import { BOOK, KEY, POOL_ID, SENDER, TOKEN_A, TOKEN_B } from "./helpers/fixture.js";

const swap = { router: BOOK.universalRouter, kind: "CL" as const, key: KEY, tokenIn: TOKEN_A, amountIn: 1000n, minOut: 990n, recipient: SENDER, sender: SENDER, deadline: 2_000_000_000n };
const facts = { tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 1000n, recipient: SENDER, minAmountOut: 990n, deadline: 2_000_000_000 };

describe("a pool swap, read back by the SDK's own checker", () => {
  it("passes verifySwapCalldata for an ERC-20 swap to the caller", () => {
    expect(() => verifySwapCalldata("universal-router", buildPoolSwap(swap), facts)).not.toThrow();
  });

  it("fails it when the facts differ, so the check is real", () => {
    const call = buildPoolSwap(swap);
    expect(() => verifySwapCalldata("universal-router", call, { ...facts, minAmountOut: 995n })).toThrow();
    expect(() => verifySwapCalldata("universal-router", call, { ...facts, amountIn: 999n })).toThrow();
    expect(() => verifySwapCalldata("universal-router", call, { ...facts, tokenOut: TOKEN_A })).toThrow();
  });

  it("sends value only for a native input, and goes through the universal router", () => {
    expect(buildPoolSwap(swap).value).toBe(0n);
    const key = { ...KEY, currency0: zeroAddress };
    const native = buildPoolSwap({ ...swap, key, tokenIn: zeroAddress });
    expect(native.value).toBe(1000n);
    expect(decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: native.data }).functionName).toBe("execute");
  });

  it("pays another recipient when asked", () => {
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const call = buildPoolSwap({ ...swap, recipient: other });
    expect(() => verifySwapCalldata("universal-router", call, { ...facts, recipient: other })).not.toThrow();
    expect(() => verifySwapCalldata("universal-router", call, facts)).toThrow();
  });
});

describe("position-manager plans", () => {
  it("mint and decrease are modifyLiquidities calls", () => {
    const mint = buildClMint({ positionManager: BOOK.clPositionManager, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n, amount0Max: 5n, amount1Max: 5n, owner: SENDER, deadline: 1n, value: 0n });
    expect(decodeFunctionData({ abi: CL_POSITION_MANAGER_ABI, data: mint.data }).functionName).toBe("modifyLiquidities");
    const dec = buildClDecrease({ positionManager: BOOK.clPositionManager, key: KEY, tokenId: 7n, liquidity: 10n, amount0Min: 1n, amount1Min: 1n, deadline: 1n });
    expect(dec.value).toBe(0n);
  });

  it("a native side attaches value", () => {
    const add = buildBinAdd({ positionManager: BOOK.binPositionManager, key: KEY, amount0: 1n, amount1: 1n, amount0Max: 2n, amount1Max: 2n, activeId: 8_388_608, idSlippage: 5, ...uniformBins(1), to: SENDER, deadline: 1n, value: 2n });
    expect(add.value).toBe(2n);
  });
});

describe("bin shape and ids", () => {
  it("each side sums to exactly 1e18, X only above the active bin, Y only below", () => {
    for (const n of [0, 1, 2, 5, 7, 50]) {
      const s = uniformBins(n);
      expect(s.deltaIds).toHaveLength(n * 2 + 1);
      expect(s.distributionX.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n);
      expect(s.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n);
      s.deltaIds.forEach((d, i) => {
        if (d < 0) expect(s.distributionX[i]).toBe(0n);
        if (d > 0) expect(s.distributionY[i]).toBe(0n);
      });
    }
  });

  it("the position id is keccak(abi.encode(poolId, binId))", () => {
    const want = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [POOL_ID, 8_388_608n])));
    expect(binPositionId(POOL_ID, 8_388_608)).toBe(want);
  });
});

describe("liquidity maths", () => {
  it("the liquidity bought never needs more than the amounts given, and uses one side fully", () => {
    const tick = 0;
    const sqrt = sqrtRatioAtTick(tick);
    const [lower, upper] = [-1200, 1200];
    const a0 = 10n ** 18n;
    const a1 = 10n ** 18n / 2n;
    const l = liquidityForAmounts(sqrt, sqrtRatioAtTick(lower), sqrtRatioAtTick(upper), a0, a1);
    const need = positionAmounts({ liquidity: l, tickLower: lower, tickUpper: upper, tick, sqrtPriceX96: sqrt });
    expect(need.amount0 <= a0).toBe(true);
    expect(need.amount1 <= a1).toBe(true);
    expect(a1 - need.amount1 < a1 / 10n ** 9n).toBe(true);
  });

  it("a range above the price takes only currency0, below it only currency1", () => {
    const sqrt = sqrtRatioAtTick(0);
    expect(liquidityForAmounts(sqrt, sqrtRatioAtTick(600), sqrtRatioAtTick(1200), 10n ** 18n, 0n) > 0n).toBe(true);
    expect(liquidityForAmounts(sqrt, sqrtRatioAtTick(600), sqrtRatioAtTick(1200), 0n, 10n ** 18n)).toBe(0n);
    expect(liquidityForAmounts(sqrt, sqrtRatioAtTick(-1200), sqrtRatioAtTick(-600), 0n, 10n ** 18n) > 0n).toBe(true);
    expect(liquidityForAmounts(sqrt, sqrtRatioAtTick(-1200), sqrtRatioAtTick(-600), 10n ** 18n, 0n)).toBe(0n);
  });
});
