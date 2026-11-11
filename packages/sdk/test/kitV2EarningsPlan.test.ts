// SPDX-License-Identifier: MIT
/**
 * An earnings read as calls (`kitV2/earningsPlan.ts`), for both generations of
 * launch guard.
 *
 * Nothing here is a chain. Every earnings object is written out by hand in the
 * shape `readKitV2Earnings` returns (that reader has its own suite), and every
 * call the plan produces is DECODED back through the generated ABI, so what is
 * asserted is the function and the arguments a wallet would sign, not bytes.
 *
 * The addresses are made up. No "quote-fee" guard is deployed anywhere.
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  BIN_LAUNCH_GUARD_HOOK_ABI,
  GULLYCORE_BIN_LP_LOCKER_ABI,
  GULLYCORE_LP_LOCKER_ABI,
  LAUNCHPAD_KIT_V2_ABI,
  LAUNCH_GUARD_BITMAPS,
  LAUNCH_GUARD_HOOK_ABI,
  NATIVE_ADDRESS,
  claimableTotals,
  collectableLocks,
  lockEarnsTradeFee,
  planKitV2Earnings,
  unsettledTotals,
  type EarningsV2,
  type KitV2Env,
} from "../src/index.js";

/** Checksummed, as a decoded argument is. */
const a = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const ME = a(0xa11ce);
const TOKEN = a(0x70ce);
const USDX = a(0x05d);
const POOL: Hex = `0x${"41".repeat(32)}`;
const POOL_2: Hex = `0x${"42".repeat(32)}`;

const envOf = (generation: "lp-fee" | "quote-fee" | "unknown"): KitV2Env => ({
  kit: a(1),
  clHook: a(2),
  binHook: a(3),
  clPoolManager: a(4),
  binPoolManager: a(5),
  clPositionManager: a(6),
  binPositionManager: a(7),
  clLocker: a(8),
  binLocker: a(9),
  tokenFactory: a(10),
  launchRegistry: a(11),
  protocolFeeRecipient: a(12),
  clHookBitmap: generation === "unknown" ? 0x0400 : LAUNCH_GUARD_BITMAPS[generation].CL,
  binHookBitmap: generation === "unknown" ? null : LAUNCH_GUARD_BITMAPS[generation].Bin,
});

const TOKEN_META = { address: TOKEN, symbol: "TKN", name: "Token", decimals: 18 };
const USDX_META = { address: USDX, symbol: "USDX", name: "Dollar", decimals: 6 };

const EMPTY: EarningsV2 = { account: ME, kitFeesOwed: 0n, claimable: [], locks: [], guardClaimable: [], tax: { claimable: [], pools: [] }, fee: { pools: [] } };

/** An "lp-fee" wallet: fees through a CL lock, a creator tax on the guard, launch fees at the kit. */
function lpFeeEarnings(): EarningsV2 {
  const guard = [
    { guard: "CL" as const, hook: a(2), currency: NATIVE_ADDRESS, meta: null, amount: 40n },
    { guard: "CL" as const, hook: a(2), currency: TOKEN, meta: TOKEN_META, amount: 900n },
  ];
  return {
    account: ME,
    kitFeesOwed: 1_000n,
    claimable: [
      { locker: "CL", currency: NATIVE_ADDRESS, meta: null, amount: 70n },
      { locker: "CL", currency: TOKEN, meta: TOKEN_META, amount: 5_000n },
    ],
    locks: [{ locker: "CL", lockId: 7n, token: TOKEN, tokenMeta: TOKEN_META, role: "creator", currency0: NATIVE_ADDRESS, currency1: TOKEN, guardGeneration: "lp-fee", lpShareBps: null }],
    guardClaimable: guard,
    tax: {
      claimable: guard,
      pools: [
        {
          guard: "CL",
          hook: a(2),
          poolId: POOL,
          token: TOKEN,
          tokenMeta: TOKEN_META,
          role: "creator",
          bps: 7_000,
          live: true,
          expiresAt: 2_000_000_000n,
          pending: [
            { currency: NATIVE_ADDRESS, meta: null, amount: 101n },
            { currency: TOKEN, meta: TOKEN_META, amount: 0n },
          ],
        },
      ],
    },
    fee: { pools: [] },
  };
}

