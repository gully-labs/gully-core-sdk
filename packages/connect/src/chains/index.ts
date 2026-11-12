/* ============================================================================
   The Gully Core chain list.

   Eleven OFFERED chains, all from wagmi's curated registry, re-exported through
   `./definitions.ts` with one field replaced: `rpcUrls.default.http`, which
   carries the probed, ordered, redundant endpoint list instead of wagmi's one-
   to-three defaults.

   Eleven mainnets: HyperEVM, Robinhood Chain, Ethereum, Base, BNB Smart Chain,
   Linea, Ink, X Layer, Monad, Plasma, Stable. NO testnet is offered: Gully Core has
   no testnet deployment (HyperEVM testnet, 998, is not deployed either).

   ---------------------------------------------------------------------------
   WHY ONLY ONE TESTNET, AND WHERE THE OTHER TWO WENT
   ---------------------------------------------------------------------------

   Stable Testnet (2201), Arc Testnet (5042002) and Ethereum Sepolia (11155111)
   are not offered. Gully Core has no contracts on any of them, so each would be a
   row in the chain switcher that could only ever lead somewhere empty — and,
   unlike a mainnet, with no roadmap value to justify the row.

   Their `defineChain` entries were NOT deleted. `./definitions.ts` still defines
   and exports both, and this module still re-exports them, because their RPC
   endpoints were genuinely probed — live `eth_chainId` and three
   `eth_blockNumber` calls per URL, ordered by median latency — and deleting
   that throws away measured work that would have to be redone the day one of
   them is wanted again. An integrator who deliberately wants one can still
   pass it to `createGullyCoreConfig({ chains: [...] })`.

   What changed is only which chains this package OFFERS by default. They are
   collected in `GULLYCORE_UNLISTED_CHAINS` so that fact is explicit and greppable
   rather than an absence you have to notice.

   Monad Testnet (10143) was a third unlisted chain until 2026-09-24, when the
   owner dropped it from the stack entirely; its definition and export are gone,
   not merely unlisted. Monad MAINNET (143) is unaffected. This package has not
   been published, so no released surface changed.

   ---------------------------------------------------------------------------

   Arc MAINNET (5042) is absent for a different reason: wagmi ships it, but it
   has no public RPC. See the header of `./definitions.ts`.

   IMPORTANT — presence here means "EIP-1153 verified target", NOT "Gully Core is
   live". Gully Core is not deployed on any chain yet; its launch chain is
   HyperEVM mainnet (999).
   `GULLYCORE_DEPLOYED_CHAIN_IDS` is the list a write path may actually use.
   ============================================================================ */

import type { Chain } from 'viem'

import { GULLYCORE_CHAIN_IDS } from '@gullylabs/core-sdk'

import {
  anubis,
  arcTestnet,
  base,
  gullyChainTestnet,
  bsc,
  hyperEvm,
  ink,
  linea,
  mainnet,
  monad,
  plasma,
  sepolia,
  robinhood,
  stable,
  stableTestnet,
  xLayer,
} from './definitions.js'

export {
  anubis,
  arcTestnet,
  gullyChainTestnet,
  base,
  bsc,
  hyperEvm,
  ink,
  linea,
  mainnet,
  monad,
  plasma,
  robinhood,
  sepolia,
  stable,
  stableTestnet,
  xLayer,
  GULLYCORE_PUBLIC_RPCS,
  SINGLE_ENDPOINT_CHAIN_IDS,
  THIN_ENDPOINT_CHAIN_IDS,
  UNVERIFIED_CHAIN_METADATA,
} from './definitions.js'

/** Gully Core target chains that are mainnets. */
export const GULLYCORE_MAINNET_CHAINS = [
  // First in the list because it is the only mainnet Gully Core is deployed on.
  anubis,
  hyperEvm,
  robinhood,
  mainnet,
  base,
  bsc,
  linea,
  ink,
  xLayer,
  monad,
  plasma,
  stable,
] as const satisfies readonly Chain[]

/**
 * Gully Core target chains that are testnets.
 *
 * Empty: Gully Core has no testnet deployment. See the header of this file for the
 * testnets that are unlisted and why their definitions were kept.
 */
export const GULLYCORE_TESTNET_CHAINS = [gullyChainTestnet] as const satisfies readonly Chain[]

/**
 * Every Gully Core target chain.
 *
 * Typed as a non-empty tuple because that is what wagmi's `createConfig` and
 * RainbowKit's `getDefaultConfig` require for `chains`.
 */
export const GULLYCORE_CHAINS = [
  ...GULLYCORE_MAINNET_CHAINS,
  ...GULLYCORE_TESTNET_CHAINS,
] as unknown as readonly [Chain, ...Chain[]]

/**
 * Chains this package defines and has probed, but deliberately does not offer.
 *
 * Not in `GULLYCORE_CHAINS`, so no default config, switcher or transport touches
 * them. Exported so the omission is a documented decision rather than a silent
 * gap, and so an integrator who wants one can opt in by hand:
 *
 * ```ts
 * import { GULLYCORE_CHAINS, stableTestnet } from '@gullylabs/core-connect/chains'
 * createGullyCoreConfig({ chains: [...GULLYCORE_CHAINS, stableTestnet] })
 * ```
 *
 * Their `rpcUrls` are the same probed, fastest-first lists as everything in
 * `GULLYCORE_CHAINS`; the only thing they lack is a reason for a Gully Core user to be
 * on them.
 */
export const GULLYCORE_UNLISTED_CHAINS = [
  sepolia,
  stableTestnet,
  arcTestnet,
] as const satisfies readonly Chain[]

/**
 * Chains Gully Core contracts are actually deployed on.
 *
 * A write path must check against this, not against `GULLYCORE_CHAINS`. Sending a
 * transaction to a Gully Core address on a chain with no deployment burns gas on a
 * call to an empty account, which succeeds silently rather than reverting.
 *
 * The chains in `@gullylabs/core-sdk`'s address book (`GULLYCORE_CHAIN_IDS`), each
 * added only after its deployment was read back. This list, not the presence of a
 * chain in GULLYCORE_CHAINS, decides whether a chain is usable; every other chain
 * is filed under "Coming soon" by the switcher.
 *
 * Mainnet first: this order is what the switcher shows.
 */
/* Driven by the SDK address book, never listed by hand: a chain appears in every switcher the day its record lands
   (Gully Chain mainnet and the rest follow their own deploys). */
export const GULLYCORE_DEPLOYED_CHAIN_IDS: readonly number[] = GULLYCORE_CHAIN_IDS

/** Default chain for a fresh session: Gully Chain Testnet. */
export const GULLYCORE_DEFAULT_CHAIN: Chain = gullyChainTestnet

/** Lookup by id across the whole Gully Core list. */
export function gullycoreChainById(chainId: number): Chain | undefined {
  return GULLYCORE_CHAINS.find((c) => c.id === chainId)
}

/** True when Gully Core contracts exist on `chainId`. */
export function isGullyCoreDeployedChain(chainId: number): boolean {
  return GULLYCORE_DEPLOYED_CHAIN_IDS.includes(chainId)
}
