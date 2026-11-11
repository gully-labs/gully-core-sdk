// SPDX-License-Identifier: MIT
/* Release 3 (per-tenant terms) as the SDK reads it: what a launch pays and restates, and retired kits staying readable. */
import { encodeFunctionResult, type Address, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { readChainFeeTerms } from "../src/fees/terms.js";
import { decodeTenantConfig, readLaunchValue, readTenantConfig, RETIRED_KIT_TENANT_ABI } from "../src/launchpad/kitV2/fees.js";
import { encodeCreatePad, tenantConfigFromTerms, type PadTerms } from "../src/launchpad/kitV2/pads.js";

const KIT = "0x00000000000000000000000000000000000000a1" as Address;
const PAD = "0x00000000000000000000000000000000000000b2" as Address;
const WALLET = "0x00000000000000000000000000000000000000c3" as Address;

const STORED = {
  integrator: WALLET,
  integratorBps: 2000,
  integratorLaunchFeeWei: 5n,
  allowedPresets: 15,
  allowedBinShapes: 31,
  restrictQuotes: false,
  active: true,
  maxTaxBps: 500,
  taxIntegratorBps: 1000,
};

/** A kit as `readContract` sees it. `release` decides which getters exist. */
function kit(opts: { release: 2 | 3; designated?: boolean; gullyTerms?: boolean; launchFeeWei?: bigint }): PublicClient {
  const revert = () => Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
  const readContract = async ({ functionName, abi }: { functionName: string; abi: readonly { name?: string; outputs?: readonly { components?: readonly unknown[] }[] }[] }) => {
    switch (functionName) {
      case "launchFeeWei":
        return opts.launchFeeWei ?? 7n;
      case "pendingLaunchFee":
        return [0n, 0n];
      case "gullyDesignated":
        if (opts.release === 2) throw revert();
        return opts.designated === true;
      case "tenantConfig": {
        const wide = (abi.find((e) => e.name === "tenantConfig")?.outputs?.[0]?.components?.length ?? 0) === 10;
        if (opts.release === 2 && wide) throw new Error("AbiDecodingDataSizeTooSmallError");
        return opts.release === 3 ? { ...STORED, gullyTerms: opts.gullyTerms === true } : STORED;
      }
      case "MIN_TRADE_FEE_PIPS":
        return 10_000;
      case "PROTOCOL_TRADE_SHARE_BPS":
        return 5_000;
      case "LAUNCH_TOTAL_SUPPLY":
        return 10n ** 27n;
      default:
        throw revert();
    }
  };
  return { readContract } as unknown as PublicClient;
}

describe("a launch on a release 3 kit", () => {
  it("an outside Launchpad pays no Gully launch fee, only its own", async () => {
    const q = await readLaunchValue(kit({ release: 3 }), KIT, { tenant: PAD });
    expect(q.terms).toBe("outside");
    expect(q.launchFeeWei).toBe(0n);
    expect(q.integratorFeeWei).toBe(5n);
    expect(q.safeValue).toBe(5n);
  });

  it("a launch with no Launchpad pays nothing to Gully", async () => {
    const q = await readLaunchValue(kit({ release: 3 }), KIT);
    expect(q.terms).toBe("outside");
    expect(q.safeValue).toBe(0n);
  });

  it("takes both keys for Gully terms: designation alone or an opt-in alone stays outside", async () => {
    expect((await readLaunchValue(kit({ release: 3, designated: true }), KIT, { tenant: PAD })).terms).toBe("outside");
    expect((await readLaunchValue(kit({ release: 3, gullyTerms: true }), KIT, { tenant: PAD })).terms).toBe("outside");
    const both = await readLaunchValue(kit({ release: 3, designated: true, gullyTerms: true }), KIT, { tenant: PAD });
    expect(both.terms).toBe("gully");
    expect(both.launchFeeWei).toBe(7n);
    expect(both.safeValue).toBe(12n);
  });
});

describe("a retired kit stays readable", () => {
  it("reads the nine-field struct of a release 2 kit, with no Gully terms", async () => {
    const t = await readTenantConfig(kit({ release: 2 }), KIT, PAD);
    expect(t.integratorBps).toBe(2000);
    expect(t.gullyTerms).toBe(false);
  });

  it("a release 2 kit has one set of terms and charges its launch fee", async () => {
    const q = await readLaunchValue(kit({ release: 2 }), KIT, { tenant: PAD });
    expect(q.terms).toBeNull();
    expect(q.launchFeeWei).toBe(7n);
  });

  it("the nine-field ABI reads the leading fields of a release 3 answer", async () => {
    const { decodeFunctionResult } = await import("viem");
    const nine = encodeFunctionResult({ abi: RETIRED_KIT_TENANT_ABI, functionName: "tenantConfig", result: STORED });
    const ten = (nine + "1".padStart(64, "0")) as `0x${string}`;
    const read = decodeFunctionResult({ abi: RETIRED_KIT_TENANT_ABI, functionName: "tenantConfig", data: ten });
    expect(read.taxIntegratorBps).toBe(1000);
  });
});

describe("readChainFeeTerms", () => {
  const args = { kit: KIT, tenant: PAD };
  it("reads Gully terms as two keys", async () => {
    expect((await readChainFeeTerms(kit({ release: 3 }), args)).tenantOnGullyTerms).toBe(false);
    expect((await readChainFeeTerms(kit({ release: 3, designated: true }), args)).tenantOnGullyTerms).toBe(false);
    expect((await readChainFeeTerms(kit({ release: 3, designated: true, gullyTerms: true }), args)).tenantOnGullyTerms).toBe(true);
  });
  it("has no such answer on release 2", async () => {
    expect((await readChainFeeTerms(kit({ release: 2 }), args)).tenantOnGullyTerms).toBeNull();
  });
});

describe("the struct a new pad writes", () => {
  const terms: PadTerms = { integrator: WALLET, integratorBps: 2000, integratorLaunchFeeWei: 0n, allowedPresets: [], allowedBinShapes: [], restrictQuotes: false, active: true };
  it("is off Gully terms by default: an outside builder never opts in by accident", () => {
    expect(tenantConfigFromTerms(terms).gullyTerms).toBe(false);
    expect(encodeCreatePad({ name: "Gully Demo Launchpad", brand: null, terms })).toMatch(/^0x/);
  });
  it("decodes a release 2 row with no flag as off", () => {
    expect(decodeTenantConfig(STORED).gullyTerms).toBe(false);
  });
});