/**
 * A "quote-fee" wallet: the trade fee and the tax both in the guard, in the quote.
 * `lpShareBps` is what the lock's guard answered for its share: zero (the guard leaves
 * the pool nothing) unless a test says otherwise, and `null` for a guard that did not say.
 */
function quoteFeeEarnings(lpShareBps: number | null = 0): EarningsV2 {
  const guard = [{ guard: "CL" as const, hook: a(2), currency: NATIVE_ADDRESS, meta: null, amount: 250n }];
  return {
    account: ME,
    kitFeesOwed: 0n,
    claimable: [
      { locker: "CL", currency: NATIVE_ADDRESS, meta: null, amount: 0n },
      { locker: "CL", currency: TOKEN, meta: TOKEN_META, amount: 0n },
    ],
    locks: [{ locker: "CL", lockId: 7n, token: TOKEN, tokenMeta: TOKEN_META, role: "both", currency0: NATIVE_ADDRESS, currency1: TOKEN, guardGeneration: "quote-fee", lpShareBps }],
    guardClaimable: guard,
    tax: {
      claimable: guard,
      pools: [
        {
          guard: "CL",
          hook: a(2),
          poolId: POOL,
          token: TOKEN,
          tokenMeta: TOKEN_META,
          role: "creator",
          bps: 7_000,
          live: true,
          expiresAt: 2_000_000_000n,
          pending: [
            { currency: NATIVE_ADDRESS, meta: null, amount: 101n },
            { currency: TOKEN, meta: TOKEN_META, amount: 0n },
          ],
        },
      ],
    },
    fee: {
      pools: [
        { guard: "CL", hook: a(2), poolId: POOL, token: TOKEN, tokenMeta: TOKEN_META, role: "both", bps: 8_000, pending: [{ currency: NATIVE_ADDRESS, meta: null, amount: 1_003n, share: 801n }] },
      ],
    },
  };
}

