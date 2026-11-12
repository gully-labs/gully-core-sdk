// SPDX-License-Identifier: MIT
/**
 * The live adapter's read paths, driven by a fake `PublicClient`.
 *
 * ## The fake client's contract
 *
 * `fakeClient(world)` is a plain object implementing only the five methods the
 * adapter's read paths touch: `simulateContract`, `readContract`, `call`,
 * `getBlock` and `getBalance`. Every call is appended to `calls` exactly as
 * the adapter made it, and each method dispatches on `address` /
 * `functionName` / `args` against the `world` the test declared:
 *
 * - `simulateContract` answers `quoteExactInputSingle` from `world.quotes`,
 *   keyed `${quoterAddress}:${poolId}` -> `[amountOut, gasEstimate]`, and
 *   rejects for any other key. The adapter treats a rejection as "this pool
 *   did not quote", which is what a reverting quoter looks like.
 * - `readContract` answers `getLaunch` / `currentFee` / `currentTaxRates` from
 *   `world.launches`, keyed `${hookAddress}:${poolId}` (the tax rates default
 *   to none, `[0, 0]`), and `legsOf` from `world.legs`, keyed by token address.
 *   Anything else throws, so an unexpected read fails the test instead of
 *   returning `undefined` into a decoder.
 * - `call` answers a hook's `CLOCK_MODE()` (`to` set, data `0x4bf5d7e9`) with
 *   the ABI-encoded string `"mode=timestamp"`, and REJECTS the creation-call
 *   `NUMBER` probe that `readContractClock` tries first (`to` unset), the way
 *   a public RPC that refuses creation calls does.
 * - `getBlock` returns a fixed Nitro-shaped header: `number` 100, `timestamp`
 *   1_700_000_000, `l1BlockNumber` 100. Chain 31337 is not in the SDK address
 *   book, so `readContractClock` takes the parent-l1 path, the probe fails,
 *   and it falls through to `l1BlockNumber`. Without that header field it
 *   would throw rather than substitute `eth_blockNumber`, by design.
 *
 * Nothing here is a chain. Every number the assertions compare against is one
 * this file put into `world`.
 */

