import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { PoolTrust, TokenTrust } from "@gullylabs/core-sdk/trust";

import { tokenTrustView } from "../src/trust/model.js";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const QUOTE = "0x00000000000000000000000000000000000000bb" as Address;
const GUARD = "0x0000000000000000000000000000000000000c02" as Address;
const KIT = "0x0000000000000000000000000000000000000c01" as Address;
const REG = "0x0000000000000000000000000000000000000c04" as Address;
const CLM = "0x0000000000000000000000000000000000000c06" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL = `0x${"11".repeat(32)}` as Hex;
const NOW = 1_800_000_000n;

function pool(over: Partial<PoolTrust> = {}): PoolTrust {
  return {
    poolId: POOL,
    kind: "CL",
    currency0: TOKEN,
    currency1: QUOTE,
    pairedWith: QUOTE,
    hooks: GUARD,
    keyFee: 0x800000,
    poolManager: CLM,
    origins: ["launch-leg", "lp-locker"],
    launchGuard: true,
    liquidity: {
      status: "read",
      sources: [{ contract: "GullyCoreLPLocker", address: GUARD, call: "getLock" }],
      lockedActiveBps: 9000,
      permanentActiveBps: 9000,
      timeLockedActiveBps: null,
      timeLockedCount: 0,
      unlockableCount: 0,
      permanentCount: 1,
      outOfRange: 0,
      nextUnlockAt: null,
      lastUnlockAt: null,
      measurable: true,
    },
    lpFee: { kind: "launch-guard", pips: 30_000, source: { contract: "LaunchGuardHook", address: GUARD, call: "currentFee" } },
    protocolFee: { status: "read", sources: [{ contract: "CLPoolManager", address: CLM, call: "getSlot0" }], zeroForOne: 0, oneForZero: 0 },
    tax: { status: "read", sources: [{ contract: "LaunchGuardHook", address: GUARD, call: "getTax, currentTaxRates" }], tax: null, buyBpsNow: 0, sellBpsNow: 0 },
    registry: {
      status: "read",
      sources: [{ contract: "GullyCoreRegistry", address: REG, call: "isRegistered, getGullyCore" }],
      listed: false,
      name: null,
      listing: null,
      verification: null,
      riskClass: null,
      permissionSource: null,
      attestationCount: 0,
      flagged: false,
      warnings: [],
    },
    ...over,
  };
}

function trust(over: Partial<TokenTrust> = {}): TokenTrust {
  return {
    token: TOKEN,
    native: false,
    symbol: "TKN",
    decimals: 18,
    readAt: { fromBlock: 10n, toBlock: 12n, chainNow: NOW },
    launch: {
      status: "read",
      sources: [{ contract: "LaunchpadKitV2", address: KIT, call: "legsOf" }],
      launch: { creator: GUARD, tenant: ZERO, operator: GUARD, integrator: ZERO, startTime: NOW - 10n, legCount: 1 },
    },
    tokenLocks: { status: "not-configured", reason: "GullyCoreTokenLock is not deployed on this chain" },
    pools: [pool()],
    failedPools: [],
    discovery: { searched: ["launch-leg", "lp-locker"], truncated: false, positionLocksTruncated: false },
    ...over,
  };
}

