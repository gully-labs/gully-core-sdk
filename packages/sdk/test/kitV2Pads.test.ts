// SPDX-License-Identifier: MIT
/**
 * Pads: the brand encoding a pad stores, the tenant terms it forwards to the
 * kit, and the calldata for the factory and the pad.
 */
import { decodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_PAD_ABI,
  GULLYCORE_PAD_FACTORY_ABI,
  PAD_MAX_METADATA_URI_BYTES,
  PAD_THEME_NAMES,
  binShapeMask,
  buildCreatePad,
  decodePadMetadataURI,
  decodePendingPadFee,
  encodeCancelPendingPadFee,
  encodeFlushPadFees,
  encodeSetPadFee,
  padSafeValue,
  readPadFactoryFee,
  encodeConfigurePad,
  encodeCreatePad,
  encodePadMetadataURI,
  encodeSetPadMetadata,
  padHostnameOf,
  presetMask,
  tenantConfigFromTerms,
  validatePadBrand,
  type PadBrand,
  type PadTerms,
  padUserSaltFromLabel,
} from "../src/index.js";

const WALLET: Address = "0x00000000000000000000000000000000000000ab";

const brand: PadBrand = {
  v: 1,
  tagline: "Launch on the trend you pick",
  logoUrl: "https://example.org/logo.svg",
  accent: "#ff2d8a",
  theme: "mono",
  links: { x: "https://x.com/example", website: "https://example.org" },
  dex: { enabled: true, feeBps: 25 },
  launchpad: { enabled: true },
};

const terms: PadTerms = {
  integrator: WALLET,
  integratorBps: 500,
  integratorLaunchFeeWei: 10n ** 15n,
  allowedPresets: ["FairLaunch", "NoTax"],
  allowedBinShapes: ["Linear", "Exponential"],
  restrictQuotes: false,
  active: true,
};