describe("planKitV2Earnings: the balances", () => {
  it("lists the kit, then the lockers, then the guards, each with the claim that pays the account", () => {
    const plan = planKitV2Earnings(lpFeeEarnings(), envOf("lp-fee"));
    expect(plan.account).toBe(ME);
    const token = TOKEN.toLowerCase();
    expect(plan.credits.map((c) => c.key)).toEqual(["kit", `locker:CL:${NATIVE_ADDRESS}`, `locker:CL:${token}`, `guard:CL:${NATIVE_ADDRESS}`, `guard:CL:${token}`]);

    const [kit, lockerNative, lockerToken, guardNative] = plan.credits;
    expect(kit).toMatchObject({ from: "kit", pools: null, contract: a(1), holds: "launch-fees", generation: null, currency: NATIVE_ADDRESS, amount: 1_000n, mayBeLaunchToken: false });
    expect(decodeFunctionData({ abi: LAUNCHPAD_KIT_V2_ABI, data: kit!.claim.data })).toMatchObject({ functionName: "claimFees", args: [ME] });
    expect(kit!.claim.to).toBe(a(1));

    expect(lockerNative).toMatchObject({ from: "locker", pools: "CL", contract: a(8), holds: "lp-fees", generation: "lp-fee", amount: 70n });
    expect(decodeFunctionData({ abi: GULLYCORE_LP_LOCKER_ABI, data: lockerToken!.claim.data })).toMatchObject({ functionName: "claim", args: [TOKEN, ME] });
    expect(lockerToken!.claim.to).toBe(a(8));

    expect(guardNative).toMatchObject({ from: "guard", pools: "CL", contract: a(2), holds: "creator-tax", generation: "lp-fee", amount: 40n });
    expect(decodeFunctionData({ abi: LAUNCH_GUARD_HOOK_ABI, data: guardNative!.claim.data })).toMatchObject({ functionName: "claim", args: [NATIVE_ADDRESS, ME] });
    expect(guardNative!.claim.to).toBe(a(2));
  });

  it("a quote-fee guard's balance holds the trade fee AND the tax: one number, one claim", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(), envOf("quote-fee"));
    const guards = plan.credits.filter((c) => c.from === "guard");
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({ holds: "trading-fees-and-tax", generation: "quote-fee", currency: NATIVE_ADDRESS, amount: 250n });
    // `guardClaimable` and `tax.claimable` are the same rows. Counted once: 250, never 500.
    expect(claimableTotals(plan)).toEqual([{ currency: NATIVE_ADDRESS, meta: null, amount: 250n }]);
  });

  it("an unclassified guard's balance is shown with no claim about what it holds", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(), envOf("unknown"));
    expect(plan.credits.find((c) => c.from === "guard")).toMatchObject({ holds: "unknown", generation: "unknown", mayBeLaunchToken: false });
  });

  it("uses the Bin contracts for Bin sources", () => {
    const e: EarningsV2 = {
      ...EMPTY,
      claimable: [{ locker: "Bin", currency: USDX, meta: USDX_META, amount: 3n }],
      guardClaimable: [{ guard: "Bin", hook: a(3), currency: USDX, meta: USDX_META, amount: 4n }],
      locks: [{ locker: "Bin", lockId: 2n, token: TOKEN, tokenMeta: TOKEN_META, role: "integrator", currency0: USDX, currency1: TOKEN, guardGeneration: "lp-fee", lpShareBps: null }],
    };
    const plan = planKitV2Earnings(e, envOf("lp-fee"));
    const locker = plan.credits.find((c) => c.from === "locker")!;
    const guard = plan.credits.find((c) => c.from === "guard")!;
    expect(locker.claim.to).toBe(a(9));
    expect(decodeFunctionData({ abi: GULLYCORE_BIN_LP_LOCKER_ABI, data: locker.claim.data })).toMatchObject({ functionName: "claim", args: [USDX, ME] });
    expect(guard.claim.to).toBe(a(3));
    expect(decodeFunctionData({ abi: BIN_LAUNCH_GUARD_HOOK_ABI, data: guard.claim.data })).toMatchObject({ functionName: "claim", args: [USDX, ME] });
    expect(plan.locks[0]!.collect.to).toBe(a(9));
    expect(decodeFunctionData({ abi: GULLYCORE_BIN_LP_LOCKER_ABI, data: plan.locks[0]!.collect.data })).toMatchObject({ functionName: "collectFees", args: [2n] });
  });
});

describe("planKitV2Earnings: where earnings can arrive in a launch token", () => {
  it("on lp-fee sources: the lockers and the guards", () => {
    const plan = planKitV2Earnings(lpFeeEarnings(), envOf("lp-fee"));
    expect(plan.credits.filter((c) => c.from !== "kit").every((c) => c.mayBeLaunchToken)).toBe(true);
    expect(plan.credits.find((c) => c.from === "kit")!.mayBeLaunchToken).toBe(false);
  });

  it("nowhere on quote-fee sources, nor on unclassified ones", () => {
    for (const generation of ["quote-fee", "unknown"] as const) {
      const plan = planKitV2Earnings(quoteFeeEarnings(), envOf(generation));
      expect(plan.credits.some((c) => c.mayBeLaunchToken), generation).toBe(false);
    }
  });

  it("per pool type: a kit with one guard of each generation is told apart", () => {
    const env: KitV2Env = { ...envOf("lp-fee"), binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin };
    const e: EarningsV2 = {
      ...EMPTY,
      guardClaimable: [
        { guard: "CL", hook: a(2), currency: TOKEN, meta: TOKEN_META, amount: 1n },
        { guard: "Bin", hook: a(3), currency: NATIVE_ADDRESS, meta: null, amount: 1n },
      ],
    };
    const guards = planKitV2Earnings(e, env).credits.filter((c) => c.from === "guard");
    expect(guards.map((c) => [c.pools, c.holds, c.mayBeLaunchToken])).toEqual([
      ["CL", "creator-tax", true],
      ["Bin", "trading-fees-and-tax", false],
    ]);
  });
});

