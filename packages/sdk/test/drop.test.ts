import { concat, decodeFunctionData, encodeAbiParameters, getAddress, getContractAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_DROP_FACTORY_ABI,
  GULLYCORE_MERKLE_DROP_ABI,
  GULLYCORE_MULTISEND_ABI,
  MULTISEND_MAX_RECIPIENTS,
  batchRecipients,
  buildClaimDrop,
  buildCreateDrop,
  buildDropClaimsFile,
  buildDropTree,
  buildMultisendNative,
  claimsOf,
  dropLeaf,
  formatAmountExact,
  hashPairSorted,
  mergeDuplicateRecipients,
  parseAmountExact,
  parseDropClaimsFile,
  parseRecipientsCsv,
  planMultisend,
  validateDropDraft,
  verifyDropClaimsFile,
  verifyMerkleProof,
} from "../src/drop/index.js";

const E18 = 10n ** 18n;
const TERMS = { feeWei: 75_000_000_000_000_000n, pendingFee: null };
const MS = "0x00000000000000000000000000000000000005e7" as Address;
const FACTORY = "0x000000000000000000000000000000000000fac7" as Address;
const TOKEN = "0x0000000000000000000000000000000000007070" as Address;

/* ---------------------------------------------------------------- golden --- */

/**
 * The 4-leaf tree of packages/launchpad/test/drop/GullyCoreDrop.t.sol. Its root was
 * read from the Solidity test's own `DropCreated` event
 * (`forge test --match-test test_CREATE_fundsTheCloneChargesTheFee -vvvv`, 2026-09-18).
 * accounts[2] is the test's `ContractAccount` and PROOF_2 the proof the test
 * passed for it, both read from the trace of
 * `test_CLAIM_contractAccountMustClaimItself -vvvv` on the same day.
 */
const CONTRACT_ACCOUNT = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as Address;
const PROOF_2 = [
  "0x3ed386a536ea9b15a2dfb98f3714d980daf96fe63b528014a702bcf6e8dcb7b3",
  "0xb2ef36660faaff37e39110f9f554265a3d86fc1d404bad98107f4761d94f3aaf",
];
const FORGE_TEST_CONTRACT = "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496" as Address;
const GOLDEN_ROOT = "0xe452b1d263741e16278073cfbd1ae051113e844203f1d0fa227c781aec6c3db1";

describe("Merkle drop tree: golden vector from the Solidity test", () => {
  const token = getContractAddress({ from: FORGE_TEST_CONTRACT, nonce: 2n });
  const accounts: Address[] = [
    "0x00000000000000000000000000000000000000a1",
    "0x00000000000000000000000000000000000000a2",
    CONTRACT_ACCOUNT,
    "0x00000000000000000000000000000000000000a4",
  ];
  const amounts = [10n * E18, 20n * E18, 30n * E18, 40n * E18];
  const recipients = accounts.map((account, i) => ({ account, amount: amounts[i] as bigint }));

  it("derives the test's addresses the way forge does (sanity: the MockERC20 in the trace)", () => {
    expect(token).toBe("0x2e234DAe75C793f67A35089C9d99245E1C58470b");
  });

  it("reproduces the root the contract test built, and its layout", () => {
    const tree = buildDropTree(recipients);
    expect(tree.root).toBe(GOLDEN_ROOT);
    expect(tree.proof(2)).toEqual(PROOF_2);
    // The test's own construction, restated independently of buildDropTree.
    const leaf = (i: number) =>
      keccak256(
        keccak256(
          encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(i), accounts[i] as Address, amounts[i] as bigint]),
        ),
      );
    const pair = (a: Hex, b: Hex) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
    expect(pair(pair(leaf(0), leaf(1)), pair(leaf(2), leaf(3)))).toBe(GOLDEN_ROOT);
    expect(tree.layers[0]).toEqual([0, 1, 2, 3].map(leaf));
  });

  it("gives the test's `_proof(i)` for every leaf, and each verifies", () => {
    const tree = buildDropTree(recipients);
    const leaves = tree.layers[0] as Hex[];
    for (let i = 0; i < 4; i++) {
      const other = i < 2 ? 1 : 0;
      const expected = [leaves[i ^ 1] as Hex, hashPairSorted(leaves[other * 2] as Hex, leaves[other * 2 + 1] as Hex)];
      expect(tree.proof(i)).toEqual(expected);
      expect(verifyMerkleProof(tree.proof(i), GOLDEN_ROOT, dropLeaf(i, accounts[i] as Address, amounts[i] as bigint))).toBe(true);
    }
    // The test's refusals: a wrong amount, a wrong account.
    expect(verifyMerkleProof(tree.proof(0), GOLDEN_ROOT, dropLeaf(0, accounts[0] as Address, (amounts[0] as bigint) + 1n))).toBe(false);
    expect(verifyMerkleProof(tree.proof(0), GOLDEN_ROOT, dropLeaf(0, "0x0000000000000000000000000000000000000BAD", amounts[0] as bigint))).toBe(false);
  });
});

