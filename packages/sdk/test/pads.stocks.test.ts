/* A site's brand may say it is a stock market (PadBrand.kind "stocks", 2026-10-12). The kind is APPENDED:
   every earlier kind keeps its index and its meaning, and an unknown kind is still refused. */
import { describe, expect, it } from "vitest";

import { decodePadMetadataURI, encodePadMetadataURI, PAD_KINDS, padKindOf, validatePadBrand } from "../src/index.js";

describe("PadBrand.kind stocks", () => {
  it("is appended after the three earlier kinds, which keep their order", () => {
    expect(PAD_KINDS.slice(0, 3)).toEqual(["launchpad", "dex", "both"]);
    expect(PAD_KINDS[3]).toBe("stocks");
  });

  it("round-trips through the on-chain encoding", () => {
    const uri = encodePadMetadataURI({ v: 1, kind: "stocks", dex: { enabled: true, feeBps: 10, scope: "all" }, launchpad: { enabled: false } });
    const back = decodePadMetadataURI(uri);
    expect(back.kind).toBe("brand");
    expect(back.kind === "brand" && padKindOf(back.brand)).toBe("stocks");
  });

  it("leaves every earlier brand reading exactly as before", () => {
    expect(padKindOf({ v: 1 })).toBe("launchpad");
    for (const k of ["launchpad", "dex", "both"] as const) expect(padKindOf({ v: 1, kind: k })).toBe(k);
    expect(validatePadBrand({ v: 1, kind: "dex" })).toEqual([]);
  });

  it("still refuses a kind nobody defined", () => {
    expect(validatePadBrand({ v: 1, kind: "stonks" }).map((i) => i.field)).toEqual(["kind"]);
  });
});