describe("tokenTrustView", () => {
  it("labels each pool with the paired symbol and every row with its source contract", () => {
    const v = tokenTrustView(trust(), { [QUOTE.toLowerCase()]: "WETH" });
    const p = v.pools[0]!;
    expect(p.title).toBe("TKN / WETH · CL pool");
    expect(p.foundBy).toBe("Found through a Kit v2 launch leg and an LP-locker lock.");
    expect(p.rows.map((r) => r.key)).toEqual(["liquidity", "lp-fee", "protocol-fee", "tax", "registry"]);
    expect(p.rows[0]!.headline).toBe("90% of active liquidity locked");
    expect(p.rows[1]!.headline).toBe("3% LP fee now");
    expect(p.rows[1]!.provenance[0]).toBe("LaunchGuardHook 0x0000…0c02");
    expect(p.rows[4]!.headline).toBe("Not listed in GullyCoreRegistry");
  });

  it("names the fee row for who charges it: the pool's LP fee, or the launch's trading fee", () => {
    const source = { contract: "LaunchGuardHook", address: GUARD, call: "currentFee" };
    const tax = {
      status: "read" as const,
      sources: [{ contract: "LaunchGuardHook", address: GUARD, call: "getTax, currentTaxRates" }],
      tax: { buyBps: 300, sellBps: 300, expiresAt: NOW + 3600n, creator: GUARD, integrator: ZERO, creatorBps: 9000, protocolBps: 1000, integratorBps: 0 },
      buyBpsNow: 300,
      sellBpsNow: 300,
    };
    const rows = (takenBy: "pool" | "launch" | undefined) =>
      tokenTrustView(trust({ pools: [pool({ lpFee: { kind: "launch-guard", pips: 10_000, source, ...(takenBy === undefined ? {} : { takenBy }) }, tax })] })).pools[0]!.rows;

    const taken = rows("launch");
    /* The key stays: it is what a host styles and tests by. The words are the fee's own. */
    expect(taken[1]!.key).toBe("lp-fee");
    expect(taken[1]!.label).toBe("Trading fee");
    expect(taken[1]!.headline).toBe("1% trading fee now");
    expect(taken[3]!.detail).toContain("in the pool's quote currency on each swap, buys and sells alike,");
    /* No division was read for that row, and it says so: never that the pool's own fee is zero. */
    expect(taken[1]!.detail).toContain("could not be read");
    expect(taken[1]!.detail).not.toContain("zero");

    /* With the division read, the row says who receives which part of a buy's fee. */
    const divided = (parts: { lpShareBps: number | null; buyLpPips: number; buyGuardPips: number; sellGuardPips: number } | null) =>
      tokenTrustView(trust({ pools: [pool({ lpFee: { kind: "launch-guard", pips: 10_000, source, takenBy: "launch", parts }, tax })] })).pools[0]!.rows[1]!;
    const shared = divided({ lpShareBps: 2_500, buyLpPips: 2_500, buyGuardPips: 7_500, sellGuardPips: 10_000 });
    expect(shared.label).toBe("Trading fee");
    expect(shared.headline).toBe("1% trading fee now");
    expect(shared.detail).toContain("On a buy, 0.25% goes to the pool's liquidity providers and the launch guard takes 0.75%. On a sell the launch guard takes all of it.");
    expect(divided({ lpShareBps: 0, buyLpPips: 0, buyGuardPips: 10_000, sellGuardPips: 10_000 }).detail).toContain("The pool's own LP fee is zero.");
    expect(divided(null).detail).toContain("could not be read");

    for (const r of [rows("pool"), rows(undefined)]) {
      expect(r[1]!.label).toBe("LP fee");
      expect(r[1]!.headline).toBe("1% LP fee now");
      expect(r[3]!.detail).toContain("Taken by the launch guard on each swap until");
      expect(r[3]!.detail).not.toContain("quote currency");
    }
  });

  it("says 'No creator tax' for a launch whose guard reads zero, and 'Not a Gully Core launch' when legsOf is empty", () => {
    expect(tokenTrustView(trust()).creatorTax.headline).toBe("No creator tax");
    const notLaunch = tokenTrustView(trust({ launch: { status: "read", sources: [], launch: null }, pools: [] }));
    expect(notLaunch.creatorTax.headline).toBe("Not a Gully Core launch");
    const noKit = tokenTrustView(trust({ launch: { status: "not-configured", reason: "x" }, pools: [] }));
    expect(noKit.creatorTax.headline).toBe("Coming soon");
    expect(noKit.creatorTax.tone).toBe("missing");
  });

  it("omits the tax row on a pool whose hook is not a launch guard, and says the pool list is not exhaustive", () => {
    const v = tokenTrustView(
      trust({
        pools: [pool({ launchGuard: false, tax: { status: "not-a-launch-pool" }, origins: ["given"] })],
        discovery: { searched: ["given"], truncated: true, positionLocksTruncated: false },
      }),
    );
    expect(v.pools[0]!.rows.some((r) => r.key === "tax")).toBe(false);
    expect(v.discoveryNote).toContain("only the first of them were read");
    expect(v.discoveryNote).toContain("is not listed");
  });

  it("differing taxes across launch legs are said to differ, never averaged", () => {
    const taxed = pool({
      poolId: `0x${"22".repeat(32)}` as Hex,
      tax: {
        status: "read",
        sources: [],
        tax: { buyBps: 500, sellBps: 500, expiresAt: NOW + 100n, creator: GUARD, integrator: ZERO, creatorBps: 9000, protocolBps: 1000, integratorBps: 0 },
        buyBpsNow: 500,
        sellBpsNow: 500,
      },
    });
    const v = tokenTrustView(trust({ pools: [pool(), taxed] }));
    expect(v.creatorTax.headline).toBe("Differs by pool");
    expect(v.summary.creatorTaxLive).toBe(true);
  });

  it("never renders 'safe'", () => {
    const v = tokenTrustView(trust());
    const text = JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
    expect(text).not.toMatch(/\bsafe\b|rug-proof/i);
  });
});