describe("buildDropTree", () => {
  const acct = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;
  it("verifies every proof for odd and even sizes 1..33", () => {
    for (let n = 1; n <= 33; n++) {
      const rows = Array.from({ length: n }, (_, i) => ({ account: acct(i), amount: BigInt(i * 7 + 1) }));
      const tree = buildDropTree(rows);
      for (let i = 0; i < n; i++) expect(verifyMerkleProof(tree.proof(i), tree.root, dropLeaf(i, acct(i), BigInt(i * 7 + 1)))).toBe(true);
    }
  });
  it("a one-leaf tree's root is the leaf and its proof is empty", () => {
    const tree = buildDropTree([{ account: acct(0), amount: 5n }]);
    expect(tree.root).toBe(dropLeaf(0, acct(0), 5n));
    expect(tree.proof(0)).toEqual([]);
  });
  it("refuses an empty list and an unknown index", () => {
    expect(() => buildDropTree([])).toThrow();
    expect(() => buildDropTree([{ account: acct(0), amount: 1n }]).proof(1)).toThrow();
  });
});

describe("claims file", () => {
  const rows = [
    { account: "0x00000000000000000000000000000000000000a1" as Address, amount: 5n },
    { account: "0x00000000000000000000000000000000000000a2" as Address, amount: 7n },
    { account: "0x00000000000000000000000000000000000000a1" as Address, amount: 1n },
  ];
  const file = buildDropClaimsFile({ chainId: 4663, currency: TOKEN, recipients: rows, symbol: "T", decimals: 18 });

  it("round-trips through JSON and verifies against the drop's root", () => {
    const back = parseDropClaimsFile(JSON.stringify(file));
    expect(back).toEqual(file);
    expect(verifyDropClaimsFile(back, { root: file.merkleRoot, chainId: 4663, currency: TOKEN })).toEqual({ ok: true, issues: [], rebuiltRoot: file.merkleRoot });
    expect(file.total).toBe("13");
    expect(claimsOf(back, "0x00000000000000000000000000000000000000a1").map((c) => c.index)).toEqual([0, 2]);
  });

  it("catches a tampered amount, a wrong root, chain and currency", () => {
    const tampered = { ...file, claims: file.claims.map((c, i) => (i === 1 ? { ...c, amount: "700" } : c)) };
    const r = verifyDropClaimsFile(tampered);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/do not produce/);
    const other = verifyDropClaimsFile(file, { root: `0x${"11".repeat(32)}`, chainId: 1, currency: zeroAddress });
    expect(other.issues.length).toBe(3);
  });

  it("refuses malformed input with a reason", () => {
    expect(() => parseDropClaimsFile({ ...file, format: "x" })).toThrow(/Not a/);
    expect(() => parseDropClaimsFile({ ...file, claims: [{ ...file.claims[0], index: 3 }] })).toThrow(/index order/);
    expect(() => parseDropClaimsFile({ ...file, claims: [{ ...file.claims[0], amount: "1.5" }] })).toThrow(/base-unit/);
  });
});

/* ---------------------------------------------------------------- amounts --- */

