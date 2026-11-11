// SPDX-License-Identifier: MIT
/**
 * Dollars, only where a price was read.
 *
 * A token amount becomes a dollar figure ONLY when the token is the chain's
 * native currency or its wrapped form (WETH is ETH held in a contract, 1:1 by
 * construction) AND the SDK's native/USD resolver answered for the chain:
 * Chainlink read on chain first, then Pyth, then a Gully Core pool — each answer
 * carrying its provenance. The resolver refuses a test network's native
 * currency, which has no market price, so a testnet build never shows dollars.
 * Every other token stays in its own units: nothing in this app prices an
 * arbitrary ERC-20, and inventing a price to produce a dollar headline is the
 * specific failure the no-invented-data rule exists to prevent.
 *
 * ONE READ FOR A WHOLE SCREEN. A list of fifty rows that each ask "what is a
 * native unit worth" is one question, so the answers are shared: every caller
 * inside `SHARE_MS` gets the same promise, and a read that threw is dropped at
 * once so a transport failure is never the answer the next caller is handed.
 * This is the DISPLAY path; the launch wizard reads through the same resolver
 * but derives a PERMANENT figure from it, and says which source it used.
 */

import { isNativeUsdQuote, resolveNativeUsd, type NativeUsdQuote, type NativeUsdResult } from "@gullylabs/core-sdk";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "./client";
import { useAsync, type AsyncState } from "./useAsync";

const SHARE_MS = 15_000;

let shared: { readonly at: number; readonly read: Promise<NativeUsdResult> } | null = null;

/** The configured chain's native/USD answer, shared between every caller that asks within `SHARE_MS`. */
export function readNativeUsd(
  load: () => Promise<NativeUsdResult> = () => {
    const cfg = resolveConfig();
    return resolveNativeUsd({ client: publicClient(), chainId: cfg.core.chainId });
  },
  now: () => number = Date.now,
): Promise<NativeUsdResult> {
  if (shared !== null && now() - shared.at < SHARE_MS) return shared.read;
  const read = load();
  const entry = { at: now(), read };
  shared = entry;
  read.catch(() => {
    if (shared === entry) shared = null;
  });
  return read;
}

/** The resolved quote, or `null` while reading, on error, or where the chain has no USD source. */
export function usdQuoteOf(state: AsyncState<NativeUsdResult>): NativeUsdQuote | null {
  return state.status === "ready" && isNativeUsdQuote(state.data) ? state.data : null;
}

/** The chain's native/USD quote for a screen, or `null`. Never throws into a render. */
export function useUsdQuote(): NativeUsdQuote | null {
  const { state } = useAsync(() => readNativeUsd(), []);
  return usdQuoteOf(state);
}

/** The full read, for a screen that must say WHY there is no dollar figure (the launch wizard). */
export function useNativeUsd(): AsyncState<NativeUsdResult> {
  return useAsync(() => readNativeUsd(), []).state;
}

export { isNativeOrWrapped, usdCompact, usdNote, usdPerUnit, usdText, usdValueOf } from "./usdFormat";
