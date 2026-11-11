// SPDX-License-Identifier: MIT
/**
 * The logo the swap box draws for a token that carries none of its own.
 *
 * The widget draws a token's own `logoUrl` (from a configured entry or a token
 * list) first, then this resolver's answer (`WidgetProvider tokenLogo`), then a
 * monogram. This resolver answers for the two kinds of token no published list
 * covers:
 *
 *   - the chain's native coin and its WRAPPED form: `brand.nativeLogoUrl` from
 *     `gullycore.config.ts`, the currency's own mark. WETH is ETH held in a
 *     contract, so it is drawn with ETH's mark, as WHYPE is with HYPE's;
 *   - a token launched by `LaunchpadKitV2`: its OWN icon, the `image` of the
 *     metadata document its contract names (`metadataURI()`), fetched through
 *     the configured IPFS gateways and checked against its CID. Only an
 *     `ipfs://` document is fetched; an `https://` one is NOT (it can change
 *     after people have bought, and it would see every visitor's address).
 *
 * Nothing else is asked for: only the addresses a screen names as launch tokens
 * are read, so a picker of a hundred tokens costs no hundred reads. A token
 * with neither answer keeps its monogram; an image that fails to load falls
 * back to it inside the widget. No logo is invented. One read per token per
 * page life. The pure parts are tested in node (`tokenLogo.test.ts`).
 */

import { decodeTokenMetadataURI, ipfsToHttp, parseIpfsUri, tokenImageUrls, validateTokenMetadata, verifyRawCid, type TokenMetadata } from "@gullylabs/core-sdk";
import type { Address } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "./client";

const ZERO = "0x0000000000000000000000000000000000000000";

/** The native coin or the chain's wrapped native: the configured native mark. Pure. */
export function chainMarkFor(token: { readonly address: string; readonly isNative?: boolean }, chain: { readonly nativeLogoUrl: string | null; readonly weth: string | null }): string | null {
  if (chain.nativeLogoUrl === null) return null;
  const a = token.address.toLowerCase();
  const native = token.isNative === true || a === ZERO;
  const wrapped = chain.weth !== null && a === chain.weth.toLowerCase();
  return native || wrapped ? chain.nativeLogoUrl : null;
}

const LAUNCH_TOKEN_METADATA_ABI = [{ type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;

/** How long one gateway may take before the next is tried. */
const GATEWAY_TIMEOUT_MS = 8_000;
/** A metadata document is under 2 KiB by the SDK's bounds; never read more than this from a gateway. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

export interface TokenMetadataRead {
  readonly state: "empty" | "inline" | "fetched" | "remote-unfetched" | "invalid" | "unreachable";
  readonly metadata: TokenMetadata | null;
  /** The `ipfs://` icon a renderer may draw, or null: never anything else. */
  readonly image: string | null;
  /** For a provenance line; never rendered as data. */
  readonly reason: string | null;
}

export type FetchBytes = (url: string) => Promise<Uint8Array | null>;

async function fetchDocument(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" }, referrerPolicy: "no-referrer", credentials: "omit", mode: "cors" });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_DOCUMENT_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length === 0 || buf.length > MAX_DOCUMENT_BYTES ? null : buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Decode a `metadataURI` already read off a token, fetching an `ipfs://` document through `gateways`. Never throws. */
export async function resolveTokenMetadataURI(uri: string, gateways: readonly string[], fetchBytes: FetchBytes = fetchDocument): Promise<TokenMetadataRead> {
  const decoded = decodeTokenMetadataURI(uri);
  const gate = (metadata: TokenMetadata): string | null => (tokenImageUrls(metadata, { gateways }) === null ? null : (metadata.image ?? null));
  switch (decoded.kind) {
    case "empty":
      return { state: "empty", metadata: null, image: null, reason: null };
    case "invalid":
      return { state: "invalid", metadata: null, image: null, reason: decoded.reason };
    case "inline":
      return { state: "inline", metadata: decoded.metadata, image: gate(decoded.metadata), reason: null };
    case "remote": {
      if (!decoded.url.startsWith("ipfs://")) {
        return { state: "remote-unfetched", metadata: null, image: null, reason: "an https:// metadata document is not fetched: it can change after people have bought" };
      }
      const parsed = parseIpfsUri(decoded.url);
      const urls = ipfsToHttp(decoded.url, { gateways });
      if (parsed === null || urls === null || urls.length === 0) return { state: "invalid", metadata: null, image: null, reason: "not a valid ipfs://<cid> URI" };
      for (const url of urls) {
        const bytes = await fetchBytes(url);
        if (bytes === null) continue;
        /* A single raw block whose bytes do not hash to the CID is a gateway lying; try the next one. */
        if (parsed.cid.codec === 0x55 && !verifyRawCid(decoded.url, bytes)) continue;
        let doc: unknown;
        try {
          doc = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return { state: "invalid", metadata: null, image: null, reason: "the document is not JSON" };
        }
        const issues = validateTokenMetadata(doc);
        if (issues.length > 0) return { state: "invalid", metadata: null, image: null, reason: issues.map((i) => `${i.field}: ${i.message}`).join("; ") };
        const metadata = doc as TokenMetadata;
        return { state: "fetched", metadata, image: gate(metadata), reason: null };
      }
      return { state: "unreachable", metadata: null, image: null, reason: "no configured gateway served the document" };
    }
  }
}

const reads = new Map<string, Promise<TokenMetadataRead>>();

/** A launch token's metadata, read once per page life; a token that does not answer `metadataURI()` reads as `unreachable`. */
export function readLaunchTokenMetadata(token: Address): Promise<TokenMetadataRead> {
  const key = token.toLowerCase();
  let hit = reads.get(key);
  if (hit === undefined) {
    const cfg = resolveConfig();
    hit = publicClient()
      .readContract({ address: token, abi: LAUNCH_TOKEN_METADATA_ABI, functionName: "metadataURI" })
      .then((uri) => resolveTokenMetadataURI(uri, cfg.ipfsGateways))
      .catch((): TokenMetadataRead => ({ state: "unreachable", metadata: null, image: null, reason: "the token did not answer metadataURI()" }));
    reads.set(key, hit);
  }
  return hit;
}
