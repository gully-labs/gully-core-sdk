// SPDX-License-Identifier: MIT
/**
 * Token lists as the picker consumes them: pure functions from the SDK's
 * `TokenList` documents to the widgets' `TokenInfo`, with the provenance kept
 * on each entry. The React hook (`hooks/useTokenLists.ts`) fetches and calls
 * these; nothing here touches the network or the DOM, so it is testable on its
 * own and reusable by a headless integrator.
 */

import {
  ipfsToHttp,
  mergeTokenLists,
  stockExtensionOf,
  type MergedTokenList,
  type TokenList,
} from "@gullylabs/core-sdk";
import { isAddress, type Address } from "viem";
import type { TokenInfo } from "../adapters/protocol.js";

/** One entry of `SwapWidget`'s `tokenLists`: a list already in hand, or a URL to fetch. */
export type TokenListInput = TokenList | { readonly url: string };

export function isTokenListUrl(input: TokenListInput): input is { readonly url: string } {
  return typeof (input as { url?: unknown }).url === "string";
}

const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** A list's `extensions.note` as the picker shows it: plain text, one line, at most 80 characters; anything else is dropped. */
export function tokenNoteOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  return text === "" || text.length > 80 ? undefined : text;
}

/**
 * The picker entries a merge yields, for `chainId`. Tokens whose address is not
 * a 20-byte hex address (the schema also admits a Solana form) are skipped:
 * they cannot be a Gully Core pool currency.
 */
export function tokensFromMergedList(merged: MergedTokenList): readonly TokenInfo[] {
  const out: TokenInfo[] = [];
  for (const t of merged.tokens) {
    if (!isAddress(t.address)) continue;
    const stock = stockExtensionOf(t);
    const note = tokenNoteOf(t.extensions?.["note"]);
    const entry: TokenInfo = {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      ...(t.logoURI === undefined ? {} : { logoUrl: t.logoURI }),
      ...(t.address.toLowerCase() === NATIVE ? { isNative: true } : {}),
      listSource: { name: t.source.name, alsoIn: t.alsoIn.map((s) => s.name) },
      ...(stock === null ? {} : { stock }),
      ...(t.tags === undefined ? {} : { tags: t.tags }),
      ...(note === undefined ? {} : { note }),
    };
    out.push(entry);
  }
  return out;
}

/**
 * The picker's final order: the adapter's own tokens first (the tokens of the
 * pools this site routes through, read on chain), then every list's tokens in
 * list order, deduped by lowercase address. A token the adapter already knows
 * keeps the adapter's fields — its decimals were read off the contract — and
 * gains the list's provenance, logo, stock badge and tags where the adapter had
 * none.
 */
export function combineTokens(adapterTokens: readonly TokenInfo[], listTokens: readonly TokenInfo[]): readonly TokenInfo[] {
  const byAddress = new Map<string, TokenInfo>();
  for (const t of adapterTokens) byAddress.set(t.address.toLowerCase(), t);
  for (const t of listTokens) {
    const key = t.address.toLowerCase();
    const existing = byAddress.get(key);
    if (existing === undefined) {
      byAddress.set(key, t);
      continue;
    }
    byAddress.set(key, {
      ...existing,
      ...(existing.logoUrl === undefined && t.logoUrl !== undefined ? { logoUrl: t.logoUrl } : {}),
      /* The adapter's token stays the adapter's; the lists that also name it are recorded as corroboration. */
      ...(t.listSource !== undefined
        ? { listSource: { name: existing.listSource?.name ?? null, alsoIn: [...(existing.listSource?.alsoIn ?? []), t.listSource.name ?? "", ...t.listSource.alsoIn].filter((n) => n !== "") } }
        : {}),
      ...(existing.stock === undefined && t.stock !== undefined ? { stock: t.stock } : {}),
      ...(existing.tags === undefined && t.tags !== undefined ? { tags: t.tags } : {}),
      ...(existing.note === undefined && t.note !== undefined ? { note: t.note } : {}),
    });
  }
  return [...byAddress.values()];
}

/** `mergeTokenLists` then `tokensFromMergedList`, for callers with every list in hand. */
export function tokensFromLists(lists: readonly TokenList[], chainId: number): readonly TokenInfo[] {
  return tokensFromMergedList(mergeTokenLists(lists, { chainId }));
}

/**
 * The URL an `<img>` can load for a token's logo: `https://` as given,
 * `ipfs://` through the SDK's first allow-listed gateway, anything else
 * `null` (the caller draws a monogram). `http://` is refused: a mixed-content
 * image on an https site is blocked by the browser and reads as a broken logo.
 * A root-relative path ("/chains/ethereum.svg") is the host's own file and loads same-origin; a `blob:`
 * URL is one the host created from bytes it verified.
 */
export function resolveLogoUrl(logoUrl: string | null | undefined, gateways?: readonly string[]): string | null {
  if (logoUrl === undefined || logoUrl === null) return null;
  if (logoUrl.startsWith("https://")) return logoUrl;
  /* The host's own file, same origin (a root-relative path such as "/chains/ethereum.svg"); never "//host". */
  if (logoUrl.startsWith("/") && !logoUrl.startsWith("//")) return logoUrl;
  /* An object URL the host made from bytes it fetched and verified itself (a launch icon from IPFS). */
  if (logoUrl.startsWith("blob:")) return logoUrl;
  if (logoUrl.startsWith("ipfs://")) {
    const urls = ipfsToHttp(logoUrl, gateways === undefined ? {} : { gateways });
    return urls === null || urls.length === 0 ? null : (urls[0] ?? null);
  }
  return null;
}

/** Group entries by their list source, in first-seen order; adapter tokens (no source) come first under `null`. */
export function groupBySource(tokens: readonly TokenInfo[]): readonly { readonly source: string | null; readonly tokens: readonly TokenInfo[] }[] {
  const groups = new Map<string | null, TokenInfo[]>();
  groups.set(null, []);
  for (const t of tokens) {
    const key = t.listSource?.name ?? null;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [t]);
    else list.push(t);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0).map(([source, list]) => ({ source, tokens: list }));
}
