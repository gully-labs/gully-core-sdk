import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  AIRDROP_CSV_TEMPLATE,
  AIRDROP_MAX_RECIPIENTS,
  buildAirdrop,
  checkAirdropList,
  dropLeaf,
  holdersFromIndexer,
  parseRecipientsCsv,
  planHolderAirdrop,
  verifyDropClaimsFile,
  verifyMerkleProof,
} from "../src/drop/index.js";

const TOKEN = "0x0000000000000000000000000000000000007070" as Address;
const addr = (i: number): Address => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`);
const csvOf = (n: number, amt = "1.5") => Array.from({ length: n }, (_, i) => `${addr(i)},${amt}`).join("\n");

describe("airdrop product rules", () => {
  it("the template parses as the header plus two rows", () => {
    const p = parseRecipientsCsv(AIRDROP_CSV_TEMPLATE, { decimals: 18 });
    expect(p.ok).toBe(true);
    expect(p.rows).toHaveLength(2);
    expect(p.header).toBe("address,amount");
  });

  it("accepts exactly 500 and refuses 501", () => {
    const ok = checkAirdropList(parseRecipientsCsv(csvOf(500), { decimals: 18 }));
    expect(ok.ok).toBe(true);
    expect(ok.count).toBe(500);
    const bad = checkAirdropList(parseRecipientsCsv(csvOf(501), { decimals: 18 }));
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.message.includes("at most 500"))).toBe(true);
  });

  it("the cap is a parameter", () => {
    expect(checkAirdropList(parseRecipientsCsv(csvOf(5), { decimals: 18 }), { max: 4 }).ok).toBe(false);
    expect(AIRDROP_MAX_RECIPIENTS).toBe(500);
  });

  it("flags duplicates, zero amounts, and a total above the approved amount", () => {
    expect(checkAirdropList(parseRecipientsCsv(`${addr(0)},1\n${addr(0)},2`, { decimals: 18 })).ok).toBe(false);
    expect(checkAirdropList(parseRecipientsCsv(`${addr(0)},0`, { decimals: 18 })).ok).toBe(false);
    expect(checkAirdropList(parseRecipientsCsv(`${addr(0)},2`, { decimals: 0 }), { approvedTotal: 1n }).ok).toBe(false);
  });

  it("reports parser errors with their line", () => {
    const c = checkAirdropList(parseRecipientsCsv(`${addr(0)},1\nnot-an-address,2`, { decimals: 18 }));
    expect(c.ok).toBe(false);
    expect(c.issues[0]?.message).toMatch(/^Line 2/);
  });

  it("500 recipients: every proof verifies against the root and the claims file rebuilds it", () => {
    const parsed = parseRecipientsCsv(csvOf(500, "3"), { decimals: 18 });
    const a = buildAirdrop({ chainId: 485590, currency: TOKEN, recipients: parsed.rows, symbol: "T", decimals: 18 });
    expect(a.recipients).toHaveLength(500);
    expect(verifyDropClaimsFile(a.claimsFile).ok).toBe(true);
    for (const i of [0, 1, 255, 256, 499]) {
      const [c] = a.getProof(addr(i));
      expect(c?.index).toBe(i);
      expect(verifyMerkleProof(c!.proof, a.merkleRoot, dropLeaf(c!.index, c!.account, BigInt(c!.amount)))).toBe(true);
    }
    expect(a.getProof(addr(9999))).toEqual([]);
    expect(a.total).toBe(500n * 3n * 10n ** 18n);
    expect(a.claimsFile.claims[0]!.proof.length).toBeLessThanOrEqual(9);
  });

  it("sums duplicates when building, drops zeros, refuses over max or empty", () => {
    const a = buildAirdrop({ chainId: 1, currency: TOKEN, recipients: [{ account: addr(0), amount: 1n }, { account: addr(0), amount: 2n }, { account: addr(1), amount: 0n }] });
    expect(a.recipients).toEqual([{ account: addr(0), amount: 3n }]);
    expect(() => buildAirdrop({ chainId: 1, currency: TOKEN, recipients: [{ account: addr(0), amount: 1n }, { account: addr(1), amount: 1n }], max: 1 })).toThrow(/at most 1/);
    expect(() => buildAirdrop({ chainId: 1, currency: TOKEN, recipients: [] })).toThrow();
  });

  it("a holder snapshot plan goes straight in; indexer rows convert", () => {
    const holders = holdersFromIndexer([
      { address: addr(0).toLowerCase(), balance: "300" },
      { address: addr(1), balance: 100 },
      { address: addr(2), balance: "0" },
      { address: "nope", balance: "5" },
    ]);
    expect(holders).toHaveLength(2);
    const plan = planHolderAirdrop(holders, { kind: "pro-rata", budget: 1000n }, {});
    const a = buildAirdrop({ chainId: 1, currency: TOKEN, recipients: plan });
    expect(a.total).toBeLessThanOrEqual(1000n);
    expect(a.recipients[0]!.amount).toBe(750n);
  });
});

import { parseAirdropCsv } from "../src/drop/index.js";

describe("parseAirdropCsv (the shared UI parser)", () => {
  it("returns entries, row errors with line numbers and a whole-list error", () => {
    const r = parseAirdropCsv(`address,amount\n${addr(0)},1.5\n${addr(0)},2\nxyz,1\n${addr(1)},0\n${addr(2)},1.1234567890123456789`, 18, { approvedTotal: 1n });
    expect(r.entries.map((e) => e.account)).toEqual([addr(0)]);
    const lines = r.errors.map((e) => e.line).sort();
    expect(lines).toContain(3);
    expect(lines).toContain(4);
    expect(lines).toContain(5);
    expect(lines).toContain(6);
    expect(lines).toContain(0);
  });
  it("500 ok, 501 whole-list error, empty is one error", () => {
    expect(parseAirdropCsv(csvOf(500), 18).errors).toEqual([]);
    expect(parseAirdropCsv(csvOf(501), 18).errors.some((e) => e.line === 0 && /500/.test(e.message))).toBe(true);
    expect(parseAirdropCsv("", 18).errors).toHaveLength(1);
  });
});