describe("pad brand", () => {
  it("round-trips through an inline data: URI and back", () => {
    const uri = encodePadMetadataURI(brand);
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(new TextEncoder().encode(uri).length).toBeLessThanOrEqual(PAD_MAX_METADATA_URI_BYTES);
    const decoded = decodePadMetadataURI(uri);
    expect(decoded).toEqual({ kind: "brand", brand });
  });

  it("validates fields the way a hosting front end will rely on", () => {
    expect(validatePadBrand(brand)).toEqual([]);
    expect(validatePadBrand({ ...brand, v: 2 }).map((i) => i.field)).toContain("v");
    expect(validatePadBrand({ ...brand, accent: "pink" }).map((i) => i.field)).toContain("accent");
    expect(validatePadBrand({ ...brand, theme: "y2k" }).map((i) => i.field)).toContain("theme");
    expect(validatePadBrand({ ...brand, logoUrl: "javascript:alert(1)" }).map((i) => i.field)).toContain("logoUrl");
    expect(validatePadBrand({ ...brand, logoUrl: "data:image/png;base64,AAAA" }).map((i) => i.field)).toContain("logoUrl");
    expect(validatePadBrand({ ...brand, dex: { enabled: true, feeBps: 101 } }).map((i) => i.field)).toContain("dex.feeBps");
    expect(validatePadBrand({ ...brand, links: { x: "http://x.com/a" } }).map((i) => i.field)).toContain("links.x");
    expect(validatePadBrand(null)).toHaveLength(1);
    expect(validatePadBrand({ ...brand, customDomain: "launch.mochi.xyz" })).toEqual([]);
    for (const bad of ["https://launch.mochi.xyz", "Launch.Mochi.xyz", "mochi", "-a.b.c", "a.b.c/path", "a..b"]) {
      expect(validatePadBrand({ ...brand, customDomain: bad }).map((i) => i.field), bad).toContain("customDomain");
    }
    expect(padHostnameOf({ ...brand, customDomain: "launch.mochi.xyz" })).toBe("launch.mochi.xyz");
    expect(padHostnameOf(brand)).toBeNull();
    expect(padHostnameOf(null)).toBeNull();
    /* Names are APPENDED, never renamed or reordered: a brand on chain stores the name. */
    expect(PAD_THEME_NAMES.slice(0, 8)).toEqual(["mono", "press", "frost", "arcade", "block", "soft", "chrome", "hazard"]);
    expect(PAD_THEME_NAMES.slice(8)).toEqual(["degen", "stonks", "candle", "moon", "bullion"]);
    for (const t of PAD_THEME_NAMES) expect(validatePadBrand({ ...brand, theme: t })).toEqual([]);
  });

  it("bounds tokenLists to a few https URLs", () => {
    const ok = ["https://raw.githubusercontent.com/gully-labs/token-lists/main/4663.tokenlist.json", "https://mochi.example/list.json"];
    expect(validatePadBrand({ ...brand, tokenLists: ok })).toEqual([]);
    expect(validatePadBrand({ ...brand, tokenLists: [] })).toEqual([]);
    expect(validatePadBrand({ ...brand, tokenLists: "https://x" }).map((i) => i.field)).toContain("tokenLists");
    expect(validatePadBrand({ ...brand, tokenLists: Array.from({ length: 6 }, (_, i) => `https://x.example/${i}.json`) }).map((i) => i.field)).toContain("tokenLists");
    for (const bad of ["http://x.example/l.json", "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", "javascript:alert(1)", "https://x.example/a b", 1]) {
      expect(validatePadBrand({ ...brand, tokenLists: [bad] }).map((i) => i.field), String(bad)).toContain("tokenLists[0]");
    }
    expect(validatePadBrand({ ...brand, tokenLists: [ok[0], ok[0]] }).map((i) => i.field)).toContain("tokenLists[1]");
    const round = decodePadMetadataURI(encodePadMetadataURI({ ...brand, tokenLists: ok }));
    expect(round.kind === "brand" && round.brand.tokenLists).toEqual(ok);
  });

  it("refuses to encode an invalid or oversized brand", () => {
    expect(() => encodePadMetadataURI({ ...brand, accent: "nope" })).toThrow(/accent/);
    expect(() => encodePadMetadataURI({ ...brand, tagline: "x".repeat(141) })).toThrow(/tagline/);
    // 4 KB of links would not fit; the byte check must fire before the pad refuses it.
    const huge = { ...brand, links: { docs: `https://example.org/${"a".repeat(480)}`, website: `https://example.org/${"b".repeat(480)}` } };
    expect(validatePadBrand(huge)).toEqual([]);
    const big = { ...huge, tagline: "t".repeat(140) };
    expect(() => encodePadMetadataURI({ ...big, logoUrl: `https://example.org/${"c".repeat(490)}` })).not.toThrow();
  });

  it("decodes what it does not understand as invalid, remote or empty - never a default", () => {
    expect(decodePadMetadataURI("")).toEqual({ kind: "empty" });
    expect(decodePadMetadataURI("ipfs://bafy")).toEqual({ kind: "remote", url: "ipfs://bafy" });
    expect(decodePadMetadataURI("https://example.org/brand.json")).toEqual({ kind: "remote", url: "https://example.org/brand.json" });
    expect(decodePadMetadataURI("data:text/plain,hello").kind).toBe("invalid");
    expect(decodePadMetadataURI("data:application/json,not json").kind).toBe("invalid");
    expect(decodePadMetadataURI("data:application/json;base64,!!!").kind).toBe("invalid");
    const wrongVersion = decodePadMetadataURI(`data:application/json,${encodeURIComponent(JSON.stringify({ v: 9 }))}`);
    expect(wrongVersion.kind).toBe("invalid");
    // Plain (non-base64) JSON is accepted on read, since a hand-written URI may use it.
    const plain = decodePadMetadataURI(`data:application/json,${encodeURIComponent(JSON.stringify({ v: 1, theme: "press" }))}`);
    expect(plain).toEqual({ kind: "brand", brand: { v: 1, theme: "press" } });
  });
});