describe("parseAmountExact / formatAmountExact", () => {
  it("parses decimals exactly", () => {
    expect(parseAmountExact("0.1", 18)).toBe(100_000_000_000_000_000n);
    expect(parseAmountExact("12.5", 6)).toBe(12_500_000n);
    expect(parseAmountExact(".5", 2)).toBe(50n);
    expect(parseAmountExact("5.", 2)).toBe(500n);
    expect(parseAmountExact("1.2300", 2)).toBe(123n);
    expect(parseAmountExact("123456789012345678901234567890", 0)).toBe(123456789012345678901234567890n);
  });
  it("refuses what is not plain or too precise", () => {
    for (const bad of ["", ".", "-1", "+1", "1e3", "1,000", "1.2.3", "abc", "0x10"]) expect(() => parseAmountExact(bad, 18)).toThrow();
    expect(() => parseAmountExact("0.001", 2)).toThrow(/3 decimal places/);
  });
  it("formats back", () => {
    expect(formatAmountExact(12_500_000n, 6)).toBe("12.5");
    expect(formatAmountExact(0n, 18)).toBe("0");
    expect(formatAmountExact(7n, 0)).toBe("7");
    expect(formatAmountExact(1n, 18)).toBe("0.000000000000000001");
  });
});

describe("parseRecipientsCsv", () => {
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000B2";
  it("reads comma, semicolon, tab and space separated lines, a header and comments", () => {
    const text = ["address,amount", `${A},1.5`, "# note", "", `${B};2`, `"${A.replace("a1", "c3")}"\t0.25`, `${A.replace("a1", "d4")}  3`].join("\n");
    const r = parseRecipientsCsv(text, { decimals: 18 });
    expect(r.header).toBe("address,amount");
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.line)).toEqual([2, 5, 6, 7]);
    expect(r.total).toBe(6_750_000_000_000_000_000n);
    expect(r.rows[1]?.account).toBe(getAddress(B));
  });
  it("reports every problem with its line", () => {
    const r = parseRecipientsCsv(
      [`${A},1`, "0x123,1", `${zeroAddress},1`, `${B},1.0000001`, `${A},2`, `${B},0`, `${B}`, `${B},1,000`, "0xAbCdEf0000000000000000000000000000000001,1"].join("\n"),
      { decimals: 6 },
    );
    expect(r.ok).toBe(false);
    const at = (line: number) => r.issues.filter((i) => i.line === line).map((i) => i.severity);
    expect(at(2)).toEqual(["error"]);
    expect(at(3)).toEqual(["error"]);
    expect(at(4)).toEqual(["error"]);
    expect(at(5)).toEqual(["warning"]); // duplicate kept
    expect(at(6)).toEqual(["warning"]); // zero amount
    expect(at(7)).toEqual(["error"]);
    expect(at(8)).toEqual(["error"]);
    expect(at(9)).toEqual(["error"]); // bad checksum
    expect(r.rows.map((x) => x.line)).toEqual([1, 5, 6]);
  });
  it("base units and duplicate refusal", () => {
    const r = parseRecipientsCsv(`${A},100\n${A},5`, { decimals: 18, unit: "base", duplicates: "error" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.amount).toBe(100n);
    expect(r.ok).toBe(false);
    expect(
      mergeDuplicateRecipients([
        { account: A as Address, amount: 1n },
        { account: B as Address, amount: 2n },
        { account: A as Address, amount: 3n },
      ]),
    ).toEqual([
      { account: A, amount: 4n },
      { account: B, amount: 2n },
    ]);
  });
  it("an empty paste is an error, not an empty success", () => {
    expect(parseRecipientsCsv("\n\n", { decimals: 18 }).ok).toBe(false);
  });
});

/* -------------------------------------------------------------- multisend --- */

