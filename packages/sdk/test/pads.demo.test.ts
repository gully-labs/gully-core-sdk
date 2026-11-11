/* A site's brand may say it is a demo (PadBrand.demo, 2026-09-28). */
import { describe, expect, it } from "vitest";

import { decodePadMetadataURI, encodePadMetadataURI, padIsDemo, validatePadBrand } from "../src/index.js";

describe("PadBrand.demo", () => {
  it("round-trips through the on-chain encoding", () => {
    const uri = encodePadMetadataURI({ v: 1, tagline: "A demo", demo: true });
    const back = decodePadMetadataURI(uri);
    expect(back.kind).toBe("brand");
    expect(back.kind === "brand" && padIsDemo(back.brand)).toBe(true);
  });

  it("is off unless the brand says true", () => {
    expect(padIsDemo(null)).toBe(false);
    expect(padIsDemo(undefined)).toBe(false);
    expect(padIsDemo({ v: 1 })).toBe(false);
    expect(padIsDemo({ v: 1, demo: false })).toBe(false);
  });

  it("refuses anything that is not a boolean", () => {
    for (const bad of ["yes", 1, null, {}]) {
      expect(validatePadBrand({ v: 1, demo: bad }).map((i) => i.field)).toEqual(["demo"]);
    }
    expect(validatePadBrand({ v: 1, demo: true })).toEqual([]);
  });
});
