// SPDX-License-Identifier: MIT
/**
 * The lock widgets' words: what the badge says for every state a pool or a
 * token can be in, tested on the pure model (`src/locks/model.ts`) the
 * components render. The unit suite has no DOM.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { CurrencyLockSummary, LockedPosition, PoolLockSummary, TokenLockView } from "@gullylabs/core-sdk/lock";

import {
  advanceChainNow,
  formatCountdown,
  formatLockAmount,
  formatLockBps,
  formatUtc,
  lockPageUrl,
  binPoolBadgeView,
  poolBadgeView,
  tokenBadgeView,
  vestedBps,
} from "../src/locks/model.js";

const POOL = `0x${"ab".repeat(32)}` as Hex;
const TOKEN = "0x00000000000000000000000000000000000000c1" as Address;
const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const NOW = 1_800_000_000n;

function position(over: Partial<LockedPosition>): LockedPosition {
  return {
    lock: OWNER,
    tokenId: 1n,
    owner: OWNER,
    pendingOwner: null,
    lockedAt: NOW - 100n,
    unlockAt: NOW + 86_400n,
    poolId: POOL,
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: TOKEN,
    withdrawn: false,
    status: "locked",
    tickLower: -60,
    tickUpper: 60,
    liquidity: 100n,
    amount0: 1n,
    amount1: 1n,
    inRange: true,
    ...over,
  };
}

function poolSummary(over: Partial<PoolLockSummary>): PoolLockSummary {
  return {
    poolId: POOL,
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: TOKEN,
    pool: { poolId: POOL, sqrtPriceX96: 2n ** 96n, tick: 0, lpFee: 3000, activeLiquidity: 1000n },
    locks: [],
    liveCount: 0,
    lockedCount: 0,
    lockedActiveLiquidity: 0n,
    lockedActiveBps: null,
    lockedAmount0: 0n,
    lockedAmount1: 0n,
    outOfRangeLocked: 0,
    nextUnlockAt: null,
    lastUnlockAt: null,
    timeLockedActiveLiquidity: 0n,
    timeLockedActiveBps: null,
    timeLockedAmount0: 0n,
    timeLockedAmount1: 0n,
    permanent: [],
    permanentActiveLiquidity: 0n,
    permanentActiveBps: null,
    permanentAmount0: 0n,
    permanentAmount1: 0n,
    permanentOutOfRange: 0,
    ...over,
  };
}

describe("formatting", () => {
  it("percent from basis points, exactly", () => {
    expect(formatLockBps(8234)).toBe("82.34%");
    expect(formatLockBps(10_000)).toBe("100%");
    expect(formatLockBps(1)).toBe("0.01%");
    expect(formatLockBps(0)).toBe("0%");
    expect(formatLockBps(1205)).toBe("12.05%");
  });
  it("countdowns", () => {
    expect(formatCountdown(0n)).toBe("now");
    expect(formatCountdown(-5n)).toBe("now");
    expect(formatCountdown(65n)).toBe("1m 05s");
    expect(formatCountdown(3_725n)).toBe("1h 02m 05s");
    expect(formatCountdown(86_400n * 3n + 3_660n)).toBe("3d 01h 01m");
    expect(formatCountdown(86_400n * 400n)).toBe("1y 35d");
  });
  it("amounts in token units, never 0 for dust, base units without decimals", () => {
    expect(formatLockAmount(1_500_000n, { symbol: "USD", decimals: 6 })).toBe("1.5 USD");
    expect(formatLockAmount(1n, { symbol: "T", decimals: 18 })).toBe("<0.000001 T");
    expect(formatLockAmount(0n, { symbol: "T", decimals: 18 })).toBe("0 T");
    expect(formatLockAmount(1234n, { symbol: "X", decimals: null })).toBe("1,234 base units X");
  });
  it("dates in UTC and the lock page links", () => {
    expect(formatUtc(0n)).toBe("1970-01-01 00:00 UTC");
    expect(lockPageUrl("https://gullychain.xyz/core/", { kind: "pool", poolId: POOL })).toBe(`https://gullychain.xyz/core/app/locks/pool/${POOL}`);
    expect(lockPageUrl("https://gullychain.xyz/core", { kind: "token", token: TOKEN })).toBe(`https://gullychain.xyz/core/app/locks/token/${TOKEN}`);
  });
  it("the chain clock advances from the read, whatever the wall clock says", () => {
    expect(advanceChainNow(NOW, 1_000, 4_999)).toBe(NOW + 3n);
    expect(advanceChainNow(NOW, 5_000, 1_000)).toBe(NOW);
  });
});

describe("poolBadgeView", () => {
  it("no lock ever", () => {
    const v = poolBadgeView(poolSummary({}));
    expect(v.tone).toBe("none");
    expect(v.headline).toBe("No locked liquidity");
    expect(v.countdownTo).toBeNull();
  });
  it("locks past their date are 'not locked now', never a share", () => {
    const v = poolBadgeView(poolSummary({ locks: [position({ status: "unlockable" }), position({ status: "withdrawn" })], liveCount: 1 }));
    expect(v.tone).toBe("open");
    expect(v.headline).toBe("No time-locked positions now");
    expect(v.detail).toMatch(/1 lock is past the unlock date/);
    const all = poolBadgeView(poolSummary({ locks: [position({ status: "withdrawn" })] }));
    expect(all.detail).toBe("Every lock on this pool has been withdrawn.");
  });
  it("names the share as a share of ACTIVE liquidity and counts down to the first unlock", () => {
    const v = poolBadgeView(
      poolSummary({ locks: [position({}), position({})], liveCount: 2, lockedCount: 2, lockedActiveBps: 8234, outOfRangeLocked: 1, nextUnlockAt: NOW + 10n, lastUnlockAt: NOW + 20n }),
    );
    expect(v.tone).toBe("locked");
    expect(v.headline).toBe("82.34% of active liquidity locked");
    expect(v.headline).not.toMatch(/LP/);
    expect(v.detail).toMatch(/moves with it/);
    expect(v.detail).toMatch(/1 locked position is out of range and not counted/);
    expect(v.detail).toMatch(/Last time-lock unlock/);
    expect(v.countdownTo).toBe(NOW + 10n);
    expect(v.countdownLabel).toMatch(/^first time-lock unlock /);
  });
  it("no active liquidity: 'not measurable', never 0% or 100%", () => {
    const v = poolBadgeView(
      poolSummary({ pool: { poolId: POOL, sqrtPriceX96: 1n, tick: -887272, lpFee: 3000, activeLiquidity: 0n }, locks: [position({ inRange: false })], liveCount: 1, lockedCount: 1, lockedActiveBps: null, nextUnlockAt: NOW + 5n, lastUnlockAt: NOW + 5n }),
    );
    expect(v.headline).toBe("1 locked position · share of active liquidity not measurable");
    expect(v.headline).not.toMatch(/%/);
    expect(v.detail).toMatch(/no liquidity at the current price/);
    const unread = poolBadgeView(poolSummary({ pool: null, locks: [position({})], liveCount: 1, lockedCount: 1, nextUnlockAt: NOW, lastUnlockAt: NOW }));
    expect(unread.detail).toMatch(/could not be read/);
  });
});

function tokenLock(over: Partial<TokenLockView>): TokenLockView {
  return {
    lock: OWNER,
    lockId: 0n,
    currency: TOKEN,
    beneficiary: OWNER,
    pendingBeneficiary: null,
    start: NOW - 100n,
    cliff: NOW - 100n,
    end: NOW + 100n,
    amount: 1_000n,
    claimed: 0n,
    creator: OWNER,
    vested: 500n,
    claimable: 500n,
    unvested: 500n,
    status: "vesting",
    ...over,
  };
}

function tokenSummary(over: Partial<CurrencyLockSummary>): CurrencyLockSummary {
  return { currency: TOKEN, locks: [], totalHeld: 0n, unvested: 0n, totalSupply: 10_000n, heldBps: 0, unvestedBps: 0, nextCliffOrEnd: null, lastEnd: null, ...over };
}

describe("tokenBadgeView", () => {
  const meta = { symbol: "TKN", decimals: 0 };
  it("no lock, and every lock claimed", () => {
    expect(tokenBadgeView(tokenSummary({}), meta)).toMatchObject({ tone: "none", headline: "No TKN locked" });
    const done = tokenBadgeView(tokenSummary({ locks: [tokenLock({ status: "claimed", claimed: 1_000n })] }), meta);
    expect(done).toMatchObject({ tone: "open", headline: "No TKN locked now" });
  });
  it("held vs not-yet-vested share of supply, labelled", () => {
    const v = tokenBadgeView(tokenSummary({ locks: [tokenLock({})], totalHeld: 1_000n, unvested: 500n, heldBps: 1000, unvestedBps: 500, nextCliffOrEnd: NOW + 100n, lastEnd: NOW + 100n }), meta);
    expect(v.tone).toBe("locked");
    expect(v.headline).toBe("10% of supply held in locks");
    expect(v.detail).toMatch(/^5% of supply \(500 TKN\) not yet vested/);
    expect(v.countdownTo).toBe(NOW + 100n);
  });
  it("native (no supply): amounts instead of a share", () => {
    const v = tokenBadgeView(tokenSummary({ locks: [tokenLock({})], totalHeld: 1_000n, unvested: 0n, totalSupply: null, heldBps: null, unvestedBps: null }), { symbol: "ETH", decimals: 0 });
    expect(v.headline).toBe("1,000 ETH held in locks");
    expect(v.tone).toBe("open");
  });
  it("vested share for the bar", () => {
    expect(vestedBps(tokenLock({ vested: 250n }))).toBe(2500);
    expect(vestedBps(tokenLock({ amount: 0n, vested: 0n }))).toBe(0);
  });
});

describe("permanent LP-locker liquidity", () => {
  const perm = {
    kind: "cl-lp-locker" as const, locker: OWNER, tokenId: 9n, poolId: POOL, currency0: "0x0000000000000000000000000000000000000000" as const, currency1: TOKEN,
    creator: OWNER, lockedAt: 1n, tickLower: -600, tickUpper: 600, liquidity: 600n, amount0: 3n, amount1: 4n, inRange: true,
  };
  it("a launch pool with only the LP locker reads as locked, not 'no time-locked positions'", () => {
    const v = poolBadgeView(poolSummary({ permanent: [perm], lockedActiveBps: 6000, permanentActiveBps: 6000, timeLockedActiveBps: 0 }));
    expect(v.tone).toBe("locked");
    expect(v.headline).toBe("60% of active liquidity locked");
    expect(v.detail).toMatch(/60% locked permanently \(LP locker, no withdraw path\)/);
    expect(v.detail).not.toMatch(/time-locked/);
    expect(v.countdownTo).toBeNull();
  });
  it("both sources are named apart, and the countdown is the time lock's", () => {
    const v = poolBadgeView(
      poolSummary({ locks: [position({})], liveCount: 1, lockedCount: 1, permanent: [perm], lockedActiveBps: 7000, permanentActiveBps: 6000, timeLockedActiveBps: 1000, nextUnlockAt: NOW + 5n, lastUnlockAt: NOW + 5n }),
    );
    expect(v.detail).toMatch(/60% locked permanently .*, 10% time-locked until a date/);
    expect(v.countdownLabel).toMatch(/^first time-lock unlock/);
  });
  it("no active liquidity: permanent is named, the share is not measurable", () => {
    const v = poolBadgeView(poolSummary({ permanent: [perm], lockedActiveBps: null }));
    expect(v.headline).toBe("Locked permanently (LP locker) · share of active liquidity not measurable");
  });
  it("a Bin pool: the active bin's locked fraction, or none", () => {
    const meta = { symbol: "T", decimals: 0 }
    const lock = { bins: [{ binId: 1, shares: 1n, totalShares: 2n, shareBps: 5000, amountX: 1n, amountY: 2n }] }
    const v = binPoolBadgeView({ locks: [lock as never], activeBinLockedBps: 5000, amount0: 1n, amount1: 2n }, meta, meta);
    expect(v.headline).toBe("50% of the active bin locked permanently (LP locker)");
    expect(v.detail).toMatch(/pool-wide share across all bins is not computed/);
    expect(binPoolBadgeView({ locks: [], activeBinLockedBps: null, amount0: 0n, amount1: 0n }, meta, meta).tone).toBe("none");
  });
  it("a token with only LP-locker liquidity", () => {
    const v = tokenBadgeView(
      { locks: [], totalHeld: 0n, unvested: 0n, heldBps: null, unvestedBps: null, nextCliffOrEnd: null, lastEnd: null, totalSupply: 1000n },
      { symbol: "MOCHI", decimals: 0 },
      { pools: [{ poolId: POOL, kind: "cl-lp-locker", pairedWith: TOKEN, amount: 250n, locks: 1 }], total: 250n },
    );
    expect(v.tone).toBe("locked");
    expect(v.headline).toBe("MOCHI liquidity locked permanently (LP locker)");
    expect(v.detail).toMatch(/250 MOCHI \(25% of supply\) locked permanently as pool liquidity/);
  });
});

describe("lockPageUrl bases", () => {
  it("defaults to /app/locks and takes a public base and a query", () => {
    expect(lockPageUrl("https://gullychain.xyz/core/", { kind: "pool", poolId: POOL })).toBe(`https://gullychain.xyz/core/app/locks/pool/${POOL}`);
    expect(lockPageUrl("https://gullychain.xyz/core", { kind: "token", token: TOKEN }, { pathBase: "/locks", query: "net=robinhood" })).toBe(`https://gullychain.xyz/core/locks/token/${TOKEN}?net=robinhood`);
  });
});
