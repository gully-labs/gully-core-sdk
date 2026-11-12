import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { summarizePoolLocks, type CurrencyLockSummary } from "@gullylabs/core-sdk/lock";

import { parseLockBadgeAttributes } from "../src/embed/lockBadge.js";
import { poolEmbedView, tokenEmbedView } from "../src/locks/embedModel.js";
import { blockWindows } from "../src/locks/scan.js";
import type { PoolLocksData, TokenLocksData } from "../src/locks/fetch.js";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const POOL = `0x${"11".repeat(32)}` as Hex;
const meta = { address: TOKEN, symbol: "TKN", decimals: 18 };

function tokenData(summary: Partial<CurrencyLockSummary> | null, permanent: TokenLocksData["permanent"] = null): TokenLocksData {
  return {
    summary:
      summary === null
        ? null
        : { currency: TOKEN, locks: [], totalHeld: 0n, unvested: 0n, totalSupply: 1000n * 10n ** 18n, heldBps: 0, unvestedBps: 0, nextCliffOrEnd: null, lastEnd: null, ...summary },
    permanent,
    token: meta,
    chainNow: 1n,
    readAtMs: 0,
  };
}

describe("embed badge words", () => {
  it("token: the share of supply nobody can take yet", () => {
    const v = tokenEmbedView(
      tokenData({ locks: [{} as never, {} as never], unvested: 120n * 10n ** 18n, unvestedBps: 1200, totalHeld: 150n * 10n ** 18n, heldBps: 1500, nextCliffOrEnd: 5n }),
    );
    expect(v.headline).toBe("12% of supply locked");
    expect(v.detail).toContain("2 Gully Core token locks");
    expect(v.countdownTo).toBe(5n);
  });

  it("token: permanent LP-locker liquidity alone, then nothing", () => {
    const lp = { pools: [{ poolId: POOL, kind: "cl-lp-locker" as const, pairedWith: TOKEN, amount: 10n * 10n ** 18n, locks: 1 }], total: 10n * 10n ** 18n, unpriced: 0 };
    expect(tokenEmbedView(tokenData(null, lp)).headline).toBe("Liquidity locked permanently (LP locker)");
    expect(tokenEmbedView(tokenData({})).headline).toBe("No TKN locked");
    expect(tokenEmbedView(tokenData({ locks: [{} as never] })).headline).toBe("No TKN locked now");
  });

  it("pool: 'No locked liquidity' when nothing is locked", () => {
    const summary = summarizePoolLocks({ poolId: POOL, currency0: TOKEN, currency1: TOKEN, pool: null, locks: [] });
    const d: PoolLocksData = { summary, bin: null, currency0: meta, currency1: meta, chainNow: 1n, readAtMs: 0 };
    expect(poolEmbedView(d).headline).toBe("No locked liquidity");
  });

  it("never says safe or rug-proof", () => {
    const all = [tokenEmbedView(tokenData({ locks: [{} as never], unvested: 1n, unvestedBps: 1 })), tokenEmbedView(tokenData({}))];
    for (const v of all) expect(`${v.headline} ${v.detail}`).not.toMatch(/\bsafe\b|rug/i);
  });
});

describe("embed attributes", () => {
  const attrs = (o: Record<string, string>) => (n: string) => o[n] ?? null;
  it("validates chain, pool and token", () => {
    expect(parseLockBadgeAttributes(attrs({ chain: "4663", pool: POOL }))).toEqual({ ok: true, chainId: 4663, target: { kind: "pool", poolId: POOL, poolType: "cl" } });
    expect(parseLockBadgeAttributes(attrs({ chain: "4663", pool: POOL, "pool-type": "BIN" }))).toMatchObject({ ok: true, target: { poolType: "bin" } });
    expect(parseLockBadgeAttributes(attrs({ chain: "4663", token: TOKEN }))).toMatchObject({ ok: true, target: { kind: "token", token: TOKEN } });
    expect(parseLockBadgeAttributes(attrs({ pool: POOL })).ok).toBe(false);
    expect(parseLockBadgeAttributes(attrs({ chain: "4663", pool: "0x1234" })).ok).toBe(false);
    expect(parseLockBadgeAttributes(attrs({ chain: "4663", token: "nope" })).ok).toBe(false);
    expect(parseLockBadgeAttributes(attrs({ chain: "4663" })).ok).toBe(false);
  });
});

describe("log scan windows", () => {
  it("covers the range exactly, without overlap", () => {
    expect(blockWindows(0n, 9n, 4n)).toEqual([
      { from: 0n, to: 3n },
      { from: 4n, to: 7n },
      { from: 8n, to: 9n },
    ]);
    expect(blockWindows(5n, 5n, 100n)).toEqual([{ from: 5n, to: 5n }]);
    expect(() => blockWindows(0n, 1n, 0n)).toThrow();
  });
});
