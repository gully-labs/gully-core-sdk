import { encodeFunctionResult, decodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  BUILDER_FEE_ABI,
  FEE_TERMS,
  KIT_TENANT_TERMS_ABI,
  LAUNCHPAD_KIT_V2_RULES_ABI,
  chainTermsSentence,
  feeTermsTable,
  gullyTakePips,
  readChainFeeTerms,
  termsChargedToOutsideLaunchpads,
} from "../src/index.js";

/* What Gully takes from a launch, by whose Launchpad it was made on (src/fees/terms.ts): the rule in both
   cases, and the reading of which case a chain can actually charge. The chain is a scripted client: each
   scenario below is a kit of one release, not a read of any deployment. */

const KIT = "0x00000000000000000000000000000000000000a1" as Address;
const CONTROLLER = "0x00000000000000000000000000000000000000a2" as Address;
const PAD = "0x00000000000000000000000000000000000000a3" as Address;

class Revert extends Error {
  override name = "ContractFunctionExecutionError";
  override cause = { name: "ContractFunctionRevertedError", data: undefined };
  constructor() {
    super("execution reverted");
  }
}

/** A kit of `release` and a fee controller that answers `builderFee()` only when `builderFee` is given. */
function chain(opts: { release: 1 | 2 | 3; designated?: boolean; optedIn?: boolean; builderFee?: number; launchFeeWei?: bigint }): PublicClient {
  const ABI = [...LAUNCHPAD_KIT_V2_RULES_ABI, ...KIT_TENANT_TERMS_ABI, ...BUILDER_FEE_ABI];
  return {
    readContract: async ({ address, abi, functionName, args }: { address: Address; abi: typeof ABI; functionName: string; args?: readonly unknown[] }) => {
      void abi;
      void args;
      if (address === CONTROLLER) {
        if (functionName === "builderFee" && opts.builderFee !== undefined) return opts.builderFee;
        throw new Revert();
      }
      if (address !== KIT) throw new Revert();
      if (functionName === "launchFeeWei") return opts.launchFeeWei ?? 900_000_000_000_000n;
      if (functionName === "gullyDesignated") {
        if (opts.release < 3) throw new Revert();
        return opts.designated ?? false;
      }
      if (opts.release === 1) throw new Revert();
      if (functionName === "tenantConfig") return { allowedPresets: 1, allowedBinShapes: 0, gullyTerms: opts.optedIn === true };
      if (functionName === "MIN_TRADE_FEE_PIPS") return 10_000;
      if (functionName === "PROTOCOL_TRADE_SHARE_BPS") return 5_000;
      if (functionName === "LAUNCH_TOTAL_SUPPLY") return 10n ** 27n;
      throw new Revert();
    },
  } as unknown as PublicClient;
}

describe("the rule: two cases", () => {
  it("Gully terms: half of the 1% trade fee, 10% of the tax, the launch fee, no core fee", () => {
    expect(FEE_TERMS.gully).toEqual({ kind: "gully", protocolTradeShareBps: 5_000, taxProtocolBps: 1_000, coreProtocolFeePips: 0, gullyLaunchFee: true });
  });

  it("outside terms: a flat 0.30% of every trade and nothing else", () => {
    expect(FEE_TERMS.outside).toEqual({ kind: "outside", protocolTradeShareBps: 0, taxProtocolBps: 0, coreProtocolFeePips: 3_000, gullyLaunchFee: false });
  });

  it("what Gully takes from one trade, in pips of the trade", () => {
    /* 1% total (no tax): Gully terms 0.50%, outside 0.30%. */
    expect(gullyTakePips("gully", 100)).toBe(5_000);
    expect(gullyTakePips("outside", 100)).toBe(3_000);
    /* 3% total (2% tax): Gully terms 0.50% + 0.20% = 0.70% (worked example); outside still 0.30%. */
    expect(gullyTakePips("gully", 300)).toBe(7_000);
    expect(gullyTakePips("outside", 300)).toBe(3_000);
    /* 11% total (10% tax): 0.50% + 1.00%; outside does not move. */
    expect(gullyTakePips("gully", 1_100)).toBe(15_000);
    expect(gullyTakePips("outside", 1_100)).toBe(3_000);
  });

  it("the table names every thing Gully does or does not take, and the two things that hold for both", () => {
    const rows = feeTermsTable();
    expect(rows.map((r) => r.key)).toEqual(["trade-fee", "creator-tax", "core-fee", "launch-fee", "floor", "supply"]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by["trade-fee"]).toMatchObject({ gully: "50% of it (0.50% of every trade)", outside: "None" });
    expect(by["creator-tax"]).toMatchObject({ gully: "10% of the tax", outside: "None" });
    expect(by["core-fee"]).toMatchObject({ gully: "None", outside: "0.30% of every trade" });
    expect(by["launch-fee"]).toMatchObject({ gully: "Charged once per launch", outside: "None" });
    expect(by["floor"]!.gully).toBe(by["floor"]!.outside);
    expect(by["supply"]!.gully).toBe(by["supply"]!.outside);
    /* The copy a user reads says Launchpad, never Pad. */
    for (const r of rows) expect(`${r.label} ${r.gully} ${r.outside}`).not.toMatch(/\bPads?\b/);
  });
});