describe("multisend", () => {
  const rows = Array.from({ length: 2_345 }, (_, i) => ({ account: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, amount: BigInt(i + 1) }));
  it("batches a list over 1,000", () => {
    expect(batchRecipients(rows).map((b) => b.length)).toEqual([1000, 1000, 345]);
    expect(() => batchRecipients(rows, 1001)).toThrow();
  });
  it("plans native: every batch carries its sum plus the fee", () => {
    const plan = planMultisend({ multisend: MS, currency: zeroAddress, recipients: rows, terms: TERMS });
    expect(plan.batches).toHaveLength(3);
    expect(plan.approval).toBeNull();
    const sum = rows.reduce((s, r) => s + r.amount, 0n);
    expect(plan.totalAmount).toBe(sum);
    expect(plan.totalValue).toBe(sum + 3n * TERMS.feeWei);
    const d = decodeFunctionData({ abi: GULLYCORE_MULTISEND_ABI, data: plan.batches[2]!.call.data });
    expect(d.functionName).toBe("multisendNative");
    expect((d.args as readonly unknown[])[0]).toHaveLength(345);
  });
  it("plans a token: exact approval for the total, the fee (and a pending increase) per call", () => {
    const terms = { feeWei: 10n, pendingFee: { feeWei: 25n, effectiveAt: 99n } };
    const plan = planMultisend({ multisend: MS, currency: TOKEN, recipients: rows.slice(0, 3), terms });
    expect(plan.approval).toEqual({ token: TOKEN, spender: MS, amount: 6n });
    expect(plan.batches[0]!.call.value).toBe(25n);
    const d = decodeFunctionData({ abi: GULLYCORE_MULTISEND_ABI, data: plan.batches[0]!.call.data });
    expect(d.functionName).toBe("multisendToken");
    expect(d.args).toEqual([TOKEN, rows.slice(0, 3).map((r) => r.account), [1n, 2n, 3n]]);
  });
  it("refuses an empty or oversize single call", () => {
    expect(() => buildMultisendNative({ multisend: MS, recipients: [], terms: TERMS })).toThrow();
    expect(() => buildMultisendNative({ multisend: MS, recipients: rows.slice(0, MULTISEND_MAX_RECIPIENTS + 1), terms: TERMS })).toThrow();
  });
});

/* ------------------------------------------------------------------- drop --- */

describe("drop builders", () => {
  const root = `0x${"ab".repeat(32)}` as Hex;
  it("createDrop: native carries the amount plus fee; token only the fee", () => {
    const n = buildCreateDrop({ factory: FACTORY, currency: zeroAddress, amount: 100n, merkleRoot: root, expiresAt: 1000n, metadataURI: "ipfs://x", terms: TERMS });
    expect(n.value).toBe(100n + TERMS.feeWei);
    const t = buildCreateDrop({ factory: FACTORY, currency: TOKEN, amount: 100n, merkleRoot: root, expiresAt: 1000n, metadataURI: "", terms: TERMS });
    expect(t.value).toBe(TERMS.feeWei);
    expect(decodeFunctionData({ abi: GULLYCORE_DROP_FACTORY_ABI, data: t.data }).args).toEqual([TOKEN, 100n, root, 1000n, ""]);
  });
  it("claim encodes the leaf's own fields", () => {
    const c = buildClaimDrop({ drop: FACTORY, claim: { index: 3, account: TOKEN, amount: "9", proof: [root] } });
    expect(decodeFunctionData({ abi: GULLYCORE_MERKLE_DROP_ABI, data: c.data }).args).toEqual([3n, TOKEN, 9n, [root]]);
  });
  it("validateDropDraft names every createDrop rule", () => {
    const now = 1_000_000n;
    expect(validateDropDraft({ amount: 1n, merkleRoot: root, expiresAt: now + 86_400n, metadataURI: "", nowSeconds: now })).toEqual([]);
    const issues = validateDropDraft({ amount: 0n, merkleRoot: `0x${"0".repeat(64)}`, expiresAt: now + 3600n, metadataURI: "x".repeat(2049), nowSeconds: now });
    expect(issues.map((i) => i.field)).toEqual(["amount", "merkleRoot", "expiresAt", "metadataURI"]);
    expect(validateDropDraft({ amount: 1n, merkleRoot: root, expiresAt: now + 6n * 365n * 86_400n, metadataURI: "", nowSeconds: now })[0]?.field).toBe("expiresAt");
  });
});
