import { describe, expect, it } from "vitest";

import { binShareBar, poolShareBar, releaseSchedule, shareBarFromBps, tokenShareBar } from "../src/locks/model.js";

const pool = (active: bigint) => ({ poolId: "0x" as const, sqrtPriceX96: 1n, tick: 0, lpFee: 3000, activeLiquidity: active });

describe("lock share bars", () => {
  it("splits a pool's active liquidity into permanent and time-locked, the rest not locked", () => {
    const v = poolShareBar({ pool: pool(1000n), lockedActiveLiquidity: 600n, permanentActiveLiquidity: 400n, timeLockedActiveLiquidity: 200n })!;
    expect(v.parts.map((p) => [p.key, p.bps])).toEqual([
      ["permanent", 4000],
      ["time", 2000],
    ]);
    expect(v.restBps).toBe(4000);
    expect(v.of).toBe("of active liquidity");
  });

  it("draws no bar when no share is measurable (no active liquidity, or no pool state)", () => {
    expect(poolShareBar({ pool: pool(0n), lockedActiveLiquidity: 0n })).toBeNull();
    expect(poolShareBar({ pool: null, lockedActiveLiquidity: 0n })).toBeNull();
    expect(binShareBar({ activeBinLockedBps: null })).toBeNull();
  });

  it("keeps a part below 0.01% visible rather than dropping it", () => {
    const v = poolShareBar({ pool: pool(10n ** 9n), lockedActiveLiquidity: 1n, permanentActiveLiquidity: 0n, timeLockedActiveLiquidity: 1n })!;
    expect(v.parts).toEqual([{ key: "time", label: "Time-locked until a date", bps: 0, nonZero: true }]);
  });

  it("splits a token's supply into unvested, vested-unclaimed and permanent LP", () => {
    const v = tokenShareBar({ totalHeld: 300n, unvested: 200n, totalSupply: 1000n }, 100n)!;
    expect(v.parts.map((p) => [p.key, p.bps])).toEqual([
      ["unvested", 2000],
      ["vested", 1000],
      ["lp", 1000],
    ]);
    expect(v.restBps).toBe(6000);
    expect(tokenShareBar({ totalHeld: 1n, unvested: 1n, totalSupply: null })).toBeNull();
  });

  it("builds from basis points and returns null when nothing was read", () => {
    expect(shareBarFromBps([{ key: "permanent", label: "p", bps: null }], "of x")).toBeNull();
    expect(shareBarFromBps([{ key: "permanent", label: "p", bps: 2500 }], "of x")!.restBps).toBe(7500);
  });
});

describe("release schedule", () => {
  it("steps at the cliff and ends at the full amount, with the contract's formula", () => {
    const s = releaseSchedule([{ start: 0n, cliff: 50n, end: 100n, amount: 1000n }], 75n, 4)!;
    const at = (t: bigint) => s.points.find((p) => p.t === t)!.vested;
    expect(at(0n)).toBe(0n);
    expect(at(49n)).toBe(0n);
    expect(at(50n)).toBe(500n);
    expect(at(75n)).toBe(750n);
    expect(at(100n)).toBe(1000n);
    expect(s.total).toBe(1000n);
  });

  it("has no schedule to draw for a single instant or no locks", () => {
    expect(releaseSchedule([], null)).toBeNull();
    expect(releaseSchedule([{ start: 5n, cliff: 5n, end: 5n, amount: 1n }], null)).toBeNull();
  });
});
