import { decodeFunctionData, getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_SPLIT_ABI,
  GULLYCORE_SPLIT_FACTORY_ABI,
  NATIVE_CURRENCY,
  SPLIT_MAX_PAYEES,
  buildCollectAndReleaseAll,
  buildCreateSplit,
  encodeCreateSplit,
  splitSafeValue,
  validateSplitDraft,
  type SplitSource,
} from "../src/split/index.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const LOCKER = "0x00000000000000000000000000000000000010c0" as Address;
const KIT = "0x000000000000000000000000000000000000c17a" as Address;
const TOKEN = "0x0000000000000000000000000000000000007070" as Address;
const SPLIT = "0x000000000000000000000000000000000000511f" as Address;

describe("validateSplitDraft", () => {
  it("accepts a plain two-payee split", () => {
    expect(validateSplitDraft({ name: "Team", payees: [{ address: A, weight: 6000 }, { address: B, weight: 4000n }] })).toEqual([]);
  });

  it("names every rule the contract enforces", () => {
    const issues = validateSplitDraft({
      name: "",
      payees: [
        { address: "nope", weight: 1 },
        { address: zeroAddress, weight: 1 },
        { address: A, weight: 0 },
        { address: A.toUpperCase().replace("0X", "0x"), weight: 1.5 },
        { address: B, weight: 2n ** 96n, label: "x".repeat(33) },
      ],
    });
    const byField = (f: string) => issues.filter((i) => i.field === f);
    expect(byField("name")).toHaveLength(1);
    expect(byField("address").map((i) => i.index)).toEqual([0, 1, 3]);
    expect(byField("weight").map((i) => i.index)).toEqual([2, 3, 4]);
    expect(byField("label").map((i) => i.index)).toEqual([4]);
  });

  it("caps the name in bytes and the payee count", () => {
    expect(validateSplitDraft({ name: "é".repeat(33), payees: [{ address: A, weight: 1 }] })[0]?.field).toBe("name");
    const many = Array.from({ length: SPLIT_MAX_PAYEES + 1 }, (_, i) => ({
      address: getAddress(`0x${(0x1000 + i).toString(16).padStart(40, "0")}`),
      weight: 1,
    }));
    expect(validateSplitDraft({ name: "T", payees: many }).some((i) => i.field === "payees")).toBe(true);
    expect(validateSplitDraft({ name: "T", payees: [] })[0]?.field).toBe("payees");
  });
});

describe("create", () => {
  it("pays the higher of the fee and a pending increase", () => {
    expect(splitSafeValue({ feeWei: 5n, pendingFee: null })).toBe(5n);
    expect(splitSafeValue({ feeWei: 5n, pendingFee: { value: 9n, effectiveAt: 1n } })).toBe(9n);
    expect(splitSafeValue({ feeWei: 5n, pendingFee: { value: 2n, effectiveAt: 1n } })).toBe(5n);
  });

  it("encodes createSplit with the share the creator saw as the limit", () => {
    const tx = buildCreateSplit({
      factory: SPLIT,
      draft: { name: "Team", payees: [{ address: A, weight: 6000, label: "alice" }, { address: B, weight: 4000 }] },
      terms: { feeWei: 1n, pendingFee: { value: 3n, effectiveAt: 9n }, protocolShareBps: 100 },
    });
    expect(tx.value).toBe(3n);
    const decoded = decodeFunctionData({ abi: GULLYCORE_SPLIT_FACTORY_ABI, data: tx.data });
    expect(decoded.functionName).toBe("createSplit");
    expect(decoded.args).toEqual(["Team", [getAddress(A), getAddress(B)], [6000n, 4000n], ["alice", ""], 100]);
  });

  it("refuses to build an invalid draft", () => {
    expect(() =>
      buildCreateSplit({ factory: SPLIT, draft: { name: "", payees: [] }, terms: { feeWei: 0n, pendingFee: null, protocolShareBps: 0 } }),
    ).toThrow(/invalid split/);
    expect(encodeCreateSplit({ name: "T", payees: [{ address: A, weight: 1 }], maxProtocolShareBps: 0 })).toMatch(/^0x/);
  });
});

describe("buildCollectAndReleaseAll", () => {
  const locker: SplitSource = { kind: "claim", address: LOCKER, label: "CL locker" };
  const kit: SplitSource = { kind: "kitFees", address: KIT, label: "Kit" };

  it("collects every non-zero credit, then releases each currency once", () => {
    const tx = buildCollectAndReleaseAll({
      split: SPLIT,
      credits: [
        { source: locker, currency: TOKEN, amount: 5n },
        { source: locker, currency: NATIVE_CURRENCY, amount: 0n },
        { source: locker, currency: NATIVE_CURRENCY, amount: null },
        { source: kit, currency: NATIVE_CURRENCY, amount: 7n },
      ],
    });
    const outer = decodeFunctionData({ abi: GULLYCORE_SPLIT_ABI, data: tx.data });
    expect(outer.functionName).toBe("multicall");
    const inner = (outer.args![0] as readonly `0x${string}`[]).map((d) => decodeFunctionData({ abi: GULLYCORE_SPLIT_ABI, data: d }));
    expect(inner.map((c) => c.functionName)).toEqual(["collect", "collectKitFees", "releaseAll", "releaseAll"]);
    expect(inner[0]!.args).toEqual([getAddress(LOCKER), getAddress(TOKEN)]);
    expect(inner[2]!.args).toEqual([getAddress(TOKEN)]);
    expect(inner[3]!.args).toEqual([zeroAddress]);
  });

  it("can release what the split already holds, and refuses an empty batch", () => {
    const tx = buildCollectAndReleaseAll({ split: SPLIT, credits: [], alsoRelease: [TOKEN] });
    const outer = decodeFunctionData({ abi: GULLYCORE_SPLIT_ABI, data: tx.data });
    expect((outer.args![0] as readonly string[]).length).toBe(1);
    expect(() => buildCollectAndReleaseAll({ split: SPLIT, credits: [{ source: locker, currency: TOKEN, amount: 0n }] })).toThrow();
  });
});
