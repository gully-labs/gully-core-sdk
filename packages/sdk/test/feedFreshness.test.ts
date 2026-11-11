// The freshness rule the native-feed generator ships a Chainlink round under, tested on
// its own: judged against the chain's head read beside the round, inside a bounded
// future tolerance, and never past the feed's own heartbeat plus grace.
//
// It exists because the rule was wrong once in a way no table test could see: the
// generator judged every chain against one wall-clock instant captured at process
// start, so a round published two minutes into the run read as "in the future" on
// whichever chain the loop reached late (Monad, 2026-10-15), and two consecutive runs
// rejected a different MON/USD aggregator each.
import { describe, expect, it } from "vitest";

import {
  FUTURE_SKEW_SECONDS,
  HEAD_WALL_TOLERANCE_SECONDS,
  STALE_GRACE_SECONDS,
  headClockFault,
  judgeRoundFreshness,
  readRoundBesideHead,
} from "../scripts/lib/feedFreshness.mjs";
import {
  FUTURE_SKEW_SECONDS as TABLE_FUTURE_SKEW_SECONDS,
  NATIVE_FEEDS,
  STALE_GRACE_SECONDS as TABLE_STALE_GRACE_SECONDS,
} from "../src/deployments/nativeFeeds.js";
import { FUTURE_SKEW_SECONDS as READER_FUTURE_SKEW_SECONDS } from "../src/price/chainlink.js";

const HEAD = 1_792_081_147; // Monad head timestamp at read 1 of the 2026-10-15 measurement
const HEARTBEAT = 3_600; // MON/USD

