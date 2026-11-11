// SPDX-License-Identifier: MIT
/**
 * Managed vaults: every builder decoded back from its calldata, the refusals that restate the
 * contract's own checks, the share maths, the share-value series, ABI parity with the compiled
 * artifacts, and the reader against a stub client. No chain, no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, getAddress, keccak256, stringToBytes, zeroAddress, type Address, type PublicClient } from "viem";

import {
  MANAGED_VAULT_ABI,
  ORACLE_KIND,
  VAULT_FACTORY_ABI,
  VAULT_FORBIDDEN_HOOK_BITS,
  VaultInputError,
  buildCreateVault,
  buildDeposit,
  buildDepositInitial,
  buildVaultCall,
  buildWithdraw,
  defaultVaultConfig,
  readVault,
  readVaultAddresses,
  shareValueSeries,
  sharesForAmounts,
  token0InToken1,
  validateVaultConfig,
  vaultKeyProblem,
  withSlippage,
  ORACLE_HOOK_ABI,
  decodeVaultCreated,
  readOracleHook,
  readVaultCreateContext,
  readVaultTwap,
  vaultBaseRange,
  vaultCreateSafeValue,
  vaultPoolChoices,
  type VaultPoolListing,
} from "../src/vaults/index.js";
import { poolKeyToId } from "../src/types/poolKey.js";
import type { PoolKey } from "../src/types/poolKey.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FACTORY = "0x00000000000000000000000000000000000fac01" as Address;
const VAULT = "0x00000000000000000000000000000000000fa001" as Address;
const MANAGER = "0x00000000000000000000000000000000000c1c1c" as Address;
const HOOK = "0x00000000000000000000000000000000000000aa" as Address;
const T0 = "0x0000000000000000000000000000000000000a00" as Address;
const T1 = "0x0000000000000000000000000000000000000b00" as Address;
const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");

/** Tick spacing 10 in bits 16.., bitmap 0x0042 (the oracle hook's) in bits 0..15. */
const PARAMS = ("0x" + (10n << 16n | 0x42n).toString(16).padStart(64, "0")) as `0x${string}`;
const KEY: PoolKey = { currency0: T0, currency1: T1, hooks: HOOK, poolManager: MANAGER, fee: 3000, parameters: PARAMS };
const NATIVE_KEY: PoolKey = { ...KEY, currency0: zeroAddress };

describe("constants", () => {
  it("restates the oracle kind and the forbidden bits", () => {
    expect(ORACLE_KIND).toBe(keccak256(stringToBytes("gullycore.oracle.truncated-twap.v1")));
    expect(VAULT_FORBIDDEN_HOOK_BITS).toBe(0x3030);
  });
});

describe("config", () => {
  it("offers defaults that pass the contract's checks", () => {
    for (const s of [1, 10, 60, 200]) expect(() => validateVaultConfig(defaultVaultConfig(s), s)).not.toThrow();
  });
  it("refuses every bound the contract refuses", () => {
    const ok = defaultVaultConfig(10);
    const bad = (patch: Partial<typeof ok>, field: string, oracleMin?: number) => {
      try {
        validateVaultConfig({ ...ok, ...patch }, 10, oracleMin);
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(VaultInputError);
        expect((e as VaultInputError).field).toBe(field);
      }
    };
    bad({ baseHalfWidth: 5 }, "baseHalfWidth");
    bad({ baseHalfWidth: 1005 }, "baseHalfWidth");
    bad({ limitWidth: 0 }, "limitWidth");
    bad({ maxDeviation: 501 }, "maxDeviation");
    bad({ maxDeviation: 0 }, "maxDeviation");
    bad({ rebalanceThreshold: 1001 }, "rebalanceThreshold");
    bad({ twapWindow: 599 }, "twapWindow");
    bad({}, "twapWindow", 3600);
    bad({ cooldown: 599 }, "cooldown");
    bad({ curatorFeeBps: 2001 }, "curatorFeeBps");
  });
});

describe("keys", () => {
  it("names why a pool cannot carry a vault", () => {
    expect(vaultKeyProblem(KEY, KEY, MANAGER)).toBeNull();
    expect(vaultKeyProblem(KEY, KEY, ALICE)).toMatch(/CL pool manager/);
    expect(vaultKeyProblem(KEY, NATIVE_KEY)).toMatch(/same two currencies/);
    const trap = { ...KEY, parameters: ("0x" + ((10n << 16n) | 0x10n).toString(16).padStart(64, "0")) as `0x${string}` };
    expect(vaultKeyProblem(trap, KEY)).toMatch(/removal/);
    expect(vaultKeyProblem(KEY, { ...KEY, hooks: zeroAddress })).toMatch(/no hook/);
  });
});

