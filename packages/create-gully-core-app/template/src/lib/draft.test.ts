// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { clearDraft, draftKey, loadDraft, sameShape, saveDraft, strippedForSave } from "./draft";

/** An in-memory Storage: the tests never touch a real one. */
function memory(opts: { readonly full?: boolean; readonly broken?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => {
      if (opts.broken) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.broken) throw new Error("SecurityError");
      if (opts.full) {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (opts.broken) throw new Error("SecurityError");
      map.delete(k);
    },
  };
}

const SHAPE = { name: "", symbol: "", totalSupply: "1000", legs: [] as unknown[], creatorMode: "wallet" };

describe("draft keys", () => {
  it("carry the builder, the chain and (lower-cased) the wallet, so a draft never crosses chains", () => {
    expect(draftKey("launch", 999)).toBe("gullycore.app.draft.v1.launch.999");
    expect(draftKey("launch", 56, "0xABCD")).toBe("gullycore.app.draft.v1.launch.56.0xabcd");
    expect(draftKey("launch", 999)).not.toBe(draftKey("launch", 56));
  });
});

describe("save and load", () => {
  it("round-trips what was typed and strips what the chain answered", () => {
    const kv = memory();
    const key = draftKey("launch", 999);
    const outcome = saveDraft(key, { ...SHAPE, name: "Deep", limits: { maxLegs: 4 }, preview: { call: 1 }, openingPrice: "5" }, kv, () => 1_700_000_000_000);
    expect(outcome).toBe("saved");
    const back = loadDraft(key, (raw) => sameShape(SHAPE, raw), kv);
    expect(back).toEqual({ form: { name: "Deep", symbol: "", totalSupply: "1000", legs: [], creatorMode: "wallet" }, savedAt: 1_700_000_000_000 });
    expect(JSON.parse(kv.map.get(key) ?? "{}")).not.toHaveProperty("form.limits");
    expect(strippedForSave({ a: 1, preview: 2, call: 3 })).toEqual({ a: 1 });
  });

  it("keeps only values of the right shape from an older or foreign draft", () => {
    const raw = { name: 42, symbol: "DC", totalSupply: "1", legs: "not-a-list", creatorMode: "split", gone: true };
    expect(sameShape(SHAPE, raw)).toEqual({ symbol: "DC", totalSupply: "1", creatorMode: "split" });
  });

  it("reads nothing from a missing, empty, malformed or wrong-version entry", () => {
    const kv = memory();
    const accept = (raw: Record<string, unknown>) => sameShape(SHAPE, raw);
    expect(loadDraft("x", accept, kv)).toBeNull();
    kv.map.set("x", "");
    expect(loadDraft("x", accept, kv)).toBeNull();
    kv.map.set("x", "{not json");
    expect(loadDraft("x", accept, kv)).toBeNull();
    kv.map.set("x", JSON.stringify({ v: 2, savedAt: 1, form: { name: "a" } }));
    expect(loadDraft("x", accept, kv)).toBeNull();
    kv.map.set("x", JSON.stringify({ v: 1, savedAt: 1, form: { unknown: "a" } }));
    expect(loadDraft("x", accept, kv)).toBeNull();
  });

  it("states a full or blocked storage instead of throwing, and reads null through a broken one", () => {
    expect(saveDraft("x", SHAPE, memory({ full: true }))).toBe("full");
    expect(saveDraft("x", SHAPE, memory({ broken: true }))).toBe("blocked");
    expect(saveDraft("x", SHAPE, null)).toBe("blocked");
    expect(loadDraft("x", (r) => sameShape(SHAPE, r), memory({ broken: true }))).toBeNull();
    expect(loadDraft("x", (r) => sameShape(SHAPE, r), null)).toBeNull();
    expect(() => clearDraft("x", memory({ broken: true }))).not.toThrow();
    expect(() => clearDraft("x", null)).not.toThrow();
  });

  it("clear forgets the draft", () => {
    const kv = memory();
    saveDraft("x", SHAPE, kv);
    clearDraft("x", kv);
    expect(loadDraft("x", (r) => sameShape(SHAPE, r), kv)).toBeNull();
  });
});
