import { describe, expect, it } from "vitest";

import {
  LAUNCH_MAX_METADATA_URI_BYTES,
  TOKEN_METADATA_MAX_DESCRIPTION,
  buildTokenMetadata,
  decodeTokenMetadataURI,
  encodeInlineTokenMetadataURI,
  pinnedTokenMetadataURI,
  tokenImageUrls,
  tokenMetadataDocument,
  validateTokenMetadata,
} from "../src/launchpad/kitV2/tokenMetadata.js";

/** A real CIDv1 raw/sha2-256, the shape `POST /v1/uploads/icon` answers with. */
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const IMAGE = `ipfs://${CID}`;

describe("token metadata — the 512-byte ceiling", () => {
  it("mirrors LaunchTokenFactory.MAX_METADATA_URI_BYTES exactly", () => {
    // If this ever disagrees with the contract, a creator discovers the limit by paying for a
    // reverted launch instead of seeing it in the form.
    expect(LAUNCH_MAX_METADATA_URI_BYTES).toBe(512);
  });

  it("a pinned URI leaves most of the budget unused, which is why pinning is the default", () => {
    const uri = pinnedTokenMetadataURI(CID);
    expect(uri).toBe(IMAGE);
    expect(new TextEncoder().encode(uri).length).toBeLessThan(LAUNCH_MAX_METADATA_URI_BYTES / 2);
  });

  it("inlining works for the minimal case", () => {
    const uri = encodeInlineTokenMetadataURI({ name: "Gully Core", symbol: "GULLY CORE" });
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(new TextEncoder().encode(uri).length).toBeLessThanOrEqual(LAUNCH_MAX_METADATA_URI_BYTES);
    const back = decodeTokenMetadataURI(uri);
    expect(back.kind).toBe("inline");
    if (back.kind === "inline") expect(back.metadata.symbol).toBe("GULLY CORE");
  });

  it("REFUSES to inline something that would not fit, rather than truncating", () => {
    // A truncated data URI does not parse at all, which is strictly worse than pinning.
    const tooBig = {
      name: "Gully Core Token",
      symbol: "GULLY CORE",
      image: IMAGE,
      description: "x".repeat(400),
    };
    expect(() => encodeInlineTokenMetadataURI(tooBig)).toThrow(/at most 512/);
    expect(() => encodeInlineTokenMetadataURI(tooBig)).toThrow(/Pin the document/);
  });

  it("pins down where inlining actually stops — these are the header's measured numbers", () => {
    // The header quotes a table; this is what keeps it honest. An icon plus ~200 characters fits,
    // ~250 does not. If this test starts failing, the table above `TokenMetadata` is now wrong and
    // the wizard's "inline or pin?" decision is being made on stale arithmetic.
    const at = (n: number) => ({ name: "Gully Core", symbol: "GULLY CORE", image: IMAGE, description: "y".repeat(n) });
    expect(() => encodeInlineTokenMetadataURI(at(200))).not.toThrow();
    expect(() => encodeInlineTokenMetadataURI(at(250))).toThrow(/at most 512/);
  });

  it("the document limit and the INLINE limit are different, and conflating them causes reverts", () => {
    // TOKEN_METADATA_MAX_DESCRIPTION (1000) bounds a PINNED document. It says nothing about what
    // fits inline, and a 1000-char description is valid metadata that cannot be inlined.
    const long = { name: "Gully Core", symbol: "GULLY CORE", description: "y".repeat(TOKEN_METADATA_MAX_DESCRIPTION) };
    expect(validateTokenMetadata(long)).toEqual([]);
    expect(() => encodeInlineTokenMetadataURI(long)).toThrow(/Pin the document/);
  });
});

