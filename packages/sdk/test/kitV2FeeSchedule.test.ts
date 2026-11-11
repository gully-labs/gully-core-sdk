// SPDX-License-Identifier: MIT
/**
 * A launch guard's fee for any second (`kitV2/feeSchedule.ts`).
 *
 * Nothing here is a chain. Every figure asserted is worked out in the comment
 * beside it from the contract's own rule:
 *
 *     opening - floor(spread * elapsed / decaySeconds)
 *
 * The last block reads `feeAt` and `_decayedFee` out of the Solidity when the
 * monorepo is present (the public mirror has none), so the rule above is a claim
 * about source that is checked, not remembered.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { guardFeeAt, guardFeePhaseAt, type GuardFeeSchedule } from "../src/index.js";

const START = 1_900_000_000n;

/** The kit's default shape: 50% decaying to 1% over a minute. */
const SCHEDULE: GuardFeeSchedule = { startTime: START, decaySeconds: 60, initialFeePips: 500_000, finalFeePips: 10_000, enabled: true };

describe("guardFeeAt", () => {
  it("is the opening fee before the window and at its first second", () => {
    expect(guardFeeAt(SCHEDULE, START - 1n)).toBe(500_000);
    expect(guardFeeAt(SCHEDULE, 0)).toBe(500_000);
    expect(guardFeeAt(SCHEDULE, START)).toBe(500_000);
  });

  it("decays linearly, flooring the discount so the rate rounds up", () => {
    // spread 490_000; 1 s: floor(490_000 * 1 / 60) = 8_166 -> 491_834
    expect(guardFeeAt(SCHEDULE, START + 1n)).toBe(491_834);
    // 30 s: floor(490_000 * 30 / 60) = 245_000 -> 255_000
    expect(guardFeeAt(SCHEDULE, START + 30n)).toBe(255_000);
    // 59 s, the last second above the final fee: floor(490_000 * 59 / 60) = 481_833 -> 18_167
    expect(guardFeeAt(SCHEDULE, START + 59n)).toBe(18_167);
  });

  it("is the final fee from the window's end on: the window is half open", () => {
    expect(guardFeeAt(SCHEDULE, START + 60n)).toBe(10_000);
    expect(guardFeeAt(SCHEDULE, START + 61n)).toBe(10_000);
    expect(guardFeeAt(SCHEDULE, START + 10n ** 9n)).toBe(10_000);
  });

  it("never leaves [final, opening] and never rises, second by second", () => {
    const s: GuardFeeSchedule = { startTime: START, decaySeconds: 97, initialFeePips: 333_333, finalFeePips: 3_001, enabled: true };
    let previous = guardFeeAt(s, START);
    for (let i = 1n; i <= 100n; i++) {
      const fee = guardFeeAt(s, START + i);
      expect(fee).toBeLessThanOrEqual(previous);
      expect(fee).toBeGreaterThanOrEqual(s.finalFeePips);
      expect(fee).toBeLessThanOrEqual(s.initialFeePips);
      previous = fee;
    }
    expect(previous).toBe(3_001);
  });

  it("is the final fee at every second when the schedule is not enabled", () => {
    const flat: GuardFeeSchedule = { ...SCHEDULE, enabled: false };
    expect(guardFeeAt(flat, START - 1_000n)).toBe(10_000);
    expect(guardFeeAt(flat, START)).toBe(10_000);
    expect(guardFeeAt(flat, START + 30n)).toBe(10_000);
    // The opening figure of a schedule that is off is not validated against the final one: it is never charged.
    expect(guardFeeAt({ ...flat, initialFeePips: 0 }, START)).toBe(10_000);
  });

  it("is flat when the spread is zero", () => {
    const s: GuardFeeSchedule = { ...SCHEDULE, initialFeePips: 10_000 };
    expect(guardFeeAt(s, START + 17n)).toBe(10_000);
  });

  it("takes a number or a bigint for either clock", () => {
    expect(guardFeeAt({ ...SCHEDULE, startTime: Number(START) }, Number(START) + 30)).toBe(255_000);
  });

  it("refuses what no guard could have written", () => {
    expect(() => guardFeeAt({ ...SCHEDULE, initialFeePips: 9_999 }, START)).toThrow(RangeError);
    expect(() => guardFeeAt({ ...SCHEDULE, initialFeePips: 1_000_001 }, START)).toThrow(RangeError);
    expect(() => guardFeeAt({ ...SCHEDULE, finalFeePips: -1 }, START)).toThrow(RangeError);
    expect(() => guardFeeAt({ ...SCHEDULE, decaySeconds: 1.5 }, START)).toThrow(RangeError);
    expect(() => guardFeeAt(SCHEDULE, -1)).toThrow(RangeError);
    expect(() => guardFeeAt(SCHEDULE, 1.5)).toThrow(RangeError);
  });
});

describe("guardFeePhaseAt", () => {
  it("names the four states", () => {
    expect(guardFeePhaseAt(SCHEDULE, START - 1n)).toBe("scheduled");
    expect(guardFeePhaseAt(SCHEDULE, START)).toBe("decaying");
    expect(guardFeePhaseAt(SCHEDULE, START + 59n)).toBe("decaying");
    expect(guardFeePhaseAt(SCHEDULE, START + 60n)).toBe("settled");
    expect(guardFeePhaseAt({ ...SCHEDULE, enabled: false }, START - 1n)).toBe("flat");
  });

  it("agrees with the fee: settled is exactly where the final fee starts", () => {
    for (let i = 0n; i <= 61n; i++) {
      const settled = guardFeePhaseAt(SCHEDULE, START + i) === "settled";
      expect(settled).toBe(i >= 60n);
      if (settled) expect(guardFeeAt(SCHEDULE, START + i)).toBe(SCHEDULE.finalFeePips);
    }
  });
});

/* ------------------------------------------------------------- the source --- */

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "src", "launch");
const GUARDS = ["LaunchGuardHook.sol", "BinLaunchGuardHook.sol"].map((f) => join(HOOKS, f));
const present = GUARDS.every((p) => existsSync(p));

describe.skipIf(!present)("the rule is the contract's", () => {
  const squash = (s: string): string => s.replace(/\s+/g, " ");

  it.each(GUARDS)("%s resolves the fee in this order and with this arithmetic", (path) => {
    const source = squash(readFileSync(path, "utf8"));
    expect(source).toContain(
      squash(`if (!l.enabled) return l.finalFeeBips;
        if (timestamp < l.startTime) return l.initialFeeBips;
        return _decayedFee(l.initialFeeBips, l.finalFeeBips, timestamp - l.startTime, l.decaySeconds);`),
    );
    expect(source).toContain("if (elapsed >= decaySeconds) return finalFee;");
    expect(source).toContain("uint256 discount = (spread * elapsed) / decaySeconds;");
    expect(source).toContain("return uint24(uint256(initialFee) - discount);");
  });
});
