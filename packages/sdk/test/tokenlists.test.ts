// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_TOKENLIST_DEFAULT_BASE,
  GULLYCORE_TOKENLIST_URL,
  LAUNCH_TAG,
  TOKEN_LIST_LIMITS,
  TokenListFetchError,
  compareTokenListVersions,
  fetchTokenList,
  formatTokenListVersion,
  isTokenList,
  gullycoreExtensionOf,
  gullycoreTokenListFileName,
  gullycoreTokenListUrl,
  launchedTokenListFromScan,
  launchedTokenListFromEntries,
  UNVERIFIED_TAG,
  LAUNCH_TAG_DEFINITION,
  mergeTokenLists,
  stockExtensionOf,
  tokenListUpdateKind,
  validateTokenList,
  type LaunchRecordV2,
  type LaunchScanV2,
  type TokenList,
} from "../src/index.js";

const A = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const B = "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa";
const C = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

function list(over: Partial<TokenList> = {}): TokenList {
  return {
    name: "Gully Core",
    timestamp: "2026-09-18T00:00:00Z",
    version: { major: 1, minor: 0, patch: 0 },
    tokens: [{ chainId: 4663, address: A, decimals: 18, name: "NVIDIA", symbol: "NVDA", tags: ["stock"], extensions: { stock: { issuer: "Robinhood", ticker: "NVDA", rebasing: false } } }],
    tags: { stock: { name: "Stock", description: "A tokenised stock." } },
    ...over,
  };
}