describe("builders", () => {
  it("createVault decodes back and carries the fee", () => {
    const cfg = defaultVaultConfig(10, 500);
    const tx = buildCreateVault({ factory: FACTORY, key: KEY, config: cfg, salt: ("0x" + "11".repeat(32)) as `0x${string}`, feeWei: 75n * 10n ** 15n });
    expect(tx.to).toBe(FACTORY);
    expect(tx.value).toBe(75n * 10n ** 15n);
    const d = decodeFunctionData({ abi: VAULT_FACTORY_ABI, data: tx.data });
    expect(d.functionName).toBe("createVault");
    const p = d.args[0] as { config: { curatorFeeBps: number; baseHalfWidth: number } };
    expect(p.config.curatorFeeBps).toBe(500);
    expect(p.config.baseHalfWidth).toBe(1000);
    expect(() => buildCreateVault({ factory: FACTORY, key: KEY, oracleKey: NATIVE_KEY, config: cfg, salt: ("0x" + "11".repeat(32)) as `0x${string}`, feeWei: 0n })).toThrow(VaultInputError);
  });

  it("deposit / depositInitial / withdraw decode back; native value is max0", () => {
    const dep = buildDeposit({ vault: VAULT, key: KEY, shares: 5n, max0: 7n, max1: 9n, to: ALICE, deadline: 100n });
    expect(dep.value).toBe(0n);
    expect(decodeFunctionData({ abi: MANAGED_VAULT_ABI, data: dep.data }).args).toEqual([5n, 7n, 9n, ALICE, 100n]);
    expect(buildDeposit({ vault: VAULT, key: NATIVE_KEY, shares: 5n, max0: 7n, max1: 9n, to: ALICE, deadline: 100n }).value).toBe(7n);
    const init = buildDepositInitial({ vault: VAULT, key: NATIVE_KEY, max0: 3n, max1: 4n, to: ALICE, deadline: 1n });
    expect(init.value).toBe(3n);
    expect(decodeFunctionData({ abi: MANAGED_VAULT_ABI, data: init.data }).functionName).toBe("depositInitial");
    const w = buildWithdraw({ vault: VAULT, shares: 5n, min0: 1n, min1: 2n, to: ALICE, deadline: 3n });
    expect(decodeFunctionData({ abi: MANAGED_VAULT_ABI, data: w.data }).args).toEqual([5n, 1n, 2n, ALICE, 3n]);
    expect(() => buildWithdraw({ vault: VAULT, shares: 0n, min0: 0n, min1: 0n, to: ALICE, deadline: 1n })).toThrow(/shares/);
    expect(() => buildDeposit({ vault: VAULT, key: KEY, shares: 1n, max0: 0n, max1: 0n, to: zeroAddress, deadline: 1n })).toThrow(/zero address/);
    for (const fn of ["rebalance", "harvest", "flushProtocolFees"] as const) {
      expect(decodeFunctionData({ abi: MANAGED_VAULT_ABI, data: buildVaultCall(VAULT, fn).data }).functionName).toBe(fn);
    }
  });
});

describe("maths", () => {
  it("shares for amounts take the binding side, rounded down", () => {
    expect(sharesForAmounts({ total0: 100n, total1: 200n, supply: 1000n, amount0: 10n, amount1: 10n })).toBe(50n);
    expect(sharesForAmounts({ total0: 0n, total1: 200n, supply: 1000n, amount0: 0n, amount1: 20n })).toBe(100n);
    expect(sharesForAmounts({ total0: 1n, total1: 1n, supply: 0n, amount0: 5n, amount1: 5n })).toBe(0n);
  });
  it("slippage rounds against the user", () => {
    expect(withSlippage(10_000n, 100, "max")).toBe(10_100n);
    expect(withSlippage(1n, 100, "max")).toBe(2n);
    expect(withSlippage(10_000n, 100, "min")).toBe(9_900n);
    expect(() => withSlippage(1n, -1, "min")).toThrow();
  });
  it("values token0 in token1 at sqrtPrice", () => {
    expect(token0InToken1(10n ** 18n, 1n << 96n)).toBe(10n ** 18n);
    expect(token0InToken1(10n ** 18n, 2n << 96n)).toBe(4n * 10n ** 18n);
  });
  it("share-value series drops empty snapshots", () => {
    const s = shareValueSeries([
      { blockNumber: 1n, total0: 0n, total1: 0n, supply: 0n, sqrtPriceX96: 1n << 96n },
      { blockNumber: 2n, total0: 10n ** 18n, total1: 10n ** 18n, supply: 2n * 10n ** 18n, sqrtPriceX96: 1n << 96n },
    ]);
    expect(s).toEqual([{ blockNumber: 2n, valuePerShare1e18: 10n ** 18n }]);
  });
});