describe("token metadata — validation", () => {
  it("requires name and symbol", () => {
    const issues = validateTokenMetadata({ name: "", symbol: "  " });
    expect(issues.map((i) => i.field).sort()).toEqual(["name", "symbol"]);
  });

  it("reports every problem at once so a form can mark all its fields", () => {
    const issues = validateTokenMetadata({ name: "", symbol: "", image: "https://evil.example/a.png" });
    expect(issues.length).toBe(3);
  });

  it("refuses an https:// image, because it can be repointed after people have bought", () => {
    const issues = validateTokenMetadata({ name: "Gully Core", symbol: "GULLY CORE", image: "https://cdn.example/icon.png" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("image");
    expect(issues[0]?.message).toMatch(/ipfs:\/\//);
  });

  it("accepts an absent image — a token without an icon is legal", () => {
    expect(validateTokenMetadata({ name: "Gully Core", symbol: "GULLY CORE" })).toEqual([]);
  });

  it("bounds the description", () => {
    const ok = validateTokenMetadata({ name: "a", symbol: "b", description: "x".repeat(TOKEN_METADATA_MAX_DESCRIPTION) });
    expect(ok).toEqual([]);
    const over = validateTokenMetadata({ name: "a", symbol: "b", description: "x".repeat(TOKEN_METADATA_MAX_DESCRIPTION + 1) });
    expect(over.map((i) => i.field)).toEqual(["description"]);
  });

  it("rejects a non-object outright rather than coercing", () => {
    expect(validateTokenMetadata(null)[0]?.field).toBe("uri");
    expect(validateTokenMetadata("{}")[0]?.field).toBe("uri");
  });
});

describe("token metadata — the document that gets pinned", () => {
  it("drops empty optionals instead of pinning empty strings", () => {
    const doc = buildTokenMetadata({ name: " Gully Core ", symbol: " GULLY CORE ", image: "", description: "   " });
    expect(doc).toEqual({ name: "Gully Core", symbol: "GULLY CORE" });
  });

  it("is byte-stable, so the same input pins to the same CID", () => {
    const a = tokenMetadataDocument({ name: "Gully Core", symbol: "GULLY CORE", image: IMAGE });
    const b = tokenMetadataDocument({ name: "Gully Core", symbol: "GULLY CORE", image: IMAGE });
    expect(a).toBe(b);
    expect(a).toBe(`{"name":"Gully Core","symbol":"GULLY CORE","image":"${IMAGE}"}`);
  });

  it("throws on an invalid document rather than pinning something unreadable", () => {
    expect(() => tokenMetadataDocument({ name: "", symbol: "GULLY CORE" })).toThrow(/invalid token metadata/);
  });
});

describe("token metadata — decoding what a token actually stores", () => {
  it("empty is empty, not invalid — a token with no metadata is legal", () => {
    expect(decodeTokenMetadataURI("")).toEqual({ kind: "empty" });
  });

  it("an ipfs:// or https:// pointer comes back for the caller to fetch", () => {
    expect(decodeTokenMetadataURI(IMAGE)).toEqual({ kind: "remote", url: IMAGE });
    expect(decodeTokenMetadataURI("https://example.invalid/t.json").kind).toBe("remote");
  });

  it("anything else is invalid WITH A REASON, never a default document", () => {
    for (const bad of ["ftp://x", "not a uri", "data:text/plain,hi"]) {
      const out = decodeTokenMetadataURI(bad);
      expect(out.kind).toBe("invalid");
      if (out.kind === "invalid") expect(out.reason.length).toBeGreaterThan(0);
    }
  });

  it("inline JSON that parses but does not validate is invalid, not accepted", () => {
    // The dangerous case: well-formed JSON with an https:// image would otherwise sail through.
    const uri = `data:application/json;base64,${btoa(JSON.stringify({ name: "a", symbol: "b", image: "https://evil.example/x.png" }))}`;
    const out = decodeTokenMetadataURI(uri);
    expect(out.kind).toBe("invalid");
    if (out.kind === "invalid") expect(out.reason).toMatch(/image/);
  });

  it("handles a data URI with no payload separator", () => {
    expect(decodeTokenMetadataURI("data:application/json").kind).toBe("invalid");
  });

  it("handles undecodable base64 without throwing", () => {
    expect(decodeTokenMetadataURI("data:application/json;base64,!!!!").kind).toBe("invalid");
  });
});

describe("token metadata — image resolution", () => {
  it("resolves an ipfs:// image through the allow-listed gateways", () => {
    const urls = tokenImageUrls({ name: "a", symbol: "b", image: IMAGE });
    expect(urls).not.toBeNull();
    expect(urls!.length).toBeGreaterThan(0);
    for (const u of urls!) expect(u.startsWith("https://")).toBe(true);
  });

  it("returns null — not a placeholder — when there is nothing to render", () => {
    expect(tokenImageUrls(null)).toBeNull();
    expect(tokenImageUrls(undefined)).toBeNull();
    expect(tokenImageUrls({ name: "a", symbol: "b" })).toBeNull();
  });

  it("returns null for a non-ipfs image, so a token cannot point a browser at an arbitrary host", () => {
    expect(tokenImageUrls({ name: "a", symbol: "b", image: "https://evil.example/x.png" } as never)).toBeNull();
  });
});

/* ===========================================================================
   The project's own links (2026-09-25).

   A scanner that picks up a new pair reads the token, and from a Gully Core launch
   that gave it a name, a symbol and no way back to the project — while the
   creator's website and handles sat on the launch registry, one contract away,
   where nothing outside Gully Core looks. These three fields close that.

   The security-relevant half is that `x` and `telegram` are HANDLES, not URLs.
   A creator-supplied URL field would let "Telegram" point anywhere, and the one
   place that link is rendered is beside a token somebody is deciding whether to
   buy. So the tests below care as much about what is REFUSED as what is kept.
   =========================================================================== */
describe("token metadata — the project's links", () => {
  const base = { name: "Token", symbol: "TKN" };

  it("keeps a website, an X handle and a Telegram handle", () => {
    const doc = buildTokenMetadata({ ...base, website: "https://gullychain.xyz/core", x: "gullycorefun", telegram: "gullycore" });
    expect(doc.website).toBe("https://gullychain.xyz/core");
    expect(doc.x).toBe("gullycorefun");
    expect(doc.telegram).toBe("gullycore");
  });

  it("refuses a URL where a handle belongs — the whole point of storing handles", () => {
    for (const bad of ["https://t.me/gullycore", "@gullylabs", "t.me/gullycore", "gullycore protocol", "gullycore-protocol"]) {
      const issues = validateTokenMetadata({ ...base, telegram: bad });
      expect(issues.map((i) => i.field), `accepted ${bad}`).toContain("telegram");
    }
  });

  it("refuses a website that is not https://, including the schemes that are attacks", () => {
    for (const bad of ["http://gullychain.xyz/core", "javascript:alert(1)", "data:text/html,<script>", "gullychain.xyz"]) {
      const issues = validateTokenMetadata({ ...base, website: bad });
      expect(issues.map((i) => i.field), `accepted ${bad}`).toContain("website");
    }
  });

  it("treats an empty string as 'not given', so a form with blank optional inputs is valid", () => {
    expect(validateTokenMetadata({ ...base, website: "", x: "", telegram: "" })).toEqual([]);
    const doc = buildTokenMetadata({ ...base, website: "", x: "", telegram: "" });
    expect("website" in doc).toBe(false);
    expect("x" in doc).toBe(false);
    expect("telegram" in doc).toBe(false);
  });

  it("bounds each field at the platform's own limit", () => {
    expect(validateTokenMetadata({ ...base, x: "a".repeat(16) }).map((i) => i.field)).toContain("x");
    expect(validateTokenMetadata({ ...base, x: "a".repeat(15) })).toEqual([]);
    expect(validateTokenMetadata({ ...base, telegram: "a".repeat(33) }).map((i) => i.field)).toContain("telegram");
    expect(validateTokenMetadata({ ...base, telegram: "a".repeat(32) })).toEqual([]);
  });

  it("pins deterministically, and a document without links is byte-identical to one from before this change", () => {
    const a = tokenMetadataDocument({ ...base, website: "https://gullychain.xyz/core", x: "gullycorefun" });
    const b = tokenMetadataDocument({ ...base, website: "https://gullychain.xyz/core", x: "gullycorefun" });
    expect(a).toBe(b);
    // The links are appended after the existing keys, so nothing that was pinnable before re-pins
    // to a different CID now.
    expect(tokenMetadataDocument({ ...base, description: "d" })).toBe(JSON.stringify({ name: "Token", symbol: "TKN", description: "d" }));
  });

  it("round-trips through an inline URI", () => {
    const uri = encodeInlineTokenMetadataURI({ name: "T", symbol: "T", x: "abc" });
    const decoded = decodeTokenMetadataURI(uri);
    /* `DecodedTokenMetadata` is a discriminated union and `metadata` lives only on the `inline`
       arm, so the variant has to be narrowed rather than reached through with `?.` — which is
       what this test used to do, and it did not typecheck. Asserting the arm is also the stronger
       test: `decoded.metadata?.x` would have passed just as happily on a `remote` decode, which
       is the exact failure a round-trip test exists to catch. */
    expect(decoded.kind).toBe("inline");
    if (decoded.kind !== "inline") return;
    expect(decoded.metadata.x).toBe("abc");
  });
});
