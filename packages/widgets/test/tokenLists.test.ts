// SPDX-License-Identifier: MIT
import { mergeTokenLists, type TokenList } from "@gullylabs/core-sdk";
import { describe, expect, it } from "vitest";

import type { TokenInfo } from "../src/adapters/protocol.js";
import { combineTokens, groupBySource, isTokenListUrl, resolveLogoUrl, tokenNoteOf, tokensFromLists, tokensFromMergedList } from "../src/core/tokenLists.js";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const SPCX = "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ZERO = "0x0000000000000000000000000000000000000000";

const gullycore: TokenList = {
  name: "Gully Core",
  timestamp: "2026-09-18T00:00:00Z",
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    { chainId: 4663, address: ZERO, decimals: 18, name: "Ether", symbol: "ETH", logoURI: "https://example.test/logos/shared/eth.svg", tags: ["native"] },
    { chainId: 4663, address: WETH, decimals: 18, name: "WETH", symbol: "WETH" },
    { chainId: 4663, address: NVDA, decimals: 18, name: "NVIDIA", symbol: "NVDA", tags: ["stock"], extensions: { stock: { issuer: "Robinhood", ticker: "NVDA", rebasing: false } } },
    { chainId: 8453, address: SPCX, decimals: 18, name: "Elsewhere", symbol: "ELSE" },
  ],
  tags: { native: { name: "Native", description: "The gas token." }, stock: { name: "Stock", description: "A tokenised stock." } },
};

