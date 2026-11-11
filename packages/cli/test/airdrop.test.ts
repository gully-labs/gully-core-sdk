import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concat, encodeAbiParameters, getAddress, keccak256, type Hex } from "viem";
import { afterAll, describe, expect, it, vi } from "vitest";

import { runAirdrop } from "../src/commands/airdrop.js";

/**
 * An independent Merkle builder written from GullyCoreMerkleDrop's NatSpec — OpenZeppelin's double-hashed
 * leaf and sorted-pair hashing — so the SDK tree the CLI uses is checked against a second
 * implementation rather than against itself. (The devnet run checks it against the contract.)
 */
function leaf(i: number, account: string, amount: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(i), getAddress(account), amount])));
}
function pair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}
function root(leaves: Hex[]): Hex {
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(level[i + 1] === undefined ? (level[i] as Hex) : pair(level[i] as Hex, level[i + 1] as Hex));
    level = next;
  }
  return level[0] as Hex;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ROWS: Array<[string, string, bigint]> = [
  ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "100", 100n * 10n ** 18n],
  ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "2.5", 25n * 10n ** 17n],
  ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0.000001", 10n ** 12n],
  ["0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "7", 7n * 10n ** 18n],
  ["0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", "1", 10n ** 18n],
];

describe("gullycore airdrop build", () => {
  it("writes a claims file whose root matches an independent builder, with --json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gullycore-drop-"));
    dirs.push(dir);
    const csv = join(dir, "r.csv");
    writeFileSync(csv, `address,amount\n${ROWS.map(([a, amt]) => `${a},${amt}`).join("\n")}\n`);
    const out = join(dir, "claims.json");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let code: number;
    try {
      code = await runAirdrop(["build", "--csv", csv, "--token", "0x0000000000000000000000000000000000000001", "--decimals", "18", "--chain", "999", "--out", out, "--json"]);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
    expect(code).toBe(0);
    const doc = JSON.parse(writes.join("")) as { schema: string; ok: boolean; command: string; result: { root: string; total: string; claims: number } };
    expect(doc.schema).toBe("gullycore.cli/1");
    expect(doc.command).toBe("airdrop build");
    expect(doc.ok).toBe(true);
    const expected = root(ROWS.map(([a, , amt], i) => leaf(i, a, amt)));
    expect(doc.result.root).toBe(expected);
    expect(doc.result.claims).toBe(5);
    expect(doc.result.total).toBe(ROWS.reduce((s, r) => s + r[2], 0n).toString());

    const file = JSON.parse(readFileSync(out, "utf8")) as { merkleRoot: string; claims: Array<{ index: number; account: string; amount: string; proof: Hex[] }> };
    expect(file.merkleRoot).toBe(expected);
    for (const c of file.claims) {
      let h = leaf(c.index, c.account, BigInt(c.amount));
      for (const p of c.proof) h = pair(h, p);
      expect(h).toBe(expected);
    }
  });

  it("refuses a CSV with an error and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gullycore-drop-"));
    dirs.push(dir);
    const csv = join(dir, "bad.csv");
    writeFileSync(csv, "0xnotanaddress,1\n");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runAirdrop(["build", "--csv", csv, "--token", "native", "--decimals", "18", "--chain", "999", "--out", join(dir, "c.json")])).rejects.toThrow(/has errors/);
    } finally {
      err.mockRestore();
    }
  });
});