describe("validateTokenList", () => {
  it("accepts a well-formed list", () => {
    expect(validateTokenList(list())).toEqual([]);
    expect(isTokenList(list())).toBe(true);
  });

  it("refuses non-objects and missing required fields", () => {
    expect(validateTokenList(null)[0]?.path).toBe("");
    const issues = validateTokenList({});
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["name", "timestamp", "version", "tokens"]));
  });

  it("enforces the schema's string rules", () => {
    expect(validateTokenList(list({ name: "Gully Core/DEX" })).some((i) => i.path === "name")).toBe(true);
    expect(validateTokenList(list({ name: "x".repeat(TOKEN_LIST_LIMITS.nameMax + 1) })).some((i) => i.path === "name")).toBe(true);
    expect(validateTokenList(list({ timestamp: "yesterday" })).some((i) => i.path === "timestamp")).toBe(true);
    expect(validateTokenList(list({ timestamp: "2026-09-18T00:00:00+02:00" }))).toEqual([]);
    expect(validateTokenList(list({ version: { major: 1, minor: 0, patch: -1 } })).some((i) => i.path === "version.patch")).toBe(true);
    expect(validateTokenList(list({ version: { major: 1, minor: 0, patch: 0, build: 1 } as never })).some((i) => i.path === "version.build")).toBe(true);
  });

  it("enforces the token rules", () => {
    const bad = (t: Record<string, unknown>) => validateTokenList(list({ tokens: [{ ...list().tokens[0], ...t } as never] }));
    expect(bad({ address: "0x123" }).some((i) => i.path === "tokens[0].address")).toBe(true);
    expect(bad({ decimals: 256 }).some((i) => i.path === "tokens[0].decimals")).toBe(true);
    expect(bad({ decimals: 1.5 }).some((i) => i.path === "tokens[0].decimals")).toBe(true);
    expect(bad({ symbol: "NV DA" }).some((i) => i.path === "tokens[0].symbol")).toBe(true);
    expect(bad({ symbol: "" })).toEqual([]);
    expect(bad({ name: "x".repeat(61) }).some((i) => i.path === "tokens[0].name")).toBe(true);
    expect(bad({ logoURI: "logos/a.png" }).some((i) => i.path === "tokens[0].logoURI")).toBe(true);
    expect(bad({ logoURI: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy" })).toEqual([]);
    expect(bad({ chainId: 0 }).some((i) => i.path === "tokens[0].chainId")).toBe(true);
    expect(bad({ foo: 1 }).some((i) => i.path === "tokens[0].foo")).toBe(true);
  });

  it("requires a token's tags to be defined on the list", () => {
    const issues = validateTokenList(list({ tokens: [{ ...list().tokens[0], tags: ["native"] } as never] }));
    expect(issues.some((i) => i.path === "tokens[0].tags[0]")).toBe(true);
    const undefinedTags = validateTokenList({ ...list(), tags: undefined });
    expect(undefinedTags.some((i) => i.path === "tokens[0].tags[0]")).toBe(true);
  });

  it("bounds extensions: identifiers, string length, depth", () => {
    const bad = (extensions: unknown) => validateTokenList(list({ tokens: [{ ...list().tokens[0], extensions } as never] }));
    expect(bad({ "bad-key": 1 }).some((i) => i.path === "tokens[0].extensions.bad-key")).toBe(true);
    expect(bad({ s: "x".repeat(43) }).some((i) => i.path === "tokens[0].extensions.s")).toBe(true);
    expect(bad({ s: "" }).some((i) => i.path === "tokens[0].extensions.s")).toBe(true);
    expect(bad({ a: { b: { c: 1 } } })).toEqual([]);
    expect(bad({ a: { b: { c: { d: 1 } } } }).some((i) => i.path === "tokens[0].extensions.a.b.c")).toBe(true);
    expect(bad({ a: [1] }).some((i) => i.path === "tokens[0].extensions.a")).toBe(true);
    expect(bad(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1]))).some((i) => i.path === "tokens[0].extensions")).toBe(true);
  });

  it("enforces tag definitions and keywords", () => {
    expect(validateTokenList(list({ tags: { stock: { name: "Stock", description: "with (parens)" } } })).some((i) => i.path === "tags.stock.description")).toBe(true);
    expect(validateTokenList(list({ tags: { "too-long-id-x": { name: "x", description: "y" } } as never })).some((i) => i.path.startsWith("tags."))).toBe(true);
    expect(validateTokenList(list({ keywords: ["dex", "dex"] })).some((i) => i.path === "keywords[1]")).toBe(true);
    expect(validateTokenList(list({ keywords: ["dex", "gullycore protocol"] }))).toEqual([]);
  });

  it("refuses an empty token array", () => {
    expect(validateTokenList(list({ tokens: [] })).some((i) => i.path === "tokens")).toBe(true);
  });
});

describe("extensions readers", () => {
  it("reads a well-formed stock extension and rejects a malformed one", () => {
    expect(stockExtensionOf(list().tokens[0]!)).toEqual({ issuer: "Robinhood", ticker: "NVDA", rebasing: false, controls: null, verifiedAt: null });
    expect(stockExtensionOf({ ...list().tokens[0]!, extensions: { stock: { issuer: "x" } } })).toBeNull();
    expect(stockExtensionOf({ chainId: 4663, address: A, decimals: 18, name: "n", symbol: "s" })).toBeNull();
  });
  it("reads the gullycore extension", () => {
    expect(gullycoreExtensionOf({ ...list().tokens[0]!, extensions: { gullycore: { launchpad: null, token: A } } })).toEqual({ launchpad: null, token: A });
    expect(gullycoreExtensionOf({ ...list().tokens[0]!, extensions: { gullycore: { launchpad: 1, token: A } } })).toBeNull();
  });
});