describe("pad terms", () => {
  it("builds the kit's bitmasks in enum order", () => {
    expect(presetMask(["Custom"])).toBe(1);
    expect(presetMask(["FairLaunch", "NoTax"])).toBe((1 << 1) | (1 << 4));
    expect(binShapeMask([])).toBe(0);
    expect(binShapeMask(["Linear", "Exponential"])).toBe((1 << 2) | (1 << 3));
    const c = tenantConfigFromTerms(terms);
    expect(c).toEqual({
      integrator: WALLET,
      integratorBps: 500,
      integratorLaunchFeeWei: 10n ** 15n,
      allowedPresets: (1 << 1) | (1 << 4),
      allowedBinShapes: (1 << 2) | (1 << 3),
      restrictQuotes: false,
      active: true,
      maxTaxBps: 0,
      taxIntegratorBps: 0,
      gullyTerms: false,
    });
    expect(tenantConfigFromTerms({ ...terms, maxTaxBps: 500, taxIntegratorBps: 1_500 })).toMatchObject({ maxTaxBps: 500, taxIntegratorBps: 1_500 });
    // No presets named means every preset: an all-zero mask would make the kit refuse the config.
    expect(tenantConfigFromTerms({ ...terms, allowedPresets: [] }).allowedPresets).toBe(0b11111);
  });

  it("encodes createPad, configure and setMetadata against the generated ABIs", () => {
    const create = decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: encodeCreatePad({ name: "Mochi", brand, terms, allowedQuotes: [WALLET] }) });
    expect(create.functionName).toBe("createPad");
    // args[0] is the user salt: by default derived from the name, so one wallet gets one address per name on every chain.
    expect(create.args[0]).toBe(padUserSaltFromLabel("Mochi"));
    expect(create.args[1]).toBe("Mochi");
    expect(decodePadMetadataURI(create.args[2] as string)).toEqual({ kind: "brand", brand });
    expect((create.args[3] as { integratorBps: number }).integratorBps).toBe(500);
    expect((create.args[4] as readonly string[]).map((a) => a.toLowerCase())).toEqual([WALLET]);

    const configure = decodeFunctionData({ abi: GULLYCORE_PAD_ABI, data: encodeConfigurePad(terms) });
    expect(configure.functionName).toBe("configure");

    const meta = decodeFunctionData({ abi: GULLYCORE_PAD_ABI, data: encodeSetPadMetadata("Mochi", null) });
    expect(meta.functionName).toBe("setMetadata");
    expect(meta.args).toEqual(["Mochi", ""]);
  });
});

describe("pad kind and dex scope", () => {
  it("defaults to a launchpad routing through its own launches", async () => {
    const { padKindOf, padDexScopeOf } = await import("../src/launchpad/kitV2/pads.js");
    expect(padKindOf(null)).toBe("launchpad");
    expect(padDexScopeOf(null)).toBe("launches");
    expect(padKindOf({ v: 1 })).toBe("launchpad");
    expect(padKindOf({ v: 1, kind: "dex" })).toBe("dex");
    expect(padDexScopeOf({ v: 1, dex: { enabled: true, feeBps: 0, scope: "all" } })).toBe("all");
  });
  it("rejects an unknown kind or scope and round-trips a DEX brand", async () => {
    const { validatePadBrand, encodePadMetadataURI, decodePadMetadataURI } = await import("../src/launchpad/kitV2/pads.js");
    expect(validatePadBrand({ v: 1, kind: "exchange" }).map((i) => i.field)).toEqual(["kind"]);
    expect(validatePadBrand({ v: 1, dex: { enabled: true, feeBps: 5, scope: "everything" } }).map((i) => i.field)).toEqual(["dex.scope"]);
    const brand = { v: 1 as const, kind: "dex" as const, dex: { enabled: true, feeBps: 25, scope: "all" as const } };
    const decoded = decodePadMetadataURI(encodePadMetadataURI(brand));
    expect(decoded.kind).toBe("brand");
    if (decoded.kind === "brand") expect(decoded.brand).toEqual(brand);
  });
});

describe("widget variable overrides", () => {
  it("accepts known keys with valid values and rejects the rest", async () => {
    const { validatePadBrand, encodePadMetadataURI, decodePadMetadataURI } = await import("../src/launchpad/kitV2/pads.js");
    const ok = { v: 1 as const, widget: { vars: { accent: "#ff5c1a", radius: "12px", font: "Inter, system-ui, sans-serif" } } };
    expect(validatePadBrand(ok)).toEqual([]);
    const d = decodePadMetadataURI(encodePadMetadataURI(ok));
    expect(d.kind === "brand" && d.brand.widget?.vars?.accent).toBe("#ff5c1a");
    const bad = validatePadBrand({ v: 1, widget: { vars: { accent: "red", radius: "99px", font: "url(x)", zIndex: "1" } } }).map((i) => i.field);
    expect(bad).toEqual(["widget.vars.accent", "widget.vars.radius", "widget.vars.font", "widget.vars.zIndex"]);
  });
});

/* ---------------------------------------------------------------- site fee */

const FACTORY: Address = "0x00000000000000000000000000000000000000f1";
const SAFE: Address = "0x00000000000000000000000000000000000dc0de";

