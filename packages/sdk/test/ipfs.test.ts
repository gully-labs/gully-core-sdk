// SPDX-License-Identifier: MIT
/* ============================================================================
   IPFS listing icons: the parser against `multiformats` (the reference CID
   implementation), the verifier against `ipfs-unixfs-importer` (what Kubo and
   Pinata run for a single-chunk raw-leaves file), and the gateway allow-list.
   ============================================================================ */

import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 as mfSha256 } from "multiformats/hashes/sha2";
import { importer } from "ipfs-unixfs-importer";
import { MemoryBlockstore } from "blockstore-core/memory";
import { IPFS_GATEWAYS, ipfsGateways, ipfsToHttp, parseCid, parseIpfsUri, rawCid, verifyRawCid } from "../src/ipfs.js";

function bytesOf(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

async function importerCid(bytes: Uint8Array): Promise<CID> {
  const store = new MemoryBlockstore();
  let last: CID | null = null;
  for await (const entry of importer([{ content: bytes }], store, { rawLeaves: true, cidVersion: 1 })) last = entry.cid;
  if (last === null) throw new Error("importer produced nothing");
  return last;
}

describe("rawCid / verifyRawCid against the reference implementations", () => {
  it("rawCid equals multiformats' CID.createV1(raw, sha256) for the same bytes", async () => {
    for (const n of [1, 31, 32, 33, 1000, 65_536, 256 * 1024]) {
      const b = bytesOf(n, n);
      const ref = CID.createV1(raw.code, await mfSha256.digest(b));
      expect(rawCid(b)).toBe(ref.toString());
      expect(rawCid(b).startsWith("bafkrei")).toBe(true);
    }
  });

  it("the unixfs importer with { rawLeaves: true, cidVersion: 1 } names a <= 256 KiB file by exactly the raw CID", async () => {
    for (const n of [1, 4_096, 100_000, 256 * 1024]) {
      const b = bytesOf(n, n + 1);
      const fromImporter = await importerCid(b);
      expect(fromImporter.toString()).toBe(rawCid(b));
      expect(fromImporter.code).toBe(raw.code);
      expect(verifyRawCid(fromImporter.toString(), b)).toBe(true);
      expect(verifyRawCid(`ipfs://${fromImporter.toString()}`, b)).toBe(true);
    }
  });

  it("a file over the 256 KiB chunk becomes a dag-pb root the verifier refuses (never a false verified)", async () => {
    const b = bytesOf(256 * 1024 + 1, 3);
    const root = await importerCid(b);
    expect(root.code).not.toBe(raw.code);
    expect(root.toString().startsWith("bafybei")).toBe(true);
    expect(verifyRawCid(root.toString(), b)).toBe(false);
  });

  it("a bit flipped in the bytes, a v0 CID of the same digest, and a path-bearing URI all fail", async () => {
    const b = bytesOf(2_000, 9);
    const cid = rawCid(b);
    const flipped = Uint8Array.from(b);
    flipped[100]! ^= 0x01;
    expect(verifyRawCid(cid, flipped)).toBe(false);
    const v0 = CID.createV0(await mfSha256.digest(b)).toString();
    expect(v0.startsWith("Qm")).toBe(true);
    expect(verifyRawCid(v0, b)).toBe(false);
    expect(verifyRawCid(`ipfs://${cid}/icon.webp`, b)).toBe(false);
    expect(verifyRawCid("not a cid", b)).toBe(false);
    expect(verifyRawCid("", b)).toBe(false);
  });
});

describe("parseCid", () => {
  it("decodes base32 lower/upper, base58btc and hex spellings of the same CIDv1 to the same multihash", async () => {
    const b = bytesOf(50, 1);
    const ref = CID.createV1(raw.code, await mfSha256.digest(b));
    const { base58btc } = await import("multiformats/bases/base58");
    const { base16, base16upper } = await import("multiformats/bases/base16");
    const { base32upper } = await import("multiformats/bases/base32");
    for (const text of [ref.toString(), ref.toString(base32upper), ref.toString(base58btc), ref.toString(base16), ref.toString(base16upper)]) {
      const p = parseCid(text);
      expect(p, text).not.toBeNull();
      expect(p!.version).toBe(1);
      expect(p!.codec).toBe(raw.code);
      expect(p!.multihash.code).toBe(0x12);
      expect(Buffer.from(p!.multihash.digest).toString("hex")).toBe(Buffer.from(ref.multihash.digest).toString("hex"));
    }
  });

  it("decodes a CIDv0 as dag-pb + sha2-256 and rejects malformed input", async () => {
    const b = bytesOf(50, 2);
    const v0 = CID.createV0(await mfSha256.digest(b));
    const p = parseCid(v0.toString());
    expect(p).not.toBeNull();
    expect(p!.version).toBe(0);
    expect(p!.codec).toBe(0x70);
    expect(Buffer.from(p!.multihash.digest).toString("hex")).toBe(Buffer.from(v0.multihash.digest).toString("hex"));
    for (const bad of ["", "b", "bafkrei", "Qm" + "1".repeat(44), "bafkreiXYZ", "xabc", rawCid(b).slice(0, -1), rawCid(b) + "a", "b" + "a".repeat(60)]) {
      expect(parseCid(bad), bad).toBeNull();
    }
  });
});

describe("parseIpfsUri / ipfsToHttp", () => {
  const cid = rawCid(bytesOf(10, 4));

  it("accepts ipfs://<cid>, ipfs://<cid>/<path>, ipfs://ipfs/<cid>, /ipfs/<cid> and a bare CID", () => {
    expect(parseIpfsUri(`ipfs://${cid}`)).toEqual({ cid: parseCid(cid), path: "" });
    expect(parseIpfsUri(`ipfs://${cid}/icons/a b.webp`)?.path).toBe("icons/a b.webp");
    expect(parseIpfsUri(`ipfs://ipfs/${cid}`)?.cid.text).toBe(cid);
    expect(parseIpfsUri(`/ipfs/${cid}`)?.cid.text).toBe(cid);
    expect(parseIpfsUri(cid)?.cid.text).toBe(cid);
    expect(parseIpfsUri(`  IPFS://${cid}  `)?.cid.text).toBe(cid);
  });

  it("rejects https, gateway URLs, data:, dot segments, queries and junk", () => {
    for (const bad of [
      "",
      "https://example.com/icon.png",
      `https://dweb.link/ipfs/${cid}`,
      `https://${cid}.ipfs.dweb.link/`,
      "data:image/png;base64,AAAA",
      `ipfs://${cid}/../x`,
      `ipfs://${cid}/a/./b`,
      `ipfs://${cid}?x=1`,
      `ipfs://${cid}#frag`,
      "ipfs://",
      "ipfs://nope",
      "/chains/4663.svg",
    ]) {
      expect(parseIpfsUri(bad), bad).toBeNull();
      expect(ipfsToHttp(bad), bad).toBeNull();
    }
  });

  it("resolves through the allow-list in order, percent-encodes the path, and never takes a gateway from the URI", () => {
    expect(ipfsToHttp(`ipfs://${cid}`)).toEqual(IPFS_GATEWAYS.map((g) => `${g}${cid}`));
    expect(ipfsToHttp(`ipfs://${cid}/icons/a b.webp`, { gateways: ["https://gw.example/ipfs"] })).toEqual([`https://gw.example/ipfs/${cid}/icons/a%20b.webp`]);
    /* An entry that is not https (or http on loopback), or carries credentials or a query, is skipped, not used. */
    expect(ipfsToHttp(cid, { gateways: ["http://evil.example/ipfs/", "https://user:pw@gw.example/ipfs/", "https://gw.example/ipfs/?x=1", "http://127.0.0.1:8080/ipfs/", "https://ok.example/ipfs/"] })).toEqual([
      `http://127.0.0.1:8080/ipfs/${cid}`,
      `https://ok.example/ipfs/${cid}`,
    ]);
  });

  it("ipfsGateways puts an own https gateway first, drops a non-https one, and never duplicates", () => {
    expect(ipfsGateways()).toEqual(IPFS_GATEWAYS);
    /* Gully Core's own gateway is FIRST by default: the public pair refuse browser fetches (CORS). */
    expect(IPFS_GATEWAYS[0]).toBe("https://ipfs.gullylabs.xyz/ipfs/");
    expect(IPFS_GATEWAYS.slice(1)).toEqual(["https://dweb.link/ipfs/", "https://ipfs.io/ipfs/"]);
    expect(ipfsGateways({ own: "https://ipfs.gullylabs.xyz/ipfs" })).toEqual(IPFS_GATEWAYS);
    expect(ipfsGateways({ own: "https://ipfs.gullycore.example/ipfs" })).toEqual(["https://ipfs.gullycore.example/ipfs/", ...IPFS_GATEWAYS]);
    expect(ipfsGateways({ env: { GULLYCORE_IPFS_GATEWAY: "http://ipfs.gullycore.example/ipfs/" } })).toEqual(IPFS_GATEWAYS);
    expect(ipfsGateways({ own: "https://dweb.link/ipfs/" })).toEqual(["https://dweb.link/ipfs/", "https://ipfs.gullylabs.xyz/ipfs/", "https://ipfs.io/ipfs/"]);
    expect(ipfsGateways({ own: "   " })).toEqual(IPFS_GATEWAYS);
  });
});
