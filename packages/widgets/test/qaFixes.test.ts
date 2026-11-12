// SPDX-License-Identifier: MIT
/**
 * The QA fixes of 2026-09-19: deadlines from the chain's clock, readable
 * refusals instead of raw viem text, the flip that carries the received
 * amount across, and the paired amount of a one-sided CL deposit.
 */

import { describe, expect, it } from "vitest";
import { BaseError, encodeErrorResult, parseAbi } from "viem";
import { UnsupportedOperationError } from "../src/adapters/protocol.js";
import { chainDeadline, defaultDeadline, type ChainConfig } from "../src/config/chain.js";
import { describeError, decodeRevertName } from "../src/core/errors.js";
import {
  amountsForLiquidity,
  clRangeSide,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  pairedAmountForRange,
} from "../src/core/clMath.js";
import { INITIAL_SWAP_STATE, swapWidgetReducer } from "../src/components/swap/state.js";

const chain = { defaultDeadlineSeconds: 1200 } as unknown as ChainConfig;

describe("deadline", () => {
  it("uses the chain's clock when it is ahead of the local one", () => {
    const ahead = BigInt(Math.floor(Date.now() / 1000)) + 3n * 86_400n;
    expect(defaultDeadline(chain, ahead)).toBe(ahead + 1200n);
  });
  it("never goes below local time + window when the chain's last block is old", () => {
    const local = BigInt(Math.floor(Date.now() / 1000));
    expect(defaultDeadline(chain, local - 10_000n) >= local + 1200n).toBe(true);
  });
  it("reads the block through the adapter and falls back on a failed read", async () => {
    const ahead = BigInt(Math.floor(Date.now() / 1000)) + 5n * 86_400n;
    expect(await chainDeadline(chain, { getBlockTimestamp: async () => ahead })).toBe(ahead + 1200n);
    const fallback = await chainDeadline(chain, { getBlockTimestamp: async () => Promise.reject(new Error("rpc down")) });
    expect(fallback >= BigInt(Math.floor(Date.now() / 1000)) + 1200n).toBe(true);
  });
});

describe("describeError", () => {
  it("decodes the router's deadline error out of anvil's message", () => {
    const e = new Error("execution reverted: custom error 0x5bf6f916");
    expect(describeError(e, "swap")).toMatch(/deadline passed/);
  });
  it("decodes revert data carried on a cause", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error TradingNotOpen(bytes32 poolId, uint256 startTime, uint256 currentTime)"]), errorName: "TradingNotOpen", args: [`0x${"11".repeat(32)}`, 2n, 1n] });
    const e = new BaseError("The contract function reverted.", { cause: Object.assign(new Error("inner"), { data }) as never });
    expect(describeError(e)).toMatch(/has not opened yet/);
  });
  it("unwraps core's WrappedError around a hook refusal", () => {
    const inner = encodeErrorResult({ abi: parseAbi(["error BuyExceedsMaxPerTx(uint256 amountIn, uint128 maxBuyPerTx)"]), errorName: "BuyExceedsMaxPerTx", args: [5n, 1n] });
    const wrapped = encodeErrorResult({
      abi: parseAbi(["error WrappedError(address target, bytes4 selector, bytes reason, bytes details)"]),
      errorName: "WrappedError",
      args: ["0x0000000000000000000000000000000000000001", "0x12345678", inner, "0x"],
    });
    expect(decodeRevertName(wrapped)).toBe("BuyExceedsMaxPerTx");
  });
  it("never prints the package tag or viem's report for a failed quote", () => {
    const e = new UnsupportedOperationError("quoteSwap", "every direct pool for this pair failed to quote: The contract function \"quoteExactInputSingle\" reverted.\n\nDocs: https://viem.sh");
    const text = describeError(e, "quote");
    expect(text).not.toMatch(/@gullylabs|viem|Docs:/);
    expect(text).toMatch(/No pool could quote this trade/);
  });
  it("names a wallet rejection", () => {
    expect(describeError(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toMatch(/rejected/);
  });
});

describe("flip carries the received amount", () => {
  it("replaces the typed amount when the flip carries one, keeps it otherwise", () => {
    const typed = swapWidgetReducer(INITIAL_SWAP_STATE, { type: "amount", text: "300000" });
    expect(swapWidgetReducer(typed, { type: "set-side", side: "sell", amountText: "0.301" }).amountText).toBe("0.301");
    expect(swapWidgetReducer(typed, { type: "set-side", side: "sell", amountText: "" }).amountText).toBe("");
    expect(swapWidgetReducer(typed, { type: "set-side", side: "sell" }).amountText).toBe("300000");
  });
});

describe("one-sided CL deposit", () => {
  const lower = 137_460;
  const upper = 138_720;
  const price = getSqrtRatioAtTick(138_094);
  it("classifies the range against the price", () => {
    expect(clRangeSide(price, lower, upper)).toBe("both");
    expect(clRangeSide(price, 138_120, 138_720)).toBe("token0-only");
    expect(clRangeSide(price, 137_460, 138_060)).toBe("token1-only");
  });
  it("pairs token0 with the token1 the same liquidity needs, and the pair mints that liquidity", () => {
    const amount0 = 10n ** 17n;
    const amount1 = pairedAmountForRange(price, lower, upper, "token0", amount0);
    expect(amount1).not.toBeNull();
    const liquidity = getLiquidityForAmounts(price, getSqrtRatioAtTick(lower), getSqrtRatioAtTick(upper), amount0, amount1 as bigint);
    expect(liquidity > 0n).toBe(true);
    const spent = amountsForLiquidity(price, lower, upper, liquidity, true);
    expect(spent.amount0 <= amount0 + 1n).toBe(true);
    expect(spent.amount1 <= (amount1 as bigint) + 1n).toBe(true);
  });
  it("pairs token1 the other way round", () => {
    const amount1 = 10n ** 24n;
    const amount0 = pairedAmountForRange(price, lower, upper, "token1", amount1);
    expect(amount0 !== null && amount0 > 0n).toBe(true);
  });
  it("refuses to pair outside the range", () => {
    expect(pairedAmountForRange(price, 138_120, 138_720, "token0", 1n)).toBeNull();
  });
});