const pad: TokenList = {
  name: "Mochi",
  timestamp: "2026-09-18T00:00:00Z",
  version: { major: 1, minor: 2, patch: 0 },
  tokens: [
    { chainId: 4663, address: NVDA.toLowerCase(), decimals: 6, name: "Wrong", symbol: "XNVDA" },
    { chainId: 4663, address: SPCX, decimals: 18, name: "SpaceX", symbol: "SPCX", logoURI: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", tags: ["launch"], extensions: { gullycore: { launchpad: null, token: SPCX } } },
  ],
  tags: { launch: { name: "Launch", description: "A launch." } },
};

describe("tokensFromMergedList", () => {
  it("keeps the winning list's fields, marks native, carries stock, tags and provenance", () => {
    const tokens = tokensFromMergedList(mergeTokenLists([gullycore, pad], { chainId: 4663 }));
    expect(tokens.map((t) => t.symbol)).toEqual(["ETH", "WETH", "NVDA", "SPCX"]);
    const eth = tokens[0]!;
    expect(eth.isNative).toBe(true);
    expect(eth.logoUrl).toBe("https://example.test/logos/shared/eth.svg");
    expect(eth.listSource).toEqual({ name: "Gully Core", alsoIn: [] });
    const nvda = tokens[2]!;
    expect(nvda.decimals).toBe(18);
    expect(nvda.stock).toEqual({ issuer: "Robinhood", ticker: "NVDA", rebasing: false, controls: null, verifiedAt: null });
    expect(nvda.tags).toEqual(["stock"]);
    expect(nvda.listSource).toEqual({ name: "Gully Core", alsoIn: ["Mochi"] });
    const spcx = tokens[3]!;
    expect(spcx.listSource?.name).toBe("Mochi");
    expect(spcx.logoUrl).toBe("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    expect(spcx.stock).toBeUndefined();
  });

  it("filters other chains and skips non-EVM addresses", () => {
    const tokens = tokensFromLists([gullycore, pad], 8453);
    expect(tokens.map((t) => t.symbol)).toEqual(["ELSE"]);
    const solana: TokenList = { ...gullycore, tokens: [{ chainId: 4663, address: "So11111111111111111111111111111111111111112", decimals: 9, name: "Sol", symbol: "SOL" }] };
    expect(tokensFromLists([solana], 4663)).toEqual([]);
  });
});

describe("combineTokens", () => {
  const adapter: readonly TokenInfo[] = [
    { address: ZERO, symbol: "ETH", name: "Ether", decimals: 18, isNative: true },
    { address: NVDA, symbol: "NVDA", name: "NVIDIA • Robinhood Token", decimals: 18 },
  ];

  it("puts the adapter's tokens first, keeps their fields, and adds the lists' provenance and badges", () => {
    const fromLists = tokensFromLists([gullycore, pad], 4663);
    const combined = combineTokens(adapter, fromLists);
    expect(combined.map((t) => t.symbol)).toEqual(["ETH", "NVDA", "WETH", "SPCX"]);
    const nvda = combined[1]!;
    expect(nvda.name).toBe("NVIDIA • Robinhood Token");
    expect(nvda.stock?.ticker).toBe("NVDA");
    expect(nvda.listSource).toEqual({ name: null, alsoIn: ["Gully Core", "Mochi"] });
    expect(nvda.tags).toEqual(["stock"]);
    expect(combined[0]!.logoUrl).toBe("https://example.test/logos/shared/eth.svg");
  });

  it("never lets a list override an adapter token's decimals", () => {
    const wrong: TokenList = { ...pad, tokens: [{ chainId: 4663, address: NVDA, decimals: 6, name: "Wrong", symbol: "XNVDA" }] };
    const combined = combineTokens(adapter, tokensFromLists([wrong], 4663));
    expect(combined.find((t) => t.address === NVDA)?.decimals).toBe(18);
    expect(combined.find((t) => t.address === NVDA)?.symbol).toBe("NVDA");
  });

  it("with no lists is the adapter's list", () => {
    expect(combineTokens(adapter, [])).toEqual(adapter);
  });
});

describe("groupBySource", () => {
  it("groups by list, adapter tokens first under null, in first-seen order", () => {
    const combined = combineTokens([{ address: WETH, symbol: "WETH", name: "WETH", decimals: 18 }], tokensFromLists([pad, gullycore], 4663));
    const groups = groupBySource(combined);
    expect(groups.map((g) => [g.source, g.tokens.map((t) => t.symbol)])).toEqual([
      [null, ["WETH"]],
      ["Mochi", ["XNVDA", "SPCX"]],
      ["Gully Core", ["ETH"]],
    ]);
    expect(combined[0]!.listSource).toEqual({ name: null, alsoIn: ["Gully Core"] });
  });
});

describe("resolveLogoUrl", () => {
  it("passes https through, resolves ipfs through the SDK's first gateway, refuses the rest", () => {
    expect(resolveLogoUrl("https://example.test/a.png")).toBe("https://example.test/a.png");
    const ipfs = resolveLogoUrl("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    expect(ipfs).toMatch(/^https:\/\/.+\/ipfs\/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy$/);
    expect(resolveLogoUrl("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", ["https://gw.example/ipfs/"])).toBe(
      "https://gw.example/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
    );
    expect(resolveLogoUrl("http://example.test/a.png")).toBeNull();
    expect(resolveLogoUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(resolveLogoUrl("ipfs://not-a-cid")).toBeNull();
    expect(resolveLogoUrl(undefined)).toBeNull();
    expect(resolveLogoUrl(null)).toBeNull();
    /* The host's own file (same origin) and an object URL the host made from verified bytes. */
    expect(resolveLogoUrl("/chains/ethereum.svg")).toBe("/chains/ethereum.svg");
    expect(resolveLogoUrl("blob:https://gullychain.xyz/core/1234")).toBe("blob:https://gullychain.xyz/core/1234");
    /* A protocol-relative URL is another host: refused. */
    expect(resolveLogoUrl("//evil.test/a.png")).toBeNull();
  });
});

describe("isTokenListUrl", () => {
  it("tells a URL input from a list", () => {
    expect(isTokenListUrl({ url: "https://x" })).toBe(true);
    expect(isTokenListUrl(gullycore)).toBe(false);
  });
});

describe("token notes (extensions.note)", () => {
  const USDT = "0x55d398326f99059fF775485246999027B3197955";
  const bnb: TokenList = {
    name: "Gully Core",
    timestamp: "2026-10-13T00:00:00Z",
    version: { major: 1, minor: 0, patch: 0 },
    tokens: [{ chainId: 56, address: USDT, decimals: 18, name: "Tether USD", symbol: "USDT", extensions: { note: "Binance-Peg, not issued by Tether" } }],
  };

  it("a list's note reaches the picker entry", () => {
    expect(tokensFromLists([bnb], 56)[0]?.note).toBe("Binance-Peg, not issued by Tether");
  });

  it("an adapter token gains the list's note and keeps its own when it has one", () => {
    const bare: TokenInfo = { address: USDT, symbol: "USDT", name: "Tether USD", decimals: 18 };
    expect(combineTokens([bare], tokensFromLists([bnb], 56))[0]?.note).toBe("Binance-Peg, not issued by Tether");
    expect(combineTokens([{ ...bare, note: "from the address book" }], tokensFromLists([bnb], 56))[0]?.note).toBe("from the address book");
  });

  it("only a short plain line is a note", () => {
    expect(tokenNoteOf("  Binance-Peg,	 not issued by Tether ")).toBe("Binance-Peg, not issued by Tether");
    expect(tokenNoteOf("")).toBeUndefined();
    expect(tokenNoteOf("x".repeat(81))).toBeUndefined();
    expect(tokenNoteOf({ text: "no" })).toBeUndefined();
    expect(tokenNoteOf(undefined)).toBeUndefined();
  });
});
