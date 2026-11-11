// SPDX-License-Identifier: MIT
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  DEAD_ADDRESS,
  HolderAirdropError,
  HolderScanError,
  defaultHolderExclusions,
  planHolderAirdrop,
  readHolderSnapshot,
  reduceTransfers,
  type HolderBalance,
} from "../src/drop/index.js";
import { launchAllocationFromLogs } from "../src/launchpad/kitV2/allocation.js";

const a = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const H = (n: number, balance: bigint): HolderBalance => ({ address: a(n), balance });

describe("planHolderAirdrop: pro-rata", () => {
  it("floors each share and reports the dust; the sum never exceeds the budget", () => {
    const p = planHolderAirdrop([H(1, 1n), H(2, 1n), H(3, 1n)], { kind: "pro-rata", budget: 100n });
    expect(p.recipients.map((r) => r.amount)).toEqual([33n, 33n, 33n]);
    expect(p.total).toBe(99n);
    expect(p.dust).toBe(1n);
    expect(p.total + p.dust).toBe(100n);
  });

  it("is proportional to balance, largest first", () => {
    const p = planHolderAirdrop([H(1, 10n), H(2, 30n), H(3, 60n)], { kind: "pro-rata", budget: 1000n });
    expect(p.recipients.map((r) => [r.account, r.amount])).toEqual([
      [a(3), 600n],
      [a(2), 300n],
      [a(1), 100n],
    ]);
    expect(p.dust).toBe(0n);
    expect(p.eligibleBalance).toBe(100n);
  });

  it("drops a holder whose share floors to zero and keeps its share in the dust", () => {
    const p = planHolderAirdrop([H(1, 1_000_000n), H(2, 1n)], { kind: "pro-rata", budget: 1000n });
    expect(p.recipients).toHaveLength(1);
    expect(p.recipients[0]?.amount).toBe(999n);
    expect(p.dust).toBe(1n);
    expect(p.excluded).toEqual([{ address: a(2), balance: 1n, kind: "rounds-to-zero", reason: "its share rounds down to zero" }]);
  });

  it("fuzz: sum + dust == budget and every amount is floor(budget*b/sum)", () => {
    let seed = 7n;
    const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
    for (let t = 0; t < 50; t++) {
      const hs = Array.from({ length: 1 + Number(rnd() % 40n) }, (_, i) => H(i + 1, 1n + (rnd() % 10n ** 24n)));
      const budget = rnd() % 10n ** 27n;
      const p = planHolderAirdrop(hs, { kind: "pro-rata", budget });
      const sum = hs.reduce((s, h) => s + h.balance, 0n);
      expect(p.total + p.dust).toBe(budget);
      expect(p.total <= budget).toBe(true);
      for (const r of p.recipients) expect(r.amount).toBe((budget * r.balance) / sum);
    }
  });
});

describe("planHolderAirdrop: equal and fixed", () => {
  it("equal split floors and states the remainder", () => {
    const p = planHolderAirdrop([H(1, 5n), H(2, 500n), H(3, 50n)], { kind: "equal", budget: 10n });
    expect(p.recipients.map((r) => r.amount)).toEqual([3n, 3n, 3n]);
    expect(p.dust).toBe(1n);
  });

  it("equal split below one unit each sends nothing and says why", () => {
    const p = planHolderAirdrop([H(1, 5n), H(2, 6n), H(3, 7n)], { kind: "equal", budget: 2n });
    expect(p.recipients).toHaveLength(0);
    expect(p.total).toBe(0n);
    expect(p.dust).toBe(2n);
    expect(p.excluded.every((e) => e.kind === "rounds-to-zero")).toBe(true);
  });

  it("fixed pays the same to each and has no budget or dust", () => {
    const p = planHolderAirdrop([H(1, 5n), H(2, 6n)], { kind: "fixed", amountEach: 7n });
    expect(p.total).toBe(14n);
    expect(p.budget).toBeNull();
    expect(p.dust).toBe(0n);
  });

  it("refuses nonsense inputs", () => {
    expect(() => planHolderAirdrop([], { kind: "fixed", amountEach: 0n })).toThrow(HolderAirdropError);
    expect(() => planHolderAirdrop([], { kind: "pro-rata", budget: -1n })).toThrow(HolderAirdropError);
    expect(() => planHolderAirdrop([], { kind: "equal", budget: 1n }, { topN: 0 })).toThrow(HolderAirdropError);
  });
});

