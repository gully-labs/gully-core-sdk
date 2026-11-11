import { decodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_POSITION_LOCK_ABI,
  GULLYCORE_TOKEN_LOCK_ABI,
  POSITION_LOCK_MAX_SECONDS,
  buildApprovePositionForLock,
  buildClaimTokenLock,
  buildErc20Approve,
  buildExtendPositionLock,
  buildLockPosition,
  buildTokenLock,
  claimableAt,
  cliffLinearSchedule,
  decodePendingUtilityFee,
  decodePositionLock,
  feeMayRise,
  feeSafeValue,
  positionAmounts,
  positionLockStatus,
  summarizeCurrencyLocks,
  summarizePoolLocks,
  timeLockSchedule,
  validatePositionLock,
  validateTokenLock,
  vestedAt,
  viewTokenLock,
  permanentTokenPools,
  summarizeBinPermanent,
  type LockedPosition,
  type PermanentBinLock,
  type PermanentClPosition,
  type TokenLockRecord,
} from "../src/lock/index.js";
import { sqrtRatioAtTick } from "../src/launchpad/tickMath.js";

const LOCK = "0x0000000000000000000000000000000000001004" as Address;
const POSM = "0x000000000000000000000000000000000000909a" as Address;
const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const TOKEN = "0x0000000000000000000000000000000000007070" as Address;
const POOL = `0x${"cd".repeat(32)}` as Hex;

describe("fee gate", () => {
  it("safe value covers a pending increase, never a pending decrease", () => {
    expect(feeSafeValue({ feeWei: 10n, pendingFee: null })).toBe(10n);
    expect(feeSafeValue({ feeWei: 10n, pendingFee: { feeWei: 30n, effectiveAt: 5n } })).toBe(30n);
    expect(feeMayRise({ feeWei: 10n, pendingFee: { feeWei: 30n, effectiveAt: 5n } })).toBe(true);
    expect(feeMayRise({ feeWei: 10n, pendingFee: null })).toBe(false);
  });
  it("pendingFee (0,0) is none", () => {
    expect(decodePendingUtilityFee([0n, 0n])).toBeNull();
    expect(decodePendingUtilityFee([5n, 9n])).toEqual({ feeWei: 5n, effectiveAt: 9n });
  });
});

