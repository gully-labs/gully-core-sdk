// SPDX-License-Identifier: MIT
/**
 * `src/launchpad/kitV2/reads.ts`, driven by a scripted fake `PublicClient`.
 *
 * ## The fake client's contract
 *
 * `fakeClient(world)` implements the four methods the reads touch:
 *
 * - `readContract` dispatches on `${address}:${functionName}` against
 *   `world.reads`; an entry is a value or a function of `args`. Anything not
 *   scripted THROWS, so an unexpected read fails the test instead of feeding
 *   `undefined` into a decoder. (`readTokenMeta` swallows that throw into
 *   `null`, which is its documented behaviour for an unreadable token.)
 * - `getLogs` dispatches on `event.name` against `world.logs` and applies the
 *   `args` filter the way a node's topic filter would, so the test can see
 *   both what was ASKED (recorded) and what came back.
 * - `call` REJECTS the creation-call `NUMBER` probe `readContractClock` tries
 *   first, the way a public RPC that refuses creation calls does.
 * - `getBlock` returns a fixed Nitro-shaped header with `l1BlockNumber`.
 *   Chain 31337 is not in the address book, so `readContractClock` takes the
 *   parent-l1 path, the probe fails and it falls through to the header. Every
 *   phase below is judged against THAT header's timestamp.
 *
 * Nothing here is a chain. Every number asserted is one this file put into
 * `world`.
 */

import { ContractFunctionRevertedError, HttpRequestError, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  CONTRACT_CLOCK_PROBE_CALLDATA,
  KitV2ClockError,
  LAUNCH_GUARD_BITMAPS,
  NATIVE_ADDRESS,
  TIMESTAMP_CLOCK_MODE,
  launchPhase,
  readKitV2Earnings,
  readKitV2Env,
  readKitV2Launches,
  readKitV2Limits,
  KIT_V2_LAUNCH_CREATED_EVENT,
  KIT_V2_LAUNCH_LEG_CREATED_EVENT,
  type KitV2Env,
  type KitV2LaunchCreatedLog,
  type KitV2LaunchLegCreatedLog,
  type KitV2LaunchLogs,
  type LaunchScanV2,
} from "../src/index.js";

/* ------------------------------------------------------------ fixtures --- */

const KIT: Address = "0x00000000000000000000000000000000000000e1";
const CL_HOOK: Address = "0x00000000000000000000000000000000000000d1";
const BIN_HOOK: Address = "0x00000000000000000000000000000000000000d2";
const CL_PM: Address = "0x00000000000000000000000000000000000000a2";
const BIN_PM: Address = "0x00000000000000000000000000000000000000a3";
const CL_LOCKER: Address = "0x00000000000000000000000000000000000000b1";
const BIN_LOCKER: Address = "0x00000000000000000000000000000000000000b2";
const FACTORY: Address = "0x00000000000000000000000000000000000000f1";
const REGISTRY: Address = "0x00000000000000000000000000000000000000f2";
const TREASURY: Address = "0x00000000000000000000000000000000000000f3";
const CREATOR: Address = "0x0000000000000000000000000000000000000c01";
const OPERATOR: Address = "0x0000000000000000000000000000000000000c02";
const LAUNCHER: Address = "0x0000000000000000000000000000000000000c04";
const INTEGRATOR: Address = "0x0000000000000000000000000000000000000c05";
const TENANT: Address = "0x0000000000000000000000000000000000000c06";
const OTHER_CREATOR: Address = "0x0000000000000000000000000000000000000c07";
const USD: Address = "0x8000000000000000000000000000000000000000";
const TOKEN_A: Address = "0xa000000000000000000000000000000000000001";
const TOKEN_B: Address = "0xb000000000000000000000000000000000000001";
const POOL_A_CL: Hex = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const POOL_A_BIN: Hex = "0x00000000000000000000000000000000000000000000000000000000000000a2";
const POOL_B_CL: Hex = "0x00000000000000000000000000000000000000000000000000000000000000b1";
const TX_A: Hex = "0x0000000000000000000000000000000000000000000000000000000000000aaa";
const TX_B: Hex = "0x0000000000000000000000000000000000000000000000000000000000000bbb";

const HEADER_TIMESTAMP = 1_700_000_000n;
const HEADER_NUMBER = 500n;

const CL_POSM: Address = "0x0000000000000000000000000000000000000d01";
const BIN_POSM: Address = "0x0000000000000000000000000000000000000d02";
const KEY_A_CL = { currency0: TOKEN_A, currency1: USD, hooks: CL_HOOK, poolManager: CL_PM, fee: 0x800000, parameters: "0x0000000000000000000000000000000000000000000000000000000000003c0041" as Hex };
const KEY_B_CL = { currency0: "0x0000000000000000000000000000000000000000" as Address, currency1: TOKEN_B, hooks: CL_HOOK, poolManager: CL_PM, fee: 0x800000, parameters: "0x0000000000000000000000000000000000000000000000000000000000003c0041" as Hex };
const KEY_A_BIN = { currency0: TOKEN_A, currency1: USD, hooks: BIN_HOOK, poolManager: BIN_PM, fee: 0x800000, parameters: "0x00000000000000000000000000000000000000000000000000000000000a0045" as Hex };

const ENV: KitV2Env = {
  kit: KIT,
  clHook: CL_HOOK,
  binHook: BIN_HOOK,
  clPoolManager: CL_PM,
  binPoolManager: BIN_PM,
  clPositionManager: CL_POSM,
  binPositionManager: BIN_POSM,
  clLocker: CL_LOCKER,
  binLocker: BIN_LOCKER,
  tokenFactory: FACTORY,
  launchRegistry: REGISTRY,
  protocolFeeRecipient: TREASURY,
  /* The guards every test below runs on unless it says otherwise: the lp-fee generation. */
  clHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].CL,
  binHookBitmap: LAUNCH_GUARD_BITMAPS["lp-fee"].Bin,
};

/** The same kit on quote-fee guards. */
const ENV_QUOTE_FEE: KitV2Env = {
  ...ENV,
  clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL,
  binHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin,
};

/** The functions only a quote-fee guard has. An lp-fee leg must never be asked for one. */
const QUOTE_FEE_ONLY = ["getFeeSplit", "pendingCreator", "pendingFee", "feeTaken", "feeSettled", "MIN_FEE_PROTOCOL_BPS", "LP_SHARE_BPS", "currentFeeParts", "feePartsAt"];

/** What each quote-fee guard leaves to the pool on buys in this world: a quarter on CL, nothing on Bin. */
const CL_LP_SHARE_BPS = 2_500;
const BIN_LP_SHARE_BPS = 0;

/* ----------------------------------------------------------- the fake --- */

type Answer = unknown | ((args: readonly unknown[]) => unknown);

interface FakeLog {
  readonly args: Record<string, unknown>;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
}

interface World {
  /** `${address}:${functionName}` -> value or `(args) => value`. */
  readonly reads: Record<string, Answer>;
  readonly logs?: Record<string, readonly FakeLog[]>;
}

interface RecordedCall {
  readonly method: "readContract" | "getLogs" | "call" | "getBlock";
  readonly address?: Address;
  readonly functionName?: string;
  readonly args?: unknown;
  readonly event?: string;
  readonly data?: Hex;
}

function k(address: Address, fn: string): string {
  return `${address.toLowerCase()}:${fn}`;
}

function fakeClient(world: World) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async readContract(req: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> {
      calls.push({ method: "readContract", address: req.address, functionName: req.functionName, args: req.args });
      const key = k(req.address, req.functionName);
      /* A release 2 kit has no per-tenant terms: the getter reverts unless a test gives it. */
      if (req.functionName === "gullyDesignated" && !(key in world.reads)) throw Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
      if (!(key in world.reads)) throw new Error(`fake: unexpected readContract ${req.functionName} at ${req.address}`);
      const answer = world.reads[key];
      return typeof answer === "function" ? (answer as (a: readonly unknown[]) => unknown)(req.args ?? []) : answer;
    },
    async getLogs(req: { address: Address; event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: unknown }) {
      calls.push({ method: "getLogs", address: req.address, event: req.event.name, args: req.args });
      if (req.address.toLowerCase() !== KIT) throw new Error(`fake: logs asked of ${req.address}, not the kit`);
      const all = world.logs?.[req.event.name];
      if (all === undefined) throw new Error(`fake: no log fixture for ${req.event.name}`);
      const filter = Object.entries(req.args ?? {}).filter(([, v]) => v !== undefined);
      return all.filter((log) => filter.every(([name, v]) => String(log.args[name]).toLowerCase() === String(v).toLowerCase()));
    },
    async call(req: { to?: Address; data: Hex }): Promise<{ data?: Hex }> {
      calls.push({ method: "call", ...(req.to === undefined ? {} : { address: req.to }), data: req.data });
      if (req.to === undefined && req.data === CONTRACT_CLOCK_PROBE_CALLDATA) {
        throw new Error("fake: this endpoint refuses creation calls");
      }
      throw new Error(`fake: unexpected call to ${String(req.to)} with ${req.data}`);
    },
    async getBlock() {
      calls.push({ method: "getBlock" });
      return { number: HEADER_NUMBER, timestamp: HEADER_TIMESTAMP, l1BlockNumber: 42n };
    },
  };
  return client;
}

