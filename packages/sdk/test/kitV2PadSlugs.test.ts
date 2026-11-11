// SPDX-License-Identifier: MIT
/**
 * Pad slugs: `/p/<slug>` from a pad's `name()`, and the collision rule
 * (first pad by factory index owns the bare slug; later same-name pads get
 * `-<hex4>`).
 */
import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { PAD_SLUG_MAX_LENGTH, assignPadSlugs, isPadSlug, padBySlug, padSlugFor, previewPadSlug, readPadNames, slugOf } from "../src/index.js";

const A: Address = "0x77D94D91BF32E34E4cd8B0e1aF125aA9596A1621";
const B: Address = "0x6358f134870D99a6A3ca97449BBc68BDd64393f2";
const C: Address = "0xAbCd000000000000000000000000000000000001";

describe("slugOf", () => {
  it("lowercases, folds to ASCII and joins with single dashes", () => {
    expect(slugOf("Mochi Pad")).toBe("mochi-pad");
    expect(slugOf("Frog Swap")).toBe("frog-swap");
    expect(slugOf("  Café  Ünïcode!! DEX ")).toBe("cafe-unicode-dex");
    expect(slugOf("a---b___c...d")).toBe("a-b-c-d");
    expect(slugOf("--lead and trail--")).toBe("lead-and-trail");
  });

  it("yields '' when nothing survives folding", () => {
    expect(slugOf("🐸🐸")).toBe("");
    expect(slugOf("")).toBe("");
    expect(slugOf("---")).toBe("");
  });

  it("cuts at the maximum length and never ends in a dash", () => {
    const long = "word ".repeat(30).trim();
    const s = slugOf(long);
    expect(s.length).toBeLessThanOrEqual(PAD_SLUG_MAX_LENGTH);
    expect(s.endsWith("-")).toBe(false);
    expect(isPadSlug(s)).toBe(true);
    expect(slugOf("a".repeat(100))).toBe("a".repeat(PAD_SLUG_MAX_LENGTH));
  });

  it("is idempotent", () => {
    for (const n of ["Mochi Pad", "café", "x", "A B C"]) expect(slugOf(slugOf(n))).toBe(slugOf(n));
  });

  it("isPadSlug accepts what slugOf produces and refuses the rest", () => {
    expect(isPadSlug("mochi-pad")).toBe(true);
    expect(isPadSlug("mochi-pad-77d9")).toBe(true);
    expect(isPadSlug("Mochi")).toBe(false);
    expect(isPadSlug("-mochi")).toBe(false);
    expect(isPadSlug("mochi-")).toBe(false);
    expect(isPadSlug("")).toBe(false);
    expect(isPadSlug("a".repeat(49))).toBe(false);
  });
});

describe("assignPadSlugs (collision rule)", () => {
  it("the first pad by factory index owns the bare slug; later same names get -<hex4>", () => {
    const entries = assignPadSlugs([
      { address: A, name: "Mochi Pad" },
      { address: B, name: "Frog Swap" },
      { address: C, name: "mochi pad" },
    ]);
    expect(entries.map((e) => e.slug)).toEqual(["mochi-pad", "frog-swap", "mochi-pad-abcd"]);
    expect(entries.map((e) => e.suffixed)).toEqual([false, false, true]);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it("appending a pad never changes an earlier pad's slug", () => {
    const before = assignPadSlugs([{ address: A, name: "Mochi Pad" }]);
    const after = assignPadSlugs([
      { address: A, name: "Mochi Pad" },
      { address: C, name: "Mochi Pad" },
    ]);
    expect(after[0]).toEqual(before[0]);
  });

  it("a name that folds to nothing is pad-<hex4>; a name that reads as an address is prefixed", () => {
    const entries = assignPadSlugs([
      { address: A, name: "🐸" },
      { address: B, name: "0x" + "ab".repeat(20) },
    ]);
    expect(entries[0]?.slug).toBe("pad-77d9");
    expect(entries[0]?.suffixed).toBe(true);
    expect(entries[1]?.slug).toBe("pad-0x" + "ab".repeat(20));
    expect(entries[1]?.slug.length).toBeLessThanOrEqual(PAD_SLUG_MAX_LENGTH);
  });

  it("widens the suffix when -<hex4> is itself taken, so every slug is unique", () => {
    const sameHead = ["0x77D90000000000000000000000000000000000A1", "0x77D90000000000000000000000000000000000A2", "0x77D90000000000000000000000000000000000A3"] as Address[];
    const entries = assignPadSlugs(sameHead.map((address) => ({ address, name: "Twin" })));
    const slugs = entries.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(3);
    expect(slugs[0]).toBe("twin");
    expect(slugs[1]).toBe("twin-77d9");
    expect(slugs[2]).toBe("twin-77d90000");
  });

  it("padSlugFor / padBySlug look up in either direction, case-insensitively on the address", () => {
    const entries = assignPadSlugs([
      { address: A, name: "Mochi Pad" },
      { address: C, name: "Mochi Pad" },
    ]);
    expect(padSlugFor(entries, A.toLowerCase())).toBe("mochi-pad");
    expect(padSlugFor(entries, C)).toBe("mochi-pad-abcd");
    expect(padSlugFor(entries, B)).toBeNull();
    expect(padBySlug(entries, "mochi-pad")?.address).toBe(A);
    expect(padBySlug(entries, "MOCHI-PAD")?.address).toBe(A);
    expect(padBySlug(entries, "mochi-pad-abcd")?.address).toBe(C);
    expect(padBySlug(entries, "nope")).toBeNull();
  });

  it("previewPadSlug says what a new pad's URL will be, and that a taken name gets a suffix", () => {
    const entries = assignPadSlugs([{ address: A, name: "Mochi Pad" }]);
    expect(previewPadSlug(entries, "Frog Swap")).toEqual({ slug: "frog-swap", taken: false });
    expect(previewPadSlug(entries, "MOCHI pad")).toEqual({ slug: "mochi-pad-…", taken: true });
    expect(previewPadSlug(entries, "🐸")).toEqual({ slug: "", taken: false });
  });
});

describe("readPadNames", () => {
  it("reads padCount, pads and every name(); falls back to per-pad reads when multicall is unavailable", async () => {
    const calls: string[] = [];
    const client = {
      readContract: async ({ functionName, address }: { functionName: string; address: Address }) => {
        calls.push(functionName);
        if (functionName === "padCount") return 2n;
        if (functionName === "pads") return [A, B];
        if (functionName === "name") return address === A ? "Mochi Pad" : "Frog Swap";
        throw new Error(`unexpected ${functionName}`);
      },
      multicall: async () => {
        calls.push("multicall");
        throw new Error("no Multicall3 at this address");
      },
    } as never;
    const names = await readPadNames(client, "0x34A54C58357D83E4058163B29A53eb5575Fb3201");
    expect(names).toEqual([
      { address: A, name: "Mochi Pad" },
      { address: B, name: "Frog Swap" },
    ]);
    expect(calls).toEqual(["padCount", "pads", "multicall", "name", "name"]);
  });

  it("uses the multicall answer when it works, and skips multicall when told there is none", async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => (functionName === "padCount" ? 1n : functionName === "pads" ? [A] : "Mochi Pad"),
      multicall: async () => ["Mochi Pad (via multicall)"],
    } as never;
    expect((await readPadNames(client, A))[0]?.name).toBe("Mochi Pad (via multicall)");
    expect((await readPadNames(client, A, { multicallAddress: null }))[0]?.name).toBe("Mochi Pad");
  });
});