describe("planHolderAirdrop: filters", () => {
  const hs = [H(1, 100n), H(2, 50n), H(3, 20n), H(4, 10n), H(5, 1n)];

  it("threshold is inclusive", () => {
    const p = planHolderAirdrop(hs, { kind: "equal", budget: 30n }, { minBalance: 20n });
    expect(p.recipients.map((r) => r.account)).toEqual([a(1), a(2), a(3)]);
    expect(p.excluded.filter((e) => e.kind === "below-minimum").map((e) => e.address)).toEqual([a(4), a(5)]);
  });

  it("exclusions and contracts, each with its reason, computed before the amounts", () => {
    const p = planHolderAirdrop(hs, { kind: "pro-rata", budget: 1000n }, {
      exclude: [{ address: a(1), reason: "the Vault" }],
      excludeContracts: true,
      contracts: [a(2).toLowerCase()],
    });
    expect(p.excluded.map((e) => [e.address, e.kind])).toEqual([
      [a(1), "listed"],
      [a(2), "contract"],
    ]);
    expect(p.eligibleBalance).toBe(31n);
    expect(p.recipients.map((r) => r.amount)).toEqual([645n, 322n, 32n]);
    expect(p.dust).toBe(1n);
  });

  it("contracts are kept unless excludeContracts is set", () => {
    const p = planHolderAirdrop(hs, { kind: "equal", budget: 5n }, { contracts: [a(2)] });
    expect(p.recipients).toHaveLength(5);
  });

  it("top N keeps the largest, ties by address", () => {
    const p = planHolderAirdrop([H(9, 5n), H(3, 5n), H(4, 9n)], { kind: "equal", budget: 4n }, { topN: 2 });
    expect(p.recipients.map((r) => r.account)).toEqual([a(4), a(3)]);
    expect(p.excluded).toEqual([{ address: a(9), balance: 5n, kind: "beyond-top-n", reason: "not in the top 2" }]);
    expect(p.dust).toBe(0n);
  });

  it("merges duplicate holders and ignores zero balances", () => {
    const p = planHolderAirdrop([H(1, 3n), H(1, 2n), H(2, 0n)], { kind: "pro-rata", budget: 10n });
    expect(p.recipients).toEqual([{ account: a(1), amount: 10n, balance: 5n }]);
  });

  it("empty set: nothing sent, the whole budget is dust", () => {
    const p = planHolderAirdrop([], { kind: "pro-rata", budget: 10n });
    expect(p.recipients).toHaveLength(0);
    expect(p.total).toBe(0n);
    expect(p.dust).toBe(10n);
    const q = planHolderAirdrop([H(1, 1n)], { kind: "equal", budget: 10n }, { exclude: [{ address: a(1), reason: "x" }] });
    expect(q.recipients).toHaveLength(0);
    expect(q.dust).toBe(10n);
  });
});

describe("defaultHolderExclusions", () => {
  /* A synthetic address book: every address is obviously fake. */
  const fake = (n: number): Address => getAddress(`0x${"dc0de".padStart(35, "0")}${n.toString(16).padStart(5, "0")}`);
  const book = {
    vault: fake(1),
    clPoolManager: fake(2),
    binPoolManager: fake(3),
    positionLock: fake(4),
    tokenLock: null,
    dropFactory: fake(6),
    multisend: null,
    launchpadV2: { clLPLocker: fake(7), binLPLocker: fake(8), launchpadKitV2: fake(9) },
    launchpadV2Retired: [{ clLPLocker: fake(10), binLPLocker: fake(8), launchpadKitV2: fake(11) }],
  } as const;

  it("reads the address book, skips nulls, dedupes, includes zero, dead and the token", () => {
    const token = a(0xabc);
    const rules = defaultHolderExclusions(book, token);
    const set = new Set(rules.map((r) => r.address.toLowerCase()));
    expect(set.has(zeroAddress)).toBe(true);
    expect(set.has(DEAD_ADDRESS.toLowerCase())).toBe(true);
    expect(set.has(token.toLowerCase())).toBe(true);
    for (const n of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) expect(set.has(fake(n).toLowerCase())).toBe(true);
    /* zero, dead, token + ten distinct book addresses (the retired bin locker repeats one). */
    expect(rules.length).toBe(13);
    expect(rules.length).toBe(set.size);
  });
});

/* ------------------------------------------------------------- the scan --- */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function fakeClient(opts: { logs: { block: bigint; from: Address; to: Address; value: bigint }[]; supply: bigint; maxRange?: bigint; head?: bigint; supplyFails?: boolean }) {
  const calls: [bigint, bigint][] = [];
  const client = {
    getBlockNumber: async () => opts.head ?? 1000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (opts.maxRange !== undefined && toBlock - fromBlock + 1n > opts.maxRange) throw new Error("range too large");
      calls.push([fromBlock, toBlock]);
      return opts.logs.filter((l) => l.block >= fromBlock && l.block <= toBlock).map((l) => ({ args: { from: l.from, to: l.to, value: l.value } }));
    },
    readContract: async () => {
      if (opts.supplyFails === true) throw new Error("missing trie node");
      return opts.supply;
    },
    getBlock: async () => ({ timestamp: 1234n }),
  };
  return { client: client as never, calls };
}

