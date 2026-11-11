// SPDX-License-Identifier: MIT
/* ============================================================================
   Guards on the Safe address tables: v1.4.1 (the batch-target set) and v1.5.0
   (what the governance Safe of record runs).

   Offline: each table is well-formed, every Gully Core chain carries both, and the
   per-chain records are the one canonical deployment (deterministic CREATE2
   addresses; a chain where they differ would be a chain with a non-canonical
   deployment, which is a fact to record, not a value to guess).

   Live, only when an RPC answers within a short budget: every address has code
   (`eth_getCode`), which is the claim the table actually makes. Skipped, not
   failed, when the network is unreachable — an offline CI run must not turn a
   network outage into a red address book.
   ============================================================================ */

import { describe, expect, it } from "vitest";
import { createPublicClient, hashTypedData, http, keccak256, type Hex } from "viem";

import { resolveEndpoints } from "../src/chains/endpoints.js";
import {
  GULLYCORE_CHAIN_IDS,
  GULLYCORE_DEPLOYMENTS,
  SAFE_CONTRACTS,
  SAFE_CONTRACTS_1_5_0,
  SAFE_CONTRACT_1_5_0_CHAIN_IDS,
  SAFE_CONTRACT_CHAIN_IDS,
  SAFE_TX_TYPES,
  SAFE_VERSIONS,
  GOVERNANCE_SAFE_VERSION,
  governanceSafeContracts,
  publishedMultiSendCallOnly,
  requireSafeContracts,
  safeContractsFor,
  safeContractsForVersion,
  type GullyCoreDeployment,
  type SafeContracts,
} from "../src/deployments/index.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_KEYS = ["singleton", "l2Singleton", "proxyFactory", "multiSend", "multiSendCallOnly", "fallbackHandler", "signMessageLib", "createCall", "simulateTxAccessor"] as const;

describe("SAFE_CONTRACTS", () => {
  it("covers the chains whose canonical deployment was read, and every Gully Core chain", () => {
    expect([...SAFE_CONTRACT_CHAIN_IDS].sort((a, b) => a - b)).toEqual([56, 999, 4663, 6714, 8453, 84532, 99901, 485590, 11155111]);
    const book: Readonly<Record<number, GullyCoreDeployment>> = GULLYCORE_DEPLOYMENTS;
    for (const chainId of GULLYCORE_CHAIN_IDS as readonly number[]) {
      expect(safeContractsFor(chainId), `chain ${chainId}`).toBeDefined();
      expect(book[chainId]!.safe).toBe(SAFE_CONTRACTS[chainId]);
    }
  });

  it("refuses a chain it has not verified", () => {
    expect(safeContractsFor(1)).toBeUndefined();
    expect(() => requireSafeContracts(1)).toThrow(/eth_getCode/);
  });

  for (const chainId of SAFE_CONTRACT_CHAIN_IDS) {
    it(`chain ${chainId}: nine distinct, well-formed, non-zero addresses at version 1.4.1`, () => {
      const c = SAFE_CONTRACTS[chainId]!;
      expect(c.version).toBe("1.4.1");
      const seen = new Set<string>();
      for (const k of ADDRESS_KEYS) {
        expect(c[k], k).toMatch(ADDRESS_RE);
        expect(c[k].toLowerCase(), `${k} is the zero address`).not.toBe(`0x${"0".repeat(40)}`);
        expect(seen.has(c[k].toLowerCase()), `${k} repeats another entry`).toBe(false);
        seen.add(c[k].toLowerCase());
      }
    });
  }

  it("records the canonical v1.4.1 MultiSendCallOnly", () => {
    // @safe-global/safe-deployments v1.4.1 multi_send_call_only, canonical address.
    expect(SAFE_CONTRACTS[4663]!.multiSendCallOnly).toBe("0x9641d764fc13c8B624c04430C7356C1C7C8102e2");
  });
});

