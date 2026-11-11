// SPDX-License-Identifier: MIT
/**
 * Routed fills: whether Gully Core's router actually answers for this chain.
 *
 * `resolveConfig().routing` says what the config ASKS for and why it might be
 * off; this module asks the router API itself. A chain the API does not serve
 * answers `/sources` with a 404 (or `NOT_FOUND`), and an API that names a
 * different `GullyCoreFillRouter` than the SDK address book is refused outright
 * (`FILL_ROUTER_MISMATCH`): the address book is the one source of truth for
 * where a user's funds may be sent. Either answer leaves the swap box on
 * Gully Core pools, which is what it does on any routing failure anyway. Fail
 * closed, to Gully Core pools; never guess that a venue exists.
 */

import { RoutedQuoteError, fetchRouterSources, type RouterEndpointConfig } from "@gullylabs/core-widgets";
import type { Address } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "./client";
import { useAsync, type AsyncState } from "./useAsync";

/** The widget's `router` prop for this app, or `undefined` when routed fills are off (see `resolveRouting`). */
export function swapRouterEndpoint(): RouterEndpointConfig | undefined {
  return resolveConfig().routing.endpoint;
}

export type RouterService =
  | { readonly k: "off"; readonly reason: string }
  | { readonly k: "served"; readonly venues: readonly string[] }
  | { readonly k: "unserved"; readonly reason: string };

/** Asks the router API's `/sources` for the configured chain. Never throws for a definite "not here"; throws on transport failure. */
export async function routerService(
  endpoint: RouterEndpointConfig | undefined,
  chainId: number,
  fetchSources: typeof fetchRouterSources = fetchRouterSources,
): Promise<RouterService> {
  if (endpoint === undefined) return { k: "off", reason: resolveConfig().routing.reason ?? "Routed fills are off." };
  try {
    const sources = await fetchSources(endpoint, chainId);
    return { k: "served", venues: [...sources.values()] };
  } catch (err) {
    if (err instanceof RoutedQuoteError) {
      if (err.status === 404 || err.code === "NOT_FOUND") return { k: "unserved", reason: `The router API does not serve chain ${chainId}.` };
      if (err.code === "FILL_ROUTER_MISMATCH") {
        return { k: "unserved", reason: "The router API names a different fill router than the SDK address book; its answers are refused." };
      }
    }
    throw err;
  }
}

/** Whether the configured chain is routed, as a screen reads it. Loading and transport errors read as their own states. */
export function useRouterService(): AsyncState<RouterService> {
  const cfg = resolveConfig();
  const endpoint = cfg.routing.endpoint;
  return useAsync(() => routerService(endpoint, cfg.core.chainId), [endpoint?.baseUrl, endpoint?.fillRouter]).state;
}

/* ---------------------------------------------------------------- the fee --- */

/** The readable surface of `GullyCoreFillRouter`: the fee in force, the scheduled one and the immutable cap. */
const FILL_ROUTER_ABI = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "maxFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  {
    type: "function",
    name: "pendingFee",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "newFeeBps", type: "uint16" },
      { name: "effectiveAt", type: "uint64" },
    ],
  },
] as const;

export interface FillRouterFee {
  readonly address: Address;
  /** The fee in force now, in basis points of the input of a routed fill. */
  readonly feeBps: number;
  /** The immutable ceiling. */
  readonly maxFeeBps: number;
  /** A scheduled change, or `null`. An increase lands only after its notice; a decrease is immediate. */
  readonly pending: { readonly feeBps: number; readonly effectiveAt: number } | null;
}

/** Reads the routing fee off the fill router the app would accept calldata for, or `null` when there is none. */
export async function readFillRouterFee(): Promise<FillRouterFee | null> {
  const endpoint = resolveConfig().routing.endpoint;
  const address = endpoint?.fillRouter ?? resolveConfig().contracts.fillRouter ?? null;
  if (address === null) return null;
  const client = publicClient();
  const [feeBps, maxFeeBps, pending] = await Promise.all([
    client.readContract({ address, abi: FILL_ROUTER_ABI, functionName: "feeBps" }),
    client.readContract({ address, abi: FILL_ROUTER_ABI, functionName: "maxFeeBps" }),
    client.readContract({ address, abi: FILL_ROUTER_ABI, functionName: "pendingFee" }),
  ]);
  const [newFeeBps, effectiveAt] = pending;
  return {
    address,
    feeBps: Number(feeBps),
    maxFeeBps: Number(maxFeeBps),
    pending: effectiveAt === 0n ? null : { feeBps: Number(newFeeBps), effectiveAt: Number(effectiveAt) },
  };
}
