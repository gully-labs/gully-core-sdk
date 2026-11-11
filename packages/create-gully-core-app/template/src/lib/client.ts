// SPDX-License-Identifier: MIT
/**
 * The one read client this app uses.
 *
 * Endpoints come from `@gullylabs/core-sdk`, where every URL was probed rather
 * than collected from a list, plus anything the tenant put in
 * `chain.rpcUrls`. Tenant endpoints go first: a keyed provider is always
 * preferable to a shared public one.
 *
 * `gullycoreTransport` throws `UnknownChainError` for a chain it has no endpoints
 * for. That is on purpose and must not be softened into a default — a transport
 * that quietly points at the wrong network is how a testnet call lands on
 * mainnet.
 */

import { gullycoreTransport } from "@gullylabs/core-sdk";
import { createPublicClient, type Chain, type PublicClient } from "viem";

import { resolveConfig } from "../config/resolve";

let cached: PublicClient | null = null;

/** viem `Chain` for the configured network, built from the address book. */
export function activeChain(): Chain {
  const cfg = resolveConfig();
  return {
    id: cfg.core.chainId,
    name: cfg.core.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [...cfg.rpcUrls] } },
    ...(cfg.explorer === null ? {} : { blockExplorers: { default: { name: "Explorer", url: cfg.explorer } } }),
    testnet: !cfg.core.isMainnet,
  };
}

export function publicClient(): PublicClient {
  if (cached !== null) return cached;
  const cfg = resolveConfig();

  // Tenant endpoints are passed through the SDK's env override so they take the
  // same "private first, public as a safety net" ordering the SDK documents.
  const env: Record<string, string | undefined> =
    cfg.rpcUrls.length > 0 ? { [`GULLYCORE_RPC_${cfg.core.chainId}`]: cfg.rpcUrls.join(",") } : {};

  cached = createPublicClient({
    chain: activeChain(),
    transport: gullycoreTransport(cfg.core.chainId, { env, timeout: 12_000 }),
  });
  return cached;
}

/**
 * Explorer link for a transaction, or `null` when the configured chain has no
 * explorer (`chain.explorer: ""`, or a local devnet). Render the bare hash then
 * (`ExplorerLink` does); never a link to the real chain's explorer.
 */
export function explorerTxUrl(hash: string): string | null {
  const base = resolveConfig().explorer;
  return base === null ? null : `${base}/tx/${hash}`;
}

/** Explorer link for an address, or `null` when there is no explorer (see `explorerTxUrl`). */
export function explorerAddressUrl(address: string): string | null {
  const base = resolveConfig().explorer;
  return base === null ? null : `${base}/address/${address}`;
}