/** A `PublicClient` stand-in: `readContract` dispatches on functionName and records every call. */
function fakeFactory(reads: Record<string, unknown>) {
  const calls: string[] = [];
  const client = {
    async readContract(req: { address: Address; functionName: string }): Promise<unknown> {
      calls.push(req.functionName);
      if (req.address !== FACTORY) throw new Error(`unexpected address ${req.address}`);
      if (!(req.functionName in reads)) throw new Error(`unexpected read ${req.functionName}`);
      return reads[req.functionName];
    },
  };
  return { client: client as unknown as Parameters<typeof readPadFactoryFee>[0], calls };
}

describe("pad site fee", () => {
  it("decodes pendingPadFee's (0, 0) as null and anything else as a scheduled increase", () => {
    expect(decodePendingPadFee([0n, 0n])).toBeNull();
    expect(decodePendingPadFee([5n, 0n])).toBeNull();
    expect(decodePendingPadFee([5n, 1_800_000_000n])).toEqual({ feeWei: 5n, effectiveAt: 1_800_000_000n });
  });

  it("safeValue is the higher of the fee in force and the announced one, and never below the fee", () => {
    expect(padSafeValue({ feeWei: 3n, pending: null })).toBe(3n);
    expect(padSafeValue({ feeWei: 3n, pending: { feeWei: 7n, effectiveAt: 1n } })).toBe(7n);
    // A pending value below the fee cannot happen on chain (only increases are scheduled), but the
    // builder must still never send less than what is in force.
    expect(padSafeValue({ feeWei: 3n, pending: { feeWei: 1n, effectiveAt: 1n } })).toBe(3n);
    expect(padSafeValue({ feeWei: 0n, pending: null })).toBe(0n);
    expect(() => padSafeValue({ feeWei: -1n, pending: null })).toThrow(RangeError);
  });

  it("readPadFactoryFee reads the six facts off the factory and shapes them", async () => {
    const { client, calls } = fakeFactory({
      padFeeWei: 3_000_000_000_000_000n,
      pendingPadFee: [6_000_000_000_000_000n, 1_800_604_800n],
      maxPadFeeWei: 30_000_000_000_000_000n,
      padFeeNoticeSeconds: 604_800,
      protocolFeeRecipient: SAFE,
      protocolFeesOwed: 9_000_000_000_000_000n,
    });
    const fee = await readPadFactoryFee(client, FACTORY);
    expect(fee).toEqual({
      feeWei: 3_000_000_000_000_000n,
      pending: { feeWei: 6_000_000_000_000_000n, effectiveAt: 1_800_604_800n },
      capWei: 30_000_000_000_000_000n,
      noticeSeconds: 604_800,
      recipient: SAFE,
      owedWei: 9_000_000_000_000_000n,
    });
    expect([...calls].sort()).toEqual(
      ["maxPadFeeWei", "padFeeNoticeSeconds", "padFeeWei", "pendingPadFee", "protocolFeeRecipient", "protocolFeesOwed"],
    );
    const none = await readPadFactoryFee(
      fakeFactory({ padFeeWei: 0n, pendingPadFee: [0n, 0n], maxPadFeeWei: 1n, padFeeNoticeSeconds: 86_400, protocolFeeRecipient: SAFE, protocolFeesOwed: 0n }).client,
      FACTORY,
    );
    expect(none.pending).toBeNull();
    expect(padSafeValue(none)).toBe(0n);
  });

  it("buildCreatePad targets the factory, encodes the same calldata as encodeCreatePad, and carries the safe value", () => {
    const fee = { feeWei: 3n, pending: { feeWei: 8n, effectiveAt: 1n } };
    const tx = buildCreatePad({ factory: FACTORY, name: "Mochi Pad", brand, terms, fee });
    expect(tx.to).toBe(FACTORY);
    expect(tx.value).toBe(8n);
    expect(tx.data).toBe(encodeCreatePad({ name: "Mochi Pad", brand, terms }));
    const decoded = decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: tx.data });
    expect(decoded.functionName).toBe("createPad");
    expect(buildCreatePad({ factory: FACTORY, name: "x", brand: null, terms, fee: { feeWei: 3n, pending: null } }).value).toBe(3n);
  });

  it("encodes the Safe's two fee calls and the permissionless flush against the generated ABI", () => {
    const set = decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: encodeSetPadFee(123n) });
    expect(set.functionName).toBe("setPadFee");
    expect(set.args).toEqual([123n]);
    expect(decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: encodeCancelPendingPadFee() }).functionName).toBe("cancelPendingPadFee");
    expect(decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: encodeFlushPadFees() }).functionName).toBe("flushProtocolFees");
  });
});