describe("position lock", () => {
  const now = 1_800_000_000n;
  it("status follows the contract: locked before unlockAt, withdrawable at it", () => {
    expect(positionLockStatus({ withdrawn: false, unlockAt: now + 1n }, now)).toBe("locked");
    expect(positionLockStatus({ withdrawn: false, unlockAt: now }, now)).toBe("unlockable");
    expect(positionLockStatus({ withdrawn: true, unlockAt: now + 1n }, now)).toBe("withdrawn");
  });
  it("getLock's zero owner is 'never locked'", () => {
    const raw = { owner: zeroAddress, lockedAt: 0, unlockAt: 0, pendingOwner: zeroAddress, poolId: POOL, currency0: zeroAddress, currency1: zeroAddress, withdrawn: false };
    expect(decodePositionLock(LOCK, 1n, raw)).toBeNull();
    const r = decodePositionLock(LOCK, 7n, { ...raw, owner: OWNER, lockedAt: 5, unlockAt: 9 });
    expect(r).toMatchObject({ tokenId: 7n, owner: OWNER, pendingOwner: null, lockedAt: 5n, unlockAt: 9n });
  });
  it("validates what lock() refuses", () => {
    expect(validatePositionLock({ unlockAt: now + 60n, owner: OWNER, nowSeconds: now, lock: LOCK })).toEqual([]);
    expect(validatePositionLock({ unlockAt: now, owner: OWNER, nowSeconds: now })[0]?.field).toBe("unlockAt");
    expect(validatePositionLock({ unlockAt: now + POSITION_LOCK_MAX_SECONDS + 1n, owner: OWNER, nowSeconds: now })[0]?.field).toBe("unlockAt");
    expect(validatePositionLock({ unlockAt: now + 60n, owner: zeroAddress, nowSeconds: now }).map((i) => i.field)).toEqual(["owner"]);
    expect(validatePositionLock({ unlockAt: now + 60n, owner: LOCK, nowSeconds: now, lock: LOCK }).map((i) => i.field)).toEqual(["owner"]);
    expect(validatePositionLock({ unlockAt: now + 60n, owner: "nope", nowSeconds: now }).map((i) => i.field)).toEqual(["owner"]);
  });
  it("builds approve then lock with the fee's safe value", () => {
    const a = buildApprovePositionForLock({ positionManager: POSM, lock: LOCK, tokenId: 42n });
    expect(a.to).toBe(POSM);
    const l = buildLockPosition({ lock: LOCK, tokenId: 42n, unlockAt: now + 60n, owner: OWNER, terms: { feeWei: 7n, pendingFee: { feeWei: 9n, effectiveAt: 1n } } });
    expect(l.value).toBe(9n);
    expect(decodeFunctionData({ abi: GULLYCORE_POSITION_LOCK_ABI, data: l.data }).args).toEqual([42n, Number(now + 60n), "0x00000000000000000000000000000000000000A1"]);
    const e = buildExtendPositionLock({ lock: LOCK, tokenId: 42n, newUnlockAt: now + 99n });
    expect(decodeFunctionData({ abi: GULLYCORE_POSITION_LOCK_ABI, data: e.data }).functionName).toBe("extend");
  });

  it("position amounts match the CL identities at, inside and past the range", () => {
    const L = 10n ** 18n;
    const below = positionAmounts({ liquidity: L, tickLower: -60, tickUpper: 60, tick: -120, sqrtPriceX96: sqrtRatioAtTick(-120) });
    expect(below.inRange).toBe(false);
    expect(below.amount1).toBe(0n);
    expect(below.amount0 > 0n).toBe(true);
    const above = positionAmounts({ liquidity: L, tickLower: -60, tickUpper: 60, tick: 60, sqrtPriceX96: sqrtRatioAtTick(60) });
    expect(above.inRange).toBe(false); // tick == tickUpper is out of range, as in core
    expect(above.amount0).toBe(0n);
    const mid = positionAmounts({ liquidity: L, tickLower: -60, tickUpper: 60, tick: 0, sqrtPriceX96: 2n ** 96n });
    expect(mid.inRange).toBe(true);
    // Symmetric range around price 1: both sides about equal, never above the one-sided totals.
    expect(mid.amount0 < below.amount0).toBe(true);
    expect(mid.amount1 < above.amount1).toBe(true);
    const diff = mid.amount0 > mid.amount1 ? mid.amount0 - mid.amount1 : mid.amount1 - mid.amount0;
    expect(diff * 1000n < mid.amount0).toBe(true);
  });

  it("summarises a pool: locked share of ACTIVE liquidity counts only live, in-range, before-unlock positions", () => {
    const base = { lock: LOCK, owner: OWNER, pendingOwner: null, lockedAt: 1n, poolId: POOL, currency0: zeroAddress, currency1: TOKEN, withdrawn: false };
    const mk = (id: bigint, over: Partial<LockedPosition>): LockedPosition =>
      ({ ...base, tokenId: id, unlockAt: now + 100n, status: "locked", tickLower: -60, tickUpper: 60, liquidity: 100n, amount0: 5n, amount1: 6n, inRange: true, ...over }) as LockedPosition;
    const locks = [
      mk(1n, {}),
      mk(2n, { unlockAt: now + 50n, liquidity: 300n }),
      mk(3n, { inRange: false, liquidity: 999n, amount1: 0n }),
      mk(4n, { status: "unlockable", unlockAt: now - 1n, liquidity: 1000n }),
      mk(5n, { status: "withdrawn", liquidity: null, amount0: null, amount1: null, inRange: null }),
    ];
    const s = summarizePoolLocks({ poolId: POOL, currency0: zeroAddress, currency1: TOKEN, pool: { poolId: POOL, sqrtPriceX96: 2n ** 96n, tick: 0, lpFee: 3000, activeLiquidity: 1600n }, locks });
    expect(s.liveCount).toBe(4);
    expect(s.lockedCount).toBe(3);
    expect(s.lockedActiveLiquidity).toBe(400n);
    expect(s.lockedActiveBps).toBe(2500);
    expect(s.outOfRangeLocked).toBe(1);
    expect(s.nextUnlockAt).toBe(now + 50n);
    expect(s.lastUnlockAt).toBe(now + 100n);
    expect(s.lockedAmount0).toBe(15n);
    expect(s.lockedAmount1).toBe(12n);
    expect(summarizePoolLocks({ poolId: POOL, currency0: zeroAddress, currency1: TOKEN, pool: null, locks }).lockedActiveBps).toBeNull();
  });
});