describe("judgeRoundFreshness — the reference is the chain head, the tolerance is bounded", () => {
  it("accepts a round behind the head, inside its heartbeat (the normal case)", () => {
    // mon-usd (canonical), read 1: updatedAt − head = −8 s.
    const v = judgeRoundFreshness({ updatedAt: HEAD - 8, referenceTimestamp: HEAD, heartbeatSeconds: HEARTBEAT });
    expect(v.ok).toBe(true);
    expect(v.ageSeconds).toBe(8);
    expect(v.aheadSeconds).toBe(-8);
    expect(v.reasons).toEqual([]);
  });

  it("accepts a round AHEAD of the head by up to the tolerance, and no more", () => {
    const atLimit = judgeRoundFreshness({
      updatedAt: HEAD + FUTURE_SKEW_SECONDS,
      referenceTimestamp: HEAD,
      heartbeatSeconds: HEARTBEAT,
    });
    expect(atLimit.ok).toBe(true);
    expect(atLimit.aheadSeconds).toBe(FUTURE_SKEW_SECONDS);

    const pastLimit = judgeRoundFreshness({
      updatedAt: HEAD + FUTURE_SKEW_SECONDS + 1,
      referenceTimestamp: HEAD,
      heartbeatSeconds: HEARTBEAT,
    });
    expect(pastLimit.ok).toBe(false);
    expect(pastLimit.reasons).toHaveLength(1);
    expect(pastLimit.reasons[0]).toMatch(/past the chain head/);
    expect(pastLimit.reasons[0]).toContain(`${FUTURE_SKEW_SECONDS + 1}s`);
  });

  it("the 2026-10-15 failure mode: the 131 s was elapsed run time, not skew — judged against the head it passes", () => {
    // The committed table before the fix: run start 1792077384, the svr round's
    // updatedAt 1792077515 (131 s later), rejected as "in the future". Against the
    // head at the moment it was read (at or after 1792077515) it is simply fresh.
    const runStart = 1_792_077_384;
    const updatedAt = 1_792_077_515;
    const againstRunStart = judgeRoundFreshness({ updatedAt, referenceTimestamp: runStart, heartbeatSeconds: HEARTBEAT });
    expect(againstRunStart.ok).toBe(false); // what the old generator did, reproduced
    const againstHead = judgeRoundFreshness({ updatedAt, referenceTimestamp: updatedAt + 3, heartbeatSeconds: HEARTBEAT });
    expect(againstHead.ok).toBe(true);
    expect(againstHead.ageSeconds).toBe(3);
  });

  it("rejects a stale round: older than heartbeat + grace, measured against the head", () => {
    const edge = judgeRoundFreshness({
      updatedAt: HEAD - (HEARTBEAT + STALE_GRACE_SECONDS),
      referenceTimestamp: HEAD,
      heartbeatSeconds: HEARTBEAT,
    });
    expect(edge.ok).toBe(true);

    const stale = judgeRoundFreshness({
      updatedAt: HEAD - (HEARTBEAT + STALE_GRACE_SECONDS + 1),
      referenceTimestamp: HEAD,
      heartbeatSeconds: HEARTBEAT,
    });
    expect(stale.ok).toBe(false);
    expect(stale.reasons).toHaveLength(1);
    expect(stale.reasons[0]).toMatch(/^stale: /);
    expect(stale.reasons[0]).toContain(`${HEARTBEAT + STALE_GRACE_SECONDS + 1}s`);
  });

  it("a stale verdict cannot be bought back by pretending the reference is older", () => {
    // The old bug UNDER-reported age by the elapsed run time. With the head as the
    // reference, the age is the age: moving the reference forward only makes it worse.
    const fresh = judgeRoundFreshness({ updatedAt: HEAD - 3_000, referenceTimestamp: HEAD, heartbeatSeconds: HEARTBEAT });
    const later = judgeRoundFreshness({ updatedAt: HEAD - 3_000, referenceTimestamp: HEAD + 1_000, heartbeatSeconds: HEARTBEAT });
    expect(fresh.ok).toBe(true);
    expect(later.ok).toBe(false);
  });

  it("refuses a feed the directory gives no heartbeat for", () => {
    const v = judgeRoundFreshness({ updatedAt: HEAD - 8, referenceTimestamp: HEAD, heartbeatSeconds: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["directory gives no heartbeat"]);
  });

  it("reports both faults when a round is both far in the future and heartbeat-less", () => {
    const v = judgeRoundFreshness({ updatedAt: HEAD + 10_000, referenceTimestamp: HEAD, heartbeatSeconds: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toHaveLength(2);
  });

  it("honours an explicit tolerance and grace, so the constants are inputs, not magic", () => {
    const tight = judgeRoundFreshness({
      updatedAt: HEAD + 5,
      referenceTimestamp: HEAD,
      heartbeatSeconds: HEARTBEAT,
      futureSkewSeconds: 4,
    });
    expect(tight.ok).toBe(false);
    const noGrace = judgeRoundFreshness({
      updatedAt: HEAD - HEARTBEAT - 1,
      referenceTimestamp: HEAD,
      heartbeatSeconds: HEARTBEAT,
      staleGraceSeconds: 0,
    });
    expect(noGrace.ok).toBe(false);
  });

  it("throws on a non-numeric clock rather than judging garbage", () => {
    expect(() =>
      judgeRoundFreshness({ updatedAt: Number.NaN, referenceTimestamp: HEAD, heartbeatSeconds: HEARTBEAT }),
    ).toThrow(TypeError);
  });

  /* The stock generator records `stale` and rejects `future` / `noHeartbeat`; the native
     generator rejects all three. The flags are how a caller tells them apart without
     parsing a reason string, so each must be set by exactly its own fault. */
  describe("the three faults are separate flags, one per reason", () => {
    it("a clean round sets none", () => {
      const v = judgeRoundFreshness({ updatedAt: HEAD - 8, referenceTimestamp: HEAD, heartbeatSeconds: HEARTBEAT });
      expect([v.future, v.noHeartbeat, v.stale]).toEqual([false, false, false]);
      expect(v.ok).toBe(true);
    });

    it("future alone", () => {
      const v = judgeRoundFreshness({
        updatedAt: HEAD + FUTURE_SKEW_SECONDS + 1,
        referenceTimestamp: HEAD,
        heartbeatSeconds: HEARTBEAT,
      });
      expect([v.future, v.noHeartbeat, v.stale]).toEqual([true, false, false]);
      expect(v.reasons).toHaveLength(1);
    });

    it("stale alone — the one the equity policy records instead of rejecting", () => {
      // A Saturday reading of a 24/5 feed: 40 hours past a 1 h heartbeat.
      const v = judgeRoundFreshness({ updatedAt: HEAD - 144_000, referenceTimestamp: HEAD, heartbeatSeconds: HEARTBEAT });
      expect([v.future, v.noHeartbeat, v.stale]).toEqual([false, false, true]);
      expect(v.ok).toBe(false);
      expect(v.ageSeconds).toBe(144_000);
    });

    it("noHeartbeat alone, and it is never reported together with stale", () => {
      const v = judgeRoundFreshness({ updatedAt: HEAD - 144_000, referenceTimestamp: HEAD, heartbeatSeconds: 0 });
      expect([v.future, v.noHeartbeat, v.stale]).toEqual([false, true, false]);
    });

    it("future and noHeartbeat together, and ok is the conjunction", () => {
      const v = judgeRoundFreshness({ updatedAt: HEAD + 10_000, referenceTimestamp: HEAD, heartbeatSeconds: 0 });
      expect([v.future, v.noHeartbeat, v.stale]).toEqual([true, true, false]);
      expect(v.ok).toBe(false);
      expect(v.reasons).toHaveLength(2);
    });
  });
});

describe("readRoundBesideHead — round first, head second, same client; a bad head is thrown, not judged", () => {
  const ABI = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [] }];
  const ADDRESS = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
  const WALL_MS = 1_792_081_110_000;
  const ROUND = [1n, 123_45n, 1_792_081_100n, 1_792_081_100n, 1n] as const;

  /** A fake viem client that logs the order of its calls and serves one head. */
  function fakeClient(head: { number: bigint; timestamp: bigint }) {
    const calls: string[] = [];
    return {
      calls,
      async readContract(args: { address: string; abi: readonly unknown[]; functionName: string }) {
        calls.push(`readContract:${args.functionName}@${args.address}`);
        expect(args.abi).toBe(ABI);
        return ROUND;
      },
      async getBlock(args: { blockTag: "latest" }) {
        calls.push(`getBlock:${args.blockTag}`);
        return head;
      },
    };
  }

  it("returns the round, the head, the wall clock and the head-wall offset from one endpoint", async () => {
    const client = fakeClient({ number: 26_199_142n, timestamp: BigInt(WALL_MS / 1000 - 12) });
    const r = await readRoundBesideHead(client, { address: ADDRESS, abi: ABI, now: () => WALL_MS });
    expect(r.data).toBe(ROUND);
    expect(r.headBlock).toBe(26_199_142);
    expect(r.headTimestamp).toBe(WALL_MS / 1000 - 12);
    expect(r.wallSeconds).toBe(WALL_MS / 1000);
    expect(r.headWallOffsetSeconds).toBe(-12);
    // The order is the property: the head can only be at or past the block the eth_call
    // was served at, so a legitimate round never reads "ahead" by the caller's own time.
    expect(client.calls).toEqual([`readContract:latestRoundData@${ADDRESS}`, "getBlock:latest"]);
  });

  it("the 2026-10-15 HyperEVM case: a head an hour behind the wall clock is thrown, naming the block", async () => {
    // rpc.purroofgroup.com served head 48617869 at 1792077528 against a wall of ~1792081110.
    const client = fakeClient({ number: 48_617_869n, timestamp: 1_792_077_528n });
    await expect(readRoundBesideHead(client, { address: ADDRESS, abi: ABI, now: () => WALL_MS })).rejects.toThrow(
      /3582s behind the wall clock.*\[head block 48617869\]/,
    );
    // Both reads were made — the refusal is of the HEAD as a clock, after the fact.
    expect(client.calls).toHaveLength(2);
  });

  it("honours an explicit tolerance and function name", async () => {
    const client = fakeClient({ number: 7n, timestamp: BigInt(WALL_MS / 1000 - 5) });
    await expect(
      readRoundBesideHead(client, { address: ADDRESS, abi: ABI, now: () => WALL_MS, tolerance: 4 }),
    ).rejects.toThrow(/5s behind/);
    const r = await readRoundBesideHead(client, { address: ADDRESS, abi: ABI, now: () => WALL_MS, functionName: "latestRoundData" });
    expect(r.headBlock).toBe(7);
  });

  it("the default tolerance is HEAD_WALL_TOLERANCE_SECONDS: at it passes, past it throws", async () => {
    const at = fakeClient({ number: 1n, timestamp: BigInt(WALL_MS / 1000 - HEAD_WALL_TOLERANCE_SECONDS) });
    await expect(readRoundBesideHead(at, { address: ADDRESS, abi: ABI, now: () => WALL_MS })).resolves.toMatchObject({
      headWallOffsetSeconds: -HEAD_WALL_TOLERANCE_SECONDS,
    });
    const past = fakeClient({ number: 1n, timestamp: BigInt(WALL_MS / 1000 - HEAD_WALL_TOLERANCE_SECONDS - 1) });
    await expect(readRoundBesideHead(past, { address: ADDRESS, abi: ABI, now: () => WALL_MS })).rejects.toThrow(/behind/);
  });
});

describe("headClockFault — a head that disagrees with the wall clock is not a reference", () => {
  const WALL = 1_792_081_110;

  it("accepts the offsets real chains showed on 2026-10-15", () => {
    for (const offset of [0, -1, 1, -4, -10]) {
      expect(headClockFault(WALL + offset, WALL), `offset ${offset}`).toBeNull();
    }
  });

  it("accepts an offset at the tolerance and refuses one past it, in both directions", () => {
    expect(headClockFault(WALL - HEAD_WALL_TOLERANCE_SECONDS, WALL)).toBeNull();
    expect(headClockFault(WALL + HEAD_WALL_TOLERANCE_SECONDS, WALL)).toBeNull();
    expect(headClockFault(WALL - HEAD_WALL_TOLERANCE_SECONDS - 1, WALL)).toMatch(/behind the wall clock/);
    expect(headClockFault(WALL + HEAD_WALL_TOLERANCE_SECONDS + 1, WALL)).toMatch(/ahead of the wall clock/);
  });

  it("the 2026-10-15 HyperEVM case: a head an hour behind is refused, so the round is never judged against it", () => {
    // rpc.purroofgroup.com served head block 48617869 at 1792077528 while the wall (and
    // the round) sat at ~1792081110. Judged against that head the round read "3582 s in
    // the future"; the head is what was wrong.
    const fault = headClockFault(1_792_077_528, WALL);
    expect(fault).not.toBeNull();
    expect(fault).toContain("3582s behind");
  });

  it("honours an explicit tolerance and throws on a non-numeric clock", () => {
    expect(headClockFault(WALL - 5, WALL, 4)).not.toBeNull();
    expect(() => headClockFault(Number.NaN, WALL)).toThrow(TypeError);
  });
});

describe("the constants are one number everywhere", () => {
  it("the generated table and the runtime reader carry the generator's FUTURE_SKEW_SECONDS", () => {
    expect(TABLE_FUTURE_SKEW_SECONDS).toBe(FUTURE_SKEW_SECONDS);
    expect(READER_FUTURE_SKEW_SECONDS).toBe(FUTURE_SKEW_SECONDS);
  });

  it("the generated table carries the generator's STALE_GRACE_SECONDS", () => {
    expect(TABLE_STALE_GRACE_SECONDS).toBe(STALE_GRACE_SECONDS);
  });

  it("every shipped row re-derives as OK from its own recorded head", () => {
    // The verdict must be reproducible from the row alone: that is what recording the
    // head is for. A row that does not pass its own rule was written down unchecked.
    for (const record of Object.values(NATIVE_FEEDS)) {
      for (const feed of [record.chainlink, ...record.chainlinkAlternatives]) {
        if (!feed) continue;
        const v = judgeRoundFreshness({
          updatedAt: feed.verifiedUpdatedAt,
          referenceTimestamp: feed.verifiedHeadTimestamp,
          heartbeatSeconds: feed.heartbeat,
        });
        expect(v.ok, `${record.chainKey} ${feed.path}: ${v.reasons.join("; ")}`).toBe(true);
        expect(v.ageSeconds, `${record.chainKey} ${feed.path}`).toBe(feed.verifiedAgeSeconds);
        expect(feed.verifiedHeadBlock).toBeGreaterThan(0);
        // The generator refuses a head further than this from the wall clock, so a row
        // outside it was judged against a clock the rule does not allow.
        expect(Math.abs(feed.verifiedHeadWallOffsetSeconds), `${record.chainKey} head-wall`).toBeLessThanOrEqual(
          HEAD_WALL_TOLERANCE_SECONDS,
        );
      }
    }
  });
});