describe("readers", () => {
  it("reads a vault and the factory's list", async () => {
    const client = {
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        switch (functionName) {
          case "poolKey":
          case "oraclePoolKey":
            return KEY;
          case "config":
            return { baseHalfWidth: 1000, limitWidth: 1000, maxDeviation: 100, rebalanceThreshold: 500, twapWindow: 1800, cooldown: 3600, curatorFeeBps: 0 };
          case "curator":
            return ALICE;
          case "performanceFeeBps":
            return 1000;
          case "totalSupply":
            return 10n;
          case "totalAmounts":
            return [1n, 2n];
          case "base":
            return [-1000, 1000];
          case "limit":
            return [0, 0];
          case "positionLiquidity":
            return [5n, 0n];
          case "lastRebalanceAt":
            return 9n;
          case "vaultCount":
            return 3n;
          case "vaults":
            return [VAULT, VAULT, VAULT].slice(Number(args?.[0] ?? 0n), Number(args?.[0] ?? 0n) + Number(args?.[1] ?? 0n));
        }
        throw new Error("unexpected " + functionName);
      },
      simulateContract: async () => {
        throw new ContractFunctionRevertedError({
          abi: MANAGED_VAULT_ABI,
          functionName: "rebalance",
          data: encodeErrorResult({ abi: MANAGED_VAULT_ABI, errorName: "CooldownActive", args: [5n] }),
        });
      },
    } as unknown as PublicClient;
    const v = await readVault(client, VAULT);
    expect(v.canRebalance).toEqual({ ok: false, reason: "cooldown" });
    expect(v.base).toEqual({ lower: -1000, upper: 1000 });
    expect(v.performanceFeeBps).toBe(1000);
    expect(await readVaultAddresses(client, FACTORY, 2)).toHaveLength(3);
  });
});

