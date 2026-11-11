// SPDX-License-Identifier: MIT
/* ============================================================================
   Guards on the address book.

   An address table cannot be unit-tested for correctness — only the chain knows
   whether an address is really the Vault, and `npm run gullycore:verify` in the scaffolded app
   is what asks it. What CAN be tested is the class of mistake that a human
   editing this file will actually make, and each of those is cheap to catch:

     * a zero-address placeholder sneaking in, which is the one thing the whole
       null-not-zero design exists to prevent;
     * a mistyped or truncated address, which reads as plausible;
     * the same address pasted into two fields, which is how a quoter ends up
       being called as a pool manager;
     * a token listed without decimals, or with decimals that disagree with the
       `weth` field pointing at it — the 10^12 mispricing trap;
     * `REDEPLOYABLE_CONTRACTS` naming a field that no longer exists after a
       rename, which would silently stop warning about anything.

   Nothing here reaches the network. These are assertions about a source file.
   ============================================================================ */

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_CHAIN_IDS,
  GULLYCORE_MAINNET_CHAIN_IDS,
  GULLYCORE_DEPLOYMENTS,
  NATIVE_CURRENCY,
  REDEPLOYABLE_CONTRACTS,
  explorerAddressUrl,
  explorerTxUrl,
  getDeployment,
  isGullyCoreChainId,
  requireContract,
  requireDeployment,
  revShareHookRecord,
  tokenByAddress,
  tokenBySymbol,
  type GullyCoreDeployment,
} from "../src/deployments/index.js";

/**
 * The earliest block at which ANY contract this address book names has an event, per chain.
 *
 * Measured, never estimated: read from the indexer's own `contract_events` table after a full
 * backfill from a deliberately-too-early start, so the range below it is proven empty rather
 * than assumed empty. Add a chain here only once it has actually been indexed.
 *
 * On a NEW chain the cheap way to get this right is not to measure it afterwards at all — it is
 * to record the block from the deployment broadcast and set `deployedAtBlock` to it directly.
 */
const MEASURED_FIRST_EVENT_BLOCK: Partial<Record<number, bigint>> = {
  /* Empty: no chain has had a full backfill from a too-early start yet. */
};

/** Wide enough for a margin, far below the span a public endpoint will refuse. */
const MAX_EMPTY_LEAD_BLOCKS = 25_000n;

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Every field of a deployment that holds a single address, live or null. */
const ADDRESS_FIELDS = [
  "vault",
  "clPoolManager",
  "binPoolManager",
  "clPoolManagerOwner",
  "binPoolManagerOwner",
  "feeController",
  "clProtocolFeeController",
  "binProtocolFeeController",
  "governanceSafe",
  "timelockCustody",
  "timelockPolicy",
  "registry",
  "universalRouter",
  "clPositionManager",
  "binPositionManager",
  "clQuoter",
  "binQuoter",
  "clPositionDescriptor",
  "create3Factory",
  "permit2",
  "weth",
  "revShareHook",
  "launchRegistry",
  "launchpadKit",
  "launchGuardHook",
] as const satisfies readonly (keyof GullyCoreDeployment)[];

/**
 * Fields that may legitimately share an address with another field.
 *
 * `governanceSafe` is deployed at the same address on both chains, and one
 * `ProtocolFeeController` contract is deployed twice on Robinhood — but those
 * are collisions ACROSS chains and across two intentionally distinct
 * instances, not within one chain, so the per-chain uniqueness check below
 * needs no exemption today. Kept as an explicit empty set so that adding one
 * later is a deliberate edit with a reason attached.
 */
const UNIQUENESS_EXEMPT: readonly string[] = [];

function addressesOf(d: GullyCoreDeployment): [string, string][] {
  /* The `as const` gives a readonly tuple of the literal key union, which no
     longer widens to [string, string] now that some fields are nullable. Map
     to plain strings first, then filter. */
  return ADDRESS_FIELDS.map((k) => [k as string, d[k] as string | null] as [string, string | null])
    .filter((pair): pair is [string, string] => pair[1] !== null);
}