describe("SAFE_CONTRACTS_1_5_0 (what the governance Safe of record runs)", () => {
  const wellFormed = (c: SafeContracts) => {
    const seen = new Set<string>();
    for (const k of ADDRESS_KEYS) {
      expect(c[k], k).toMatch(ADDRESS_RE);
      expect(c[k].toLowerCase(), `${k} is the zero address`).not.toBe(`0x${"0".repeat(40)}`);
      expect(seen.has(c[k].toLowerCase()), `${k} repeats another entry`).toBe(false);
      seen.add(c[k].toLowerCase());
    }
  };

  it("covers the four deployed chains and Base Sepolia (read 2026-10-15), and no chain whose 1.5.0 set was not read", () => {
    expect([...SAFE_CONTRACT_1_5_0_CHAIN_IDS].sort((a, b) => a - b)).toEqual([56, 999, 4663, 8453, 84532]);
    expect(SAFE_CONTRACTS_1_5_0[11155111]).toBeUndefined();
    expect(SAFE_VERSIONS).toEqual(["1.4.1", "1.5.0"]);
  });

  for (const chainId of SAFE_CONTRACT_1_5_0_CHAIN_IDS) {
    it(`chain ${chainId}: nine distinct, well-formed addresses at version 1.5.0, none shared with 1.4.1`, () => {
      const c = SAFE_CONTRACTS_1_5_0[chainId]!;
      expect(c.version).toBe("1.5.0");
      wellFormed(c);
      const old = SAFE_CONTRACTS[chainId]!;
      for (const k of ADDRESS_KEYS) expect(c[k].toLowerCase(), `${k} equals the 1.4.1 address`).not.toBe(old[k].toLowerCase());
    });
  }

  it("records the singleton and fallback handler the governance Safe points at (read on chain 2026-10-11)", () => {
    // apps/admin/src/lib/safeContracts.ts: proxy slot 0 and the FallbackManager slot of 0xeEd9…8c8B on 999 / 56 / 4663 / 8453.
    expect(SAFE_CONTRACTS_1_5_0[999]!.l2Singleton).toBe("0xEdd160fEBBD92E350D4D398fb636302fccd67C7e");
    expect(SAFE_CONTRACTS_1_5_0[999]!.fallbackHandler).toBe("0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4");
    // @safe-global/safe-deployments v1.5.0 multi_send_call_only, canonical address (code read on all four chains, 421 bytes).
    expect(SAFE_CONTRACTS_1_5_0[999]!.multiSendCallOnly).toBe("0xA83c336B20401Af773B6219BA5027174338D1836");
  });

  it("safeContractsForVersion answers by the proxy's own VERSION() and nothing else", () => {
    expect(safeContractsForVersion(999, "1.4.1")).toBe(SAFE_CONTRACTS[999]);
    expect(safeContractsForVersion(999, "1.5.0")).toBe(SAFE_CONTRACTS_1_5_0[999]);
    expect(safeContractsForVersion(11155111, "1.5.0")).toBeUndefined();
    expect(safeContractsForVersion(999, "1.3.0")).toBeUndefined();
    expect(safeContractsForVersion(1, "1.4.1")).toBeUndefined();
  });

  it("the batch target stays the v1.4.1 library, and the published set names both libraries", () => {
    // buildSafeTx is given GullyCoreDeployment.safe.multiSendCallOnly (the admin room verifies the same address): never moved alone.
    const book: Readonly<Record<number, GullyCoreDeployment>> = GULLYCORE_DEPLOYMENTS;
    for (const chainId of GULLYCORE_CHAIN_IDS as readonly number[]) {
      expect(book[chainId]!.safe.version).toBe("1.4.1");
      expect(publishedMultiSendCallOnly(chainId)[0]).toBe(book[chainId]!.safe.multiSendCallOnly);
      // Gully Chain Testnet and Anubis publish the v1.4.1 set only; Robinhood, Base and BNB publish Safe's v1.5.0 set
      // too, and the batch target is still the deployment record's v1.4.1 library (first in the list).
      const v150 = SAFE_CONTRACTS_1_5_0[chainId];
      expect(publishedMultiSendCallOnly(chainId)).toEqual(v150 === undefined ? [SAFE_CONTRACTS[chainId]!.multiSendCallOnly] : [SAFE_CONTRACTS[chainId]!.multiSendCallOnly, v150.multiSendCallOnly]);
    }
    expect(publishedMultiSendCallOnly(8453)).toEqual([SAFE_CONTRACTS[8453]!.multiSendCallOnly, SAFE_CONTRACTS_1_5_0[8453]!.multiSendCallOnly]);
    expect(publishedMultiSendCallOnly(11155111)).toEqual([SAFE_CONTRACTS[11155111]!.multiSendCallOnly]);
    expect(publishedMultiSendCallOnly(1)).toEqual([]);
  });
});