describe("token lock", () => {
  const rec: TokenLockRecord = {
    lock: LOCK,
    lockId: 0n,
    currency: TOKEN,
    beneficiary: OWNER,
    pendingBeneficiary: null,
    start: 1000n,
    cliff: 1250n,
    end: 2000n,
    amount: 1_000_003n,
    claimed: 0n,
    creator: OWNER,
  };
  it("vests exactly like the contract: zero before the cliff, floor(linear from start), all at end", () => {
    expect(vestedAt(rec, 1249n)).toBe(0n);
    expect(vestedAt(rec, 1250n)).toBe((1_000_003n * 250n) / 1000n);
    expect(vestedAt(rec, 1999n)).toBe((1_000_003n * 999n) / 1000n);
    expect(vestedAt(rec, 2000n)).toBe(1_000_003n);
    expect(claimableAt({ ...rec, claimed: 300_000n }, 1500n)).toBe(500_001n - 300_000n);
    expect(claimableAt({ ...rec, claimed: 999_999_999n }, 1500n)).toBe(0n);
  });
  it("a time-lock releases all at once", () => {
    const t = { ...rec, ...timeLockSchedule(5000n) };
    expect(vestedAt(t, 4999n)).toBe(0n);
    expect(vestedAt(t, 5000n)).toBe(rec.amount);
    expect(cliffLinearSchedule({ start: 10n, cliffSeconds: 5n, durationSeconds: 100n })).toEqual({ start: 10n, cliff: 15n, end: 110n });
  });
  it("views and summarises: held vs unvested share of supply", () => {
    const v = viewTokenLock({ ...rec, claimed: 100n }, 1500n);
    expect(v.status).toBe("vesting");
    expect(v.unvested).toBe(rec.amount - vestedAt(rec, 1500n));
    expect(viewTokenLock(rec, 100n).status).toBe("cliff");
    expect(viewTokenLock({ ...rec, claimed: rec.amount }, 3000n).status).toBe("claimed");
    const s = summarizeCurrencyLocks({ currency: TOKEN, locks: [v], totalHeld: rec.amount - 100n, totalSupply: 10_000_030n, now: 1500n });
    expect(s.heldBps).toBe(Number(((rec.amount - 100n) * 10_000n) / 10_000_030n));
    expect(s.unvestedBps).toBe(Number((v.unvested * 10_000n) / 10_000_030n));
    expect(s.nextCliffOrEnd).toBe(2000n);
    expect(summarizeCurrencyLocks({ currency: zeroAddress, locks: [v], totalHeld: 1n, totalSupply: null, now: 1500n }).heldBps).toBeNull();
  });
  it("validates what lock() refuses", () => {
    const now = 1000n;
    const ok = { currency: TOKEN, amount: 1n, beneficiary: OWNER, schedule: { start: 900n, cliff: 1000n, end: 2000n }, nowSeconds: now, lock: LOCK };
    expect(validateTokenLock(ok)).toEqual([]);
    expect(validateTokenLock({ ...ok, amount: 0n }).map((i) => i.field)).toEqual(["amount"]);
    expect(validateTokenLock({ ...ok, beneficiary: LOCK }).map((i) => i.field)).toEqual(["beneficiary"]);
    expect(validateTokenLock({ ...ok, schedule: { start: 1n, cliff: 5n, end: 3n } }).some((i) => i.field === "schedule")).toBe(true);
    expect(validateTokenLock({ ...ok, schedule: timeLockSchedule(1000n) }).map((i) => i.field)).toEqual(["schedule"]);
  });
  it("builds: native carries amount + fee, a token only the fee after an exact approve", () => {
    const terms = { feeWei: 3n, pendingFee: null };
    const n = buildTokenLock({ lock: LOCK, currency: zeroAddress, amount: 100n, beneficiary: OWNER, schedule: timeLockSchedule(5n), terms });
    expect(n.value).toBe(103n);
    const t = buildTokenLock({ lock: LOCK, currency: TOKEN, amount: 100n, beneficiary: OWNER, schedule: { start: 1n, cliff: 2n, end: 3n }, terms });
    expect(t.value).toBe(3n);
    expect(decodeFunctionData({ abi: GULLYCORE_TOKEN_LOCK_ABI, data: t.data }).args).toEqual([TOKEN, 100n, "0x00000000000000000000000000000000000000A1", 1, 2, 3]);
    expect(buildErc20Approve({ token: TOKEN, spender: LOCK, amount: 100n }).to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: GULLYCORE_TOKEN_LOCK_ABI, data: buildClaimTokenLock({ lock: LOCK, lockId: 4n, to: OWNER }).data }).args).toEqual([4n, "0x00000000000000000000000000000000000000A1"]);
  });
});

