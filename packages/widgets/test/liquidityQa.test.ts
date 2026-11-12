// SPDX-License-Identifier: MIT
/**
 * The QA follow-ups of 2026-09-19 (second pass): the liquidity widget checks
 * the wallet's balances before an approval or a deposit, re-reads its own lists
 * after a confirmed change, and deadlines take the next block's clock.
 */

import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import type { PositionInfo, PoolInfo, TokenInfo } from "../src/adapters/protocol.js";
import { createViemAdapter } from "../src/adapters/viem.js";
import { chainDeadline, defaultDeadline, explorerTxUrl, nextBlockClock, type ChainConfig } from "../src/config/chain.js";
import { InsufficientBalanceError, depositRequirements, findShortfall, isNativeToken } from "../src/core/liquidityGuards.js";
import { bumpOnConfirmed, reconcileSelection, withdrawablePositions } from "../src/core/liquidityRefresh.js";
import { describeError } from "../src/core/errors.js";

const ETH: TokenInfo = { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", decimals: 18, isNative: true };
const USDC: TokenInfo = { address: "0x00000000000000000000000000000000000000aa", symbol: "USDC", name: "USD Coin", decimals: 6 };
const TKN: TokenInfo = { address: "0x00000000000000000000000000000000000000bb", symbol: "TKN", name: "Token", decimals: 18 };

const quoteOf = (token0: TokenInfo, token1: TokenInfo, amount0: bigint, amount1: bigint) => ({ pool: { token0, token1 }, amount0, amount1 });

describe("deposit balance check", () => {
  it("native: compares the transaction value (the side's max) with the balance, no invented gas reserve", () => {
    const req = depositRequirements(quoteOf(ETH, USDC, 1_000n, 500n), 1_005n, 503n);
    expect(req).toEqual([
      { token: ETH, required: 1_005n },
      { token: USDC, required: 500n },
    ]);
    /* 1_004 wei cannot pay a 1_005 wei value: insufficient native. */
    expect(findShortfall(req, [1_004n, 10_000n])).toBe(ETH);
    /* Exactly the value is enough: nothing is held back for gas. */
    expect(findShortfall(req, [1_005n, 10_000n])).toBeNull();
  });

  it("ERC-20: compares the quoted pull, not the slippage cap, and names the short token", () => {
    const req = depositRequirements(quoteOf(USDC, TKN, 500n, 7_000n), 503n, 7_035n);
    expect(req).toEqual([
      { token: USDC, required: 500n },
      { token: TKN, required: 7_000n },
    ]);
    expect(findShortfall(req, [10_000n, 6_999n])).toBe(TKN);
    /* A wallet holding the quoted amount but not the cap can still deposit. */
    expect(findShortfall(req, [500n, 7_000n])).toBeNull();
    /* The first short token in pool order is the one reported. */
    expect(findShortfall(req, [499n, 1n])).toBe(USDC);
  });

  it("sufficient balances report nothing; unread balances are never called insufficient", () => {
    const req = depositRequirements(quoteOf(USDC, TKN, 500n, 7_000n), 503n, 7_035n);
    expect(findShortfall(req, [1_000_000n, 1_000_000n])).toBeNull();
    expect(findShortfall(req, [null, null])).toBeNull();
    expect(findShortfall(req, [])).toBeNull();
  });

  it("a one-sided deposit requires nothing of the other token", () => {
    const req = depositRequirements(quoteOf(ETH, USDC, 0n, 900n), 0n, 905n);
    expect(req).toEqual([{ token: USDC, required: 900n }]);
    expect(findShortfall(req, [0n])).toBe(USDC);
  });

  it("recognises native by flag or by the zero address, and refuses with a readable message", () => {
    expect(isNativeToken(ETH)).toBe(true);
    expect(isNativeToken({ ...ETH, isNative: undefined } as unknown as TokenInfo)).toBe(true);
    expect(isNativeToken(USDC)).toBe(false);
    const e = new InsufficientBalanceError(USDC);
    expect(describeError(e, "liquidity")).toMatch(/^Insufficient USDC/);
  });
});

const pool = { id: "0xpool" } as unknown as PoolInfo;
function position(id: string, liquidity: bigint, fees0 = 0n, fees1 = 0n): PositionInfo {
  return {
    id,
    pool,
    range: { type: "CL", tickLower: -60, tickUpper: 60 },
    liquidity,
    amount0: liquidity,
    amount1: liquidity,
    feesOwed0: fees0,
    feesOwed1: fees1,
    inRange: true,
    source: "live",
  };
}

describe("refetch after a confirmed change", () => {
  it("a confirmation advances the widget's refresh counter, then tells the host", () => {
    const order: string[] = [];
    let key = 0;
    const host = vi.fn((hash: string) => order.push(`host:${hash}`));
    const onChanged = bumpOnConfirmed<string>(() => {
      key += 1;
      order.push("bump");
    }, host);
    onChanged("0xabc");
    onChanged("0xdef");
    expect(key).toBe(2);
    expect(order).toEqual(["bump", "host:0xabc", "bump", "host:0xdef"]);
    /* No host callback: still refreshes. */
    const bare = bumpOnConfirmed<string>(() => {
      key += 1;
    }, undefined);
    bare("0x1");
    expect(key).toBe(3);
  });

  it("the counter still moves when the host's callback throws", () => {
    let key = 0;
    const onChanged = bumpOnConfirmed<string>(() => {
      key += 1;
    }, () => {
      throw new Error("host bug");
    });
    expect(() => onChanged("0x1")).toThrow("host bug");
    expect(key).toBe(1);
  });

  it("a position removed to zero drops out of the picker; one with owed fees stays", () => {
    const list = [position("cl:1", 0n), position("cl:2", 5n), position("cl:3", 0n, 1n)];
    expect(withdrawablePositions(list).map((p) => p.id)).toEqual(["cl:2", "cl:3"]);
  });

  it("the selection follows the FRESH record after a re-read, else falls to the first, else null", () => {
    const before = position("cl:2", 100n);
    const after = position("cl:2", 40n);
    const picked = reconcileSelection(before, [position("cl:1", 9n), after]);
    expect(picked).toBe(after);
    expect(picked?.liquidity).toBe(40n);
    /* Fully removed: the list no longer carries it. */
    expect(reconcileSelection(before, withdrawablePositions([position("cl:2", 0n), position("cl:7", 3n)]))?.id).toBe("cl:7");
    expect(reconcileSelection(before, [])).toBeNull();
    expect(reconcileSelection(null, [after])).toBe(after);
  });
});

const chain = { defaultDeadlineSeconds: 1200 } as unknown as ChainConfig;
const now = () => BigInt(Math.floor(Date.now() / 1000));

describe("deadline base selection", () => {
  it("base = max(chain clock, local clock)", () => {
    const ahead = now() + 7n * 86_400n;
    expect(defaultDeadline(chain, ahead)).toBe(ahead + 1200n);
    const behind = now() - 50_000n;
    const d = defaultDeadline(chain, behind);
    expect(d >= now() + 1200n && d <= now() + 1201n).toBe(true);
    const local = defaultDeadline(chain);
    expect(local >= now() + 1200n && local <= now() + 1201n).toBe(true);
  });

  it("the next block's clock is the later of pending and latest, ignoring an unread one", () => {
    expect(nextBlockClock(2_000n, 1_000n)).toBe(2_000n);
    expect(nextBlockClock(1_000n, 1_000n)).toBe(1_000n);
    /* A pending block that echoes an older view never pulls the clock back. */
    expect(nextBlockClock(900n, 1_000n)).toBe(1_000n);
    expect(nextBlockClock(null, 1_000n)).toBe(1_000n);
    expect(nextBlockClock(2_000n, null)).toBe(2_000n);
    expect(nextBlockClock(null, null)).toBeNull();
  });

  it("an idle chain AHEAD of wall time: the pending block carries the deadline past the next block", async () => {
    /* Chain clock runs 30 days ahead; the last block is 2 hours old on that
       clock, longer than the 20-minute window. latest + window would already
       be behind the next block's stamp; pending + window is not. */
    const offset = 30n * 86_400n;
    const nextStamp = now() + offset;
    const latest = nextStamp - 7_200n;
    const client = {
      async getBlock({ blockTag }: { blockTag: string }) {
        return { timestamp: blockTag === "pending" ? nextStamp : latest };
      },
    } as unknown as PublicClient;
    const adapter = createViemAdapter({ chain: fakeChain(), publicClient: client, tokens: [], pools: [] });
    const deadline = await chainDeadline(chain, adapter);
    expect(deadline).toBe(nextStamp + 1200n);
    expect(latest + 1200n < nextStamp).toBe(true);
  });

  it("an RPC with no pending block falls back to the latest block; no block at all falls back to local", async () => {
    const latest = now() + 86_400n;
    const noPending = {
      async getBlock({ blockTag }: { blockTag: string }) {
        if (blockTag === "pending") throw new Error("pending not supported");
        return { timestamp: latest };
      },
    } as unknown as PublicClient;
    expect(await chainDeadline(chain, createViemAdapter({ chain: fakeChain(), publicClient: noPending, tokens: [], pools: [] }))).toBe(latest + 1200n);

    const down = {
      async getBlock() {
        throw new Error("rpc down");
      },
    } as unknown as PublicClient;
    const d = await chainDeadline(chain, createViemAdapter({ chain: fakeChain(), publicClient: down, tokens: [], pools: [] }));
    expect(d >= now() + 1200n && d <= now() + 1201n).toBe(true);
  });
});

describe("explorer links in the widgets", () => {
  it("an empty or missing explorer is none; a trailing slash is dropped", () => {
    expect(explorerTxUrl({}, "0xab")).toBeNull();
    expect(explorerTxUrl({ blockExplorerUrl: "" }, "0xab")).toBeNull();
    expect(explorerTxUrl({ blockExplorerUrl: "   " }, "0xab")).toBeNull();
    expect(explorerTxUrl({ blockExplorerUrl: "https://scan.example/" }, "0xab")).toBe("https://scan.example/tx/0xab");
  });
});

function fakeChain(): ChainConfig {
  return {
    chainId: 31337,
    name: "Fake",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    contracts: {
      vault: "0x00000000000000000000000000000000000000a1",
      clPoolManager: "0x00000000000000000000000000000000000000a2",
      binPoolManager: "0x00000000000000000000000000000000000000a3",
    },
  };
}