describe("creation", () => {
  const params = (spacing: number, bitmap: number) => ("0x" + ((BigInt(spacing) << 16n) | BigInt(bitmap)).toString(16).padStart(64, "0")) as `0x${string}`;
  const OTHER_HOOK = "0x00000000000000000000000000000000000000bb" as Address;
  const listing = (key: PoolKey, kind: "CL" | "Bin" = "CL"): VaultPoolListing => ({ poolId: poolKeyToId(key), kind, key });
  const ORACLE_POOL = listing(KEY); // hook = HOOK, bitmap 0x0042
  const PLAIN = listing({ ...KEY, hooks: zeroAddress, fee: 500, parameters: params(10, 0) });
  const TRAPPING = listing({ ...KEY, hooks: OTHER_HOOK, fee: 100, parameters: params(10, 1 << 4) });
  const OTHER_PAIR = listing({ ...KEY, currency1: "0x0000000000000000000000000000000000000c00" as Address, hooks: zeroAddress, parameters: params(10, 0) });
  const ELSEWHERE = listing({ ...KEY, poolManager: "0x00000000000000000000000000000000000d0d0d" as Address, hooks: zeroAddress, parameters: params(10, 0) });

  it("sizes the value to the announced fee when it is higher", () => {
    expect(vaultCreateSafeValue({ feeWei: 5n, pendingFee: { wei: 0n, effectiveAt: 0n } })).toBe(5n);
    expect(vaultCreateSafeValue({ feeWei: 5n, pendingFee: { wei: 9n, effectiveAt: 100n } })).toBe(9n);
    expect(vaultCreateSafeValue({ feeWei: 5n, pendingFee: { wei: 3n, effectiveAt: 100n } })).toBe(5n);
  });

  it("lists the pools a vault can be created on, each with its oracle pools, own pool first", () => {
    const out = vaultPoolChoices([PLAIN, ORACLE_POOL, TRAPPING, OTHER_PAIR, ELSEWHERE, listing(KEY, "Bin")], [{ hook: HOOK, minWindow: 1800 }], MANAGER);
    expect(out.map((c) => c.poolId)).toEqual([PLAIN.poolId, ORACLE_POOL.poolId]);
    expect(out[0]!.oracles).toEqual([{ key: KEY, poolId: ORACLE_POOL.poolId, minWindow: 1800, self: false }]);
    expect(out[1]!.oracles.map((o) => o.self)).toEqual([true]);
    expect(out[1]!.tickSpacing).toBe(10);
    // With no oracle hook checked, nothing qualifies: spot is never used.
    expect(vaultPoolChoices([PLAIN, ORACLE_POOL], [], MANAGER)).toEqual([]);
  });

  it("places the base range as the contract does", () => {
    expect(vaultBaseRange(105, 10, 1000)).toEqual({ lower: -900, upper: 1100 });
    expect(vaultBaseRange(-105, 10, 1000)).toEqual({ lower: -1110, upper: 890 });
    expect(vaultBaseRange(887_000, 60, 1200)).toEqual({ lower: 886_980 - 1200, upper: 887_220 });
    expect(vaultBaseRange(-887_000, 60, 1200)).toEqual({ lower: -887_220, upper: -887_040 + 1200 });
  });

  it("checks an oracle hook by its kind, and refuses what the vault refuses", async () => {
    const mk = (kind: unknown, code = "0x60") =>
      ({
        getCode: async () => code,
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "kind") {
            if (kind instanceof Error) throw kind;
            return kind;
          }
          if (functionName === "ORACLE_MIN_WINDOW_SECONDS") return 1800;
          throw new Error("unexpected " + functionName);
        },
      }) as unknown as PublicClient;
    expect(await readOracleHook(mk(ORACLE_KIND), HOOK)).toEqual({ hook: HOOK, minWindow: 1800 });
    expect(await readOracleHook(mk(keccak256(stringToBytes("other"))), HOOK)).toBeNull();
    expect(await readOracleHook(mk(ORACLE_KIND, "0x"), HOOK)).toBeNull();
    expect(await readOracleHook(mk(new ContractFunctionZeroDataError({ functionName: "kind" })), HOOK)).toBeNull();
    await expect(readOracleHook(mk(new Error("socket hang up")), HOOK)).rejects.toThrow("socket hang up");
  });

  it("reads the TWAP, or names the refusal", async () => {
    const ok = { readContract: async ({ args }: { args: unknown[] }) => (args[0] === poolKeyToId(KEY) && args[1] === 1800 ? [-42, 7] : null) } as unknown as PublicClient;
    expect(await readVaultTwap(ok, KEY, 1800)).toEqual({ ok: true, tick: -42, lastWriteAge: 7 });
    const errAbi = [{ type: "error", name: "HistoryTooShort", inputs: [] }] as const;
    const short = {
      readContract: async () => {
        throw new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: errAbi, functionName: "consult", data: encodeErrorResult({ abi: errAbi, errorName: "HistoryTooShort" }) }) });
      },
    } as unknown as PublicClient;
    expect(await readVaultTwap(short, KEY, 1800)).toEqual({ ok: false, reason: "HistoryTooShort" });
  });

  it("reads the factory's fees, cap and the oracle hooks that pass", async () => {
    const client = {
      getCode: async ({ address }: { address: Address }) => (address === HOOK ? "0x60" : "0x"),
      readContract: async ({ functionName }: { functionName: string }) =>
        ({ feeWei: 7n, performanceFeeBps: 700, pendingFee: [9n, 50n], pendingPerformanceFee: [0, 0n], maxPerformanceFeeBps: 2000, kind: ORACLE_KIND, ORACLE_MIN_WINDOW_SECONDS: 1800 })[functionName],
    } as unknown as PublicClient;
    const ctx = await readVaultCreateContext(client, FACTORY, [HOOK, HOOK, OTHER_HOOK]);
    expect(ctx.oracleHooks).toEqual([{ hook: HOOK, minWindow: 1800 }]);
    expect(ctx.maxPerformanceFeeBps).toBe(2000);
    expect(vaultCreateSafeValue(ctx.fees)).toBe(9n);
  });

  it("finds the created vault in a receipt's logs", () => {
    const event = VAULT_FACTORY_ABI.find((i) => i.type === "event" && i.name === "VaultCreated")!;
    const topics = encodeEventTopics({ abi: [event], eventName: "VaultCreated", args: { vault: VAULT, poolId: poolKeyToId(KEY), curator: ALICE } } as never);
    const data = encodeAbiParameters([{ type: "uint16" }, { type: "uint256" }], [700, 7n]);
    expect(decodeVaultCreated([{ address: FACTORY, topics: topics as never, data }], FACTORY)).toBe(getAddress(VAULT));
    expect(decodeVaultCreated([{ address: VAULT, topics: topics as never, data }], FACTORY)).toBeNull();
  });

  it("restates the oracle's interface", () => {
    expect(ORACLE_HOOK_ABI.map((i) => i.name)).toEqual(["kind", "ORACLE_MIN_WINDOW_SECONDS", "consult"]);
  });
});

describe("ABI parity", () => {
  const art = (n: string) => join(HERE, `../../vaults/foundry-out/${n}.sol/${n}.json`);
  const strip = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(strip) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "internalType").map(([k, v]) => [k, strip(v)])) : x;
  it.skipIf(!existsSync(art("GullyCoreManagedVault")))("matches the compiled artifacts", () => {
    const v = strip(JSON.parse(readFileSync(art("GullyCoreManagedVault"), "utf8")).abi.filter((i: { type: string }) => i.type !== "constructor"));
    const f = strip(JSON.parse(readFileSync(art("GullyCoreVaultFactory"), "utf8")).abi.filter((i: { type: string }) => i.type !== "constructor"));
    expect(MANAGED_VAULT_ABI).toEqual(v);
    expect(VAULT_FACTORY_ABI).toEqual(f);
  });
});