describe("planKitV2Earnings: the guards' pots", () => {
  it("quote-fee: the fee's pot and the tax's pot of a pool are ONE row, in the quote", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(), envOf("quote-fee"));
    expect(plan.pots).toHaveLength(1);
    const pot = plan.pots[0]!;
    expect(pot).toMatchObject({ pools: "CL", hook: a(2), generation: "quote-fee", poolId: POOL, token: TOKEN, currency: NATIVE_ADDRESS });
    expect(pot.fee).toEqual({ pot: 1_003n, share: 801n, bps: 8_000 });
    // floor(101 * 7000 / 10000) = floor(70.7) = 70
    expect(pot.tax).toEqual({ pot: 101n, share: 70n, bps: 7_000, live: true });
    expect(pot.share).toBe(871n);
    expect(unsettledTotals(plan)).toEqual([{ currency: NATIVE_ADDRESS, meta: null, amount: 871n }]);
  });

  it("quote-fee: the launch-token side is left out, not listed at zero for good", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(), envOf("quote-fee"));
    expect(plan.pots.some((p) => p.currency === TOKEN)).toBe(false);
  });

  it("lp-fee: the tax's pots only, in both of the pool's currencies, and no fee pot", () => {
    const plan = planKitV2Earnings(lpFeeEarnings(), envOf("lp-fee"));
    expect(plan.pots.map((p) => [p.currency, p.fee, p.tax?.pot, p.share])).toEqual([
      [NATIVE_ADDRESS, null, 101n, 70n],
      [TOKEN, null, 0n, 0n],
    ]);
  });

  it("settle-and-claim names the one pool and the currency, and pays the account", () => {
    const pot = planKitV2Earnings(quoteFeeEarnings(), envOf("quote-fee")).pots[0]!;
    expect(pot.settleAndClaim.to).toBe(a(2));
    expect(decodeFunctionData({ abi: LAUNCH_GUARD_HOOK_ABI, data: pot.settleAndClaim.data })).toMatchObject({ functionName: "claimFrom", args: [[POOL], NATIVE_ADDRESS, ME] });
  });

  it("a wallet that is a party to the fee of one pool and the tax of another gets a row for each", () => {
    const e = quoteFeeEarnings();
    const two: EarningsV2 = { ...e, tax: { ...e.tax, pools: [{ ...e.tax.pools[0]!, poolId: POOL_2 }] } };
    const plan = planKitV2Earnings(two, envOf("quote-fee"));
    expect(plan.pots.map((p) => [p.poolId, p.fee?.share ?? null, p.tax?.share ?? null])).toEqual([
      [POOL, 801n, null],
      [POOL_2, null, 70n],
    ]);
  });

  it("an expired tax keeps its pot: what was taken before the expiry is still owed", () => {
    const e = quoteFeeEarnings();
    const expired: EarningsV2 = { ...e, tax: { ...e.tax, pools: [{ ...e.tax.pools[0]!, live: false }] } };
    expect(planKitV2Earnings(expired, envOf("quote-fee")).pots[0]!.tax).toMatchObject({ pot: 101n, share: 70n, live: false });
  });

  it("is never part of what is claimable now", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(), envOf("quote-fee"));
    expect(claimableTotals(plan)).toEqual([{ currency: NATIVE_ADDRESS, meta: null, amount: 250n }]);
  });
});