describe("the chain: which case it can charge today", () => {
  it("release 2 (Gully Chain Testnet today): one set of terms, so an outside Launchpad's launches are charged the Gully terms, and the sentence says so", async () => {
    const t = await readChainFeeTerms(chain({ release: 2 }), { kit: KIT, protocolFeeController: CONTROLLER, tenant: PAD });
    expect(t).toMatchObject({ release: 2, perTenantTerms: false, tenantDesignated: null, builderFeePips: null, launchFeeWei: 900_000_000_000_000n });
    expect(t.rules).toEqual({ minTradeFeePips: 10_000, protocolTradeShareBps: 5_000, launchTotalSupply: 10n ** 27n });
    expect(termsChargedToOutsideLaunchpads(t)).toBe("gully");
    const s = chainTermsSentence(t, "Gully Chain Testnet");
    expect(s).toContain("release 2");
    expect(s).toContain("50% of the 1.00% trade fee");
    expect(s).toContain("whoever's Launchpad it is made on");
    expect(s).toContain("starts with release 3");
  });

  it("release 3 with fee controller V5: outside terms are on chain, and the builder fee is the controller's own number", async () => {
    const t = await readChainFeeTerms(chain({ release: 3, builderFee: 3_000 }), { kit: KIT, protocolFeeController: CONTROLLER, tenant: PAD });
    expect(t).toMatchObject({ release: 3, perTenantTerms: true, tenantDesignated: false, builderFeePips: 3_000 });
    expect(termsChargedToOutsideLaunchpads(t)).toBe("outside");
    expect(chainTermsSentence(t, "Gully Chain")).toContain("pays Gully 0.30% of every trade and nothing else");
  });

  it("release 3: a Launchpad the Safe designated reads as designated; no Launchpad asked about reads null", async () => {
    expect((await readChainFeeTerms(chain({ release: 3, designated: true, builderFee: 3_000 }), { kit: KIT, protocolFeeController: CONTROLLER, tenant: PAD })).tenantDesignated).toBe(true);
    expect((await readChainFeeTerms(chain({ release: 3, designated: true, builderFee: 3_000 }), { kit: KIT, protocolFeeController: CONTROLLER })).tenantDesignated).toBeNull();
  });

  it("a release 3 chain whose controller is lowered reads the lowered fee, never the default", async () => {
    const t = await readChainFeeTerms(chain({ release: 3, builderFee: 1_500 }), { kit: KIT, protocolFeeController: CONTROLLER });
    expect(t.builderFeePips).toBe(1_500);
    expect(chainTermsSentence(t, "Anubis")).toContain("0.15% of every trade");
  });

  it("release 1: no release 2 constants, no per-Launchpad terms", async () => {
    const t = await readChainFeeTerms(chain({ release: 1 }), { kit: KIT });
    expect(t).toMatchObject({ release: 1, rules: null, perTenantTerms: false, builderFeePips: null });
  });

  it("a transport failure is thrown, never read as 'release 1'", async () => {
    const broken = { readContract: async () => { throw new Error("socket hang up"); } } as unknown as PublicClient;
    await expect(readChainFeeTerms(broken, { kit: KIT })).rejects.toThrow(/socket hang up/);
  });

  it("the hand-written getters encode and decode (selectors are the solc ones for these signatures)", () => {
    const data = encodeFunctionResult({ abi: BUILDER_FEE_ABI, functionName: "builderFee", result: 3_000 });
    expect(BigInt(data as Hex)).toBe(3_000n);
    expect(() => decodeFunctionData({ abi: KIT_TENANT_TERMS_ABI, data: "0x00000000" })).toThrow();
  });
});
