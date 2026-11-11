// SPDX-License-Identifier: MIT
import { encodeInlineTokenMetadataURI, rawCid, tokenMetadataDocument } from "@gullylabs/core-sdk";
import { describe, expect, it } from "vitest";

import { chainMarkFor, resolveTokenMetadataURI } from "./tokenLogo";

const WETH = "0x5555555555555555555555555555555555555555";
const GATEWAYS = ["https://gw-one.invalid/ipfs/", "https://gw-two.invalid/ipfs/"];
const ICON = "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

describe("chainMarkFor", () => {
  const chain = { nativeLogoUrl: "/hype.svg", weth: WETH };
  it("is the configured mark for the native coin and its wrapped form only", () => {
    expect(chainMarkFor({ address: "0x0000000000000000000000000000000000000000" }, chain)).toBe("/hype.svg");
    expect(chainMarkFor({ address: "0x1234567890123456789012345678901234567890", isNative: true }, chain)).toBe("/hype.svg");
    expect(chainMarkFor({ address: WETH.toUpperCase().replace("0X", "0x") }, chain)).toBe("/hype.svg");
    expect(chainMarkFor({ address: "0x1234567890123456789012345678901234567890" }, chain)).toBeNull();
  });
  it("is nothing when no mark is configured: the widget draws a monogram, which is honest", () => {
    expect(chainMarkFor({ address: "0x0000000000000000000000000000000000000000" }, { nativeLogoUrl: null, weth: WETH })).toBeNull();
  });
});

describe("resolveTokenMetadataURI", () => {
  const never = async () => {
    throw new Error("fetch must not be called");
  };

  it("reads an inline document without fetching and gates the image to ipfs://", async () => {
    const r = await resolveTokenMetadataURI(encodeInlineTokenMetadataURI({ name: "Deep", symbol: "DEEP", image: ICON }), GATEWAYS, never);
    expect(r.state).toBe("inline");
    expect(r.image).toBe(ICON);
    const noIcon = await resolveTokenMetadataURI(encodeInlineTokenMetadataURI({ name: "Deep", symbol: "DEEP" }), GATEWAYS, never);
    expect(noIcon.image).toBeNull();
  });

  it("never fetches an https:// document", async () => {
    const r = await resolveTokenMetadataURI("https://creator.example/meta.json", GATEWAYS, never);
    expect(r.state).toBe("remote-unfetched");
    expect(r.image).toBeNull();
  });

  it("fetches an ipfs:// document through the gateways in order, verifying a raw block against its CID", async () => {
    const doc = new TextEncoder().encode(tokenMetadataDocument({ name: "Deep", symbol: "DEEP", image: ICON }));
    const cid = rawCid(doc);
    const asked: string[] = [];
    const lying = new TextEncoder().encode(JSON.stringify({ name: "Not", symbol: "IT", image: ICON }));
    const fetchBytes = async (url: string) => {
      asked.push(url);
      /* The first gateway serves other bytes under the same CID; the second the real document. */
      return url.startsWith(GATEWAYS[0] ?? "") ? lying : doc;
    };
    const r = await resolveTokenMetadataURI(`ipfs://${cid}`, GATEWAYS, fetchBytes);
    expect(asked).toEqual([`${GATEWAYS[0]}${cid}`, `${GATEWAYS[1]}${cid}`]);
    expect(r.state).toBe("fetched");
    expect(r.metadata?.symbol).toBe("DEEP");
    expect(r.image).toBe(ICON);
  });

  it("is unreachable when no gateway serves it, invalid when the document does not conform, empty for no URI", async () => {
    const doc = new TextEncoder().encode(tokenMetadataDocument({ name: "Deep", symbol: "DEEP" }));
    const cid = rawCid(doc);
    expect((await resolveTokenMetadataURI(`ipfs://${cid}`, GATEWAYS, async () => null)).state).toBe("unreachable");
    const bad = new TextEncoder().encode(JSON.stringify({ symbol: "X" }));
    expect((await resolveTokenMetadataURI(`ipfs://${rawCid(bad)}`, GATEWAYS, async () => bad)).state).toBe("invalid");
    expect((await resolveTokenMetadataURI("", GATEWAYS, never)).state).toBe("empty");
    expect((await resolveTokenMetadataURI("ftp://x", GATEWAYS, never)).state).toBe("invalid");
  });
});