describe("versions", () => {
  it("formats and compares", () => {
    expect(formatTokenListVersion({ major: 1, minor: 2, patch: 3 })).toBe("1.2.3");
    expect(compareTokenListVersions({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 10, patch: 0 })).toBeLessThan(0);
    expect(tokenListUpdateKind(undefined, { major: 1, minor: 0, patch: 0 })).toBe("first");
    expect(tokenListUpdateKind({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 })).toBe("none");
    expect(tokenListUpdateKind({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 1 })).toBe("patch");
    expect(tokenListUpdateKind({ major: 1, minor: 0, patch: 5 }, { major: 1, minor: 1, patch: 0 })).toBe("minor");
    expect(tokenListUpdateKind({ major: 1, minor: 9, patch: 9 }, { major: 2, minor: 0, patch: 0 })).toBe("major");
    expect(tokenListUpdateKind({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBe("older");
  });
});

describe("URLs", () => {
  it("points at the published repository by default and never at gullychain.xyz", () => {
    expect(GULLYCORE_TOKENLIST_DEFAULT_BASE).toBe("https://raw.githubusercontent.com/gully-labs/token-lists/main");
    expect(GULLYCORE_TOKENLIST_DEFAULT_BASE).not.toContain("gullychain.xyz");
    expect(gullycoreTokenListUrl(4663)).toBe(`${GULLYCORE_TOKENLIST_DEFAULT_BASE}/4663.tokenlist.json`);
    expect(GULLYCORE_TOKENLIST_URL(11155111, "http://localhost:5173/tokenlists/")).toBe("http://localhost:5173/tokenlists/11155111.tokenlist.json");
    expect(gullycoreTokenListFileName(56)).toBe("56.tokenlist.json");
    expect(() => gullycoreTokenListFileName(0)).toThrow(RangeError);
  });
});

describe("mergeTokenLists", () => {
  const gullycore = list({ name: "Gully Core", tokens: [list().tokens[0]!, { chainId: 4663, address: C, decimals: 18, name: "Wrapped Ether", symbol: "WETH" }] });
  const pad = list({
    name: "Mochi",
    version: { major: 3, minor: 1, patch: 0 },
    tokens: [
      { chainId: 4663, address: A.toLowerCase(), decimals: 6, name: "NOT NVIDIA", symbol: "XNVDA" },
      { chainId: 4663, address: B, decimals: 18, name: "SpaceX", symbol: "SPCX" },
      { chainId: 1, address: B, decimals: 18, name: "Elsewhere", symbol: "ELSE" },
    ],
    tags: { stock: { name: "Overridden", description: "ignored" }, pad: { name: "Pad", description: "Listed by the pad." } },
  });

  it("dedupes by lowercase address, first list wins, and records the other sources", () => {
    const merged = mergeTokenLists([gullycore, pad], { chainId: 4663 });
    expect(merged.tokens.map((t) => t.symbol)).toEqual(["NVDA", "WETH", "SPCX"]);
    const nvda = merged.tokens[0]!;
    expect(nvda.decimals).toBe(18);
    expect(nvda.source).toEqual({ index: 0, name: "Gully Core", version: "1.0.0" });
    expect(nvda.alsoIn).toEqual([{ index: 1, name: "Mochi", version: "3.1.0" }]);
    expect(merged.tokens[2]!.source.name).toBe("Mochi");
    expect(merged.duplicates).toEqual([A.toLowerCase()]);
    expect(merged.sources).toHaveLength(2);
  });

  it("filters other chains and keeps the first tag definition", () => {
    const merged = mergeTokenLists([gullycore, pad], { chainId: 4663 });
    expect(merged.tokens.some((t) => t.symbol === "ELSE")).toBe(false);
    expect(merged.tags["stock"]?.name).toBe("Stock");
    expect(merged.tags["pad"]?.name).toBe("Pad");
    expect(mergeTokenLists([gullycore, pad], { chainId: 1 }).tokens.map((t) => t.symbol)).toEqual(["ELSE"]);
  });

  it("merges nothing to nothing", () => {
    expect(mergeTokenLists([], { chainId: 4663 })).toEqual({ chainId: 4663, tokens: [], sources: [], tags: {}, duplicates: [] });
  });
});

describe("fetchTokenList", () => {
  const body = JSON.stringify(list());
  const fake = (init: { status?: number; body?: string; headers?: Record<string, string> } = {}): typeof fetch =>
    (async () => new Response(init.body ?? body, { status: init.status ?? 200, headers: init.headers ?? {} })) as unknown as typeof fetch;

  it("returns a validated list with the update kind", async () => {
    const r = await fetchTokenList("https://example.test/4663.tokenlist.json", { fetch: fake(), current: { major: 0, minor: 9, patch: 0 } });
    expect(r.list.name).toBe("Gully Core");
    expect(r.bytes).toBe(new TextEncoder().encode(body).byteLength);
    expect(r.update).toBe("major");
  });

  it("names the failure: http, not-json, invalid, too-large, network", async () => {
    await expect(fetchTokenList("u", { fetch: fake({ status: 404 }) })).rejects.toMatchObject({ name: "TokenListFetchError", reason: "http", status: 404 });
    await expect(fetchTokenList("u", { fetch: fake({ body: "<html>" }) })).rejects.toMatchObject({ reason: "not-json" });
    const invalid = fetchTokenList("u", { fetch: fake({ body: JSON.stringify({ ...list(), name: "" }) }) });
    await expect(invalid).rejects.toMatchObject({ reason: "invalid" });
    await invalid.catch((e: TokenListFetchError) => expect(e.issues[0]?.path).toBe("name"));
    await expect(fetchTokenList("u", { fetch: fake(), maxBytes: 10 })).rejects.toMatchObject({ reason: "too-large" });
    await expect(fetchTokenList("u", { fetch: fake({ headers: { "content-length": "99999999" } }) })).rejects.toMatchObject({ reason: "too-large" });
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchTokenList("u", { fetch: failing })).rejects.toMatchObject({ reason: "network" });
  });

  it("with validate: false still requires a tokens array", async () => {
    const r = await fetchTokenList("u", { fetch: fake({ body: JSON.stringify({ tokens: [] }) }), validate: false });
    expect(r.list.tokens).toEqual([]);
    await expect(fetchTokenList("u", { fetch: fake({ body: "[]" }), validate: false })).rejects.toMatchObject({ reason: "invalid" });
  });
});

describe("launchedTokenListFromScan", () => {
  const base: LaunchRecordV2 = {
    kit: "0x000000000000000000000000000000000000c0DE",
    token: A,
    tokenMeta: { address: A, symbol: "MOCHI", name: "Mochi Coin", decimals: 18 },
    listing: { description: "", websiteURI: "", xHandle: "mochi", telegramHandle: "" },
    creator: B,
    tenant: C,
    launcher: B,
    operator: B,
    totalSupply: 1n,
    seedSupply: 1n,
    startTime: 0n,
    startTimeAtCreation: 0n,
    protocolFeeWei: 0n,
    integrator: B,
    integratorFeeWei: 0n,
    createdAtBlock: 10n,
    txHash: "0x00",
    legs: [],
    phase: "settled",
  };
  const scan = (launches: LaunchRecordV2[]): LaunchScanV2 => ({ launches, env: {} as never, fromBlock: 0n, atBlock: 100n, now: 1_789_000_000n });

  it("builds a schema-valid list with the launch tag and pad extension, and no logoURI (the listing has no icon member)", () => {
    const r = launchedTokenListFromScan(scan([base]), { chainId: 4663 });
    expect(validateTokenList(r.list)).toEqual([]);
    expect(r.list.version).toEqual({ major: 1, minor: 1, patch: 0 });
    expect(r.list.timestamp).toBe(new Date(1_789_000_000_000).toISOString());
    const t = r.list.tokens[0]!;
    expect(t.tags).toEqual([LAUNCH_TAG]);
    /* `LaunchMetadata.iconURI` was removed 2026-09-24; nothing on chain names an icon, so none is written. */
    expect(t.logoURI).toBeUndefined();
    expect(gullycoreExtensionOf(t)).toEqual({ launchpad: C, token: A });
    expect(r.omitted).toEqual([]);
  });

  it("orders oldest first, dedupes, and nulls a direct launch's pad", () => {
    const newer: LaunchRecordV2 = { ...base, token: B, tokenMeta: { address: B, symbol: "TWO", name: "Two", decimals: 6 }, tenant: "0x0000000000000000000000000000000000000000", listing: null, createdAtBlock: 20n };
    const r = launchedTokenListFromScan(scan([newer, base, { ...base, createdAtBlock: 30n }]), { chainId: 4663 });
    expect(r.list.tokens.map((t) => t.symbol)).toEqual(["MOCHI", "TWO"]);
    expect(r.list.tokens[1]!.logoURI).toBeUndefined();
    expect(gullycoreExtensionOf(r.list.tokens[1]!)?.launchpad).toBeNull();
    expect(r.list.version.minor).toBe(2);
  });

  it("omits a launch whose token did not answer or whose symbol the schema refuses, and says why", () => {
    const mute: LaunchRecordV2 = { ...base, token: B, tokenMeta: null, createdAtBlock: 20n };
    const spaced: LaunchRecordV2 = { ...base, token: C, tokenMeta: { address: C, symbol: "BAD SYM", name: "Bad", decimals: 18 }, createdAtBlock: 30n };
    const r = launchedTokenListFromScan(scan([base, mute, spaced]), { chainId: 4663 });
    expect(r.list.tokens).toHaveLength(1);
    expect(r.omitted).toHaveLength(2);
    expect(r.omitted[0]?.token).toBe(B);
    expect(r.omitted[1]?.reason).toContain("symbol");
  });

  it("truncates a name the schema cannot hold to 60 characters", () => {
    const long: LaunchRecordV2 = { ...base, tokenMeta: { address: A, symbol: "L", name: "x".repeat(80), decimals: 18 } };
    const r = launchedTokenListFromScan(scan([long]), { chainId: 4663 });
    expect(r.list.tokens[0]!.name).toHaveLength(60);
    expect(validateTokenList(r.list)).toEqual([]);
  });
});

describe("launchedTokenListFromEntries", () => {
  const A2 = "0x00000000000000000000000000000000000000a1" as const;
  const B2 = "0x00000000000000000000000000000000000000b2" as const;
  const Z = "0x0000000000000000000000000000000000000000" as const;
  it("builds the same list from plain entries, and tags every token unverified when asked", () => {
    const r = launchedTokenListFromEntries(
      [
        { token: B2, tenant: Z, createdAtBlock: 20n, tokenMeta: { symbol: "TWO", name: "Two", decimals: 6 } },
        { token: A2, tenant: Z, createdAtBlock: 10n, tokenMeta: { symbol: "ONE", name: "One", decimals: 18 }, listing: null },
      ],
      { chainId: 11155111, name: "Gully Core Launches", now: 1_789_000_000n, unverified: true },
    );
    expect(validateTokenList(r.list)).toEqual([]);
    expect(r.list.tokens.map((t) => t.symbol)).toEqual(["ONE", "TWO"]);
    expect(r.list.tokens[0]!.tags).toEqual([LAUNCH_TAG, UNVERIFIED_TAG]);
    expect(Object.keys(r.list.tags ?? {})).toEqual([LAUNCH_TAG, UNVERIFIED_TAG]);
    expect(r.list.version).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(r.list.timestamp).toBe(new Date(1_789_000_000_000).toISOString());
  });
  it("leaves the unverified tag off by default and omits an entry with no metadata", () => {
    const r = launchedTokenListFromEntries([{ token: A2, tenant: Z, createdAtBlock: 1n, tokenMeta: null }], { chainId: 1, now: 0n });
    expect(r.list.tokens).toEqual([]);
    expect(r.omitted).toHaveLength(1);
    expect(r.list.tags).toEqual({ [LAUNCH_TAG]: LAUNCH_TAG_DEFINITION });
  });
});