import { describe, expect, it } from "vitest";
import { HttpRequestError, encodeAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import {
  BIN_LAUNCH_GUARD_HOOK_ABI,
  BIN_QUOTER_ABI,
  CLOCK_MODE_CALLDATA,
  CL_QUOTER_ABI,
  CONTRACT_CLOCK_PROBE_CALLDATA,
  DYNAMIC_FEE_FLAG,
  LAUNCH_GUARD_HOOK_ABI,
  TIMESTAMP_CLOCK_MODE,
  createBinPoolKey,
  createCLPoolKey,
  poolKeyToId,
  type PoolId,
  type PoolKey,
} from "@gullylabs/core-sdk";
import { createViemAdapter } from "../src/adapters/viem.js";
import { UnsupportedOperationError, type PoolInfo, type TokenInfo } from "../src/adapters/protocol.js";
import { ChainConfigError, type ChainConfig, type ContractAddresses } from "../src/config/chain.js";
import type { RawLaunchGuard } from "../src/callpath/launch.js";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                 */
/* ------------------------------------------------------------------------ */

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const TOKEN_A = "0x000000000000000000000000000000000000000a" as const;
const TOKEN_B = "0x000000000000000000000000000000000000000b" as const;
const TOKEN_C = "0x000000000000000000000000000000000000000c" as const;
const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const CL_MANAGER = "0x00000000000000000000000000000000000000a2" as const;
const BIN_MANAGER = "0x00000000000000000000000000000000000000a3" as const;
const CL_QUOTER = "0x00000000000000000000000000000000000000c1" as const;
const BIN_QUOTER = "0x00000000000000000000000000000000000000c2" as const;
const CL_GUARD = "0x00000000000000000000000000000000000000d1" as const;
const BIN_GUARD = "0x00000000000000000000000000000000000000d2" as const;
const OTHER_HOOK = "0x00000000000000000000000000000000000000d9" as const;
const KIT_V2 = "0x00000000000000000000000000000000000000e1" as const;
const LAUNCH_OWNER = "0x00000000000000000000000000000000000000ff" as const;

const HEADER_TIMESTAMP = 1_700_000_000n;
const HEADER_NUMBER = 100n;

const tokenA: TokenInfo = { address: TOKEN_A, symbol: "TKA", name: "Token A", decimals: 18 };
const tokenB: TokenInfo = { address: TOKEN_B, symbol: "TKB", name: "Token B", decimals: 18 };
const tokenC: TokenInfo = { address: TOKEN_C, symbol: "TKC", name: "Token C", decimals: 6 };

function clPool(args: { hooks?: Address; fee?: number; token0?: TokenInfo; token1?: TokenInfo }): PoolInfo {
  const token0 = args.token0 ?? tokenA;
  const token1 = args.token1 ?? tokenB;
  const key: PoolKey = createCLPoolKey({
    currency0: token0.address,
    currency1: token1.address,
    hooks: args.hooks ?? ZERO,
    poolManager: CL_MANAGER,
    fee: args.fee ?? 3_000,
    tickSpacing: 60,
  });
  return {
    id: poolKeyToId(key),
    key,
    poolType: "CL",
    token0,
    token1,
    lpFeePips: key.fee,
    tickSpacing: 60,
    hooks: key.hooks,
  };
}

function binPool(args: { hooks?: Address; fee?: number; token0?: TokenInfo; token1?: TokenInfo }): PoolInfo {
  const token0 = args.token0 ?? tokenA;
  const token1 = args.token1 ?? tokenB;
  const key: PoolKey = createBinPoolKey({
    currency0: token0.address,
    currency1: token1.address,
    hooks: args.hooks ?? ZERO,
    poolManager: BIN_MANAGER,
    fee: args.fee ?? 100,
    binStep: 25,
  });
  return {
    id: poolKeyToId(key),
    key,
    poolType: "BIN",
    token0,
    token1,
    lpFeePips: key.fee,
    binStep: 25,
    hooks: key.hooks,
  };
}

function chainWith(contracts: Partial<ContractAddresses>): ChainConfig {
  return {
    chainId: 31337,
    name: "Fake",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    contracts: { vault: VAULT, clPoolManager: CL_MANAGER, binPoolManager: BIN_MANAGER, ...contracts },
  };
}

/** A claimed, enabled launch record in the `getLaunch` tuple shape. */
function launchRecord(overrides: Partial<RawLaunchGuard> = {}): RawLaunchGuard {
  return {
    owner: LAUNCH_OWNER,
    startTime: 1_700_000_100n,
    decaySeconds: 600,
    enabled: true,
    initialFeeBips: 300_000,
    finalFeeBips: 10_000,
    maxBuyPerTx: 0n,
    launchTokenIsCurrency0: true,
    launched: false,
    ...overrides,
  };
}

const UNCLAIMED: RawLaunchGuard = launchRecord({
  owner: ZERO,
  startTime: 0n,
  decaySeconds: 0,
  enabled: false,
  initialFeeBips: 0,
  finalFeeBips: 0,
});

/* ------------------------------------------------------------------------ */
/* The fake client                                                          */
/* ------------------------------------------------------------------------ */

interface RecordedCall {
  readonly method: "simulateContract" | "readContract" | "call" | "getBlock" | "getBalance";
  readonly address?: Address;
  readonly abi?: unknown;
  readonly functionName?: string;
  readonly args?: readonly unknown[];
  readonly data?: Hex;
}

interface World {
  /** `${quoter}:${poolId}` -> [amountOut, gasEstimate]. */
  readonly quotes?: Record<string, readonly [bigint, bigint]>;
  /** `${hook}:${poolId}` -> { record, currentFee, taxRates? }. `taxRates` is `[buyBps, sellBps]`, none when absent. */
  readonly launches?: Record<string, { readonly record: RawLaunchGuard; readonly currentFee: number; readonly taxRates?: readonly [number, number] }>;
  /** token address -> pool ids the kit lists for it. */
  readonly legs?: Record<string, readonly PoolId[]>;
  /** Addresses whose reads fail with a TRANSPORT error (not a revert). */
  readonly transportDown?: readonly Address[];
}

function key(address: Address, id: unknown): string {
  return `${address.toLowerCase()}:${String(id)}`;
}

function fakeClient(world: World) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async simulateContract(req: {
      address: Address;
      abi: unknown;
      functionName: string;
      args: readonly unknown[];
    }) {
      calls.push({ method: "simulateContract", ...req });
      if (req.functionName !== "quoteExactInputSingle") {
        throw new Error(`fake: unexpected simulateContract ${req.functionName}`);
      }
      const params = req.args[0] as { poolKey: PoolKey };
      const answer = world.quotes?.[key(req.address, poolKeyToId(params.poolKey))];
      if (answer === undefined) throw new Error(`fake: quoter ${req.address} reverted`);
      return { result: answer };
    },
    async readContract(req: {
      address: Address;
      abi: unknown;
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown> {
      calls.push({ method: "readContract", ...req });
      const arg0 = req.args?.[0];
      if (req.functionName === "getLaunch") {
        const launch = world.launches?.[key(req.address, arg0)];
        if (launch === undefined) throw new Error(`fake: no launch fixture at ${req.address} for ${String(arg0)}`);
        return launch.record;
      }
      if (req.functionName === "currentFee") {
        if (world.transportDown?.includes(req.address.toLowerCase() as Address)) {
          throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
        }
        const launch = world.launches?.[key(req.address, arg0)];
        if (launch === undefined) throw new Error(`fake: no launch fixture at ${req.address} for ${String(arg0)}`);
        return BigInt(launch.currentFee);
      }
      if (req.functionName === "currentTaxRates") {
        const launch = world.launches?.[key(req.address, arg0)];
        if (launch === undefined) throw new Error(`fake: no launch fixture at ${req.address} for ${String(arg0)}`);
        return launch.taxRates ?? [0, 0];
      }
      if (req.functionName === "legsOf") {
        const legs = world.legs?.[String(arg0).toLowerCase()];
        if (legs === undefined) throw new Error(`fake: no legs fixture for ${String(arg0)}`);
        return legs;
      }
      throw new Error(`fake: unexpected readContract ${req.functionName} at ${req.address}`);
    },
    async call(req: { to?: Address; data: Hex }): Promise<{ data?: Hex }> {
      calls.push({ method: "call", ...(req.to === undefined ? {} : { address: req.to }), data: req.data });
      if (req.to === undefined && req.data === CONTRACT_CLOCK_PROBE_CALLDATA) {
        throw new Error("fake: this endpoint refuses creation calls");
      }
      if (req.data === CLOCK_MODE_CALLDATA) {
        return { data: encodeAbiParameters([{ type: "string" }], [TIMESTAMP_CLOCK_MODE]) };
      }
      throw new Error(`fake: unexpected call to ${String(req.to)} with ${req.data}`);
    },
    async getBlock() {
      calls.push({ method: "getBlock" });
      return { number: HEADER_NUMBER, timestamp: HEADER_TIMESTAMP, l1BlockNumber: HEADER_NUMBER };
    },
    async getBalance(req: { address: Address }) {
      calls.push({ method: "getBalance", address: req.address });
      return 0n;
    },
  };
  return client;
}

function asPublicClient(client: ReturnType<typeof fakeClient>): PublicClient {
  return client as unknown as PublicClient;
}

function simulations(client: ReturnType<typeof fakeClient>) {
  return client.calls.filter((c) => c.method === "simulateContract");
}

function reads(client: ReturnType<typeof fakeClient>, functionName: string) {
  return client.calls.filter((c) => c.method === "readContract" && c.functionName === functionName);
}

/* ------------------------------------------------------------------------ */
/* quoteSwap                                                                */
/* ------------------------------------------------------------------------ */

describe("ViemProtocolAdapter.quoteSwap", () => {
  const cl = clPool({});
  const bin = binPool({});
  const chain = chainWith({ quoter: CL_QUOTER, binQuoter: BIN_QUOTER });

  it("quotes every direct pool through its type's quoter and returns the best output", async () => {
    const client = fakeClient({
      quotes: {
        [key(CL_QUOTER, cl.id)]: [900n, 120_000n],
        [key(BIN_QUOTER, bin.id)]: [950n, 80_000n],
      },
    });
    const adapter = createViemAdapter({ chain, publicClient: asPublicClient(client), tokens: [tokenA, tokenB], pools: [cl, bin] });

    /* tokenIn is currency1, so the direction is one-for-zero: zeroForOne must be false. */
    const quote = await adapter.quoteSwap({ tokenIn: tokenB, tokenOut: tokenA, amountIn: 1_000n });

    const sims = simulations(client);
    expect(sims).toHaveLength(2);
    const clSim = sims.find((s) => s.address === CL_QUOTER);
    const binSim = sims.find((s) => s.address === BIN_QUOTER);
    expect(clSim).toBeDefined();
    expect(binSim).toBeDefined();
    expect(clSim?.abi).toBe(CL_QUOTER_ABI);
    expect(binSim?.abi).toBe(BIN_QUOTER_ABI);
    for (const sim of [clSim, binSim]) {
      expect(sim?.functionName).toBe("quoteExactInputSingle");
      const [params] = sim?.args as [{ poolKey: PoolKey; zeroForOne: boolean; exactAmount: bigint; hookData: Hex }];
      expect(params.zeroForOne).toBe(false);
      expect(params.exactAmount).toBe(1_000n);
      expect(params.hookData).toBe("0x");
    }
    expect((clSim?.args as [{ poolKey: PoolKey }])[0].poolKey).toEqual(cl.key);
    expect((binSim?.args as [{ poolKey: PoolKey }])[0].poolKey).toEqual(bin.key);

    expect(quote.grossAmountOut).toBe(950n);
    expect(quote.estimatedGas).toBe(80_000n);
    expect(quote.route).toHaveLength(1);
    expect(quote.route[0]?.poolId).toBe(bin.id);
    expect(quote.route[0]?.poolType).toBe("BIN");
    expect(quote.route[0]?.hooks).toBe(ZERO);
    expect(quote.amountIn).toBe(1_000n);
    expect(quote.spotAmountOut).toBeNull();
    expect(quote.lpFeePips).toBe(100);
    expect(quote.lpFeeAmount).toBe((1_000n * 100n) / 1_000_000n);
    expect(quote.lpFeeUnknown).toBeUndefined();
    expect(quote.source).toBe("live");
  });

  it("honours request.poolId: only that pool is quoted even when a better one exists", async () => {
    const client = fakeClient({
      quotes: {
        [key(CL_QUOTER, cl.id)]: [900n, 120_000n],
        [key(BIN_QUOTER, bin.id)]: [950n, 80_000n],
      },
    });
    const adapter = createViemAdapter({ chain, publicClient: asPublicClient(client), tokens: [tokenA, tokenB], pools: [cl, bin] });

    const quote = await adapter.quoteSwap({ tokenIn: tokenA, tokenOut: tokenB, amountIn: 1_000n, poolId: cl.id });

    const sims = simulations(client);
    expect(sims).toHaveLength(1);
    expect(sims[0]?.address).toBe(CL_QUOTER);
    expect((sims[0]?.args as [{ zeroForOne: boolean }])[0].zeroForOne).toBe(true);
    expect(quote.grossAmountOut).toBe(900n);
    expect(quote.estimatedGas).toBe(120_000n);
    expect(quote.route[0]?.poolId).toBe(cl.id);
    expect(quote.lpFeePips).toBe(3_000);
  });

  it("throws UnsupportedOperationError when no pool holds the pair, and differently when the pool's quoter is missing", async () => {
    /* No pool for A/C at all. */
    const noPair = fakeClient({});
    const adapterNoPair = createViemAdapter({ chain, publicClient: asPublicClient(noPair), tokens: [tokenA, tokenC], pools: [cl, bin] });
    const missingPool = await adapterNoPair
      .quoteSwap({ tokenIn: tokenA, tokenOut: tokenC, amountIn: 1n })
      .then(() => null, (e: unknown) => e);
    expect(missingPool).toBeInstanceOf(UnsupportedOperationError);
    expect((missingPool as UnsupportedOperationError).operation).toBe("quoteSwap");
    expect((missingPool as Error).message).toContain("no configured pool holds both TKA and TKC");
    expect(simulations(noPair)).toHaveLength(0);

    /* A Bin pool exists for A/B, but the chain config has no binQuoter. */
    const noQuoter = fakeClient({ quotes: { [key(BIN_QUOTER, bin.id)]: [950n, 80_000n] } });
    const adapterNoQuoter = createViemAdapter({
      chain: chainWith({ quoter: CL_QUOTER }),
      publicClient: asPublicClient(noQuoter),
      tokens: [tokenA, tokenB],
      pools: [bin],
    });
    const missingQuoter = await adapterNoQuoter
      .quoteSwap({ tokenIn: tokenA, tokenOut: tokenB, amountIn: 1n })
      .then(() => null, (e: unknown) => e);
    expect(missingQuoter).toBeInstanceOf(UnsupportedOperationError);
    expect((missingQuoter as Error).message).toContain("no quoter is configured for its type (BIN)");
    expect((missingQuoter as Error).message).not.toContain("no configured pool holds both");
    expect(simulations(noQuoter)).toHaveLength(0);
  });

  it("reports a dynamic fee as unknown unless the pool's hook is the configured launch guard", async () => {
    const dynamicOther = clPool({ hooks: OTHER_HOOK, fee: DYNAMIC_FEE_FLAG });
    const dynamicGuarded = clPool({ hooks: CL_GUARD, fee: DYNAMIC_FEE_FLAG });
    expect(dynamicOther.lpFeePips).toBe(0x800000);
    const guardedChain = chainWith({ quoter: CL_QUOTER, launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp" });

    /* Hook is not a configured guard: the fee cannot be read, so it is not invented. */
    const unknownClient = fakeClient({ quotes: { [key(CL_QUOTER, dynamicOther.id)]: [700n, 90_000n] } });
    const unknownAdapter = createViemAdapter({
      chain: guardedChain,
      publicClient: asPublicClient(unknownClient),
      tokens: [tokenA, tokenB],
      pools: [dynamicOther],
    });
    const unknown = await unknownAdapter.quoteSwap({ tokenIn: tokenA, tokenOut: tokenB, amountIn: 10_000n });
    expect(unknown.lpFeeUnknown).toBe(true);
    expect(unknown.lpFeePips).toBe(0);
    expect(unknown.lpFeeAmount).toBe(0n);
    expect(unknown.route[0]?.lpFeePips).toBe(0);
    expect(unknown.grossAmountOut).toBe(700n);
    expect(reads(unknownClient, "currentFee")).toHaveLength(0);

    /* Hook IS contracts.launchGuardHook: the guard's currentFee is the rate in force. */
    const guardedClient = fakeClient({
      quotes: { [key(CL_QUOTER, dynamicGuarded.id)]: [700n, 90_000n] },
      launches: { [key(CL_GUARD, dynamicGuarded.id)]: { record: launchRecord(), currentFee: 250_000 } },
    });
    const guardedAdapter = createViemAdapter({
      chain: guardedChain,
      publicClient: asPublicClient(guardedClient),
      tokens: [tokenA, tokenB],
      pools: [dynamicGuarded],
    });
    const guarded = await guardedAdapter.quoteSwap({ tokenIn: tokenA, tokenOut: tokenB, amountIn: 10_000n });
    expect(guarded.lpFeeUnknown).toBeUndefined();
    expect("lpFeeUnknown" in guarded).toBe(false);
    /* The key's bitmap is not that of a guard taking the fee itself, so the fee is the pool's. */
    expect(guarded.launch).toEqual({ feeTakenBy: "pool", quote: tokenB, taxBps: 0 });
    expect(unknown.launch).toBeUndefined();
    expect(guarded.lpFeePips).toBe(250_000);
    expect(guarded.lpFeeAmount).toBe((10_000n * 250_000n) / 1_000_000n);
    expect(guarded.route[0]?.lpFeePips).toBe(250_000);
    expect(guarded.route[0]?.hooks).toBe(CL_GUARD);
    const feeReads = reads(guardedClient, "currentFee");
    expect(feeReads).toHaveLength(1);
    expect(feeReads[0]?.address).toBe(CL_GUARD);
    expect(feeReads[0]?.abi).toBe(LAUNCH_GUARD_HOOK_ABI);
    expect(feeReads[0]?.args).toEqual([dynamicGuarded.id]);
    /* The clock is configured, so the hook was never asked CLOCK_MODE(). */
    expect(guardedClient.calls.filter((c) => c.method === "call")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/* listLaunches / getLaunchesForToken                                       */
/* ------------------------------------------------------------------------ */

describe("ViemProtocolAdapter launches", () => {
  const clLaunch = clPool({ hooks: CL_GUARD, fee: DYNAMIC_FEE_FLAG });
  const binLaunch = binPool({ hooks: BIN_GUARD, fee: DYNAMIC_FEE_FLAG, token0: tokenA, token1: tokenC });
  const clUnclaimed = clPool({ hooks: CL_GUARD, fee: DYNAMIC_FEE_FLAG, token0: tokenB, token1: tokenC });
  const plain = clPool({});
  const pools = [plain, clLaunch, binLaunch, clUnclaimed];

  const launches: NonNullable<World["launches"]> = {
    [key(CL_GUARD, clLaunch.id)]: { record: launchRecord({ launchTokenIsCurrency0: true }), currentFee: 300_000 },
    [key(BIN_GUARD, binLaunch.id)]: {
      record: launchRecord({ launchTokenIsCurrency0: false, startTime: 1_699_999_000n, launched: true }),
      currentFee: 42_000,
    },
    [key(CL_GUARD, clUnclaimed.id)]: { record: UNCLAIMED, currentFee: 0 },
  };

  it("listLaunches reads CL launches from launchGuardHook and Bin launches from binLaunchGuardHook, skipping unclaimed pools", async () => {
    const client = fakeClient({ launches });
    const adapter = createViemAdapter({
      chain: chainWith({ launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp", binLaunchGuardHook: BIN_GUARD }),
      publicClient: asPublicClient(client),
      tokens: [tokenA, tokenB, tokenC],
      pools,
    });

    const result = await adapter.listLaunches();
    expect(result.map((l) => l.poolId)).toEqual([clLaunch.id, binLaunch.id]);

    const [clInfo, binInfo] = result;
    expect(clInfo?.hook).toBe(CL_GUARD);
    expect(clInfo?.pool).toBe(clLaunch);
    expect(clInfo?.guard.durationClock).toBe("timestamp");
    expect(clInfo?.guard.owner).toBe(LAUNCH_OWNER);
    expect(clInfo?.guard.start).toBe(1_700_000_100n);
    expect(clInfo?.guard.window).toBe(600);
    expect(clInfo?.guard.initialFeePips).toBe(300_000);
    expect(clInfo?.guard.finalFeePips).toBe(10_000);
    expect(clInfo?.currentFeePips).toBe(300_000);
    expect(clInfo?.launchToken).toBe(tokenA);
    expect(clInfo?.quoteToken).toBe(tokenB);
    expect(clInfo?.readAt).toBe(HEADER_TIMESTAMP);
    expect(clInfo?.source).toBe("live");

    expect(binInfo?.hook).toBe(BIN_GUARD);
    expect(binInfo?.pool).toBe(binLaunch);
    expect(binInfo?.guard.durationClock).toBe("timestamp");
    expect(binInfo?.guard.launched).toBe(true);
    expect(binInfo?.currentFeePips).toBe(42_000);
    /* launchTokenIsCurrency0 = false: the launch token is currency1 (TKC). */
    expect(binInfo?.launchToken).toBe(tokenC);
    expect(binInfo?.quoteToken).toBe(tokenA);
    expect(binInfo?.readAt).toBe(HEADER_TIMESTAMP);

    /* Each guard was read on its own address with its own ABI. */
    const launchReads = reads(client, "getLaunch");
    expect(launchReads.map((r) => [r.address, r.args?.[0]])).toEqual(
      expect.arrayContaining([
        [CL_GUARD, clLaunch.id],
        [BIN_GUARD, binLaunch.id],
        [CL_GUARD, clUnclaimed.id],
      ]),
    );
    expect(launchReads).toHaveLength(3);
    expect(launchReads.find((r) => r.address === CL_GUARD && r.args?.[0] === clLaunch.id)?.abi).toBe(LAUNCH_GUARD_HOOK_ABI);
    expect(launchReads.find((r) => r.address === BIN_GUARD)?.abi).toBe(BIN_LAUNCH_GUARD_HOOK_ABI);

    /* currentFee is read only for claimed launches - it reverts on an unclaimed id. */
    const feeReads = reads(client, "currentFee");
    expect(feeReads.map((r) => [r.address, r.args?.[0]])).toEqual(
      expect.arrayContaining([
        [CL_GUARD, clLaunch.id],
        [BIN_GUARD, binLaunch.id],
      ]),
    );
    expect(feeReads).toHaveLength(2);

    /* The plain pool names no guard and was never read. */
    expect(client.calls.some((c) => c.args?.[0] === plain.id)).toBe(false);

    /* The Bin guard's clock came from the hook itself; the CL guard's from config. */
    const clockModeCalls = client.calls.filter((c) => c.method === "call" && c.data === CLOCK_MODE_CALLDATA);
    expect(clockModeCalls.map((c) => c.address)).toEqual([BIN_GUARD]);
  });

  it("a pool naming a RETIRED generation's guard is a launch too (an earlier kit's pools trade forever)", async () => {
    const OLD_CL_GUARD = "0x00000000000000000000000000000000000c1d01" as const;
    const oldLaunch = clPool({ hooks: OLD_CL_GUARD, fee: DYNAMIC_FEE_FLAG, token0: tokenA, token1: tokenC });
    const client = fakeClient({ launches: { ...launches, [key(OLD_CL_GUARD, oldLaunch.id)]: { record: launchRecord({ launchTokenIsCurrency0: true }), currentFee: 5_000 } } });
    const adapter = createViemAdapter({
      chain: { ...chainWith({ launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp", binLaunchGuardHook: BIN_GUARD }), retiredLaunchGenerations: [{ launchGuardHook: OLD_CL_GUARD }] },
      publicClient: asPublicClient(client),
      tokens: [tokenA, tokenB, tokenC],
      pools: [...pools, oldLaunch],
    });
    const result = await adapter.listLaunches();
    expect(result.map((l) => l.poolId)).toEqual([clLaunch.id, binLaunch.id, oldLaunch.id]);
    expect(result[2]?.hook).toBe(OLD_CL_GUARD);
    expect(result[2]?.currentFeePips).toBe(5_000);

    /* Without the retired generation, the same pool is not a launch: the regression this guards. */
    const without = createViemAdapter({
      chain: chainWith({ launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp", binLaunchGuardHook: BIN_GUARD }),
      publicClient: asPublicClient(fakeClient({ launches })),
      tokens: [tokenA, tokenB, tokenC],
      pools: [...pools, oldLaunch],
    });
    expect((await without.listLaunches()).map((l) => l.poolId)).toEqual([clLaunch.id, binLaunch.id]);
  });

  it("listLaunches needs at least one guard: ChainConfigError naming launchGuardHook, else the Bin guard alone suffices", async () => {
    const none = fakeClient({ launches });
    const noGuards = createViemAdapter({
      chain: chainWith({}),
      publicClient: asPublicClient(none),
      tokens: [tokenA, tokenB, tokenC],
      pools,
    });
    const error = await noGuards.listLaunches().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigError);
    expect((error as ChainConfigError).contract).toBe("launchGuardHook");
    expect((error as ChainConfigError).chainId).toBe(31337);
    expect(none.calls).toHaveLength(0);

    const binOnlyClient = fakeClient({ launches });
    const binOnly = createViemAdapter({
      chain: chainWith({ binLaunchGuardHook: BIN_GUARD }),
      publicClient: asPublicClient(binOnlyClient),
      tokens: [tokenA, tokenB, tokenC],
      pools,
    });
    const result = await binOnly.listLaunches();
    expect(result.map((l) => l.poolId)).toEqual([binLaunch.id]);
    expect(result[0]?.hook).toBe(BIN_GUARD);
    expect(result[0]?.currentFeePips).toBe(42_000);
    /* CL_GUARD is not configured on this chain, so its pools are not launches here and it is never read. */
    expect(binOnlyClient.calls.some((c) => c.address === CL_GUARD)).toBe(false);
  });

  it("getLaunchesForToken needs the kit, follows legsOf order, and refuses an undeclared pool by id", async () => {
    const noKitClient = fakeClient({ launches });
    const noKit = createViemAdapter({
      chain: chainWith({ launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp", binLaunchGuardHook: BIN_GUARD }),
      publicClient: asPublicClient(noKitClient),
      tokens: [tokenA, tokenB, tokenC],
      pools,
    });
    const error = await noKit.getLaunchesForToken(TOKEN_A).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChainConfigError);
    expect((error as ChainConfigError).contract).toBe("launchpadKitV2");
    expect(noKitClient.calls).toHaveLength(0);

    const chain = chainWith({
      launchGuardHook: CL_GUARD,
      launchGuardHookClock: "timestamp",
      binLaunchGuardHook: BIN_GUARD,
      launchpadKitV2: KIT_V2,
    });
    const missingId = "0x1111111111111111111111111111111111111111111111111111111111111111" as PoolId;

    /* Bin leg first: the result must follow the kit's order, not the pool list's. */
    const client = fakeClient({
      launches,
      legs: {
        [TOKEN_A]: [binLaunch.id, clLaunch.id],
        [TOKEN_B]: [],
        [TOKEN_C]: [clLaunch.id, missingId],
      },
    });
    const adapter = createViemAdapter({ chain, publicClient: asPublicClient(client), tokens: [tokenA, tokenB, tokenC], pools });

    const result = await adapter.getLaunchesForToken(TOKEN_A);
    expect(result.map((l) => l.poolId)).toEqual([binLaunch.id, clLaunch.id]);
    expect(result[0]?.hook).toBe(BIN_GUARD);
    expect(result[1]?.hook).toBe(CL_GUARD);
    const legReads = reads(client, "legsOf");
    expect(legReads).toHaveLength(1);
    expect(legReads[0]?.address).toBe(KIT_V2);
    expect(legReads[0]?.args).toEqual([TOKEN_A]);

    /* A token the kit never launched is an empty list, and no guard is read for it. */
    const before = client.calls.length;
    expect(await adapter.getLaunchesForToken(TOKEN_B)).toEqual([]);
    expect(client.calls.slice(before).map((c) => c.functionName)).toEqual(["legsOf"]);

    /* An id the host did not declare is an error naming that id, never a shorter list. */
    const undeclared = await adapter.getLaunchesForToken(TOKEN_C).then(() => null, (e: unknown) => e);
    expect(undeclared).toBeInstanceOf(UnsupportedOperationError);
    expect((undeclared as UnsupportedOperationError).operation).toBe("getLaunchesForToken");
    expect((undeclared as Error).message).toContain(missingId);
    expect((undeclared as Error).message).toContain("2 pool(s)");
    expect((undeclared as Error).message).toContain("1 of them");
  });

  it("getLaunchesForToken refuses a declared pool whose guard is not configured, never a shorter list", async () => {
    /* Only the CL guard is configured, but the kit lists a Bin leg too. Dropping
       the Bin leg would show a launch with a pool missing, which is the exact
       class of silent lie the pool-list check exists to prevent. */
    const client = fakeClient({ launches, legs: { [TOKEN_A]: [binLaunch.id, clLaunch.id] } });
    const adapter = createViemAdapter({
      chain: chainWith({ launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp", launchpadKitV2: KIT_V2 }),
      publicClient: asPublicClient(client),
      tokens: [tokenA, tokenB, tokenC],
      pools,
    });
    const error = await adapter.getLaunchesForToken(TOKEN_A).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect((error as Error).message).toContain(binLaunch.id);
    expect((error as Error).message).toContain("binLaunchGuardHook");
    expect(reads(client, "getLaunch")).toHaveLength(0);
  });

  it("quoteSwap surfaces a transport failure on the guard's currentFee instead of calling the fee dynamic", async () => {
    const client = fakeClient({
      quotes: { [key(CL_QUOTER, clLaunch.id)]: [900n, 21_000n] },
      launches,
      transportDown: [CL_GUARD],
    });
    const adapter = createViemAdapter({
      chain: chainWith({ quoter: CL_QUOTER, launchGuardHook: CL_GUARD, launchGuardHookClock: "timestamp" }),
      publicClient: asPublicClient(client),
      tokens: [tokenA, tokenB],
      pools: [clLaunch],
    });
    await expect(adapter.quoteSwap({ tokenIn: tokenB, tokenOut: tokenA, amountIn: 1_000n })).rejects.toBeInstanceOf(HttpRequestError);
  });
});