describe("readHolderSnapshot", () => {
  const mint = { block: 10n, from: zeroAddress, to: a(1), value: 100n };
  const t1 = { block: 500n, from: a(1), to: a(2), value: 40n };
  const burn = { block: 900n, from: a(2), to: zeroAddress, value: 10n };

  it("reduces, verifies against totalSupply at the snapshot, and windows adaptively", async () => {
    const { client, calls } = fakeClient({ logs: [mint, t1, burn], supply: 90n, maxRange: 300n });
    const s = await readHolderSnapshot(client, a(0xdd), { fromBlock: 0n, snapshotBlock: 1000n, window: 1000n, minWindow: 100n });
    expect(s.holders).toEqual([
      { address: a(1), balance: 60n },
      { address: a(2), balance: 30n },
    ]);
    expect(s.totalSupply).toBe(90n);
    expect(s.snapshotTimestamp).toBe(1234n);
    expect(calls.every(([f, t]) => t - f + 1n <= 300n)).toBe(true);
    expect(calls[0]?.[0]).toBe(0n);
    expect(calls[calls.length - 1]?.[1]).toBe(1000n);
  });

  it("refuses a scan that starts after the mint (negative balance)", async () => {
    const { client } = fakeClient({ logs: [mint, t1], supply: 100n });
    await expect(readHolderSnapshot(client, a(0xdd), { fromBlock: 100n, snapshotBlock: 1000n })).rejects.toThrow(HolderScanError);
  });

  it("refuses when the sum does not match totalSupply (rebasing, or logs missing)", async () => {
    const { client } = fakeClient({ logs: [mint, t1], supply: 101n });
    await expect(readHolderSnapshot(client, a(0xdd), { fromBlock: 0n, snapshotBlock: 1000n })).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("refuses when the RPC refuses even the smallest window", async () => {
    const { client } = fakeClient({ logs: [mint], supply: 100n, maxRange: 10n });
    await expect(readHolderSnapshot(client, a(0xdd), { fromBlock: 0n, snapshotBlock: 1000n, window: 800n, minWindow: 100n })).rejects.toMatchObject({ kind: "logs" });
  });

  it("refuses when totalSupply at the snapshot cannot be read", async () => {
    const { client } = fakeClient({ logs: [mint], supply: 100n, supplyFails: true });
    await expect(readHolderSnapshot(client, a(0xdd), { fromBlock: 0n, snapshotBlock: 1000n })).rejects.toMatchObject({ kind: "supply" });
  });

  it("reduceTransfers keeps negatives so a late start is visible", () => {
    const b = reduceTransfers([t1]);
    expect(b.get(a(1).toLowerCase())).toBe(-40n);
  });
});

/* ------------------------------------------------------- the allocation --- */

describe("launchAllocationFromLogs", () => {
  const token = a(0x70);
  const kit = a(0x71);
  const vault = a(0x72);
  const log = (from: Address, to: Address, value: bigint, address: Address = token) => ({
    address,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from, to } }) as [`0x${string}`, ...`0x${string}`[]],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  });

  it("finds the kit's transfer to the recipient, ignoring the mint and the Vault settlement", () => {
    const logs = [log(zeroAddress, kit, 1000n), log(kit, vault, 600n), log(kit, vault, 199n), log(a(0x99), a(0x98), 5n, a(0x55)), log(kit, a(0x42), 201n)];
    const r = launchAllocationFromLogs({ logs, token, kit, vault, totalSupply: 1000n, seedSupply: 800n });
    expect(r).toEqual({ recipient: a(0x42), amount: 201n, unseeded: 200n, dust: 1n, dustOnly: false });
  });

  it("whole supply seeded: dust only, flagged", () => {
    const r = launchAllocationFromLogs({ logs: [log(kit, vault, 999n), log(kit, a(0x42), 1n)], token, kit, vault, totalSupply: 1000n, seedSupply: 1000n });
    expect(r?.dustOnly).toBe(true);
    expect(r?.dust).toBe(1n);
  });

  it("no transfer except to the Vault: null", () => {
    expect(launchAllocationFromLogs({ logs: [log(kit, vault, 1000n)], token, kit, vault, totalSupply: 1000n, seedSupply: 1000n })).toBeNull();
  });
});