const asClient = (c: ReturnType<typeof fakeClient>): PublicClient => c as unknown as PublicClient;

/** The kit's immutables, as `readKitV2Env` reads them. */
function envReads(clockMode: string = TIMESTAMP_CLOCK_MODE): Record<string, Answer> {
  return {
    [k(KIT, "CLOCK_MODE")]: clockMode,
    [k(KIT, "clHook")]: CL_HOOK,
    [k(KIT, "binHook")]: BIN_HOOK,
    [k(KIT, "clPoolManager")]: CL_PM,
    [k(KIT, "binPoolManager")]: BIN_PM,
    [k(KIT, "clPositionManager")]: CL_POSM,
    [k(KIT, "binPositionManager")]: BIN_POSM,
    [k(KIT, "clLocker")]: CL_LOCKER,
    [k(KIT, "binLocker")]: BIN_LOCKER,
    [k(KIT, "tokenFactory")]: FACTORY,
    [k(KIT, "launchRegistry")]: REGISTRY,
    [k(KIT, "protocolFeeRecipient")]: TREASURY,
    /* What each guard registers, asked of the GUARD. */
    [k(CL_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["lp-fee"].CL,
    [k(BIN_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["lp-fee"].Bin,
  };
}

const TENANT_CONFIG = {
  integrator: INTEGRATOR,
  integratorBps: 1_000,
  integratorLaunchFeeWei: 5n,
  allowedPresets: 0b10010, // FairLaunch | NoTax
  allowedBinShapes: 0b00110, // Flat | Linear
  restrictQuotes: true,
  active: true,
  maxTaxBps: 500,
  taxIntegratorBps: 1_500,
};

/** `getTax` for a pool with no creator tax: the all-zero record. */
const NO_TAX_RECORD = {
  creator: NATIVE_ADDRESS,
  buyBps: 0,
  sellBps: 0,
  expiresAt: 0,
  creatorBps: 0,
  integrator: NATIVE_ADDRESS,
  protocolBps: 0,
  integratorBps: 0,
};

/** Everything `readKitV2Limits` reads beyond the env. */
function limitReads(): Record<string, Answer> {
  return {
    [k(KIT, "maxLegs")]: 4,
    [k(KIT, "maxBinsPerLeg")]: 20,
    [k(KIT, "maxIntegratorLaunchFeeWei")]: 10n ** 16n,
    [k(KIT, "maxLaunchFeeWei")]: 10n ** 17n,
    [k(KIT, "launchFeeWei")]: 1_000n,
    [k(KIT, "pendingLaunchFee")]: [2_000n, HEADER_TIMESTAMP + 3_600n] as const,
    [k(KIT, "tenantConfig")]: (args: readonly unknown[]) => {
      if (String(args[0]).toLowerCase() !== TENANT) throw new Error(`fake: tenantConfig asked for ${String(args[0])}`);
      return TENANT_CONFIG;
    },
    [k(KIT, "tenantQuoteAllowed")]: (args: readonly unknown[]) => {
      expect(String(args[0]).toLowerCase()).toBe(TENANT);
      return String(args[1]).toLowerCase() === NATIVE_ADDRESS;
    },
    [k(CL_HOOK, "MIN_DECAY_SECONDS")]: 60n,
    [k(CL_HOOK, "MAX_DECAY_SECONDS")]: 2_592_000n,
    [k(CL_HOOK, "MAX_INITIAL_FEE")]: 500_000n,
    [k(CL_HOOK, "MAX_FINAL_FEE")]: 100_000n,
    [k(CL_HOOK, "MAX_START_DELAY_SECONDS")]: 2_592_000n,
    [k(CL_HOOK, "MAX_TAX_BPS")]: 1_000,
    [k(CL_HOOK, "MIN_PROTOCOL_BPS")]: 1_000,
    [k(CL_HOOK, "MAX_PROTOCOL_BPS")]: 5_000,
    [k(CL_HOOK, "MAX_INTEGRATOR_BPS")]: 2_000,
    [k(CL_HOOK, "MAX_TAX_DURATION_SECONDS")]: 15_552_000n,
    [k(CL_LOCKER, "minProtocolBps")]: 2_000,
    [k(CL_LOCKER, "maxProtocolBps")]: 5_000,
    [k(CL_LOCKER, "maxIntegratorBps")]: 2_000,
    [k(FACTORY, "MAX_NAME_BYTES")]: 64n,
    [k(FACTORY, "MAX_SYMBOL_BYTES")]: 16n,
    [k(FACTORY, "MAX_METADATA_URI_BYTES")]: 256n,
  };
}

/* ----------------------------------------------------------------- env --- */

describe("readKitV2Env", () => {
  it("reads every immutable off the kit, and each guard's bitmap off the guard", async () => {
    const c = fakeClient({ reads: envReads() });
    await expect(readKitV2Env(asClient(c), KIT)).resolves.toEqual(ENV);
    const reads = c.calls.filter((x) => x.method === "readContract");
    const offTheKit = reads.filter((x) => x.address !== KIT);
    expect(offTheKit.map((x) => `${x.address}:${x.functionName}`).sort()).toEqual(
      [`${CL_HOOK}:getHooksRegistrationBitmap`, `${BIN_HOOK}:getHooksRegistrationBitmap`].sort(),
    );
    expect(reads.filter((x) => x.address === KIT).some((x) => x.functionName === "getHooksRegistrationBitmap")).toBe(false);
  });

  it("carries whatever each guard answers: quote-fee guards, and a guard that REVERTS reads as null", async () => {
    const quoteFee = fakeClient({
      reads: {
        ...envReads(),
        [k(CL_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["quote-fee"].CL,
        [k(BIN_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin,
      },
    });
    await expect(readKitV2Env(asClient(quoteFee), KIT)).resolves.toEqual(ENV_QUOTE_FEE);

    const silent = fakeClient({
      reads: {
        ...envReads(),
        [k(BIN_HOOK, "getHooksRegistrationBitmap")]: () => {
          throw new ContractFunctionRevertedError({ abi: [], functionName: "getHooksRegistrationBitmap" });
        },
      },
    });
    await expect(readKitV2Env(asClient(silent), KIT)).resolves.toEqual({ ...ENV, binHookBitmap: null });
  });

  it("throws on a TRANSPORT failure of the bitmap read instead of calling the guard unknown", async () => {
    const c = fakeClient({
      reads: {
        ...envReads(),
        [k(CL_HOOK, "getHooksRegistrationBitmap")]: () => {
          throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
        },
      },
    });
    await expect(readKitV2Env(asClient(c), KIT)).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("refuses a kit that does not count in block.timestamp", async () => {
    const c = fakeClient({ reads: envReads("mode=blocknumber&from=default") });
    await expect(readKitV2Env(asClient(c), KIT)).rejects.toBeInstanceOf(KitV2ClockError);
    await expect(readKitV2Env(asClient(c), KIT)).rejects.toThrow(/mode=blocknumber/);
  });
});

/* -------------------------------------------------------------- limits --- */

describe("readKitV2Limits", () => {
  it("with a tenant: the STORED terms win, the tenant is named, its quote list is filtered", async () => {
    const c = fakeClient({ reads: { ...envReads(), ...limitReads() } });
    const l = await readKitV2Limits(asClient(c), KIT, {
      tenant: TENANT,
      candidateQuotes: [NATIVE_ADDRESS, USD],
      /* Supplied direct terms must be ignored with a tenant. */
      direct: { integrator: OTHER_CREATOR, integratorBps: 1, integratorLaunchFeeWei: 1n },
    });

    expect(l.env).toEqual(ENV);
    expect(l.integrator).toEqual({ address: INTEGRATOR, bps: 1_000, launchFeeWei: 5n, taxBps: 1_500, source: "tenant" });
    expect(l.tenant).toMatchObject({ maxTaxBps: 500, taxIntegratorBps: 1_500 });
    expect(l.tax).toEqual({ maxTaxBps: 1_000, minProtocolBps: 1_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000, maxTaxDurationSeconds: 15_552_000 });
    expect(l.tenantAddress).toBe(TENANT);
    expect(l.tenant).toMatchObject({ integrator: INTEGRATOR, integratorBps: 1_000, integratorLaunchFeeWei: 5n, restrictQuotes: true, active: true, configured: true });
    expect(l.tenant?.allowedPresets).toEqual(["FairLaunch", "NoTax"]);
    expect(l.tenant?.allowedBinShapes).toEqual(["Flat", "Linear"]);
    expect(l.tenantAllowedQuotes).toEqual([NATIVE_ADDRESS]);

    expect(l.caps).toEqual({ maxLegs: 4, maxBinsPerLeg: 20 });
    expect(l.guard).toEqual({ minDecaySeconds: 60, maxDecaySeconds: 2_592_000, maxInitialFeeBips: 500_000, maxFinalFeeBips: 100_000, maxStartDelaySeconds: 2_592_000 });
    expect(l.locker).toEqual({ minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 });
    /* lp-fee guards: no fee split on the guard, and its constant is never asked for. */
    expect(l.feeSplit).toBeNull();
    /* Nor a share for liquidity providers: there the whole fee is the pool's, and the guards are not asked. */
    expect(l.lpShareBps).toEqual({ CL: null, Bin: null });
    expect(c.calls.some((x) => QUOTE_FEE_ONLY.includes(x.functionName ?? ""))).toBe(false);
    expect(l.maxIntegratorLaunchFeeWei).toBe(10n ** 16n);
    expect(l.maxLaunchFeeWei).toBe(10n ** 17n);
    expect(l.token).toEqual({ maxNameBytes: 64, maxSymbolBytes: 16, maxMetadataUriBytes: 256 });
    /* The value quote carries the tenant's fee and covers the announced increase. */
    expect(l.value.integratorFeeWei).toBe(5n);
    expect(l.value.minimumValue).toBe(1_005n);
    expect(l.value.pending).toEqual({ feeWei: 2_000n, effectiveAt: HEADER_TIMESTAMP + 3_600n });
    expect(l.value.safeValue).toBe(2_005n);

    const quoteChecks = c.calls.filter((x) => x.functionName === "tenantQuoteAllowed");
    expect(quoteChecks.map((x) => (x.args as unknown[])[1])).toEqual([NATIVE_ADDRESS, USD]);
  });

  it("with direct terms: the supplied ones are carried, no tenant is read, and the fee is checked against the cap", async () => {
    const c = fakeClient({ reads: { ...envReads(), ...limitReads() } });
    const l = await readKitV2Limits(asClient(c), KIT, { direct: { integrator: INTEGRATOR, integratorBps: 300, integratorLaunchFeeWei: 7n } });
    expect(l.integrator).toEqual({ address: INTEGRATOR, bps: 300, launchFeeWei: 7n, taxBps: 0, source: "direct" });
    expect(l.tenantAddress).toBeNull();
    expect(l.tenant).toBeNull();
    expect(l.tenantAllowedQuotes).toEqual([]);
    expect(l.value.integratorFeeWei).toBe(7n);
    expect(l.value.safeValue).toBe(2_007n);
    expect(c.calls.some((x) => x.functionName === "tenantConfig")).toBe(false);
    expect(c.calls.some((x) => x.functionName === "tenantQuoteAllowed")).toBe(false);
    /* readLaunchValue reads the cap for a non-zero direct fee. */
    expect(c.calls.some((x) => x.functionName === "maxIntegratorLaunchFeeWei")).toBe(true);
  });

  it("with neither: a zero integrator, and a cached env skips the immutables", async () => {
    const c = fakeClient({ reads: limitReads() });
    const l = await readKitV2Limits(asClient(c), KIT, { env: ENV });
    expect(l.integrator).toEqual({ address: NATIVE_ADDRESS, bps: 0, launchFeeWei: 0n, taxBps: 0, source: "direct" });
    expect(l.value.integratorFeeWei).toBe(0n);
    expect(l.value.safeValue).toBe(2_000n);
    expect(c.calls.some((x) => x.functionName === "CLOCK_MODE")).toBe(false);
    expect(c.calls.some((x) => x.functionName === "getHooksRegistrationBitmap")).toBe(false);
  });

  it("on quote-fee guards: reads the fee split's floor off the guard, beside the caps it shares with the tax", async () => {
    const c = fakeClient({
      reads: { ...limitReads(), [k(CL_HOOK, "MIN_FEE_PROTOCOL_BPS")]: 2_000, [k(CL_HOOK, "LP_SHARE_BPS")]: CL_LP_SHARE_BPS, [k(BIN_HOOK, "LP_SHARE_BPS")]: BIN_LP_SHARE_BPS },
    });
    const l = await readKitV2Limits(asClient(c), KIT, { env: ENV_QUOTE_FEE });
    expect(l.feeSplit).toEqual({ minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 });
    /* Each guard's own share, as each answered it: zero is an answer. */
    expect(l.lpShareBps).toEqual({ CL: 2_500, Bin: 0 });
    expect(l.env).toEqual(ENV_QUOTE_FEE);
  });

  it("on quote-fee guards that do not say their share: null, never zero, and the rest of the limits still read", async () => {
    const silent = () => {
      throw new ContractFunctionRevertedError({ abi: [], functionName: "LP_SHARE_BPS" });
    };
    const c = fakeClient({ reads: { ...limitReads(), [k(CL_HOOK, "MIN_FEE_PROTOCOL_BPS")]: 2_000, [k(CL_HOOK, "LP_SHARE_BPS")]: silent, [k(BIN_HOOK, "LP_SHARE_BPS")]: BIN_LP_SHARE_BPS } });
    const l = await readKitV2Limits(asClient(c), KIT, { env: ENV_QUOTE_FEE });
    expect(l.lpShareBps).toEqual({ CL: null, Bin: 0 });
    expect(l.feeSplit).not.toBeNull();
  });

  it("each guard is asked for its share by ITS OWN generation: an lp-fee Bin guard beside a quote-fee CL guard is not asked", async () => {
    const c = fakeClient({ reads: { ...limitReads(), [k(CL_HOOK, "MIN_FEE_PROTOCOL_BPS")]: 2_000, [k(CL_HOOK, "LP_SHARE_BPS")]: CL_LP_SHARE_BPS } });
    const l = await readKitV2Limits(asClient(c), KIT, { env: { ...ENV, clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL } });
    expect(l.lpShareBps).toEqual({ CL: 2_500, Bin: null });
    expect(c.calls.some((x) => x.address === BIN_HOOK && x.functionName === "LP_SHARE_BPS")).toBe(false);
  });

  it("throws on a TRANSPORT failure of the share instead of reading it as unknown", async () => {
    const c = fakeClient({
      reads: {
        ...limitReads(),
        [k(CL_HOOK, "MIN_FEE_PROTOCOL_BPS")]: 2_000,
        [k(BIN_HOOK, "LP_SHARE_BPS")]: BIN_LP_SHARE_BPS,
        [k(CL_HOOK, "LP_SHARE_BPS")]: () => {
          throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
        },
      },
    });
    await expect(readKitV2Limits(asClient(c), KIT, { env: ENV_QUOTE_FEE })).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("an env written without the bitmaps has them read, and the limits carry the completed env", async () => {
    const { clHookBitmap: _cl, binHookBitmap: _bin, ...bare } = ENV;
    const c = fakeClient({
      reads: {
        ...limitReads(),
        [k(CL_HOOK, "MIN_FEE_PROTOCOL_BPS")]: 2_000,
        [k(CL_HOOK, "LP_SHARE_BPS")]: CL_LP_SHARE_BPS,
        [k(BIN_HOOK, "LP_SHARE_BPS")]: BIN_LP_SHARE_BPS,
        [k(CL_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["quote-fee"].CL,
        [k(BIN_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["quote-fee"].Bin,
      },
    });
    const l = await readKitV2Limits(asClient(c), KIT, { env: bare });
    expect(l.env).toEqual(ENV_QUOTE_FEE);
    expect(l.feeSplit).not.toBeNull();
  });

  it("a guard whose bitmap is no launch guard's is not asked for the fee split's floor", async () => {
    /* Bit 10 is set, and it is still not a guard: 0x0C01 lacks the two swap callbacks. */
    const c = fakeClient({ reads: limitReads() });
    const l = await readKitV2Limits(asClient(c), KIT, { env: { ...ENV, clHookBitmap: 0x0c01 } });
    expect(l.feeSplit).toBeNull();
    expect(c.calls.some((x) => x.functionName === "MIN_FEE_PROTOCOL_BPS")).toBe(false);
  });
});

/* ------------------------------------------------------------ launches --- */

/** Token A: a CL leg (lock 1) and a Bin leg (lock 7), decaying. Token B: one CL leg (lock 2), scheduled. */
const START_A = HEADER_TIMESTAMP - 100n;
const START_B = HEADER_TIMESTAMP + 500n;

function launchLogs(): Record<string, readonly FakeLog[]> {
  const created = (token: Address, creator: Address, tenant: Address, start: bigint, block: bigint, tx: Hex, legCount: number): FakeLog => ({
    args: {
      token,
      creator,
      tenant,
      launcher: LAUNCHER,
      operator: OPERATOR,
      totalSupply: 1_000n,
      seedSupply: 800n,
      legCount,
      startTime: start,
      protocolFeeWei: 1_000n,
      integrator: INTEGRATOR,
      integratorFeeWei: 5n,
    },
    blockNumber: block,
    transactionHash: tx,
  });
  const leg = (token: Address, poolId: Hex, quote: Address, kind: number, lockId: bigint, seeded: bigint, weightBps: number, block: bigint, tx: Hex): FakeLog => ({
    args: { token, poolId, quote, kind, lockId, launchTokenSeeded: seeded, weightBps },
    blockNumber: block,
    transactionHash: tx,
  });
  return {
    LaunchCreated: [
      created(TOKEN_A, CREATOR, TENANT, START_A, 100n, TX_A, 2),
      created(TOKEN_B, OTHER_CREATOR, NATIVE_ADDRESS, START_B, 200n, TX_B, 1),
    ],
    LaunchLegCreated: [
      leg(TOKEN_A, POOL_A_CL, NATIVE_ADDRESS, 0, 1n, 560n, 7_000, 100n, TX_A),
      leg(TOKEN_A, POOL_A_BIN, USD, 1, 7n, 240n, 3_000, 100n, TX_A),
      leg(TOKEN_B, POOL_B_CL, NATIVE_ADDRESS, 0, 2n, 800n, 10_000, 200n, TX_B),
    ],
  };
}

function guardRecord(start: bigint, decay: number, is0: boolean) {
  return { owner: KIT, startTime: start, decaySeconds: decay, enabled: true, initialFeeBips: 100_000, finalFeeBips: 3_000, maxBuyPerTx: 0n, launchTokenIsCurrency0: is0, launched: true };
}

function launchReads(): Record<string, Answer> {
  const byPool = (table: Record<string, unknown>, what: string) => (args: readonly unknown[]) => {
    const v = table[String(args[0])];
    if (v === undefined) throw new Error(`fake: no ${what} for ${String(args[0])}`);
    return v;
  };
  return {
    /* Token A sorts above native (currency1) and above USD (currency1); token B above native. */
    [k(KIT, "getLeg")]: byPool(
      {
        [POOL_A_CL]: { launchToken: TOKEN_A, kind: 0, launchTokenIsCurrency0: false, lockId: 1n },
        [POOL_A_BIN]: { launchToken: TOKEN_A, kind: 1, launchTokenIsCurrency0: false, lockId: 7n },
        [POOL_B_CL]: { launchToken: TOKEN_B, kind: 0, launchTokenIsCurrency0: false, lockId: 2n },
      },
      "leg",
    ),
    /* CL pools answer on the CL guard only; the Bin pool on the Bin guard only. */
    [k(CL_HOOK, "getLaunch")]: byPool({ [POOL_A_CL]: guardRecord(START_A, 600, false), [POOL_B_CL]: guardRecord(START_B, 300, false) }, "CL launch"),
    [k(CL_HOOK, "currentFee")]: byPool({ [POOL_A_CL]: 83_833n, [POOL_B_CL]: 100_000n }, "CL fee"),
    [k(BIN_HOOK, "getLaunch")]: byPool({ [POOL_A_BIN]: guardRecord(START_A, 60, false) }, "Bin launch"),
    [k(BIN_HOOK, "currentFee")]: byPool({ [POOL_A_BIN]: 3_000n }, "Bin fee"),
    /* No launch in this world carries a creator tax; the earnings test below adds one. */
    [k(CL_HOOK, "getTax")]: () => NO_TAX_RECORD,
    [k(BIN_HOOK, "getTax")]: () => NO_TAX_RECORD,
    [k(CL_LOCKER, "getLock")]: byPool(
      {
        "1": { creator: CREATOR, creatorBps: 7_000, integratorBps: 1_000, protocolBps: 2_000, lockedAt: START_A - 1n, integrator: INTEGRATOR, currency0: NATIVE_ADDRESS, currency1: TOKEN_A, poolId: POOL_A_CL },
        "2": { creator: OTHER_CREATOR, creatorBps: 8_000, integratorBps: 0, protocolBps: 2_000, lockedAt: START_B - 1n, integrator: NATIVE_ADDRESS, currency0: NATIVE_ADDRESS, currency1: TOKEN_B, poolId: POOL_B_CL },
      },
      "CL lock",
    ),
    [k(CL_POSM, "getPoolAndPositionInfo")]: byPool({ "1": [KEY_A_CL, 0n], "2": [KEY_B_CL, 0n] }, "CL position"),
    [k(BIN_LOCKER, "getPoolKey")]: byPool({ "7": KEY_A_BIN }, "Bin key"),
    [k(BIN_LOCKER, "getLock")]: byPool(
      { "7": { creator: OTHER_CREATOR, creatorBps: 7_000, integratorBps: 1_000, protocolBps: 2_000, lockedAt: START_A - 1n, integrator: CREATOR, binCount: 10, poolId: POOL_A_BIN } },
      "Bin lock",
    ),
    /* The launch registry's record for the first leg's pool: token A has a listing, token B's record reverts (reads as null). */
    [k(REGISTRY, "getLaunch")]: (args: readonly unknown[]) => {
      if (String(args[0]).toLowerCase() === POOL_A_CL.toLowerCase()) {
        return { metadata: { description: "Token A, described", websiteURI: "https://a.example", xHandle: "a_project", telegramHandle: "" } };
      }
      /* An unregistered pool: the registry reverts, and the record reads as null, never as an empty listing. */
      throw new ContractFunctionRevertedError({ abi: [], functionName: "getLaunch" });
    },
    /* ERC-20 metadata for token A and USD; token B is unreadable and must read as null. */
    [k(TOKEN_A, "symbol")]: "TKA",
    [k(TOKEN_A, "name")]: "Token A",
    [k(TOKEN_A, "decimals")]: 18,
    [k(USD, "symbol")]: "USD",
    [k(USD, "name")]: "Dollar",
    [k(USD, "decimals")]: 6,
  };
}

describe("readKitV2Launches: a guard that cannot answer", () => {
  it("renders a REVERTED getLaunch as phase unknown, never settled", async () => {
    const reads = launchReads();
    const failing = reads[k(CL_HOOK, "getLaunch")] as (a: readonly unknown[]) => unknown;
    reads[k(CL_HOOK, "getLaunch")] = (args: readonly unknown[]) => {
      if (String(args[0]).toLowerCase() === POOL_B_CL.toLowerCase()) {
        throw new ContractFunctionRevertedError({ abi: [], functionName: "getLaunch" });
      }
      return failing(args);
    };
    reads[k(CL_HOOK, "currentFee")] = (args: readonly unknown[]) => {
      if (String(args[0]).toLowerCase() === POOL_B_CL.toLowerCase()) {
        throw new ContractFunctionRevertedError({ abi: [], functionName: "currentFee" });
      }
      return 100_000n;
    };
    const c = fakeClient({ reads, logs: launchLogs() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV });
    const b = scan.launches.find((l) => l.token === TOKEN_B)!;
    expect(b.legs[0]!.guard).toBeNull();
    expect(b.legs[0]!.currentFeePips).toBeNull();
    expect(b.legs[0]!.phase).toBe("unknown");
    expect(b.phase).toBe("unknown");
    const a = scan.launches.find((l) => l.token === TOKEN_A)!;
    expect(a.phase).not.toBe("unknown");
  });

  it("throws on a TRANSPORT failure instead of inventing a phase", async () => {
    const reads = launchReads();
    reads[k(CL_HOOK, "getLaunch")] = () => {
      throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
    };
    const c = fakeClient({ reads, logs: launchLogs() });
    await expect(readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV })).rejects.toBeInstanceOf(HttpRequestError);
  });
});

describe("readKitV2Launches", () => {
  it("groups legs by token, reads each leg from its own guard and locker, and judges phases against the header timestamp", async () => {
    const c = fakeClient({ reads: launchReads(), logs: launchLogs() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV });

    /* The clock: probe refused, header used. */
    expect(c.calls.some((x) => x.method === "call" && x.data === CONTRACT_CLOCK_PROBE_CALLDATA)).toBe(true);
    expect(scan.now).toBe(HEADER_TIMESTAMP);
    expect(scan.atBlock).toBe(HEADER_NUMBER);
    expect(scan.fromBlock).toBe(1n);
    expect(scan.env).toEqual(ENV);

    /* Newest first. */
    expect(scan.launches.map((l) => l.token)).toEqual([TOKEN_B, TOKEN_A]);

    const a = scan.launches[1]!;
    expect(a).toMatchObject({
      token: TOKEN_A,
      tokenMeta: { address: TOKEN_A, symbol: "TKA", name: "Token A", decimals: 18 },
      creator: CREATOR,
      tenant: TENANT,
      launcher: LAUNCHER,
      operator: OPERATOR,
      totalSupply: 1_000n,
      seedSupply: 800n,
      startTime: START_A,
      protocolFeeWei: 1_000n,
      integrator: INTEGRATOR,
      integratorFeeWei: 5n,
      createdAtBlock: 100n,
      txHash: TX_A,
      phase: "decaying",
    });
    expect(a.legs).toHaveLength(2);

    const [cl, bin] = a.legs as [typeof a.legs[number], typeof a.legs[number]];
    expect(cl).toMatchObject({ poolId: POOL_A_CL, kind: "CL", quote: NATIVE_ADDRESS, quoteMeta: null, lockId: 1n, weightBps: 7_000, launchTokenSeeded: 560n, launchTokenIsCurrency0: false, currentFeePips: 83_833, phase: "decaying" });
    expect(cl.guard).toEqual({ startTime: START_A, decaySeconds: 600, initialFeeBips: 100_000, finalFeeBips: 3_000, maxBuyPerTx: 0n, enabled: true, launched: true });
    expect(cl.lock).toEqual({ creator: CREATOR, integrator: INTEGRATOR, creatorBps: 7_000, integratorBps: 1_000, protocolBps: 2_000, lockedAt: START_A - 1n });
    expect(cl.remaining).toBe(500n);
    /* lp-fee guards: every leg says so, carries no fee split and no parts, and was never asked for either. */
    expect(scan.launches.flatMap((l) => l.legs).map((l) => [l.guardGeneration, l.feeSplit, l.feeParts, l.lpShareBps])).toEqual([
      ["lp-fee", null, null, null],
      ["lp-fee", null, null, null],
      ["lp-fee", null, null, null],
    ]);
    expect(c.calls.some((x) => QUOTE_FEE_ONLY.includes(x.functionName ?? ""))).toBe(false);

    /* The Bin leg's 60 s window closed 40 s ago: settled, nothing remaining. */
    expect(bin).toMatchObject({ poolId: POOL_A_BIN, kind: "Bin", quote: USD, lockId: 7n, weightBps: 3_000, launchTokenSeeded: 240n, currentFeePips: 3_000, phase: "settled", remaining: null });
    expect(bin.quoteMeta).toEqual({ address: USD, symbol: "USD", name: "Dollar", decimals: 6 });
    expect(bin.guard?.decaySeconds).toBe(60);
    expect(bin.lock).toEqual({ creator: OTHER_CREATOR, integrator: CREATOR, creatorBps: 7_000, integratorBps: 1_000, protocolBps: 2_000, lockedAt: START_A - 1n });

    /* Each kind was read from ITS guard and ITS locker, never the other. */
    const reads = c.calls.filter((x) => x.method === "readContract");
    const at = (address: Address, fn: string) => reads.filter((x) => x.address === address && x.functionName === fn).map((x) => (x.args as unknown[])[0]);
    expect(at(CL_HOOK, "getLaunch").sort()).toEqual([POOL_A_CL, POOL_B_CL].sort());
    expect(at(BIN_HOOK, "getLaunch")).toEqual([POOL_A_BIN]);
    expect(at(CL_LOCKER, "getLock").map(String).sort()).toEqual(["1", "2"]);
    expect(a.listing).toEqual({ description: "Token A, described", websiteURI: "https://a.example", xHandle: "a_project", telegramHandle: "" });
    expect(scan.launches[0]!.listing).toBeNull();
    expect(at(BIN_LOCKER, "getLock").map(String)).toEqual(["7"]);

    /* Token B: scheduled, unreadable metadata is null rather than invented. */
    const b = scan.launches[0]!;
    expect(b.phase).toBe("scheduled");
    expect(b.tokenMeta).toBeNull();
    expect(b.tenant).toBe(NATIVE_ADDRESS);
    expect(b.legs[0]).toMatchObject({ kind: "CL", lockId: 2n, phase: "scheduled", remaining: 800n, currentFeePips: 100_000 });
    expect(b.legs[0]?.lock?.integrator).toBe(NATIVE_ADDRESS);
  });

  it("passes the tenant filter to the node and returns only that tenant's launches", async () => {
    const c = fakeClient({ reads: launchReads(), logs: launchLogs() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV, tenant: TENANT });
    const created = c.calls.find((x) => x.method === "getLogs" && x.event === "LaunchCreated");
    expect(created?.args).toEqual({ tenant: TENANT });
    expect(scan.launches.map((l) => l.token)).toEqual([TOKEN_A]);
    /* The leg logs are not tenant-filtered (the event has no tenant topic); grouping by token does the work. */
    const legs = c.calls.find((x) => x.method === "getLogs" && x.event === "LaunchLegCreated");
    expect(legs).toBeDefined();
    expect(legs?.args).toBeUndefined();
  });

  it("passes the creator filter the same way", async () => {
    const c = fakeClient({ reads: launchReads(), logs: launchLogs() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV, creator: OTHER_CREATOR });
    expect(c.calls.find((x) => x.method === "getLogs" && x.event === "LaunchCreated")?.args).toEqual({ creator: OTHER_CREATOR });
    expect(scan.launches.map((l) => l.token)).toEqual([TOKEN_B]);
  });

  it("reads the env off the kit when none is cached", async () => {
    const c = fakeClient({ reads: { ...envReads(), ...launchReads() }, logs: launchLogs() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337 });
    expect(scan.env).toEqual(ENV);
    expect(c.calls.some((x) => x.functionName === "CLOCK_MODE")).toBe(true);
  });
});

describe("readKitV2Launches: pre-read creation logs (opts.logs)", () => {
  /** The same fixture rows as the node serves, handed over as `KitV2LaunchLogs` (the shape an indexer maps into). */
  function injected(): KitV2LaunchLogs {
    const logs = launchLogs();
    return {
      created: logs["LaunchCreated"]!.map((l) => ({
        args: l.args as unknown as KitV2LaunchCreatedLog["args"],
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
      })),
      legs: logs["LaunchLegCreated"]!.map((l) => ({ args: l.args as unknown as KitV2LaunchLegCreatedLog["args"] })),
    };
  }

  it("yields the same LaunchScanV2 as the log path, with zero eth_getLogs", async () => {
    const viaLogs = await readKitV2Launches(asClient(fakeClient({ reads: launchReads(), logs: launchLogs() })), KIT, { fromBlock: 1n, chainId: 31337, env: ENV });
    /* No log fixture at all: any getLogs would throw "no log fixture". */
    const c = fakeClient({ reads: launchReads() });
    const viaInjected = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV, logs: injected() });
    expect(c.calls.filter((x) => x.method === "getLogs")).toHaveLength(0);
    expect(viaInjected).toEqual(viaLogs);
  });

  it("applies the tenant and creator filters to the injected rows, as a node applies them to topics", async () => {
    for (const filter of [{ tenant: TENANT }, { creator: OTHER_CREATOR }, { tenant: TENANT, creator: OTHER_CREATOR }] as const) {
      const viaLogs = await readKitV2Launches(asClient(fakeClient({ reads: launchReads(), logs: launchLogs() })), KIT, { fromBlock: 1n, chainId: 31337, env: ENV, ...filter });
      const viaInjected = await readKitV2Launches(asClient(fakeClient({ reads: launchReads() })), KIT, { fromBlock: 1n, chainId: 31337, env: ENV, ...filter, logs: injected() });
      expect(viaInjected).toEqual(viaLogs);
    }
    /* Case-insensitive, as a topic match is. */
    const upper = await readKitV2Launches(asClient(fakeClient({ reads: launchReads() })), KIT, {
      fromBlock: 1n,
      chainId: 31337,
      env: ENV,
      tenant: TENANT.toUpperCase().replace("0X", "0x") as Address,
      logs: injected(),
    });
    expect(upper.launches.map((l) => l.token)).toEqual([TOKEN_A]);
  });

  it("an empty injection is an empty scan, still judged against the live clock", async () => {
    const c = fakeClient({ reads: launchReads() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV, logs: { created: [], legs: [] } });
    expect(scan.launches).toEqual([]);
    expect(scan.now).toBe(HEADER_TIMESTAMP);
    expect(c.calls.filter((x) => x.method === "getLogs")).toHaveLength(0);
  });

  it("exports the two scanned events so a caller can read them itself", () => {
    expect(KIT_V2_LAUNCH_CREATED_EVENT.name).toBe("LaunchCreated");
    expect(KIT_V2_LAUNCH_LEG_CREATED_EVENT.name).toBe("LaunchLegCreated");
  });
});

describe("launchPhase", () => {
  it("is scheduled before start, decaying inside the window, settled from its end", () => {
    expect(launchPhase(100n, 50, 99n)).toBe("scheduled");
    expect(launchPhase(100n, 50, 100n)).toBe("decaying");
    expect(launchPhase(100n, 50, 149n)).toBe("decaying");
    expect(launchPhase(100n, 50, 150n)).toBe("settled");
  });
});

/* ------------------------------------------------------------ earnings --- */

describe("readKitV2Earnings", () => {
  async function scanFor(c: ReturnType<typeof fakeClient>): Promise<LaunchScanV2> {
    return readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV });
  }

  it("lists the account's locks by role and reads claimable per currency on the right locker", async () => {
    const claimed: { locker: Address; args: unknown }[] = [];
    const c = fakeClient({
      reads: {
        ...launchReads(),
        [k(KIT, "feesOwed")]: (args: readonly unknown[]) => {
          expect(args).toEqual([CREATOR]);
          return 123n;
        },
        [k(CL_LOCKER, "claimable")]: (args: readonly unknown[]) => {
          claimed.push({ locker: CL_LOCKER, args });
          return String(args[1]).toLowerCase() === TOKEN_A ? 11n : 12n;
        },
        [k(BIN_LOCKER, "claimable")]: (args: readonly unknown[]) => {
          claimed.push({ locker: BIN_LOCKER, args });
          return String(args[1]).toLowerCase() === TOKEN_A ? 21n : 22n;
        },
      },
      logs: launchLogs(),
    });
    const scan = await scanFor(c);
    /* CREATOR is the creator of lock 1 (CL) and the integrator of lock 7 (Bin); nothing on token B. */
    const e = await readKitV2Earnings(asClient(c), scan, CREATOR);

    expect(e.account).toBe(CREATOR);
    expect(e.kitFeesOwed).toBe(123n);
    expect(e.locks).toEqual([
      { locker: "CL", lockId: 1n, token: TOKEN_A, tokenMeta: scan.launches[1]!.tokenMeta, role: "creator", currency0: NATIVE_ADDRESS, currency1: TOKEN_A, guardGeneration: "lp-fee", lpShareBps: null },
      { locker: "Bin", lockId: 7n, token: TOKEN_A, tokenMeta: scan.launches[1]!.tokenMeta, role: "integrator", currency0: USD, currency1: TOKEN_A, guardGeneration: "lp-fee", lpShareBps: null },
    ]);
    /* lp-fee guards take no fee of their own: nothing under `fee`, and no guard was asked for a pot. */
    expect(e.fee).toEqual({ pools: [] });
    expect(e.guardClaimable).toEqual([]);
    expect(c.calls.some((x) => QUOTE_FEE_ONLY.includes(x.functionName ?? ""))).toBe(false);
    expect(e.claimable).toEqual([
      { locker: "CL", currency: NATIVE_ADDRESS, meta: null, amount: 12n },
      { locker: "CL", currency: TOKEN_A, meta: scan.launches[1]!.tokenMeta, amount: 11n },
      { locker: "Bin", currency: USD, meta: { address: USD, symbol: "USD", name: "Dollar", decimals: 6 }, amount: 22n },
      { locker: "Bin", currency: TOKEN_A, meta: scan.launches[1]!.tokenMeta, amount: 21n },
    ]);
    /* Every claimable read named the account, and each currency went to the locker that holds the lock. */
    expect(claimed.every((x) => (x.args as unknown[])[0] === CREATOR)).toBe(true);
    expect(claimed.map((x) => `${x.locker}:${String((x.args as unknown[])[1])}`).sort()).toEqual(
      [`${CL_LOCKER}:${NATIVE_ADDRESS}`, `${CL_LOCKER}:${TOKEN_A}`, `${BIN_LOCKER}:${USD}`, `${BIN_LOCKER}:${TOKEN_A}`].sort(),
    );
  });

  it("an account on no lock gets only its kit fees", async () => {
    const c = fakeClient({ reads: { ...launchReads(), [k(KIT, "feesOwed")]: 0n }, logs: launchLogs() });
    const scan = await scanFor(c);
    const e = await readKitV2Earnings(asClient(c), scan, LAUNCHER);
    expect(e).toEqual({ account: LAUNCHER, kitFeesOwed: 0n, claimable: [], locks: [], guardClaimable: [], fee: { pools: [] }, tax: { claimable: [], pools: [] } });
    expect(c.calls.some((x) => x.functionName === "claimable")).toBe(false);
  });

  it("reports 'both' when the account is creator and integrator of one lock, and the launcher's currency order", async () => {
    const reads = launchReads();
    const c = fakeClient({
      reads: {
        ...reads,
        [k(BIN_LOCKER, "getLock")]: () => ({ creator: CREATOR, creatorBps: 7_000, integratorBps: 1_000, protocolBps: 2_000, lockedAt: 0n, integrator: CREATOR, binCount: 10, poolId: POOL_A_BIN }),
        [k(KIT, "feesOwed")]: 0n,
        [k(CL_LOCKER, "claimable")]: 0n,
        [k(BIN_LOCKER, "claimable")]: 0n,
      },
      logs: launchLogs(),
    });
    const e = await readKitV2Earnings(asClient(c), await scanFor(c), CREATOR);
    expect(e.locks.find((l) => l.locker === "Bin")?.role).toBe("both");
  });
});

/* ------------------------------------------------ the guards' generation --- */

const NOMINEE: Address = "0x0000000000000000000000000000000000000c08";

/** `getFeeSplit` as a quote-fee guard answers it, per pool. `protocolBps` is never zero on a written split. */
const FEE_SPLITS: Record<string, { creator: Address; creatorBps: number; protocolBps: number; integratorBps: number; integrator: Address }> = {
  [POOL_A_CL]: { creator: CREATOR, creatorBps: 7_000, protocolBps: 2_000, integratorBps: 1_000, integrator: INTEGRATOR },
  [POOL_A_BIN]: { creator: OTHER_CREATOR, creatorBps: 7_000, protocolBps: 2_000, integratorBps: 1_000, integrator: CREATOR },
  [POOL_B_CL]: { creator: OTHER_CREATOR, creatorBps: 8_000, protocolBps: 2_000, integratorBps: 0, integrator: NATIVE_ADDRESS },
};

/** What a quote-fee guard answers beyond `launchReads()`. The creator functions take the pool id AS A NUMBER. */
function quoteFeeReads(): Record<string, Answer> {
  const split = (args: readonly unknown[]) => {
    const v = FEE_SPLITS[String(args[0])];
    if (v === undefined) throw new Error(`fake: no fee split for ${String(args[0])}`);
    return v;
  };
  const nominee = (args: readonly unknown[]) => {
    expect(typeof args[0]).toBe("bigint");
    return args[0] === BigInt(POOL_A_CL) ? NOMINEE : NATIVE_ADDRESS;
  };
  /* The parts of `currentFee` as the guard computes them: the pool's part is floor(fee * share / 10_000). */
  const parts = (hook: Address, shareBps: number) => (args: readonly unknown[]) => {
    const fee = FEES_NOW[String(args[0])];
    if (fee === undefined) throw new Error(`fake: no fee parts for ${String(args[0])} at ${hook}`);
    const lp = Math.floor((fee * shareBps) / 10_000);
    return [lp, fee - lp, fee] as const;
  };
  return {
    [k(CL_HOOK, "getFeeSplit")]: split,
    [k(BIN_HOOK, "getFeeSplit")]: split,
    [k(CL_HOOK, "pendingCreator")]: nominee,
    [k(BIN_HOOK, "pendingCreator")]: nominee,
    [k(CL_HOOK, "LP_SHARE_BPS")]: CL_LP_SHARE_BPS,
    [k(BIN_HOOK, "LP_SHARE_BPS")]: BIN_LP_SHARE_BPS,
    [k(CL_HOOK, "currentFeeParts")]: parts(CL_HOOK, CL_LP_SHARE_BPS),
    [k(BIN_HOOK, "currentFeeParts")]: parts(BIN_HOOK, BIN_LP_SHARE_BPS),
  };
}

/** `currentFee` per pool, as `launchReads()` scripts it. */
const FEES_NOW: Record<string, number> = { [POOL_A_CL]: 83_833, [POOL_A_BIN]: 3_000, [POOL_B_CL]: 100_000 };

describe("readKitV2Launches: which guard a leg runs on", () => {
  const scanWith = async (env: KitV2Env | Omit<KitV2Env, "clHookBitmap" | "binHookBitmap">, reads: Record<string, Answer>) => {
    const c = fakeClient({ reads, logs: launchLogs() });
    const scan = await readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env });
    const leg = (poolId: Hex) => scan.launches.flatMap((l) => l.legs).find((l) => l.poolId === poolId)!;
    return { c, scan, leg };
  };
  const feeReadsOn = (c: ReturnType<typeof fakeClient>, hook: Address) =>
    c.calls.filter((x) => x.address === hook && QUOTE_FEE_ONLY.includes(x.functionName ?? "")).map((x) => x.functionName);

  it("quote-fee guards: every leg says so and carries the guard's fee split and its nominee", async () => {
    const { leg } = await scanWith(ENV_QUOTE_FEE, { ...launchReads(), ...quoteFeeReads() });
    expect(leg(POOL_A_CL).guardGeneration).toBe("quote-fee");
    expect(leg(POOL_A_CL).feeSplit).toEqual({ creator: CREATOR, integrator: INTEGRATOR, creatorBps: 7_000, protocolBps: 2_000, integratorBps: 1_000, pendingCreator: NOMINEE });
    expect(leg(POOL_A_BIN).guardGeneration).toBe("quote-fee");
    /* Nobody nominated: the zero address reads as null, never as a nominee. */
    expect(leg(POOL_A_BIN).feeSplit).toEqual({ creator: OTHER_CREATOR, integrator: CREATOR, creatorBps: 7_000, protocolBps: 2_000, integratorBps: 1_000, pendingCreator: null });
    expect(leg(POOL_B_CL).feeSplit?.integrator).toBe(NATIVE_ADDRESS);
    /* The lock is still read: the locked position exists on both generations. */
    expect(leg(POOL_A_CL).lock?.creator).toBe(CREATOR);
  });

  it("quote-fee guards: every leg carries the parts of its fee and its guard's share, as the guard answered", async () => {
    const { c, leg } = await scanWith(ENV_QUOTE_FEE, { ...launchReads(), ...quoteFeeReads() });
    /* 83_833 * 25% = 20_958.25: the pool's part is floored and the guard takes the rest. */
    expect(leg(POOL_A_CL).currentFeePips).toBe(83_833);
    expect(leg(POOL_A_CL).feeParts).toEqual({ buyLpPips: 20_958, buyGuardPips: 62_875, sellGuardPips: 83_833 });
    expect(leg(POOL_A_CL).lpShareBps).toBe(2_500);
    expect(leg(POOL_B_CL).feeParts).toEqual({ buyLpPips: 25_000, buyGuardPips: 75_000, sellGuardPips: 100_000 });
    /* A share of zero is an answer: the guard takes the whole fee on a buy as well. */
    expect(leg(POOL_A_BIN).feeParts).toEqual({ buyLpPips: 0, buyGuardPips: 3_000, sellGuardPips: 3_000 });
    expect(leg(POOL_A_BIN).lpShareBps).toBe(0);
    /* Both parts of a buy are the whole fee, and so is a sell's. */
    for (const id of [POOL_A_CL, POOL_A_BIN, POOL_B_CL]) {
      const l = leg(id);
      expect(l.feeParts!.buyLpPips + l.feeParts!.buyGuardPips).toBe(l.currentFeePips);
      expect(l.feeParts!.sellGuardPips).toBe(l.currentFeePips);
    }
    /* Each leg asked ITS OWN guard, for its own pool. */
    const asked = (hook: Address) => c.calls.filter((x) => x.address === hook && x.functionName === "currentFeeParts").map((x) => (x.args as unknown[])[0]);
    expect(asked(CL_HOOK).sort()).toEqual([POOL_A_CL, POOL_B_CL].sort());
    expect(asked(BIN_HOOK)).toEqual([POOL_A_BIN]);
  });

  it("a quote-fee guard that does not answer: the whole fee is still read, and the split is null, never zero", async () => {
    const silent = (functionName: string) => () => {
      throw new ContractFunctionRevertedError({ abi: [], functionName });
    };
    const { leg } = await scanWith(ENV_QUOTE_FEE, {
      ...launchReads(),
      ...quoteFeeReads(),
      [k(CL_HOOK, "LP_SHARE_BPS")]: silent("LP_SHARE_BPS"),
      [k(CL_HOOK, "currentFeeParts")]: silent("currentFeeParts"),
    });
    expect(leg(POOL_A_CL).guardGeneration).toBe("quote-fee");
    expect(leg(POOL_A_CL).currentFeePips).toBe(83_833);
    expect(leg(POOL_A_CL).feeParts).toBeNull();
    expect(leg(POOL_A_CL).lpShareBps).toBeNull();
    /* Everything else about the leg is still read. */
    expect(leg(POOL_A_CL).feeSplit).not.toBeNull();
    /* The Bin guard answered for itself. */
    expect(leg(POOL_A_BIN).lpShareBps).toBe(0);
  });

  it("the two answers are independent: a share with no parts, and parts with no share", async () => {
    const silent = (functionName: string) => () => {
      throw new ContractFunctionRevertedError({ abi: [], functionName });
    };
    const noParts = await scanWith(ENV_QUOTE_FEE, { ...launchReads(), ...quoteFeeReads(), [k(CL_HOOK, "currentFeeParts")]: silent("currentFeeParts") });
    expect(noParts.leg(POOL_A_CL).feeParts).toBeNull();
    expect(noParts.leg(POOL_A_CL).lpShareBps).toBe(2_500);
    const noShare = await scanWith(ENV_QUOTE_FEE, { ...launchReads(), ...quoteFeeReads(), [k(CL_HOOK, "LP_SHARE_BPS")]: silent("LP_SHARE_BPS") });
    expect(noShare.leg(POOL_A_CL).feeParts).toEqual({ buyLpPips: 20_958, buyGuardPips: 62_875, sellGuardPips: 83_833 });
    expect(noShare.leg(POOL_A_CL).lpShareBps).toBeNull();
  });

  it("throws on a TRANSPORT failure of the parts instead of reading the split as unknown", async () => {
    const c = fakeClient({
      reads: {
        ...launchReads(),
        ...quoteFeeReads(),
        [k(CL_HOOK, "currentFeeParts")]: () => {
          throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
        },
      },
      logs: launchLogs(),
    });
    await expect(readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV_QUOTE_FEE })).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("each leg goes by ITS OWN guard: a quote-fee CL guard beside an lp-fee Bin guard", async () => {
    const { c, leg } = await scanWith({ ...ENV, clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL }, { ...launchReads(), ...quoteFeeReads() });
    expect(leg(POOL_A_CL).guardGeneration).toBe("quote-fee");
    expect(leg(POOL_A_CL).feeSplit).not.toBeNull();
    expect(leg(POOL_A_BIN).guardGeneration).toBe("lp-fee");
    expect(leg(POOL_A_BIN).feeSplit).toBeNull();
    expect(feeReadsOn(c, BIN_HOOK)).toEqual([]);
    expect(feeReadsOn(c, CL_HOOK).length).toBeGreaterThan(0);
  });

  it.each([
    ["bit 10 set on a bitmap that is no guard's", 0x0c01],
    ["the OTHER pool type's quote-fee bitmap", LAUNCH_GUARD_BITMAPS["quote-fee"].Bin],
    ["the other pool type's lp-fee bitmap", LAUNCH_GUARD_BITMAPS["lp-fee"].Bin],
    ["a guard that did not answer", null],
  ])("%s reads as unknown, and the guard is asked for nothing only one generation has", async (_, clHookBitmap) => {
    /* No quote-fee answers are scripted: asking for one would throw "unexpected readContract". */
    const { c, leg } = await scanWith({ ...ENV, clHookBitmap }, launchReads());
    expect(leg(POOL_A_CL).guardGeneration).toBe("unknown");
    expect(leg(POOL_A_CL).feeSplit).toBeNull();
    expect(leg(POOL_B_CL).guardGeneration).toBe("unknown");
    expect(feeReadsOn(c, CL_HOOK)).toEqual([]);
    /* The Bin guard is untouched by what the CL guard answered. */
    expect(leg(POOL_A_BIN).guardGeneration).toBe("lp-fee");
  });

  it("an env written without the bitmaps: each guard is asked once, and the scan carries the completed env", async () => {
    const { clHookBitmap: _cl, binHookBitmap: _bin, ...bare } = ENV;
    const { c, scan, leg } = await scanWith(bare, {
      ...launchReads(),
      ...quoteFeeReads(),
      [k(CL_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["quote-fee"].CL,
      [k(BIN_HOOK, "getHooksRegistrationBitmap")]: LAUNCH_GUARD_BITMAPS["lp-fee"].Bin,
    });
    expect(scan.env).toEqual({ ...ENV, clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL });
    expect(leg(POOL_A_CL).guardGeneration).toBe("quote-fee");
    expect(leg(POOL_A_BIN).guardGeneration).toBe("lp-fee");
    expect(c.calls.filter((x) => x.functionName === "getHooksRegistrationBitmap").map((x) => x.address).sort()).toEqual([CL_HOOK, BIN_HOOK].sort());
  });

  it("an env that carries its bitmaps is not re-read", async () => {
    const { c } = await scanWith(ENV_QUOTE_FEE, { ...launchReads(), ...quoteFeeReads() });
    expect(c.calls.some((x) => x.functionName === "getHooksRegistrationBitmap")).toBe(false);
  });

  it("a fee split that REVERTS, or was never written, reads as null on a quote-fee leg", async () => {
    const { leg } = await scanWith(ENV_QUOTE_FEE, {
      ...launchReads(),
      ...quoteFeeReads(),
      [k(CL_HOOK, "getFeeSplit")]: (args: readonly unknown[]) => {
        if (String(args[0]) === POOL_B_CL) throw new ContractFunctionRevertedError({ abi: [], functionName: "getFeeSplit" });
        return { creator: NATIVE_ADDRESS, creatorBps: 0, protocolBps: 0, integratorBps: 0, integrator: NATIVE_ADDRESS };
      },
    });
    expect(leg(POOL_A_CL).guardGeneration).toBe("quote-fee");
    expect(leg(POOL_A_CL).feeSplit).toBeNull();
    expect(leg(POOL_B_CL).feeSplit).toBeNull();
  });

  it("throws on a TRANSPORT failure of the fee split instead of reading it as absent", async () => {
    const c = fakeClient({
      reads: {
        ...launchReads(),
        ...quoteFeeReads(),
        [k(CL_HOOK, "getFeeSplit")]: () => {
          throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
        },
      },
      logs: launchLogs(),
    });
    await expect(readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env: ENV_QUOTE_FEE })).rejects.toBeInstanceOf(HttpRequestError);
  });
});

describe("readKitV2Earnings: the trade fee of quote-fee guards", () => {
  const USD_META = { address: USD, symbol: "USD", name: "Dollar", decimals: 6 };
  /** Pots chosen so every share floors: 1_000_003 * 70% = 700_002.1, * 10% = 100_000.3; 19 * 10% = 1.9. */
  const POTS: Record<string, bigint> = { [POOL_A_CL]: 1_000_003n, [POOL_A_BIN]: 19n, [POOL_B_CL]: 5n };

  function world(extra: Record<string, Answer> = {}) {
    const asked: { hook: Address; fn: string; args: readonly unknown[] }[] = [];
    const pot = (hook: Address) => (args: readonly unknown[]) => {
      asked.push({ hook, fn: "pendingFee", args });
      const v = POTS[String(args[0])];
      if (v === undefined) throw new Error(`fake: no pot for ${String(args[0])}`);
      return v;
    };
    const credited = (hook: Address, amount: bigint) => (args: readonly unknown[]) => {
      asked.push({ hook, fn: "claimable", args });
      return amount;
    };
    const c = fakeClient({
      reads: {
        ...launchReads(),
        ...quoteFeeReads(),
        [k(KIT, "feesOwed")]: 0n,
        [k(CL_LOCKER, "claimable")]: 0n,
        [k(BIN_LOCKER, "claimable")]: 0n,
        [k(CL_HOOK, "pendingFee")]: pot(CL_HOOK),
        [k(BIN_HOOK, "pendingFee")]: pot(BIN_HOOK),
        [k(CL_HOOK, "claimable")]: credited(CL_HOOK, 41n),
        [k(BIN_HOOK, "claimable")]: credited(BIN_HOOK, 42n),
        ...extra,
      },
      logs: launchLogs(),
    });
    return { c, asked };
  }
  const scanOf = (c: ReturnType<typeof fakeClient>, env: KitV2Env = ENV_QUOTE_FEE) =>
    readKitV2Launches(asClient(c), KIT, { fromBlock: 1n, chainId: 31337, env });

  it("reports the pool's pot, the account's FLOORED share of it, and what the guard has already credited", async () => {
    const { c, asked } = world();
    const scan = await scanOf(c);
    /* CREATOR is the fee split's creator on the CL leg (70%) and its integrator on the Bin leg (10%). */
    const e = await readKitV2Earnings(asClient(c), scan, CREATOR);
    const tokenMeta = scan.launches[1]!.tokenMeta;

    expect(e.fee.pools).toEqual([
      {
        guard: "CL",
        hook: CL_HOOK,
        poolId: POOL_A_CL,
        token: TOKEN_A,
        tokenMeta,
        role: "creator",
        bps: 7_000,
        pending: [{ currency: NATIVE_ADDRESS, meta: null, amount: 1_000_003n, share: 700_002n }],
      },
      {
        guard: "Bin",
        hook: BIN_HOOK,
        poolId: POOL_A_BIN,
        token: TOKEN_A,
        tokenMeta,
        role: "integrator",
        bps: 1_000,
        pending: [{ currency: USD, meta: USD_META, amount: 19n, share: 1n }],
      },
    ]);
    /* One balance per guard and currency, in the QUOTE: the fee is never taken in the launch token. */
    expect(e.guardClaimable).toEqual([
      { guard: "CL", hook: CL_HOOK, currency: NATIVE_ADDRESS, meta: null, amount: 41n },
      { guard: "Bin", hook: BIN_HOOK, currency: USD, meta: USD_META, amount: 42n },
    ]);
    /* The older name is the same rows, not a second balance. */
    expect(e.tax.claimable).toBe(e.guardClaimable);
    expect(e.tax.pools).toEqual([]);

    /* Each pot was asked of its own guard, for its own pool, in the quote; each balance for the account. */
    expect(asked.filter((x) => x.fn === "pendingFee").map((x) => [x.hook, ...x.args])).toEqual([
      [CL_HOOK, POOL_A_CL, NATIVE_ADDRESS],
      [BIN_HOOK, POOL_A_BIN, USD],
    ]);
    expect(asked.filter((x) => x.fn === "claimable").map((x) => [x.hook, ...x.args])).toEqual([
      [CL_HOOK, CREATOR, NATIVE_ADDRESS],
      [BIN_HOOK, CREATOR, USD],
    ]);
    /* The locks are still listed, each with its guard's share: the CL lock earns a quarter of what buys pay, the Bin lock none. */
    expect(e.locks.map((l) => [l.locker, l.guardGeneration, l.lpShareBps])).toEqual([
      ["CL", "quote-fee", 2_500],
      ["Bin", "quote-fee", 0],
    ]);
  });

  it("the integrator's share is its own bucket, floored on its own", async () => {
    const { c } = world();
    const e = await readKitV2Earnings(asClient(c), await scanOf(c), INTEGRATOR);
    expect(e.fee.pools.map((p) => [p.poolId, p.role, p.bps, p.pending[0]!.amount, p.pending[0]!.share])).toEqual([[POOL_A_CL, "integrator", 1_000, 1_000_003n, 100_000n]]);
  });

  it("an account holding both buckets gets both floors added, never the floor of the sum", async () => {
    /* 1_000_003 * 80% = 800_002.4 either way, so use a pot where the two differ: 15 * 70% = 10.5, 15 * 10% = 1.5. */
    const { c } = world({
      [k(CL_HOOK, "getFeeSplit")]: () => ({ creator: CREATOR, creatorBps: 7_000, protocolBps: 2_000, integratorBps: 1_000, integrator: CREATOR }),
      [k(CL_HOOK, "pendingFee")]: 15n,
    });
    const e = await readKitV2Earnings(asClient(c), await scanOf(c), CREATOR);
    const cl = e.fee.pools.filter((p) => p.guard === "CL");
    expect(cl.map((p) => [p.role, p.bps])).toEqual([
      ["both", 8_000],
      ["both", 8_000],
    ]);
    /* floor(10.5) + floor(1.5) = 11; floor(12) would be 12. The protocol keeps the difference. */
    expect(cl.map((p) => p.pending[0]!.share)).toEqual([11n, 11n]);
  });

  it("the protocol's remainder is nobody's share: creator + integrator never exceed the pot", async () => {
    const { c } = world();
    const scan = await scanOf(c);
    const [creator, integrator] = await Promise.all([readKitV2Earnings(asClient(c), scan, CREATOR), readKitV2Earnings(asClient(c), scan, INTEGRATOR)]);
    const share = (e: typeof creator) => e.fee.pools.find((p) => p.poolId === POOL_A_CL)!.pending[0]!.share;
    expect(share(creator) + share(integrator)).toBe(800_002n);
    expect(1_000_003n - share(creator) - share(integrator)).toBe(200_001n);
  });

  it("a nominee is not a party until it accepts, and a zero-share bucket is no bucket", async () => {
    const { c } = world();
    const scan = await scanOf(c);
    expect((await readKitV2Earnings(asClient(c), scan, NOMINEE)).fee.pools).toEqual([]);
    /* Token B's split names the zero address as integrator at 0 bps: the zero address earns nothing there. */
    expect((await readKitV2Earnings(asClient(c), scan, NATIVE_ADDRESS)).fee.pools).toEqual([]);
  });

  it("lp-fee legs contribute nothing to the fee, even beside a quote-fee guard", async () => {
    const { c, asked } = world();
    const scan = await scanOf(c, { ...ENV, clHookBitmap: LAUNCH_GUARD_BITMAPS["quote-fee"].CL });
    const e = await readKitV2Earnings(asClient(c), scan, CREATOR);
    expect(e.fee.pools.map((p) => p.guard)).toEqual(["CL"]);
    expect(asked.filter((x) => x.hook === BIN_HOOK)).toEqual([]);
    expect(e.locks.map((l) => [l.locker, l.guardGeneration, l.lpShareBps])).toEqual([
      ["CL", "quote-fee", 2_500],
      ["Bin", "lp-fee", null],
    ]);
  });

  it("a leg whose fee split could not be read contributes no pool, rather than a pot split by a guess", async () => {
    const { c, asked } = world({
      [k(CL_HOOK, "getFeeSplit")]: () => {
        throw new ContractFunctionRevertedError({ abi: [], functionName: "getFeeSplit" });
      },
    });
    const e = await readKitV2Earnings(asClient(c), await scanOf(c), CREATOR);
    expect(e.fee.pools.map((p) => p.guard)).toEqual(["Bin"]);
    expect(asked.filter((x) => x.fn === "pendingFee" && x.hook === CL_HOOK)).toEqual([]);
  });

  it("a pool with a live tax and a fee reads ONE balance for the quote, not one per source", async () => {
    const { c, asked } = world({
      [k(CL_HOOK, "getTax")]: (args: readonly unknown[]) =>
        String(args[0]) === POOL_A_CL
          ? { creator: CREATOR, buyBps: 300, sellBps: 500, expiresAt: Number(HEADER_TIMESTAMP) + 1_000, creatorBps: 7_000, integrator: INTEGRATOR, protocolBps: 2_000, integratorBps: 1_000 }
          : NO_TAX_RECORD,
      [k(CL_HOOK, "pendingTax")]: (args: readonly unknown[]) => (String(args[1]).toLowerCase() === NATIVE_ADDRESS ? 9n : 0n),
    });
    const e = await readKitV2Earnings(asClient(c), await scanOf(c), CREATOR);
    expect(e.tax.pools.map((p) => p.poolId)).toEqual([POOL_A_CL]);
    expect(e.fee.pools.map((p) => p.poolId)).toEqual([POOL_A_CL, POOL_A_BIN]);
    const native = e.guardClaimable.filter((r) => r.guard === "CL" && r.currency === NATIVE_ADDRESS);
    expect(native).toHaveLength(1);
    expect(asked.filter((x) => x.fn === "claimable" && x.hook === CL_HOOK && x.args[1] === NATIVE_ADDRESS)).toHaveLength(1);
  });
});