describe("LP lockers: permanent liquidity", () => {
  const now = 1_800_000_000n;
  const base = { lock: LOCK, owner: OWNER, pendingOwner: null, lockedAt: 1n, poolId: POOL, currency0: zeroAddress, currency1: TOKEN, withdrawn: false };
  const timeLock = { ...base, tokenId: 1n, unlockAt: now + 100n, status: "locked", tickLower: -60, tickUpper: 60, liquidity: 100n, amount0: 5n, amount1: 6n, inRange: true } as LockedPosition;
  const perm = (id: bigint, over: Partial<PermanentClPosition>): PermanentClPosition => ({
    kind: "cl-lp-locker", locker: LOCK, tokenId: id, poolId: POOL, currency0: zeroAddress, currency1: TOKEN, creator: OWNER, lockedAt: 1n,
    tickLower: -600, tickUpper: 600, liquidity: 700n, amount0: 10n, amount1: 20n, inRange: true, ...over,
  });
  const pool = { poolId: POOL, sqrtPriceX96: 2n ** 96n, tick: 0, lpFee: 3000, activeLiquidity: 1000n };

  it("counts permanent in-range liquidity in the locked share and keeps the two sources apart", () => {
    const s = summarizePoolLocks({ poolId: POOL, currency0: zeroAddress, currency1: TOKEN, pool, locks: [timeLock], permanent: [perm(7n, {}), perm(8n, { inRange: false, liquidity: 50n })] });
    expect(s.timeLockedActiveBps).toBe(1000);
    expect(s.permanentActiveBps).toBe(7000);
    expect(s.lockedActiveBps).toBe(8000);
    expect(s.lockedActiveLiquidity).toBe(800n);
    expect(s.permanentOutOfRange).toBe(1);
    expect(s.lockedAmount0).toBe(5n + 20n);
    expect(s.timeLockedAmount1).toBe(6n);
    expect(s.lockedCount).toBe(1); // time locks only
    expect(summarizePoolLocks({ poolId: POOL, currency0: zeroAddress, currency1: TOKEN, pool, locks: [timeLock] }).permanentActiveBps).toBe(0);
  });

  it("a Bin pool's figure is the locked fraction of the ACTIVE bin, amounts summed exactly", () => {
    const lock = (id: bigint, bins: [number, bigint][]): PermanentBinLock => ({
      kind: "bin-lp-locker", locker: LOCK, lockId: id, poolId: POOL, currency0: zeroAddress, currency1: TOKEN, creator: OWNER, lockedAt: 1n,
      bins: bins.map(([binId, shares]) => ({ binId, shares, totalShares: 1000n, shareBps: Number((shares * 10_000n) / 1000n), amountX: shares, amountY: 2n * shares })),
      amount0: bins.reduce((s, b) => s + b[1], 0n), amount1: bins.reduce((s, b) => s + 2n * b[1], 0n),
    });
    const s = summarizeBinPermanent(POOL, [lock(1n, [[100, 300n], [101, 50n]]), lock(2n, [[100, 200n]])], { activeId: 100, totalShares: 1000n });
    expect(s.activeBinLockedBps).toBe(5000);
    expect(s.amount0).toBe(550n);
    expect(s.amount1).toBe(1100n);
    expect(summarizeBinPermanent(POOL, [lock(1n, [[101, 50n]])], { activeId: 100, totalShares: 1000n }).activeBinLockedBps).toBeNull();
  });

  it("per token: the token's side of every permanent position, priced ones only", () => {
    const r = permanentTokenPools(TOKEN, [perm(7n, {}), perm(8n, { amount1: null, amount0: null })], []);
    expect(r.total).toBe(20n);
    expect(r.unpriced).toBe(1);
    expect(r.pools).toHaveLength(1);
    expect(r.pools[0]?.pairedWith).toBe(zeroAddress);
    expect(permanentTokenPools(OWNER, [perm(7n, {})], []).pools).toHaveLength(0);
  });
});
