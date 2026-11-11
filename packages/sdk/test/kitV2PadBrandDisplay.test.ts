// SPDX-License-Identifier: MIT
/**
 * Pad brand fields for display: the logo, website and X readers a directory
 * card or a site header renders from, and the X input normaliser the brand
 * editors store through. The stored schema is unchanged; these are stricter.
 */
import { describe, expect, it } from "vitest";

import {
  decodePadMetadataURI,
  encodePadMetadataURI,
  normalizePadXInput,
  padLogoSrcOf,
  padMonogramOf,
  padWebsiteOf,
  padXOf,
  type PadBrand,
} from "../src/index.js";

const base: PadBrand = { v: 1 };

describe("padXOf", () => {
  it("reads x.com and twitter.com profile URLs, canonical x.com out", () => {
    expect(padXOf({ ...base, links: { x: "https://x.com/mochi_pad" } })).toEqual({ handle: "mochi_pad", url: "https://x.com/mochi_pad" });
    expect(padXOf({ ...base, links: { x: "https://twitter.com/Frog/" } })).toEqual({ handle: "Frog", url: "https://x.com/Frog" });
    expect(padXOf({ ...base, links: { x: "https://www.x.com/frog?s=21" } })?.handle).toBe("frog");
  });
  it("is null when absent or not a profile", () => {
    expect(padXOf(base)).toBeNull();
    expect(padXOf(null)).toBeNull();
    expect(padXOf({ ...base, links: { x: "https://x.com/frog/status/1" } })).toBeNull();
    expect(padXOf({ ...base, links: { x: "https://evil.example/x.com/frog" } })).toBeNull();
    expect(padXOf({ ...base, links: { x: "https://x.com.evil.example/frog" } })).toBeNull();
    expect(padXOf({ ...base, links: { x: "ipfs://x.com/frog" } })).toBeNull();
  });
});

describe("normalizePadXInput", () => {
  it("accepts a handle or a profile URL and stores https://x.com/<handle>", () => {
    for (const input of ["@frog", "frog", " frog ", "x.com/frog", "twitter.com/frog", "http://twitter.com/frog", "https://x.com/frog/"]) {
      expect(normalizePadXInput(input)).toEqual({ ok: true, url: "https://x.com/frog" });
    }
  });
  it("treats empty as no link", () => {
    expect(normalizePadXInput("  ")).toEqual({ ok: true, url: null });
  });
  it("refuses anything else", () => {
    for (const input of ["@this_handle_is_too_long", "frog pad", "https://example.org/frog", "x.com/frog/status/1", "@"]) {
      expect(normalizePadXInput(input).ok).toBe(false);
    }
  });
  it("its output is a brand the schema accepts and padXOf reads back", () => {
    const r = normalizePadXInput("@frog");
    if (!r.ok || r.url === null) throw new Error("unexpected");
    const brand: PadBrand = { ...base, links: { x: r.url } };
    const decoded = decodePadMetadataURI(encodePadMetadataURI(brand));
    expect(decoded.kind).toBe("brand");
    if (decoded.kind === "brand") expect(padXOf(decoded.brand)?.handle).toBe("frog");
  });
});

describe("padLogoSrcOf / padWebsiteOf", () => {
  it("render only https", () => {
    expect(padLogoSrcOf({ ...base, logoUrl: "https://cdn.example/logo.png" })).toBe("https://cdn.example/logo.png");
    expect(padLogoSrcOf({ ...base, logoUrl: "ipfs://bafy/logo.png" })).toBeNull();
    expect(padLogoSrcOf(base)).toBeNull();
    expect(padWebsiteOf({ ...base, links: { website: "https://frog.example" } })).toBe("https://frog.example");
    expect(padWebsiteOf({ ...base, links: { website: "ipfs://bafy" } })).toBeNull();
    expect(padWebsiteOf(undefined)).toBeNull();
  });
});

describe("padMonogramOf", () => {
  it("initials of two words, else the first two letters", () => {
    expect(padMonogramOf("Mochi Pad")).toBe("MP");
    expect(padMonogramOf("frog-swap")).toBe("FS");
    expect(padMonogramOf("Zed")).toBe("ZE");
    expect(padMonogramOf("Café")).toBe("CA");
    expect(padMonogramOf("!!!")).toBe("");
  });
});
