// SPDX-License-Identifier: MIT
/* The address book against the deployment records in packages/sdk/records.

   Anubis is GENERATED from its record, so the check is that the generated file is current and holds
   nothing the record does not. Gully Chain Testnet is written by hand (it carries the retired kit
   generations), so each field is compared with its record. */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHAIN_6714 } from "../src/deployments/generated/chain6714.js";
import { GULLYCORE_DEPLOYMENTS, assertNativeValue, defaultQuote, multicall3For, nativeValueAllowed, requireDeployment } from "../src/deployments/index.js";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DeploymentRecord {
  readonly chainId: number;
  readonly launchRelease: number;
  readonly reused: Readonly<Record<string, string | null>>;
  readonly contracts: Readonly<Record<string, { readonly address: string }>>;
}

const record = (id: number): DeploymentRecord => JSON.parse(readFileSync(join(sdkRoot, "records", `gully-core-${id}.json`), "utf8")) as DeploymentRecord;

const addressesIn = (value: unknown): string[] => {
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/.test(value) ? [value] : [];
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(addressesIn);
  return [];
};

/* Book path -> record contract, for every contract both chains' records name. */
const PAIRS: readonly (readonly [string, string])[] = [
  ["vault", "vault"], ["clPoolManager", "clPoolManager"], ["binPoolManager", "binPoolManager"],
  ["clPoolManagerOwner", "clPoolManagerOwner"], ["binPoolManagerOwner", "binPoolManagerOwner"],
  ["feeController", "feeControllerV5"], ["governanceSafe", "governanceSafe"], ["registry", "registry"],
  ["launchRegistry", "launchRegistry"], ["universalRouter", "universalRouter"], ["fillRouter", "fillRouter"],
  ["clPositionManager", "clPositionManager"], ["binPositionManager", "binPositionManager"], ["clQuoter", "clQuoter"],
  ["binQuoter", "binQuoter"], ["clPositionDescriptor", "clPositionDescriptor"], ["revShareHook", "revShareHook"],
  ["launchAndBuy", "launchAndBuy"], ["dynamicFeeHook", "dynamicFeeHook"], ["binDynamicFeeHook", "binDynamicFeeHook"],
  ["splitFactory", "splitFactory"], ["positionLock", "positionLock"], ["tokenLock", "tokenLock"], ["multisend", "multisend"],
  ["dropFactory", "dropFactory"], ["rangeOrders", "rangeOrders"], ["dca", "dca"], ["lpRewardsHook", "liquidityRewardsHook"],
  ["oracleHook", "oracleHook"], ["dexHook", "dexHook"], ["tunerGate", "tunerGate"], ["vaultFactory", "vaultFactory"],
  ["launchpadV2.launchpadKitV2", "launchpadKitV2"], ["launchpadV2.launchLegs", "launchLegs"],
  ["launchpadV2.launchTokenFactory", "launchTokenFactory"], ["launchpadV2.clLPLocker", "lpLocker"],
  ["launchpadV2.binLPLocker", "binLpLocker"], ["launchpadV2.clLaunchGuardHook", "launchGuardHook"],
  ["launchpadV2.binLaunchGuardHook", "binLaunchGuardHook"], ["launchpadV2.padFactory", "padFactory"],
];

const at = (book: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], book);

describe("the address book and the deployment records", () => {
  it("generated files are what the records give", () => {
    expect(() => execFileSync(process.execPath, [join(sdkRoot, "scripts", "generate-deployments.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  for (const id of [6714, 485590] as const) {
    it(`${id}: every contract equals its record`, () => {
      const r = record(id);
      expect(r.chainId).toBe(id);
      expect(r.launchRelease).toBe(3);
      for (const [path, name] of PAIRS) {
        expect(at(GULLYCORE_DEPLOYMENTS[id], path), path).toBe(r.contracts[name]?.address);
      }
      expect(GULLYCORE_DEPLOYMENTS[id].permit2).toBe(r.reused["permit2"]);
      expect(GULLYCORE_DEPLOYMENTS[id].create3Factory).toBe(r.reused["createX"]);
      expect(GULLYCORE_DEPLOYMENTS[id].weth).toBe(r.reused["weth9"]);
    });
  }

  it("6714: the generated entry holds no contract the record does not name", () => {
    const r = record(6714);
    const known = new Set([...Object.values(r.contracts).map((c) => c.address), ...Object.values(r.reused)]);
    const { tokens, quoteToken, safe, ...rest } = CHAIN_6714;
    expect(addressesIn(rest).filter((a) => !known.has(a))).toEqual([]);
    expect(quoteToken).toBe(tokens[0].address);
    expect(safe.l2Singleton).toBe(r.reused["safeL2Singleton"]);
    expect(safe.proxyFactory).toBe(r.reused["safeProxyFactory"]);
  });
});

describe("a chain whose native coin pays gas only", () => {
  const anubis = requireDeployment(6714);
  const testnet = requireDeployment(485590);

  it("says so", () => {
    expect(nativeValueAllowed(anubis)).toBe(false);
    expect(nativeValueAllowed(testnet)).toBe(true);
  });

  it("quotes in DAI, 18 decimals, and defaults to native elsewhere", () => {
    expect(defaultQuote(anubis)).toEqual({ address: CHAIN_6714.quoteToken, symbol: "DAI", decimals: 18 });
    expect(defaultQuote(testnet)).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 });
  });

  it("refuses a value before a wallet opens, and lets a zero value through", () => {
    expect(() => assertNativeValue(anubis, 1n)).toThrow(/gas only/);
    expect(() => assertNativeValue(anubis, 0n)).not.toThrow();
    expect(() => assertNativeValue(testnet, 1n)).not.toThrow();
  });

  it("uses the deployment record's Multicall3 on Anubis, the canonical one elsewhere", () => {
    expect(multicall3For(6714)).toBe(record(6714).contracts["multicall3"]?.address);
    expect(multicall3For(485590)).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
  });
});

describe("the README quickstart", () => {
  const samples = resolve(sdkRoot, "..", "..", "apps", "web", "src", "routes", "docs", "samples");
  const readme = readFileSync(join(sdkRoot, "README.md"), "utf8");

  /* The compiled samples are in the Gully Core app (monorepo only); the public mirror skips this one. */
  it.skipIf(!existsSync(samples))("is the compiled sample, line for line", () => {
    for (const file of ["quickstart.ts", "integrate-swap.tsx"]) {
      const lines = readFileSync(join(samples, file), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trimEnd().endsWith("// @docs-hide"));
      for (const line of lines) expect(readme, `${file}: ${line}`).toContain(line);
    }
  });

  it("claims only the chains in the book", () => {
    expect(readme).not.toMatch(/Live on [^.]*HyperEVM/);
    for (const name of ["Robinhood Chain", "Base", "BNB Chain", "Kinetiq Elysium"]) expect(readme).toContain(name);
    expect(readme).toContain("Anubis");
    expect(readme).toContain("Gully Chain Testnet");
  });
});