describe("governance Safe vs batch target", () => {
  it("the governance Safe of record is v1.4.1, and every Gully Core chain carries that set", () => {
    expect(GOVERNANCE_SAFE_VERSION).toBe("1.4.1");
    expect(SAFE_VERSIONS).toContain(GOVERNANCE_SAFE_VERSION);
    for (const chainId of GULLYCORE_CHAIN_IDS as readonly number[]) {
      const g = governanceSafeContracts(chainId);
      expect(g, `chain ${chainId}`).toBe(SAFE_CONTRACTS[chainId]);
      expect(g!.version).toBe("1.4.1");
    }
    // What the testnet proxy 0xC552…b240 points at (storage slot 0, read on chain 2026-11-05).
    expect(governanceSafeContracts(485590)!.l2Singleton).toBe("0x76667330c237Fb40f28d74563cdAAae4b06C23Ec");
    expect(governanceSafeContracts(485590)!.fallbackHandler).toBe("0xcB4a8d3609A7CCa2D9c063a742f75c899BF2f7b5");
    // Anubis reached the canonical set through the Safe singleton factory (deployment record, `reused`).
    expect(governanceSafeContracts(6714)!.l2Singleton).toBe("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");
  });

  it("governanceSafeContracts is undefined where the governance version's set was not read", () => {
    expect(governanceSafeContracts(1)).toBeUndefined();
  });

  it("the deployment record's `safe` block is the batch target; on Gully Chain it is also the set the Safe runs (one version)", () => {
    const book: Readonly<Record<number, GullyCoreDeployment>> = GULLYCORE_DEPLOYMENTS;
    for (const chainId of GULLYCORE_CHAIN_IDS as readonly number[]) {
      expect(book[chainId]!.safe).toBe(governanceSafeContracts(chainId));
      expect(publishedMultiSendCallOnly(chainId)).toContain(governanceSafeContracts(chainId)!.multiSendCallOnly);
    }
  });

  it("requireSafeContracts names the batch target, not 'the Safe version', when a chain is missing", () => {
    expect(() => requireSafeContracts(1)).toThrow(/batch-target/);
  });
});

describe("SAFE_TX_TYPES", () => {
  it("hashes the v1.4.1 SafeTx struct: keccak of the canonical type string", () => {
    // SAFE_TX_TYPEHASH in Safe.sol 1.4.1.
    const typeString = `SafeTx(${SAFE_TX_TYPES.SafeTx.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(keccak256(new TextEncoder().encode(typeString) as unknown as Hex)).toBe("0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8");
  });

  it("produces a hash that differs when chain, safe or nonce differ (the binding the room relies on)", () => {
    const base = { to: "0x00000000000000000000000000000000000dc0de", value: 0n, data: "0x2b6dcd2100000000000000000000000000000000000000000000000000000000000dc0d1", operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: `0x${"0".repeat(40)}`, refundReceiver: `0x${"0".repeat(40)}`, nonce: 8n } as const;
    const h = (chainId: number, safe: `0x${string}`, nonce: bigint) =>
      hashTypedData({ domain: { chainId, verifyingContract: safe }, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: { ...base, nonce } });
    const safe = "0x00000000000000000000000000000000000dc0d0";
    const a = h(999, safe, 8n);
    expect(a).not.toBe(h(998, safe, 8n));
    expect(a).not.toBe(h(999, "0x0000000000000000000000000000000000000001", 8n));
    expect(a).not.toBe(h(999, safe, 9n));
    expect(a).toBe(h(999, safe, 8n));
  });
});

/* ---------------------------------------------------------------------------
   Live: code at every address, when a chain answers. Read-only.
   --------------------------------------------------------------------------- */

/** Every endpoint for the chain, as clients, in the order the SDK ranks them. */
function clientsFor(chainId: number): ReturnType<typeof createPublicClient>[] {
  return resolveEndpoints(chainId, process.env)
    .slice(0, 3)
    .map((url) => createPublicClient({ transport: http(url, { timeout: 4_000, retryCount: 0 }) }));
}

describe.each([
  ["v1.4.1", SAFE_CONTRACT_CHAIN_IDS, SAFE_CONTRACTS],
  ["v1.5.0", SAFE_CONTRACT_1_5_0_CHAIN_IDS, SAFE_CONTRACTS_1_5_0],
] as const)("live: the canonical %s contracts have code on each listed chain", (_version, chainIds, table) => {
  for (const chainId of chainIds) {
    it(`chain ${chainId} (skipped when no RPC answers)`, async (ctx) => {
      /* AN ENDPOINT THAT ANSWERS ONCE AND THEN REFUSES IS STILL AN ENDPOINT THAT DID
         NOT ANSWER. This used to pick the first client whose `getChainId` succeeded and
         then read every address through it; a 429 on the second call threw, and the test
         reported a FAILURE with a name that promises a SKIP: the suite went red because of
         a rate limit, not because a Safe contract was missing, which is the least useful
         way for a live test to fail.

         Now each endpoint gets the WHOLE read set. A transport error anywhere in it moves
         to the next endpoint; only a complete set of successful reads is judged, and only
         a genuine absence of code fails. If every endpoint refuses, the test skips, which
         is what its name has always said it would do. */
      const c = table[chainId]!;
      for (const client of clientsFor(chainId)) {
        let codes: (string | undefined)[];
        try {
          const id = await client.getChainId();
          if (id !== chainId) continue;
          codes = await Promise.all(ADDRESS_KEYS.map((k) => client.getCode({ address: c[k] })));
        } catch {
          continue; // unreachable, rate-limited, or mid-read: try the next endpoint
        }
        ADDRESS_KEYS.forEach((k, i) => {
          const code = codes[i];
          expect(code && code !== "0x", `${k} at ${c[k]} has no code on ${chainId}`).toBe(true);
        });
        return;
      }
      ctx.skip();
    }, 60_000);
  }
});
