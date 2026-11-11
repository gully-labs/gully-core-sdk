import { ContractFunctionRevertedError, HttpRequestError, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { encodeCLPoolParameters } from "../src/index.js";
import {
  describeCreatorTax,
  describeLaunch,
  describeLiquidity,
  describeLpFee,
  describeProtocolFee,
  describeRegistry,
  describeTokenLocks,
  formatFeePips,
  formatTrustBps,
  formatTrustSource,
  mergePoolCandidates,
  readTokenTrust,
  summarizeTokenTrust,
  type PoolLiquidityFacts,
  type TokenTrust,
} from "../src/trust/index.js";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const QUOTE = "0x00000000000000000000000000000000000000bb" as Address;
const KIT = "0x0000000000000000000000000000000000000c01" as Address;
const GUARD = "0x0000000000000000000000000000000000000c02" as Address;
const BIN_GUARD = "0x0000000000000000000000000000000000000c03" as Address;
const REG = "0x0000000000000000000000000000000000000c04" as Address;
const TLOCK = "0x0000000000000000000000000000000000000c05" as Address;
const CLM = "0x0000000000000000000000000000000000000c06" as Address;
const BINM = "0x0000000000000000000000000000000000000c07" as Address;
const CREATOR = "0x0000000000000000000000000000000000000d01" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL = `0x${"11".repeat(32)}` as Hex;
const POOL2 = `0x${"22".repeat(32)}` as Hex;

const READ_AT = { fromBlock: 100n, toBlock: 103n, chainNow: 1_800_000_000n };

const liq = (over: Partial<PoolLiquidityFacts> = {}): PoolLiquidityFacts => ({
  lockedActiveBps: null,
  permanentActiveBps: null,
  timeLockedActiveBps: null,
  timeLockedCount: 0,
  unlockableCount: 0,
  permanentCount: 0,
  outOfRange: 0,
  nextUnlockAt: null,
  lastUnlockAt: null,
  measurable: true,
  ...over,
});

describe("trust formatting", () => {
  it("formats bps and fee pips exactly", () => {
    expect(formatTrustBps(8234)).toBe("82.34%");
    expect(formatTrustBps(10_000)).toBe("100%");
    expect(formatTrustBps(5)).toBe("0.05%");
    expect(formatTrustBps(1250)).toBe("12.5%");
    expect(formatFeePips(3000)).toBe("0.3%");
    expect(formatFeePips(999)).toBe("0.0999%");
    expect(formatFeePips(0)).toBe("0%");
    expect(formatFeePips(10_000)).toBe("1%");
    expect(formatFeePips(52_500)).toBe("5.25%");
  });

  it("states provenance as contract, call and blocks", () => {
    const s = formatTrustSource({ contract: "GullyCoreTokenLock", address: TLOCK, call: "totalHeld" }, READ_AT);
    expect(s).toBe("GullyCoreTokenLock 0x0000…0c05 · totalHeld · blocks 100–103");
    expect(formatTrustSource({ contract: "X", address: TLOCK, call: "y" }, { fromBlock: 7n, toBlock: 7n })).toMatch(/· block 7$/);
  });

  it("says what the liquidity read found, never more", () => {
    expect(describeLiquidity({ status: "read", sources: [], ...liq() }, "CL").headline).toBe("No locked liquidity");
    expect(describeLiquidity({ status: "read", sources: [], ...liq({ unlockableCount: 2 }) }, "CL").headline).toBe("No locked liquidity now");
    const perm = describeLiquidity({ status: "read", sources: [], ...liq({ lockedActiveBps: 6000, permanentActiveBps: 6000, permanentCount: 1 }) }, "CL");
    expect(perm.headline).toBe("60% of active liquidity locked");
    expect(perm.detail).toContain("locked permanently (LP locker, no withdraw path)");
    expect(describeLiquidity({ status: "read", sources: [], ...liq({ permanentCount: 1, measurable: false }) }, "CL").headline).toBe("Locked permanently (LP locker)");
    expect(describeLiquidity({ status: "read", sources: [], ...liq({ permanentCount: 2, lockedActiveBps: 2500 }) }, "Bin").headline).toBe("25% of the active bin locked permanently (LP locker)");
    expect(describeLiquidity({ status: "not-configured", reason: "GullyCorePositionLock is not deployed" }, "CL").tone).toBe("missing");
    expect(describeLiquidity({ status: "error", message: "timeout", source: null }, "CL").headline).toBe("Could not be read");
  });

  it("never calls anything safe", () => {
    const lines = [
      describeRegistry({ status: "read", sources: [], listed: true, name: "Guard", listing: "Active", verification: "Audited", riskClass: "ValueExtracting", permissionSource: "PoolAttested", attestationCount: 1, flagged: false, warnings: [] }),
      describeRegistry({ status: "read", sources: [], listed: false, name: null, listing: null, verification: null, riskClass: null, permissionSource: null, attestationCount: 0, flagged: false, warnings: [] }),
      describeLiquidity({ status: "read", sources: [], ...liq({ lockedActiveBps: 10_000, permanentCount: 1, permanentActiveBps: 10_000 }) }, "CL"),
    ];
    for (const l of lines) expect(`${l.headline} ${l.detail}`).not.toMatch(/\bsafe\b|rug/i);
    expect(lines[0]!.detail).toContain("a listing is not an audit");
  });

  it("describes the registry as what it records, and flags as flags", () => {
    const flagged = describeRegistry({ status: "read", sources: [], listed: true, name: null, listing: "Malicious", verification: "Unverified", riskClass: "Passive", permissionSource: "SelfReported", attestationCount: 0, flagged: true, warnings: ["FlaggedMalicious"] });
    expect(flagged.headline).toBe("Flagged malicious in GullyCoreRegistry");
    expect(flagged.tone).toBe("flagged");
    expect(describeRegistry({ status: "no-hook" }).headline).toBe("No hook");
    expect(describeRegistry({ status: "not-configured", reason: "The Gully Core Marketplace is coming soon on this chain" }).headline).toBe("Coming soon");
  });

  it("says 'No creator tax' only when read as zero", () => {
    expect(describeCreatorTax({ status: "not-a-launch-pool" }, READ_AT.chainNow).headline).toBe("Not a Gully Core launch pool");
    expect(describeCreatorTax({ status: "read", sources: [], tax: null, buyBpsNow: 0, sellBpsNow: 0 }, READ_AT.chainNow).headline).toBe("No creator tax");
    expect(describeCreatorTax({ status: "error", message: "x", source: null }, READ_AT.chainNow).headline).toBe("Could not be read");
    const tax = { buyBps: 300, sellBps: 500, expiresAt: READ_AT.chainNow + 86_400n, creator: CREATOR, integrator: ZERO, creatorBps: 9000, protocolBps: 1000, integratorBps: 0 };
    const live = describeCreatorTax({ status: "read", sources: [], tax, buyBpsNow: 300, sellBpsNow: 500 }, READ_AT.chainNow);
    expect(live.headline).toBe("Creator tax: buy 3% · sell 5% now");
    expect(live.detail).toContain("90% creator, 10% protocol");
    expect(live.detail).not.toContain("integrator");
    expect(live.detail).toContain("Taken by the launch guard on each swap until");
    expect(describeCreatorTax({ status: "read", sources: [], tax, buyBpsNow: 300, sellBpsNow: 500 }, READ_AT.chainNow, "pool").detail).toBe(live.detail);
    const inQuote = describeCreatorTax({ status: "read", sources: [], tax, buyBpsNow: 300, sellBpsNow: 500 }, READ_AT.chainNow, "launch");
    expect(inQuote.headline).toBe(live.headline);
    expect(inQuote.detail).toContain("Taken by the launch guard in the pool's quote currency on each swap, buys and sells alike, until");
    const ended = describeCreatorTax({ status: "read", sources: [], tax: { ...tax, expiresAt: READ_AT.chainNow - 1n }, buyBpsNow: 0, sellBpsNow: 0 }, READ_AT.chainNow);
    expect(ended.headline).toBe("Creator tax ended");
  });

  it("describes fees: guard now, static, dynamic, protocol per direction", () => {
    const src = { contract: "C", address: GUARD, call: "currentFee" };
    expect(describeLpFee({ kind: "launch-guard", pips: 50_000, source: src }).headline).toBe("5% LP fee now");
    expect(describeLpFee({ kind: "launch-guard", pips: 50_000, source: src, takenBy: "pool" }).headline).toBe("5% LP fee now");
    /* A guard that takes the fee itself and leaves the pool nothing: the line names the fee, never an LP fee. */
    const taken = describeLpFee({ kind: "launch-guard", pips: 10_000, source: src, takenBy: "launch", parts: { lpShareBps: 0, buyLpPips: 0, buyGuardPips: 10_000, sellGuardPips: 10_000 } });
    expect(taken.headline).toBe("1% trading fee now");
    expect(taken.detail).toContain("in the pool's quote currency on every trade, buys and sells alike");
    expect(taken.detail).toContain("The pool's own LP fee is zero");
    /* A guard that leaves the pool a share: each part is named, and nothing says the pool's fee is zero. */
    const shared = describeLpFee({ kind: "launch-guard", pips: 10_000, source: src, takenBy: "launch", parts: { lpShareBps: 2_500, buyLpPips: 2_500, buyGuardPips: 7_500, sellGuardPips: 10_000 } });
    expect(shared.headline).toBe("1% trading fee now");
    expect(shared.detail).toContain("On a buy, 0.25% goes to the pool's liquidity providers and the launch guard takes 0.75%.");
    expect(shared.detail).toContain("On a sell the launch guard takes all of it.");
    expect(shared.detail).toContain("Every part is paid in the pool's quote currency.");
    expect(shared.detail).not.toContain("zero");
    /* A guard that did not say how the fee is divided: the whole fee, and the split is unknown, never zero. */
    for (const parts of [null, undefined]) {
      const unknown = describeLpFee({ kind: "launch-guard", pips: 10_000, source: src, takenBy: "launch", ...(parts === undefined ? {} : { parts }) });
      expect(unknown.headline).toBe("1% trading fee now");
      expect(unknown.detail).toContain("could not be read");
      expect(unknown.detail).not.toContain("zero");
    }
    expect(describeLpFee({ kind: "static", pips: 3000, source: src }).headline).toBe("0.3% LP fee");
    expect(describeLpFee({ kind: "dynamic", reason: "flag", source: null }).headline).toBe("Dynamic (hook-set)");
    expect(describeProtocolFee({ status: "read", sources: [], zeroForOne: 0, oneForZero: 0 }).headline).toBe("No protocol fee");
    expect(describeProtocolFee({ status: "read", sources: [], zeroForOne: 999, oneForZero: 999 }).headline).toBe("0.0999% protocol fee");
    expect(describeProtocolFee({ status: "read", sources: [], zeroForOne: 999, oneForZero: 0 }).headline).toBe("0.0999% / 0% protocol fee");
  });

  it("describes token locks by what nobody can take yet", () => {
    const base = { status: "read" as const, sources: [], lockCount: 2, totalHeld: 150n * 10n ** 18n, unvested: 100n * 10n ** 18n, totalSupply: 1000n * 10n ** 18n, heldBps: 1500, unvestedBps: 1000, nextRelease: READ_AT.chainNow + 10n, lastEnd: READ_AT.chainNow + 100n };
    const l = describeTokenLocks(base, "TKN", 18);
    expect(l.headline).toBe("10% of supply locked");
    expect(l.detail).toContain("15% of supply (150 TKN) held in 2 locks");
    expect(describeTokenLocks({ ...base, lockCount: 0, totalHeld: 0n, unvested: 0n }, "TKN", 18).headline).toBe("No TKN locked");
    expect(describeTokenLocks({ status: "not-configured", reason: "Token locks are coming soon on this chain" }, "TKN", 18).headline).toBe("Coming soon");
  });

  it("launch: unknown without a kit, never 'not a launch'", () => {
    expect(describeLaunch({ status: "not-configured", reason: "x" }, READ_AT).headline).toBe("Launch status unknown");
    expect(describeLaunch({ status: "read", sources: [], launch: null }, READ_AT).headline).toBe("Not a Gully Core launch");
  });
});

describe("pool discovery merge", () => {
  it("keeps one row per pool, unions origins, keeps first order", () => {
    const out = mergePoolCandidates([
      [{ poolId: POOL, kind: "CL", origin: "launch-leg" }],
      [
        { poolId: POOL2, kind: "Bin", origin: "given" },
        { poolId: POOL.toUpperCase().replace("0X", "0x") as Hex, kind: "CL", origin: "given" },
      ],
      [{ poolId: POOL, kind: "CL", origin: "lp-locker" }],
    ]);
    expect(out.map((p) => p.poolId)).toEqual([POOL, POOL2]);
    expect(out[0]!.origins).toEqual(["launch-leg", "given", "lp-locker"]);
  });
});

/* --------------------------------------------------------- composition --- */

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

function fakeClient(handlers: Record<string, (c: Call) => unknown>): PublicClient {
  let block = 100n;
  return {
    getBlockNumber: async () => block++,
    getBlock: async () => ({ timestamp: READ_AT.chainNow }),
    readContract: async (c: Call) => {
      const h = handlers[`${c.address.toLowerCase()}.${c.functionName}`] ?? handlers[c.functionName];
      if (h === undefined) throw new Error(`unexpected read ${c.address}.${c.functionName}`);
      return h(c);
    },
  } as unknown as PublicClient;
}

const meta = { symbol: () => "TKN", name: () => "Token", decimals: () => 18 };

describe("readTokenTrust composition", () => {
  it("reports every section as not configured when nothing is deployed", async () => {
    const t = await readTokenTrust(fakeClient({ ...meta }), { token: TOKEN, contracts: { clPoolManager: CLM, binPoolManager: BINM } });
    expect(t.symbol).toBe("TKN");
    expect(t.launch.status).toBe("not-configured");
    expect(t.tokenLocks.status).toBe("not-configured");
    expect(t.pools).toEqual([]);
    expect(t.readAt.fromBlock).toBe(100n);
    expect(t.readAt.toBlock).toBeGreaterThanOrEqual(t.readAt.fromBlock);
    expect(summarizeTokenTrust(t).launch).toBe("unknown");
  });

  it("reads a Kit v2 launch: legs, guard fee, creator tax, registry, token locks", async () => {
    const client = fakeClient({
      ...meta,
      [`${KIT}.legsOf`]: () => [POOL],
      [`${KIT}.getLaunch`]: () => ({ creator: CREATOR, createdAt: 1, legCount: 1, operator: CREATOR, startTime: Number(READ_AT.chainNow - 60n), tenant: ZERO, integrator: ZERO }),
      [`${KIT}.clHook`]: () => GUARD,
      [`${KIT}.binHook`]: () => BIN_GUARD,
      [`${KIT}.getLeg`]: () => ({ launchToken: TOKEN, kind: 0, launchTokenIsCurrency0: true, lockId: 7n }),
      [`${CLM}.poolIdToPoolKey`]: () => [TOKEN, QUOTE, GUARD, CLM, 0x800000, `0x${"00".repeat(32)}`],
      [`${CLM}.getSlot0`]: () => [2n ** 96n, 0, 999 | (999 << 12), 0],
      [`${GUARD}.currentFee`]: () => 50_000,
      [`${GUARD}.getTax`]: () => ({ creator: CREATOR, buyBps: 300, sellBps: 500, expiresAt: Number(READ_AT.chainNow + 3600n), creatorBps: 9000, integrator: ZERO, protocolBps: 1000, integratorBps: 0 }),
      [`${GUARD}.currentTaxRates`]: () => [300, 500],
      [`${REG}.isRegistered`]: () => true,
      [`${REG}.getGullyCore`]: () => ({
        submitter: CREATOR, submittedAt: 1n, permissions: 0, verification: 0, listing: 0, steward: CREATOR, updatedAt: 1n,
        permissionsValid: true, permissionsReadable: true, attestedPermissions: 0, codehash: `0x${"00".repeat(32)}`,
        attestedPoolManager: ZERO, attestedAt: 0n, attestationCount: 0, attestedPoolId: `0x${"00".repeat(32)}`,
        metadata: { name: "Launch guard", description: "", sourceURI: "", auditURI: "", chainIds: [] },
      }),
      [`${TLOCK}.currencyLockCount`]: () => 0n,
      [`${TLOCK}.totalHeld`]: () => 0n,
      [`${TOKEN}.totalSupply`]: () => 1000n,
    });
    const t: TokenTrust = await readTokenTrust(client, {
      token: TOKEN,
      contracts: { clPoolManager: CLM, binPoolManager: BINM, launchpadKitV2: KIT, registry: REG, tokenLock: TLOCK },
    });
    expect(t.launch.status).toBe("read");
    expect(t.launch.status === "read" && t.launch.launch?.creator).toBe(CREATOR);
    expect(t.pools).toHaveLength(1);
    const p = t.pools[0]!;
    expect(p.origins).toEqual(["launch-leg"]);
    expect(p.launchGuard).toBe(true);
    expect(p.pairedWith).toBe(QUOTE);
    /* The key's bitmap is not one of a guard that takes the fee itself, so the fee is the pool's. */
    expect(p.lpFee).toMatchObject({ kind: "launch-guard", pips: 50_000, takenBy: "pool" });
    expect(p.protocolFee).toMatchObject({ status: "read", zeroForOne: 999, oneForZero: 999 });
    expect(p.tax.status === "read" && p.tax.tax?.buyBps).toBe(300);
    expect(p.registry).toMatchObject({ status: "read", listed: true, name: "Launch guard", listing: "Active", flagged: false });
    /* Neither the position lock nor an LP locker is configured: said, not zeroed. */
    expect(p.liquidity.status).toBe("not-configured");
    expect(t.tokenLocks).toMatchObject({ status: "read", lockCount: 0, totalSupply: 1000n });
    const sum = summarizeTokenTrust(t);
    expect(sum).toMatchObject({ launch: "launch", poolsRead: 1, creatorTaxLive: true, flaggedHooks: 0, errors: 0 });
  });

  it("says who charges a launch pool's fee from the bitmap in the pool's own key", async () => {
    const asked: string[] = [];
    const read = async (bitmap: number, parts: Record<string, (c: Call) => unknown> = {}): Promise<TokenTrust> =>
      readTokenTrust(
        fakeClient({
          ...meta,
          ...parts,
          [`${KIT}.legsOf`]: () => [POOL],
          [`${KIT}.getLaunch`]: () => ({ creator: CREATOR, createdAt: 1, legCount: 1, operator: CREATOR, startTime: Number(READ_AT.chainNow - 60n), tenant: ZERO, integrator: ZERO }),
          [`${KIT}.clHook`]: () => GUARD,
          [`${KIT}.binHook`]: () => BIN_GUARD,
          [`${KIT}.getLeg`]: () => ({ launchToken: TOKEN, kind: 0, launchTokenIsCurrency0: true, lockId: 7n }),
          [`${CLM}.poolIdToPoolKey`]: () => [TOKEN, QUOTE, GUARD, CLM, 0x800000, encodeCLPoolParameters(bitmap, 60)],
          /* The pool's own LP fee reads zero where the guard takes the fee: it is never what is reported. */
          [`${CLM}.getSlot0`]: () => [2n ** 96n, 0, 0, 0],
          [`${GUARD}.currentFee`]: () => 10_000,
          [`${GUARD}.getTax`]: () => ({ creator: CREATOR, buyBps: 0, sellBps: 0, expiresAt: 0, creatorBps: 0, integrator: ZERO, protocolBps: 0, integratorBps: 0 }),
          [`${GUARD}.currentTaxRates`]: () => [0, 0],
          [`${REG}.isRegistered`]: () => false,
          [`${TLOCK}.currencyLockCount`]: () => 0n,
          [`${TLOCK}.totalHeld`]: () => 0n,
          [`${TOKEN}.totalSupply`]: () => 1000n,
        }),
        { token: TOKEN, contracts: { clPoolManager: CLM, binPoolManager: BINM, launchpadKitV2: KIT, registry: REG, tokenLock: TLOCK } },
      );
    /* A guard that takes the fee itself is asked how it divides it, and the answer is carried as read. */
    const answers = {
      [`${GUARD}.LP_SHARE_BPS`]: () => (asked.push("LP_SHARE_BPS"), 2_500),
      [`${GUARD}.currentFeeParts`]: () => (asked.push("currentFeeParts"), [2_500, 7_500, 10_000]),
    };
    const taken = (await read(0x0cc1, answers)).pools[0]!;
    expect(taken.lpFee).toEqual({
      kind: "launch-guard",
      pips: 10_000,
      source: { contract: "LaunchGuardHook", address: GUARD, call: "currentFee, currentFeeParts, LP_SHARE_BPS" },
      takenBy: "launch",
      parts: { lpShareBps: 2_500, buyLpPips: 2_500, buyGuardPips: 7_500, sellGuardPips: 10_000 },
    });
    expect(describeLpFee(taken.lpFee).headline).toBe("1% trading fee now");
    expect(describeLpFee(taken.lpFee).detail).toContain("On a buy, 0.25% goes to the pool's liquidity providers");
    expect(asked.sort()).toEqual(["LP_SHARE_BPS", "currentFeeParts"]);

    /* A guard that REVERTS both: the whole fee is still reported, and the split is null, not zero. */
    const reverts = () => {
      throw new ContractFunctionRevertedError({ abi: [], functionName: "currentFeeParts" });
    };
    const silent = (await read(0x0cc1, { [`${GUARD}.LP_SHARE_BPS`]: reverts, [`${GUARD}.currentFeeParts`]: reverts })).pools[0]!;
    expect(silent.lpFee).toMatchObject({ kind: "launch-guard", pips: 10_000, takenBy: "launch", parts: null });
    expect(describeLpFee(silent.lpFee).detail).toContain("could not be read");
    expect(describeLpFee(silent.lpFee).detail).not.toContain("zero");

    /* A transport failure of the parts is an error, never a fee with a guessed split. */
    const down = () => {
      throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
    };
    expect((await read(0x0cc1, { [`${GUARD}.LP_SHARE_BPS`]: down, [`${GUARD}.currentFeeParts`]: down })).pools[0]!.lpFee).toMatchObject({ kind: "error" });

    /* A pool whose fee is the pool's own is never asked: no answers are scripted, and asking would throw. */
    asked.length = 0;
    const pool = (await read(0x08c1)).pools[0]!;
    expect(pool.lpFee).toMatchObject({ kind: "launch-guard", pips: 10_000, takenBy: "pool" });
    expect(pool.lpFee).not.toHaveProperty("parts");
    expect(describeLpFee(pool.lpFee).headline).toBe("1% LP fee now");
    /* The Bin guard's bitmap on a CL key is not a CL guard that takes the fee: nothing is assumed. */
    expect((await read(0x0cc5)).pools[0]!.lpFee).toMatchObject({ takenBy: "pool" });
  });

  it("a failed read is an error section, not a default", async () => {
    const client = fakeClient({
      ...meta,
      [`${KIT}.legsOf`]: () => {
        throw new Error("HTTP request failed");
      },
      [`${KIT}.getLaunch`]: () => ({}),
      [`${KIT}.clHook`]: () => GUARD,
      [`${KIT}.binHook`]: () => BIN_GUARD,
    });
    const t = await readTokenTrust(client, { token: TOKEN, contracts: { clPoolManager: CLM, binPoolManager: BINM, launchpadKitV2: KIT } });
    expect(t.launch).toMatchObject({ status: "error" });
    expect(describeLaunch(t.launch, t.readAt).headline).toBe("Could not be read");
  });

  it("a given dynamic-fee pool with no hook reads as dynamic and no hook", async () => {
    const client = fakeClient({
      ...meta,
      [`${CLM}.poolIdToPoolKey`]: () => [QUOTE, TOKEN, ZERO, CLM, 0x800000, `0x${"00".repeat(32)}`],
      [`${CLM}.getSlot0`]: () => [2n ** 96n, 0, 0, 3000],
    });
    const t = await readTokenTrust(client, { token: TOKEN, contracts: { clPoolManager: CLM, binPoolManager: BINM }, pools: [{ poolId: POOL2, kind: "CL" }] });
    const p = t.pools[0]!;
    expect(p.lpFee.kind).toBe("dynamic");
    expect(p.registry.status).toBe("no-hook");
    expect(p.tax.status).toBe("not-a-launch-pool");
    expect(p.pairedWith).toBe(QUOTE);
  });
});

/**
 * Deployment status is internal (rule, 2026-09-19). These lines reach the dapp, the public
 * token pages and every hosted launchpad site, so a not-configured section must say the feature is
 * coming, never which contract is missing or how the app worked that out.
 *
 * Asserted as a RULE over every describe* function rather than as two literals, because the two
 * literals it replaced were the ones that drifted: the copy was corrected in three places and the
 * fourth kept saying "not deployed on this chain" until a sweep noticed it on a live page.
 */
describe("not-configured copy never states deployment status", () => {
  const BANNED = /not deployed|no contract|is absent|address book|null address/i;
  /* Contract identifiers are code-voice elsewhere and fine there; they are not fine in a line whose
     whole job is telling a visitor a feature has not arrived. */
  const NAMES = /LaunchpadKitV2|GullyCoreTokenLock|GullyCoreRegistry|GullyCorePadFactory|GullyCoreSplit|LaunchGuardHook/;

  const lines = [
    describeRegistry({ status: "not-configured", reason: "The Gully Core Marketplace is coming soon on this chain" }),
    describeTokenLocks({ status: "not-configured", reason: "Token locks are coming soon on this chain" }, "TKN", 18),
    describeLaunch({ status: "not-configured", reason: "Launches are coming soon on this chain" }, { chainNow: 0n }),
  ];

  it("says coming soon, names no contract, and describes no deployment", () => {
    for (const line of lines) {
      const text = `${line.headline} ${line.detail ?? ""}`;
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(NAMES);
      expect(text.toLowerCase()).toContain("coming soon");
      expect(line.tone).toBe("missing");
    }
  });

  it("still distinguishes a FAILED read from a feature that has not arrived", () => {
    /* Collapsing these would hide an outage behind a roadmap promise. */
    const failed = describeTokenLocks({ status: "error", message: "HTTP 503", source: null }, "TKN", 18);
    expect(failed.headline).toBe("Could not be read");
    expect(failed.tone).toBe("error");
  });
});
