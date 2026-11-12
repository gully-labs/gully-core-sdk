import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  lockSchedule,
  lockerFeeView,
  parseDays,
  parseLockAmount,
  parseUtcInput,
  planPositionLock,
  planTokenLock,
  positionLockActions,
  toUtcInput,
  tokenLockActions,
} from "../src/locker/model.js";

const ME = "0x00000000000000000000000000000000000000a1" as Address;
const YOU = "0x00000000000000000000000000000000000000a2" as Address;
const SAFE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address; // a public test address standing in for the Safe

describe("locker inputs", () => {
  it("parses exact amounts and refuses anything it would have to round", () => {
    expect(parseLockAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseLockAmount("0.000001", 6)).toBe(1n);
    expect(parseLockAmount("0.0000001", 6)).toBeNull();
    expect(parseLockAmount("1e3", 18)).toBeNull();
    expect(parseLockAmount("-1", 18)).toBeNull();
    expect(parseLockAmount("", 18)).toBeNull();
  });

  it("reads datetime-local as UTC and round-trips", () => {
    const t = parseUtcInput("2027-01-31T12:00");
    expect(t).toBe(BigInt(Date.UTC(2027, 0, 31, 12, 0) / 1000));
    expect(toUtcInput(t as bigint)).toBe("2027-01-31T12:00");
    expect(parseUtcInput("31/01/2027")).toBeNull();
    expect(parseDays("30")).toBe(30n * 86_400n);
    expect(parseDays("1.5")).toBeNull();
  });

  it("builds a time lock or a cliff + linear schedule", () => {
    expect(lockSchedule("timelock", { unlockAt: 100n, start: null, cliffDays: null, durationDays: null })).toEqual({ start: 100n, cliff: 100n, end: 100n });
    expect(lockSchedule("vesting", { unlockAt: null, start: 1000n, cliffDays: 86_400n, durationDays: 10n * 86_400n })).toEqual({
      start: 1000n,
      cliff: 1000n + 86_400n,
      end: 1000n + 864_000n,
    });
    expect(lockSchedule("vesting", { unlockAt: null, start: 1000n, cliffDays: null, durationDays: 1n })).toBeNull();
  });
});

describe("locker fee", () => {
  it("shows the live fee, sends the higher announced one and says the surplus is refunded", () => {
    const now = lockerFeeView({ feeWei: 75_000_000_000_000_000n, pendingFee: null, recipient: SAFE }, { symbol: "ETH", decimals: 18 });
    expect(now.fee).toBe("0.075 ETH per lock");
    expect(now.sends).toBe("0.075 ETH");
    expect(now.pending).toBeNull();
    const rising = lockerFeeView(
      { feeWei: 75_000_000_000_000_000n, pendingFee: { feeWei: 100_000_000_000_000_000n, effectiveAt: 1_900_000_000n }, recipient: SAFE },
      { symbol: "ETH", decimals: 18 },
    );
    expect(rising.sends).toBe("0.1 ETH");
    expect(rising.pending).toMatch(/^An increase to 0.1 ETH applies from /);
    expect(rising.note).toContain("refunds any surplus");
    expect(JSON.stringify(rising)).not.toMatch(/\$|USD/);
  });
});

describe("locker plans and actions", () => {
  it("approves only when missing, and exactly", () => {
    expect(planPositionLock({ tokenId: 7n, approved: true, unlockAt: 0n }).map((s) => s.key)).toEqual(["lock"]);
    const p = planPositionLock({ tokenId: 7n, approved: false, unlockAt: 0n });
    expect(p.map((s) => s.key)).toEqual(["approve", "lock"]);
    expect(p[0]!.label).toContain("this NFT only");
    expect(planTokenLock({ native: false, allowance: 5n, amount: 10n, amountText: "10", symbol: "TKN" })[0]!.label).toBe("Approve GullyCoreTokenLock for exactly 10 TKN");
    expect(planTokenLock({ native: false, allowance: 10n, amount: 10n, amountText: "10", symbol: "TKN" }).map((s) => s.key)).toEqual(["lock"]);
    expect(planTokenLock({ native: true, allowance: 0n, amount: 10n, amountText: "10", symbol: "ETH" }).map((s) => s.key)).toEqual(["lock"]);
  });

  it("offers only what the contract allows the connected account", () => {
    const r = { owner: ME, pendingOwner: null, withdrawn: false, unlockAt: 100n };
    expect(positionLockActions(r, ME, 50n)).toEqual(["collect", "extend"]);
    expect(positionLockActions(r, ME, 100n)).toEqual(["collect", "extend", "withdraw"]);
    expect(positionLockActions(r, YOU, 200n)).toEqual(["collect"]);
    expect(positionLockActions({ ...r, pendingOwner: YOU }, YOU, 0n)).toEqual(["collect", "accept"]);
    expect(positionLockActions({ ...r, withdrawn: true }, ME, 200n)).toEqual([]);
    expect(tokenLockActions({ beneficiary: ME, pendingBeneficiary: null, claimable: 1n }, ME)).toEqual(["claim"]);
    expect(tokenLockActions({ beneficiary: ME, pendingBeneficiary: null, claimable: 0n }, ME)).toEqual([]);
    expect(tokenLockActions({ beneficiary: ME, pendingBeneficiary: YOU, claimable: 5n }, YOU)).toEqual(["accept"]);
  });
});
