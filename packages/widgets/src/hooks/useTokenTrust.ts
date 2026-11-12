// SPDX-License-Identifier: MIT
/**
 * Headless reader for `TokenTrustPanel`: the SDK's `readTokenTrust` for one
 * token, plus the symbols of the currencies its pools pair it with, as a React
 * resource. No provider and no wallet: a viem `PublicClient` is enough.
 */

import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { readTokenMeta } from "@gullylabs/core-sdk";
import { readTokenTrust, type PoolKind, type TokenTrust, type TrustContracts } from "@gullylabs/core-sdk/trust";

import { useAsyncResource, type AsyncResource } from "./useAsyncResource.js";
import type { SymbolBook } from "../trust/model.js";

/** What to read. `contracts: null` means the host gave no addresses for this chain: nothing is read, and surfaces say "coming soon". */
export interface TokenTrustTarget {
  readonly token: Address;
  readonly contracts: TrustContracts | null;
  /** Pools the host knows the token trades in, beyond the ones Gully Core's launches and locks reveal. */
  readonly pools?: readonly { readonly poolId: Hex; readonly kind: PoolKind }[];
  /** CL LP-locker position ids from a log scan the host already made. */
  readonly lpLockerTokenIds?: readonly bigint[];
  readonly native?: { readonly symbol: string; readonly decimals: number };
}

export interface TokenTrustData {
  readonly trust: TokenTrust;
  readonly symbols: SymbolBook;
}

/** One read of a token's trust facts, with the paired currencies' symbols. */
export async function fetchTokenTrust(client: PublicClient, target: TokenTrustTarget & { readonly contracts: TrustContracts }): Promise<TokenTrustData> {
  const trust = await readTokenTrust(client, {
    token: target.token,
    contracts: target.contracts,
    ...(target.pools !== undefined ? { pools: target.pools } : {}),
    ...(target.lpLockerTokenIds !== undefined ? { lpLockerTokenIds: target.lpLockerTokenIds } : {}),
    ...(target.native !== undefined ? { native: target.native } : {}),
  });
  const paired = [...new Set(trust.pools.map((p) => p.pairedWith.toLowerCase()))] as Address[];
  const nativeSymbol = target.native?.symbol ?? "ETH";
  const metas = await Promise.all(paired.map((a) => (a === zeroAddress ? Promise.resolve({ symbol: nativeSymbol }) : readTokenMeta(client, a).catch(() => null))));
  const symbols: Record<string, string> = {};
  paired.forEach((a, i) => {
    const m = metas[i];
    if (m) symbols[a] = m.symbol;
  });
  return { trust, symbols };
}

export interface UseTokenTrustOptions {
  /** Re-read interval in ms; default 60,000. 0 disables polling. */
  readonly refetchIntervalMs?: number;
}

/** {@link fetchTokenTrust} as a resource: `idle` when `contracts` is `null`. */
export function useTokenTrust(client: PublicClient, target: TokenTrustTarget, options: UseTokenTrustOptions = {}): AsyncResource<TokenTrustData> {
  const c = target.contracts;
  const contractsKey = c === null ? "none" : Object.entries(c).map(([k, v]) => `${k}:${String(v ?? "")}`).sort().join("|");
  return useAsyncResource(
    () => fetchTokenTrust(client, { ...target, contracts: c as TrustContracts }),
    [
      client,
      target.token.toLowerCase(),
      contractsKey,
      (target.pools ?? []).map((p) => `${p.kind}${p.poolId}`).join(","),
      (target.lpLockerTokenIds ?? []).join(","),
      target.native?.symbol,
      target.native?.decimals,
    ],
    { enabled: c !== null, refetchIntervalMs: options.refetchIntervalMs ?? 60_000 },
  );
}
