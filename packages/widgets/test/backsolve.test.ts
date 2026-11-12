// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { solveAmountIn } from "../src/core/backsolve.js";

/** A constant-product pool with a fee, as a quote function: out = y*x*(1-f) / (X + x*(1-f)). */
const pool = (X: bigint, Y: bigint, feeBps = 30n, cap: bigint | null = null) => async (x: bigint) => {
  if (cap !== null && x > cap) return null;
  const xf = (x * (10_000n - feeBps)) / 10_000n;
  return (Y * xf) / (X + xf);
};

describe("solveAmountIn (a typed output back-solved to an exact input)", () => {
  it("finds the smallest input whose quote reaches the target, within tolerance", async () => {
    const q = pool(1_000_000n * 10n ** 18n, 3_000_000n * 10n ** 6n);
    const target = 2_500n * 10n ** 6n;
    const r = await solveAmountIn(target, q, { seed: 10n ** 18n });
    expect(r).not.toBeNull();
    expect(r!.amountOut).toBeGreaterThanOrEqual(target);
    expect(r!.amountOut * 10_000n).toBeLessThanOrEqual(target * 10_010n);
    // One unit less would be short (or within tolerance of it): the input is not padded.
    expect((await q(r!.amountIn - r!.amountIn / 1000n))!).toBeLessThan(target);
    expect(r!.quotes).toBeLessThanOrEqual(24);
  });
  it("works from a seed far too large and far too small", async () => {
    const q = pool(10n ** 24n, 10n ** 24n);
    for (const seed of [1n, 10n ** 23n]) {
      const r = await solveAmountIn(10n ** 20n, q, { seed });
      expect(r!.amountOut).toBeGreaterThanOrEqual(10n ** 20n);
    }
  });
  it("returns null when no input reaches the target (more than the pool holds)", async () => {
    const q = pool(10n ** 18n, 10n ** 18n);
    expect(await solveAmountIn(2n * 10n ** 18n, q, { seed: 10n ** 15n })).toBeNull();
  });
  it("returns null when the venue refuses inputs before the target is reached (a launch range's end)", async () => {
    const q = pool(10n ** 21n, 10n ** 21n, 30n, 10n ** 19n);
    expect(await solveAmountIn(5n * 10n ** 19n, q, { seed: 10n ** 18n })).toBeNull();
  });
  it("solves under a cap when the target is reachable below it", async () => {
    const q = pool(10n ** 21n, 10n ** 21n, 30n, 10n ** 20n);
    const r = await solveAmountIn(5n * 10n ** 19n, q, { seed: 10n ** 17n });
    expect(r!.amountIn).toBeLessThanOrEqual(10n ** 20n);
    expect(r!.amountOut).toBeGreaterThanOrEqual(5n * 10n ** 19n);
  });
  it("treats a throwing quote as unfillable, never as a price", async () => {
    expect(await solveAmountIn(10n, async () => { throw new Error("rpc"); }, { seed: 1n })).toBeNull();
  });
});
