// SPDX-License-Identifier: MIT
/* ============================================================================
   Where the Gully Core token lists are published.

   The lists are generated in the monorepo (`packages/tokenlists`) from the
   SDK address book and the verified stock registry, and PUBLISHED from a
   separate public repository so a third party can pin, fork or PR them
   without touching the protocol code:

       https://github.com/gully-labs/token-lists

   One file per chain, served raw from the default branch, and the
   logos beside them under `logos/<chainId>/<address>.png`.

   Nothing here points at the website domain
   (it was a placeholder domain), and a list
   URL that does not resolve is a list nobody can load. An app that serves its
   own copy passes its base; the dapp reads `VITE_GULLYCORE_TOKENLIST_BASE` for
   local development.
   ============================================================================ */

/** The public repository the lists are published from. */
export const GULLYCORE_TOKENLIST_REPO = "https://github.com/gully-labs/token-lists";

/** Base URL (no trailing slash) under which `<chainId>.tokenlist.json` and `logos/` are served. */
export const GULLYCORE_TOKENLIST_DEFAULT_BASE = "https://raw.githubusercontent.com/gully-labs/token-lists/main";

/** The file name of a chain's list, the same everywhere it is served. */
export function gullycoreTokenListFileName(chainId: number): string {
  if (!Number.isInteger(chainId) || chainId < 1) throw new RangeError(`not a chain id: ${String(chainId)}`);
  return `${chainId}.tokenlist.json`;
}

/**
 * The URL of the Gully Core token list for `chainId`. `base` defaults to the
 * published repository; pass another base (an app's own origin, a mirror)
 * and the same file name is used under it.
 */
export function gullycoreTokenListUrl(chainId: number, base: string = GULLYCORE_TOKENLIST_DEFAULT_BASE): string {
  return `${base.replace(/\/+$/, "")}/${gullycoreTokenListFileName(chainId)}`;
}

/** Upper-case alias for callers that read it as a constant-per-chain. */
export const GULLYCORE_TOKENLIST_URL = gullycoreTokenListUrl;