describe("planKitV2Earnings: the locks", () => {
  it("lp-fee: the trade fee accrues to the lock, and collecting is offered", () => {
    const plan = planKitV2Earnings(lpFeeEarnings(), envOf("lp-fee"));
    expect(plan.locks).toHaveLength(1);
    expect(plan.locks[0]).toMatchObject({ key: "CL:7", pools: "CL", locker: a(8), lockId: 7n, role: "creator", generation: "lp-fee", earnsTradeFee: true, lpShareBps: null });
    expect(decodeFunctionData({ abi: GULLYCORE_LP_LOCKER_ABI, data: plan.locks[0]!.collect.data })).toMatchObject({ functionName: "collectFees", args: [7n] });
    expect(collectableLocks(plan)).toHaveLength(1);
  });

  it("quote-fee CL, a guard that leaves the pool nothing: the lock earns no trade fee and is not offered for collection", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(0), envOf("quote-fee"));
    expect(plan.locks[0]).toMatchObject({ generation: "quote-fee", earnsTradeFee: false, lpShareBps: 0 });
    expect(collectableLocks(plan)).toEqual([]);
  });

  it("quote-fee CL, a guard that leaves the pool a share: the lock earns that part of what buys pay, and collecting is offered", () => {
    for (const share of [1, 2_500, 5_000]) {
      const plan = planKitV2Earnings(quoteFeeEarnings(share), envOf("quote-fee"));
      expect(plan.locks[0]).toMatchObject({ generation: "quote-fee", earnsTradeFee: true, lpShareBps: share });
      expect(collectableLocks(plan)).toHaveLength(1);
      expect(decodeFunctionData({ abi: GULLYCORE_LP_LOCKER_ABI, data: plan.locks[0]!.collect.data })).toMatchObject({ functionName: "collectFees", args: [7n] });
    }
  });

  it("quote-fee CL, a guard that did not say its share: unknown, never 'no', and collecting is offered", () => {
    const plan = planKitV2Earnings(quoteFeeEarnings(null), envOf("quote-fee"));
    expect(plan.locks[0]).toMatchObject({ generation: "quote-fee", earnsTradeFee: null, lpShareBps: null });
    expect(collectableLocks(plan)).toHaveLength(1);
  });

  it("a share read beside an lp-fee or unclassified guard says nothing: the generation decides first", () => {
    expect(lockEarnsTradeFee("lp-fee", null)).toBe(true);
    expect(lockEarnsTradeFee("lp-fee", 0)).toBe(true);
    expect(lockEarnsTradeFee("unknown", 2_500)).toBeNull();
    expect(lockEarnsTradeFee("unknown", 0)).toBeNull();
    expect(lockEarnsTradeFee("quote-fee", 0)).toBe(false);
    expect(lockEarnsTradeFee("quote-fee", 1)).toBe(true);
    expect(lockEarnsTradeFee("quote-fee", null)).toBeNull();
    /* The plan carries no share for a lock whose guard is not quote-fee, whatever the read held. */
    const e = quoteFeeEarnings(2_500);
    const lp: EarningsV2 = { ...e, locks: [{ ...e.locks[0]!, guardGeneration: "lp-fee" }] };
    expect(planKitV2Earnings(lp, envOf("lp-fee")).locks[0]).toMatchObject({ earnsTradeFee: true, lpShareBps: null });
  });

  it("quote-fee Bin: still offered, because liquidity added at the current price pays the lock", () => {
    const e = quoteFeeEarnings();
    const bin: EarningsV2 = { ...e, locks: [{ ...e.locks[0]!, locker: "Bin" }] };
    const plan = planKitV2Earnings(bin, envOf("quote-fee"));
    expect(plan.locks[0]).toMatchObject({ pools: "Bin", earnsTradeFee: false });
    expect(collectableLocks(plan)).toHaveLength(1);
  });

  it("an unclassified guard: unknown, and offered (a collect that finds nothing moves nothing)", () => {
    const e = quoteFeeEarnings();
    const unknown: EarningsV2 = { ...e, locks: [{ ...e.locks[0]!, guardGeneration: "unknown" }] };
    const plan = planKitV2Earnings(unknown, envOf("unknown"));
    expect(plan.locks[0]!.earnsTradeFee).toBeNull();
    expect(collectableLocks(plan)).toHaveLength(1);
  });
});

describe("the totals", () => {
  it("sum per currency, never across currencies, native first, zero rows dropped", () => {
    const plan = planKitV2Earnings(lpFeeEarnings(), envOf("lp-fee"));
    expect(claimableTotals(plan)).toEqual([
      // 1000 (kit) + 70 (locker) + 40 (guard)
      { currency: NATIVE_ADDRESS, meta: null, amount: 1_110n },
      // 5000 (locker) + 900 (guard)
      { currency: TOKEN, meta: TOKEN_META, amount: 5_900n },
    ]);
  });

  it("are empty for a wallet that is owed nothing", () => {
    const plan = planKitV2Earnings(EMPTY, envOf("lp-fee"));
    expect(plan.credits).toHaveLength(1); // the kit's row, at zero
    expect(claimableTotals(plan)).toEqual([]);
    expect(unsettledTotals(plan)).toEqual([]);
    expect(plan.pots).toEqual([]);
    expect(plan.locks).toEqual([]);
  });
});
