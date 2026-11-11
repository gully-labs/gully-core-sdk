// SPDX-License-Identifier: MIT
/**
 * Gully Core's shared core, per chain.
 *
 * These are the contracts you do NOT deploy. Your pools live in this Vault and
 * are managed by these pool managers; you deploy a front end and, if you want
 * one, a launchpad instance. That is the whole shared-core model.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE NO LONGER HOLDS ANY ADDRESSES, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * It used to carry its own hand-typed table. So did Gully Core's own dapp. Two
 * copies of one truth is a drift machine: the two had ALREADY diverged before
 * anybody noticed — this copy knew nothing about the timelocks, the fee
 * controller, the quoters or the position descriptor, and there was no way to
 * tell from either file which one was behind.
 *
 * The table now lives in `@gullylabs/core-sdk` (MIT, the same package this app
 * already depends on for ABIs, event decoding and probed RPC endpoints), and
 * both consumers import it. When Gully Core redeploys a contract you get the new
 * address by bumping the SDK — not by editing this file, and not by discovering
 * six months later that you were reading a retired one.
 *
 * Everything below is a RE-EXPORT under the names this project already used, so
 * nothing else in the template changes.
 *
 * ---------------------------------------------------------------------------
 * WHY `registry` AND `launchpadKit` STILL LIVE IN `gullycore.config.ts`
 * ---------------------------------------------------------------------------
 *
 * A `Vault` is immutable and permanent — its address will not change, and
 * baking it in means you cannot mistype it. `GullyCoreRegistry` is a redeployable
 * directory contract that has already been redeployed once, and a stale
 * registry address does not fail loudly: it answers `gullycoreCount()` with a
 * number, renders as a healthy empty marketplace, and nothing anywhere says the
 * app is reading a retired contract. So it stays in `gullycore.config.ts` where you
 * can see and change it, and the same goes for `launchpadKit`.
 *
 * The SDK marks exactly this class of address in `REDEPLOYABLE_CONTRACTS`, and
 * anything it does not yet have an address for reads `null` — never a zero
 * address, which is a value your code would happily call and get silence from.
 *
 * Run `npm run gullycore:verify` to check every address here actually has code on
 * the chain you configured. An address book is a claim, not a fact.
 */

import {
  GULLYCORE_DEPLOYMENTS as SDK_DEPLOYMENTS,
  /* CHAIN_NATIVE_CURRENCIES, not NATIVE_CURRENCY. This import wanted the
     per-chain table and used to get it only because the SDK's barrel had two
     bindings of that name — a star-exported zero-address sentinel and an
     explicit re-export of the table — and ESM silently let the explicit one
     win. The sentinel was unreachable from the root and
     isNativeCurrency(NATIVE_CURRENCY) threw. The names are distinct now, and
     this is the side that was depending on the collision. */
  CHAIN_NATIVE_CURRENCIES as SDK_NATIVE_CURRENCY,
  GULLYCORE_CHAIN_IDS,
  chainById,
  isGullyCoreChainId,
  type GullyCoreDeployment,
} from "@gullylabs/core-sdk";

import type { SupportedChainId, UndeployedChainId } from "./types.js";

/**
 * Every Gully Core contract on one chain, plus its token decimals and the reference
 * pool if it has one.
 *
 * A field typed `Address` is deployed on every supported chain. A field typed
 * `Address | null` genuinely does not exist somewhere — check it rather than
 * substituting a placeholder. `decimals` on a token is never optional: raw
 * units are what `sqrtPriceX96` encodes, so a 6-decimal quote assumed to be 18
 * misprices a pool by 10^12, permanently, at `initialize`.
 */
export type CoreDeployment = GullyCoreDeployment;

export const GULLYCORE_DEPLOYMENTS: Readonly<Record<SupportedChainId, CoreDeployment>> =
  SDK_DEPLOYMENTS;

/** Native currency metadata per chain. */
export const NATIVE_CURRENCY: Readonly<
  Record<SupportedChainId, { name: string; symbol: string; decimals: number }>
> = SDK_NATIVE_CURRENCY;

/**
 * Whether Gully Core's shared core is deployed on a chain.
 *
 * Delegated to the SDK rather than restated as a hardcoded comparison, so a
 * chain Gully Core adds becomes supported here by bumping the dependency.
 *
 * Every chain Gully Core's shared core is deployed on, from the SDK. Derived.
 */
export const SUPPORTED_CHAIN_IDS: readonly SupportedChainId[] = GULLYCORE_CHAIN_IDS;

export function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return isGullyCoreChainId(chainId);
}

/**
 * Chains this template can be pointed at before Gully Core is deployed there: on
 * the SDK's target list (`CHAIN_RPCS`, probed public endpoints), absent from
 * its address book, AND announced by Gully Core. Pointed at one, the app renders
 * a single honest page — every feature "Coming soon on <chain>" — and reads
 * nothing it cannot.
 *
 * EMPTY TODAY. The rollout is settled at the four chains the address book
 * records (HyperEVM, BNB Smart Chain, Robinhood Chain, Base; owner, 2026-10-11).
 * A chain the SDK lists but Gully Core is not launching on is not "coming soon",
 * and this list must never say so: add an id here only when Gully Core has
 * announced that chain and the SDK already lists it. Derived, not asserted:
 * an id the address book gains stops being "undeployed" by the filter below.
 */
const CANDIDATE_UNDEPLOYED: readonly UndeployedChainId[] = [];

export const UNDEPLOYED_CHAIN_IDS: readonly UndeployedChainId[] = CANDIDATE_UNDEPLOYED.filter(
  (id) => !isGullyCoreChainId(id) && chainById(id) !== undefined,
);

/** The SDK's name for a chain it lists but Gully Core is not deployed on, else `null`. */
export function undeployedChain(chainId: number): { readonly chainId: number; readonly name: string } | null {
  if (!(UNDEPLOYED_CHAIN_IDS as readonly number[]).includes(chainId)) return null;
  const rpc = chainById(chainId);
  return rpc === undefined ? null : { chainId, name: rpc.name };
}
