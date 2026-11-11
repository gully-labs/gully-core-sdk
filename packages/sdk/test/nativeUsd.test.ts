// SPDX-License-Identifier: MIT
/* ============================================================================
   THE NATIVE/USD RESOLVER, AND THE TABLE BEHIND IT.

   The property under test is not "does it return a price". It is "does it return
   NOTHING, with a reason, in every case where a price would be a guess". CLAUDE.md:
   "If you cannot read it, do not render it." Every path below that ends in
   `{ ok: false }` is a path where an earlier draft of this kind of code would have
   returned a zero, a cached number, or a figure from another chain.

   The client is a stub, not a network. A test that reaches a real RPC endpoint is a
   test that goes red when somebody else's node has a bad afternoon, and a staleness
   test cannot be written against a feed that is healthy.
   ============================================================================ */

import { describe, expect, it } from "vitest";

import {
  NATIVE_FEEDS,
  NATIVE_FEEDS_VERIFIED_INSTANT,
  NATIVE_USD_NO_SOURCE_CHAIN_IDS,
  NATIVE_USD_TIER1_CHAIN_IDS,
  STALE_GRACE_SECONDS,
  nativeFeedFor,
  staleAfterSeconds,
} from "../src/deployments/nativeFeeds.js";
import { readChainlinkNativeUsd } from "../src/price/chainlink.js";
import { POOL_TWAP_PREREQUISITES, poolTwapAttempt } from "../src/price/pool.js";
import { readPythNativeUsd } from "../src/price/pyth.js";
import { resolveNativeUsd } from "../src/price/resolve.js";
import { isNativeUsdQuote } from "../src/price/types.js";

/* ------------------------------------------------------------------- stubs */

const BASE = 8453;
const ROBINHOOD = 4663;
const STABLE = 988;
const SEPOLIA = 11155111;
const NOW = 1_800_000_000;

type Answers = {
  decimals?: number | Error;
  description?: string | Error;
  round?: readonly [bigint, bigint, bigint, bigint, bigint] | Error;
  pyth?: { price: bigint; conf: bigint; expo: number; publishTime: bigint } | Error;
  blockNumber?: bigint | Error;
};

/** A `PublicClient` shaped enough for these readers and nothing more. */
function stubClient(a: Answers): any {
  const give = <T>(v: T | Error | undefined, fallback: T): T => {
    if (v instanceof Error) throw v;
    return v === undefined ? fallback : v;
  };
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "decimals") return give(a.decimals, 8);
      if (functionName === "description") return give(a.description, "ETH / USD");
      if (functionName === "latestRoundData") {
        return give(a.round, [1n, 200_000_000_000n, BigInt(NOW - 10), BigInt(NOW - 10), 1n] as const);
      }
      if (functionName === "getPriceUnsafe") {
        return give(a.pyth, { price: 200_000_000_000n, conf: 1n, expo: -8, publishTime: BigInt(NOW - 10) });
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    async getBlockNumber() {
      return give(a.blockNumber, 123_456n);
    },
  };
}

/** A client whose every call throws — a chain that is simply unreachable. */
function deadClient(): any {
  return {
    async readContract() {
      throw new Error("HTTP request failed");
    },
    async getBlockNumber() {
      throw new Error("HTTP request failed");
    },
  };
}

/* ------------------------------------------------------- the committed table */