/**
 * EVERY address in a deployment, including the nested groups, as [path, address].
 *
 * `addressesOf` above walks a hand-maintained `ADDRESS_FIELDS` list, and that list has not kept
 * up: `fillRouter`, the whole eight-address `launchpadV2` group, `splitFactory` and the four
 * utilities are absent from it, so on 2026-09-25 thirteen addresses were covered by NO guard at
 * all — not the zero-address check, not the well-formedness check. The mis-checksummed Sepolia
 * lockers sat in exactly that blind spot.
 *
 * This walks the object instead, so a field added later is covered the day it is added rather
 * than the day somebody remembers to extend a list. It is deliberately NOT used for the
 * cross-field uniqueness check: nested duplication is legitimate and expected (a chain's
 * `launchGuardHook` IS its `launchpadV2.clLaunchGuardHook`), whereas duplication among the
 * curated top-level fields is the paste error that check exists to catch.
 */
function everyAddressOf(d: GullyCoreDeployment): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (/^0x[0-9a-fA-F]{40}$/.test(node)) out.push([path, node]);
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(d, "");
  return out;
}

describe("GULLYCORE_DEPLOYMENTS", () => {
  it("carries exactly the chains GULLYCORE_CHAIN_IDS advertises", () => {
    expect(Object.keys(GULLYCORE_DEPLOYMENTS).map(Number).sort((a, b) => a - b)).toEqual(
      [...GULLYCORE_CHAIN_IDS].sort((a, b) => a - b),
    );
  });

  it("does not ship Arc mainnet (5042), which has never answered a probe", () => {
    expect(isGullyCoreChainId(5042)).toBe(false);
    expect(getDeployment(5042)).toBeUndefined();
  });

  for (const chainId of GULLYCORE_CHAIN_IDS) {
    /* Through a number-indexed view: with the book empty `GullyCoreChainId` is `never`. */
    const d = (GULLYCORE_DEPLOYMENTS as Readonly<Record<number, GullyCoreDeployment>>)[chainId]!;

    describe(`${d.name} (${chainId})`, () => {
      it("agrees with its own key", () => {
        expect(d.chainId).toBe(chainId);
      });

      it("has no zero-address placeholder anywhere — null is the placeholder", () => {
        for (const [field, addr] of everyAddressOf(d)) {
          expect(addr.toLowerCase(), `${field} is the zero address`).not.toBe(ZERO);
        }
      });

      /*
       * EIP-55, and it is not pedantry. Thirteen of the Sepolia release addresses were transcribed
       * with a WRONG mixed-case checksum on 2026-09-25 — the right hex, so every RPC call worked
       * and nothing looked broken, but viem's `isAddress`/`getAddress` reject them. The symptom
       * surfaced far away: `apps/api`'s chain-config schema refused two locker addresses as "not
       * an address", which is a confusing thing to be told about an address that plainly works.
       *
       * An all-lowercase or all-uppercase address carries no checksum and is legal, so only a
       * MIXED-case one is checked — that is the case where the mixed case is a claim.
       */
      it("checksums every mixed-case address correctly (EIP-55)", () => {
        for (const [field, addr] of everyAddressOf(d)) {
          if (addr === addr.toLowerCase() || addr === addr.toUpperCase()) continue;
          expect(addr, `${field} has a bad EIP-55 checksum`).toBe(getAddress(addr.toLowerCase()));
        }
      });

      it("has well-formed 20-byte addresses", () => {
        for (const [field, addr] of addressesOf(d)) {
          expect(addr, `${field} is malformed: ${addr}`).toMatch(ADDRESS_RE);
        }
      });

      it("does not repeat one address across two contract fields", () => {
        const seen = new Map<string, string>();
        for (const [field, addr] of addressesOf(d)) {
          if (UNIQUENESS_EXEMPT.includes(field)) continue;
          const key = addr.toLowerCase();
          const prior = seen.get(key);
          expect(prior, `${field} repeats the address already used by ${String(prior)}`).toBe(
            undefined,
          );
          seen.set(key, field);
        }
      });

      it("records a duration clock exactly where the contract exists", () => {
        expect(d.durationClocks.revShareHook === null).toBe(d.revShareHook === null);
        expect(d.durationClocks.launchpadKit === null).toBe(d.launchpadKit === null);
        expect(d.durationClocks.launchGuardHook === null).toBe(d.launchGuardHook === null);
        /* A kit drives exactly one hook, and a timestamp kit refuses a block hook on
           chain - so where kit v1 exists, its clock and the guard's must agree.

           `launchpadKit` is v1 SPECIFICALLY, and since the 2026-09-25 Sepolia release a
           chain can carry a guard without it: v2 is the release and v1 was never
           deployed there. Pairing them unconditionally would force this record to claim
           a v1 that does not exist, which is the opposite of what the field means. */
        if (d.launchpadKit !== null) {
          expect(d.durationClocks.launchpadKit).toBe(d.durationClocks.launchGuardHook);
        } else if (d.launchGuardHook !== null) {
          // Every guard deployed from 2026-09-13 onward is timestamp-based by decision.
          expect(d.durationClocks.launchGuardHook).toBe("timestamp");
        }
      });

      it("lists the current RevShareHook exactly once, with the clock the record claims", () => {
        const current = d.revShareHooks.filter((h) => h.status === "current");
        if (d.revShareHook === null) {
          // Not deployed on this chain: no current hook may be listed (a retired one could be).
          expect(current).toHaveLength(0);
          return;
        }
        expect(current).toHaveLength(1);
        expect(current[0]?.address.toLowerCase()).toBe(d.revShareHook.toLowerCase());
        expect(current[0]?.durationClock).toBe(d.durationClocks.revShareHook);
      });

      it("gives every RevShareHook shape the clock that shape stores", () => {
        for (const h of d.revShareHooks) {
          expect(h.address).toMatch(ADDRESS_RE);
          const expected = h.pendingShape === "timestamp-with-expiry" ? "timestamp" : "contract-block";
          expect(h.durationClock, `${h.address} shape/clock disagree`).toBe(expected);
          expect(revShareHookRecord(chainId, h.address.toUpperCase().replace("0X", "0x"))).toEqual(h);
        }
        const unique = new Set(d.revShareHooks.map((h) => h.address.toLowerCase()));
        expect(unique.size).toBe(d.revShareHooks.length);
      });

      it("scans logs from a real block, not from genesis", () => {
        expect(d.deployedAtBlock).toBeTypeOf("bigint");
        expect(d.deployedAtBlock > 0n).toBe(true);
      });

      /*
       * The check above is the one that DIDN'T bite. On 2026-09-25 Sepolia's `deployedAtBlock`
       * was 105,474 blocks earlier than its earliest real event, because it still named a
       * superseded deployment — and `> 0n` was perfectly happy with that. The indexer's first
       * pass then asked every public endpoint for a 105k-block span, all five refused at once,
       * and it only finished by halving the window down; the budget bought nothing, because
       * none of our contracts existed in those blocks.
       *
       * A unit test cannot learn a chain's truth, so it asserts against a MEASURED number
       * instead: the earliest block at which any watched contract has an event, read from the
       * indexer's own table after a full backfill. That makes the empty range proven rather than
       * assumed. A chain with no row here is not failed — it is simply not yet measured, which
       * is the honest state for a chain nobody has indexed.
       */
      it("does not start the scan in a range with nothing in it", () => {
        const measured = MEASURED_FIRST_EVENT_BLOCK[chainId];
        if (measured === undefined) return;
        expect(d.deployedAtBlock, "must not start AFTER the first real event — that loses history").toBeLessThanOrEqual(measured);
        const lead = measured - d.deployedAtBlock;
        expect(lead, `${lead} empty blocks before the first event; public RPCs refuse spans this wide`).toBeLessThanOrEqual(MAX_EMPTY_LEAD_BLOCKS);
      });

      it("has an explorer origin with no trailing slash", () => {
        expect(d.explorer).toMatch(/^https:\/\//);
        expect(d.explorer.endsWith("/")).toBe(false);
      });

      it("gives every token its decimals", () => {
        for (const t of d.tokens) {
          expect(t.address, `${t.symbol} is malformed`).toMatch(ADDRESS_RE);
          expect(Number.isInteger(t.decimals), `${t.symbol} decimals`).toBe(true);
          expect(t.decimals).toBeGreaterThanOrEqual(0);
          expect(t.decimals).toBeLessThanOrEqual(36);
          expect(t.symbol.length).toBeGreaterThan(0);
          expect(t.name.length).toBeGreaterThan(0);
        }
      });

      it("lists no token twice", () => {
        const addrs = d.tokens.map((t) => t.address.toLowerCase());
        expect(new Set(addrs).size).toBe(addrs.length);
      });

      it("lists its own WETH in the token table, at 18 decimals", () => {
        const weth = tokenByAddress(chainId, d.weth);
        expect(weth, "the weth field points at a token not in `tokens`").toBeDefined();
        expect(weth?.decimals).toBe(18);
      });

      it("has native currency metadata matching NATIVE_CURRENCY", () => {
        expect(NATIVE_CURRENCY[chainId]).toEqual(d.nativeCurrency);
        expect(d.nativeCurrency.decimals).toBe(18);
      });

      it("has every REDEPLOYABLE_CONTRACTS key as a field", () => {
        for (const key of REDEPLOYABLE_CONTRACTS) {
          expect(Object.hasOwn(d, key), `${key} is not a field of GullyCoreDeployment`).toBe(true);
        }
      });

      it("requireContract returns a deployed address and throws, never zero, for a null one", () => {
        expect(requireContract(d, "vault")).toBe(d.vault);
        const absent = (["launchpadKit", "timelockPolicy", "clPoolManagerOwner"] as const).filter((k) => d[k] === null);
        for (const k of absent) expect(() => requireContract(d, k)).toThrow(new RegExp(`${k} is not deployed on`));
      });

      it("finds its WETH case-insensitively, and builds explorer links on its own origin", () => {
        const wrapped = tokenByAddress(chainId, d.weth.toUpperCase());
        expect(wrapped).toBeDefined();
        expect(tokenBySymbol(chainId, wrapped!.symbol.toLowerCase())?.address).toBe(wrapped!.address);
        expect(tokenBySymbol(chainId, "nope")).toBeUndefined();
        expect(explorerTxUrl(chainId, "0xabc")).toBe(`${d.explorer}/tx/0xabc`);
        expect(explorerAddressUrl(chainId, "0xabc")).toBe(`${d.explorer}/address/0xabc`);
      });

      it("narrows its own id to a GullyCoreChainId", () => {
        expect(isGullyCoreChainId(chainId)).toBe(true);
        expect(getDeployment(chainId)).toBe(d);
      });
    });
  }

  /* The four mainnets deployed 2026-10-10/12. The records this book held before the fork
     (Robinhood 4663, Base 8453, Sepolia 11155111) belonged to another protocol: an old
     record reappearing here is that data coming back, not a new chain. Base Sepolia
     (84532, Gully Core's testnet since 2026-10-15) joins ONLY once its live run is complete
     and the record is written from on-chain read-back by `make-record.mjs` (key
     `base-sepolia`, `isMainnet: false`) — never before, never with placeholder addresses. */
  it("lists only mainnets in GULLYCORE_MAINNET_CHAIN_IDS, all of them from the book", () => {
    for (const id of GULLYCORE_MAINNET_CHAIN_IDS) expect(GULLYCORE_CHAIN_IDS).toContain(id);
  });

  it("admits the chains with a Gully Core record (BNB 56, Robinhood 4663, Anubis 6714, Base 8453, Kinetiq Elysium 99901, Gully Chain Testnet 485590), and nothing else", () => {
    expect([...GULLYCORE_CHAIN_IDS]).toEqual([56, 4663, 6714, 8453, 99901, 485590]);
    for (const id of [1, 11155111, 998, 84532, 999]) expect(isGullyCoreChainId(id), `${id}`).toBe(false);
  });

});

describe("REDEPLOYABLE_CONTRACTS", () => {
  it("does not claim the Vault is redeployable", () => {
    expect((REDEPLOYABLE_CONTRACTS as readonly string[]).includes("vault")).toBe(false);
  });
});

describe("lookup helpers", () => {
  it("returns undefined for an unknown chain rather than defaulting to one", () => {
    expect(getDeployment(1)).toBeUndefined();
    expect(getDeployment(10)).toBeUndefined();
  });

  it("throws for a chain Gully Core is not deployed on", () => {
    expect(() => requireDeployment(1)).toThrow(/not deployed on chain 1/);
    expect(() => requireDeployment(11155111)).toThrow(/not deployed on chain 11155111/);
  });
});