describe("the generated native-feed table", () => {
  /* Every one of these was read from the chain by the generator. The test is not
     re-reading them; it is asserting the SHAPE nobody may quietly relax — an
     address with no description, or a feed with no heartbeat, is a row that was
     written down without being checked. */
  it("carries a full verification record on every shipped feed", () => {
    for (const record of Object.values(NATIVE_FEEDS)) {
      const feed = record.chainlink;
      if (!feed) continue;
      expect(feed.proxyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(feed.decimals).toBeGreaterThan(0);
      expect(feed.heartbeat).toBeGreaterThan(0);
      expect(feed.codeSize).toBeGreaterThan(0);
      expect(feed.description.length).toBeGreaterThan(0);
      expect(BigInt(feed.verifiedAnswer)).toBeGreaterThan(0n);
      expect(feed.verifiedUpdatedAt).toBeGreaterThan(0);
      // The generator's own rule: nothing stale was shipped.
      expect(feed.verifiedAgeSeconds).toBeLessThanOrEqual(staleAfterSeconds(feed));
      // Every feed here is 24/7. If one ever is not, the staleness rule in
      // chainlink.ts is wrong for it and this test is where that surfaces.
      expect(feed.marketHours).toBe("Crypto");
    }
  });

  it("names the base asset in every shipped description", () => {
    for (const record of Object.values(NATIVE_FEEDS)) {
      if (!record.chainlink) continue;
      const symbol = record.native.symbol.toUpperCase();
      expect(record.chainlink.description.toUpperCase()).toContain(symbol);
    }
  });

  it("derives staleness from the feed's own heartbeat, not from a house number", () => {
    const base = nativeFeedFor(BASE)!;
    expect(staleAfterSeconds(base.chainlink!)).toBe(base.chainlink!.heartbeat + STALE_GRACE_SECONDS);
  });

  /* Load-bearing chains, pinned by chain id rather than by address: the address is
     allowed to change when Chainlink republishes, but Base and Robinhood having a
     tier-1 source at all is a fact the launch wizard depends on. */
  it("has a tier-1 source on Base and on Robinhood", () => {
    expect(NATIVE_USD_TIER1_CHAIN_IDS).toContain(BASE);
    expect(NATIVE_USD_TIER1_CHAIN_IDS).toContain(ROBINHOOD);
  });

  /* Robinhood's only ETH/USD aggregator is an SVR one. That is a real difference in
     delivery, not a footnote, and the caveat must reach the caller. */
  it("marks Robinhood's feed as the SVR variant it is", () => {
    expect(nativeFeedFor(ROBINHOOD)!.chainlink!.variant).toBe("svr");
  });

  it("records a reason on every chain with no Chainlink feed", () => {
    for (const record of Object.values(NATIVE_FEEDS)) {
      if (record.chainlink) continue;
      expect(record.note, `chain ${record.chainId} has no feed and no explanation`).toBeTruthy();
    }
  });

  it("does not claim a native currency it could not establish", () => {
    for (const record of Object.values(NATIVE_FEEDS)) {
      expect(record.native.symbol.length).toBeGreaterThan(0);
      expect(record.native.source.length).toBeGreaterThan(0);
      // An inferred value must say so; a read one must not claim to be inferred.
      if (record.native.inferred) expect(record.native.source).toMatch(/INFERENCE|inferred|998/);
    }
  });

  it("was verified at a plausible instant", () => {
    expect(NATIVE_FEEDS_VERIFIED_INSTANT).toBeGreaterThan(1_700_000_000);
  });
});

/* ------------------------------------------------------------------- tier 1 */

describe("readChainlinkNativeUsd", () => {
  it("returns the answer with provenance a UI can render", async () => {
    const r = await readChainlinkNativeUsd({ client: stubClient({}), chainId: BASE, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.answer).toBe(200_000_000_000n);
    expect(r.quote.answerDecimals).toBe(8);
    expect(r.quote.nativeSymbol).toBe("ETH");
    expect(r.quote.nativeDecimals).toBe(18);
    expect(r.quote.provenance.tier).toBe("chainlink-onchain");
    expect(r.quote.provenance.source).toBe("Chainlink");
    expect(r.quote.provenance.address).toBe(nativeFeedFor(BASE)!.chainlink!.proxyAddress);
    expect(r.quote.provenance.blockNumber).toBe(123_456n);
    expect(r.quote.provenance.roundId).toBe("1");
    expect(r.quote.provenance.ageSeconds).toBe(10);
    expect(r.quote.provenance.label).toContain("Chainlink");
    expect(r.quote.provenance.label).toContain("block 123456");
  });

  /* Base's selected aggregator is an SVR feed, so the caveat is not hypothetical:
     it must reach the caller on the happy path, not only in an error. */
  it("carries the SVR caveat on a chain whose only feed is an SVR one", async () => {
    const r = await readChainlinkNativeUsd({ client: stubClient({}), chainId: ROBINHOOD, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.provenance.caveats.join(" ")).toContain("SVR");
  });

  it("refuses a stale round rather than returning a number", async () => {
    const feed = nativeFeedFor(BASE)!.chainlink!;
    const tooOld = BigInt(NOW - staleAfterSeconds(feed) - 1);
    const r = await readChainlinkNativeUsd({
      client: stubClient({ round: [1n, 200_000_000_000n, tooOld, tooOld, 1n] }),
      chainId: BASE,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.outcome).toBe("stale");
    expect(r.attempt.detail).toContain("heartbeat");
  });

  it("accepts a round exactly on the threshold and refuses the second past it", async () => {
    const feed = nativeFeedFor(BASE)!.chainlink!;
    const limit = staleAfterSeconds(feed);
    const at = BigInt(NOW - limit);
    const past = BigInt(NOW - limit - 1);
    const ok = await readChainlinkNativeUsd({
      client: stubClient({ round: [1n, 1n, at, at, 1n] }),
      chainId: BASE,
      now: NOW,
    });
    expect(ok.ok).toBe(true);
    const no = await readChainlinkNativeUsd({
      client: stubClient({ round: [1n, 1n, past, past, 1n] }),
      chainId: BASE,
      now: NOW,
    });
    expect(no.ok).toBe(false);
  });

  it("refuses a non-positive answer", async () => {
    for (const answer of [0n, -1n]) {
      const r = await readChainlinkNativeUsd({
        client: stubClient({ round: [1n, answer, BigInt(NOW - 5), BigInt(NOW - 5), 1n] }),
        chainId: BASE,
        now: NOW,
      });
      expect(r.ok).toBe(false);
      expect(r.attempt.outcome).toBe("refused");
    }
  });

  it("refuses an incomplete round", async () => {
    const r = await readChainlinkNativeUsd({
      client: stubClient({ round: [1n, 1n, 0n, BigInt(NOW - 5), 1n] }),
      chainId: BASE,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.detail).toContain("incomplete round");
  });

  it("refuses a round dated in the future", async () => {
    const ahead = BigInt(NOW + 3600);
    const r = await readChainlinkNativeUsd({
      client: stubClient({ round: [1n, 1n, ahead, ahead, 1n] }),
      chainId: BASE,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.detail).toContain("future");
  });

  /* A silent decimals change is a factor-of-10^n error in a dollar figure. The
     Solidity adapter treats it as an incident; so does this. */
  it("refuses a feed whose decimals no longer match the committed table", async () => {
    const r = await readChainlinkNativeUsd({ client: stubClient({ decimals: 18 }), chainId: BASE, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.attempt.detail).toContain("decimals");
    expect(r.attempt.detail).toContain("generate-native-feeds");
  });

  it("returns an error outcome, not a throw, when the chain is unreachable", async () => {
    const r = await readChainlinkNativeUsd({ client: deadClient(), chainId: BASE, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.attempt.outcome).toBe("error");
  });

  it("still answers when only the block number read fails", async () => {
    const r = await readChainlinkNativeUsd({
      client: stubClient({ blockNumber: new Error("no") }),
      chainId: BASE,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.provenance.blockNumber).toBeNull();
  });

  it("skips a chain with no verified aggregator instead of inventing one", async () => {
    const r = await readChainlinkNativeUsd({ client: stubClient({}), chainId: STABLE, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.attempt.outcome).toBe("skipped");
    expect(r.attempt.address).toBeNull();
  });

  it("marks a caller-supplied aggregator as the caller's claim", async () => {
    const r = await readChainlinkNativeUsd({
      client: stubClient({}),
      chainId: BASE,
      aggregator: "0x00000000000000000000000000000000deadbeef",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.provenance.caveats.join(" ")).toContain("Caller-supplied aggregator");
  });
});

/* ------------------------------------------------------------------- tier 2 */

describe("readPythNativeUsd", () => {
  it("turns Pyth's negative exponent into answerDecimals", async () => {
    const r = await readPythNativeUsd({
      client: stubClient({ pyth: { price: 123_456n, conf: 1n, expo: -5, publishTime: BigInt(NOW - 3) } }),
      chainId: BASE,
      pythContract: "0x00000000000000000000000000000000000000py" as never,
      staleAfter: 60,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.answer).toBe(123_456n);
    expect(r.quote.answerDecimals).toBe(5);
    expect(r.quote.provenance.tier).toBe("pyth-hermes");
    expect(r.quote.provenance.roundId).toBeNull();
    // A pull oracle's caveat must always travel with the number.
    expect(r.quote.provenance.caveats.join(" ")).toContain("pull oracle");
  });

  /* A pull oracle's on-chain price is whatever the last poster paid for. The
     threshold is the caller's, with no default — and it is enforced. */
  it("refuses an update older than the caller's threshold", async () => {
    const r = await readPythNativeUsd({
      client: stubClient({ pyth: { price: 1n, conf: 1n, expo: -8, publishTime: BigInt(NOW - 61) } }),
      chainId: BASE,
      pythContract: "0x00000000000000000000000000000000000000py" as never,
      staleAfter: 60,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.outcome).toBe("stale");
    expect(r.attempt.detail).toContain("pull oracle");
  });

  it("refuses a feed nobody has ever posted on this chain", async () => {
    const r = await readPythNativeUsd({
      client: stubClient({ pyth: { price: 1n, conf: 1n, expo: -8, publishTime: 0n } }),
      chainId: BASE,
      pythContract: "0x00000000000000000000000000000000000000py" as never,
      staleAfter: 60,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.detail).toContain("never had an update");
  });

  it("refuses a non-negative exponent rather than guessing at the scale", async () => {
    const r = await readPythNativeUsd({
      client: stubClient({ pyth: { price: 1n, conf: 1n, expo: 2, publishTime: BigInt(NOW - 1) } }),
      chainId: BASE,
      pythContract: "0x00000000000000000000000000000000000000py" as never,
      staleAfter: 60,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.detail).toContain("exponent");
  });

  it("skips a chain with no verified price-feed id", async () => {
    // Chain 1 has one; a chain absent from the table has none at all.
    const r = await readPythNativeUsd({
      client: stubClient({}),
      chainId: 424242,
      pythContract: "0x00000000000000000000000000000000000000py" as never,
      staleAfter: 60,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.attempt.outcome).toBe("skipped");
  });
});

/* ------------------------------------------------------------------- tier 3 */

describe("tier 3, the Gully Core pool TWAP", () => {
  /* The tier is defined and unimplemented ON PURPOSE. This test exists so that
     "implement it" is a deliberate act that breaks a visible assertion, rather
     than something that quietly appears behind a flag. */
  it("is a skip, and says why in terms of manipulation cost", () => {
    const a = poolTwapAttempt();
    expect(a.tier).toBe("gullycore-pool-twap");
    expect(a.outcome).toBe("skipped");
    expect(a.detail).toContain("manipulable by a single swap");
    expect(a.address).toBeNull();
  });

  it("states the prerequisites as data, not only as a comment", () => {
    expect(POOL_TWAP_PREREQUISITES.length).toBeGreaterThanOrEqual(3);
    expect(POOL_TWAP_PREREQUISITES.join(" ")).toContain("depth floor");
  });
});

/* ----------------------------------------------------------------- resolver */

describe("resolveNativeUsd", () => {
  it("answers from tier 1 and records the attempt", async () => {
    const r = await resolveNativeUsd({ client: stubClient({}), chainId: BASE, now: NOW });
    expect(isNativeUsdQuote(r)).toBe(true);
    if (!r.ok) return;
    expect(r.provenance.tier).toBe("chainlink-onchain");
  });

  /* THE CENTRAL PROPERTY. No source means no number — not a zero, not a default. */
  it("returns unavailable, not a number, on a chain with no source", async () => {
    const r = await resolveNativeUsd({ client: stubClient({}), chainId: STABLE, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).not.toHaveProperty("answer");
    expect(r.nativeSymbol).toBe("USDT0");
    expect(r.nativeDecimals).toBe(18);
    expect(r.detail).toContain("USDT0");
    // The caller is told what to do instead, in words a user can read.
    expect(r.detail).toContain("not dollars");
  });

  it("returns unavailable when the only feed is stale", async () => {
    const feed = nativeFeedFor(BASE)!.chainlink!;
    const tooOld = BigInt(NOW - staleAfterSeconds(feed) - 1);
    const r = await resolveNativeUsd({
      client: stubClient({ round: [1n, 200_000_000_000n, tooOld, tooOld, 1n] }),
      chainId: BASE,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("answer-refused");
    expect(r.attempts.some((a) => a.outcome === "stale")).toBe(true);
  });

  it("returns unavailable when the chain cannot be reached", async () => {
    const r = await resolveNativeUsd({ client: deadClient(), chainId: BASE, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("read-failed");
  });

  it("does not know about a chain nobody surveyed", async () => {
    const r = await resolveNativeUsd({ client: stubClient({}), chainId: 424242, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("chain-not-surveyed");
    expect(r.nativeSymbol).toBeNull();
  });

  /* A testnet's native token has no market price. Sepolia's feed prices REAL ether,
     which is the most misleading kind of true number. */
  it("refuses a USD figure on a testnet by default, and opts in explicitly", async () => {
    const refused = await resolveNativeUsd({ client: stubClient({}), chainId: SEPOLIA, now: NOW });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("testnet-native-has-no-market-price");

    const allowed = await resolveNativeUsd({
      client: stubClient({}),
      chainId: SEPOLIA,
      allowTestnetUsd: true,
      now: NOW,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.provenance.caveats.join(" ")).toContain("testnet");
  });

  /* Tier 2 is skipped rather than guessed at: this SDK commits no Pyth address
     because it verified none, so the caller has to supply one. */
  it("skips tier 2 when no Pyth contract is supplied, and says so", async () => {
    const r = await resolveNativeUsd({ client: deadClient(), chainId: BASE, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const pyth = r.attempts.find((a) => a.tier === "pyth-hermes")!;
    expect(pyth.outcome).toBe("skipped");
    expect(pyth.detail).toContain("no Pyth contract address was supplied");
  });

  it("falls through to tier 2 when Chainlink fails and a Pyth contract is supplied", async () => {
    // Chainlink refuses (answer 0); Pyth answers.
    const client = {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === "decimals") return 8;
        if (functionName === "description") return "ETH / USD";
        if (functionName === "latestRoundData") return [1n, 0n, BigInt(NOW - 5), BigInt(NOW - 5), 1n];
        if (functionName === "getPriceUnsafe") {
          return { price: 199_000_000_000n, conf: 1n, expo: -8, publishTime: BigInt(NOW - 5) };
        }
        throw new Error("unexpected");
      },
      async getBlockNumber() {
        return 1n;
      },
    } as any;
    const r = await resolveNativeUsd({
      client,
      chainId: BASE,
      pyth: { contract: "0x00000000000000000000000000000000000000py" as never, staleAfter: 600 },
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provenance.tier).toBe("pyth-hermes");
    expect(r.answer).toBe(199_000_000_000n);
  });

  it("records every tier it tried, in order, when nothing answers", async () => {
    const r = await resolveNativeUsd({ client: deadClient(), chainId: BASE, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.attempts.map((a) => a.tier)).toEqual(["chainlink-onchain", "pyth-hermes", "gullycore-pool-twap"]);
  });

  /* Whatever else changes, no chain may acquire a price by accident. This asserts
     the two derived lists cannot both claim the same chain. */
  it("never lists a chain as both tier-1 and no-source", () => {
    for (const id of NATIVE_USD_TIER1_CHAIN_IDS) {
      expect(NATIVE_USD_NO_SOURCE_CHAIN_IDS).not.toContain(id);
    }
  });
});
