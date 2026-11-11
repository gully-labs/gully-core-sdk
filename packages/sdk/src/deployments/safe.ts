// SPDX-License-Identifier: MIT
/* ============================================================================
   Safe{Wallet} contract addresses, per chain and per version.

   The governance Safe (`GullyCoreDeployment.governanceSafe`) is a proxy created
   through the canonical `SafeProxyFactory`, and every chain Gully Core governs
   must be one where the canonical singleton deployments landed at the same
   deterministic addresses. That is what lets a Safe transaction be hashed,
   signed and executed WITHOUT app.safe.global: the EIP-712 domain is
   `{ chainId, verifyingContract: safe }` for every Safe >= 1.3.0, and a batch
   is a DELEGATECALL into `multiSendCallOnly`, which can only CALL onward.

   TWO VERSIONS ARE RECORDED, and they are different things:

     - `SAFE_CONTRACTS` (v1.4.1) is the set the BATCH TARGET comes from.
       `buildSafeTx` and the API's signing room (`apps/api/src/admin/safeRoom.ts`)
       delegate a multi-call proposal into `SAFE_CONTRACTS[chain].multiSendCallOnly`,
       and the admin console (`apps/admin/src/lib/safeContracts.ts`) verifies that
       the target is a PUBLISHED MultiSendCallOnly with code before it hashes.
       The library is stateless and version-independent in what it does, so a
       1.5.0 Safe delegating into the 1.4.1 library is fine; what matters is that
       both halves name the SAME address, or every batch reads "DISAGREE".
       Do not move the batch target without changing both halves together.

     - `SAFE_CONTRACTS_1_5_0` is the set the governance Safe of record IS: its
       proxy points at the v1.5.0 `SafeL2` and the v1.5.0
       `CompatibilityFallbackHandler` (read on chain 2026-10-11, facts in the
       admin file above). Readers that must say which singleton a Safe runs
       (`safeContractsForVersion`) take it from here.

   Every value below is the canonical address published by
   `@safe-global/safe-deployments` (MIT), transcribed rather than imported so the
   SDK stays dependency-free. `test/safeContracts.test.ts` re-reads the code when
   an RPC is reachable and asserts the transcription against the published package
   in the admin build. A chain missing from a table has NOT been checked — do not
   add it on the strength of "the canonical deployment is everywhere". Read the
   code first.

   Which singleton a given Safe proxy points at (L1 `singleton` or `l2Singleton`)
   is read from the proxy's storage slot 0 at run time; both are listed because
   both exist on every chain here and Safe{Wallet} creates L2 proxies on L2s.
   ============================================================================ */

import type { Address } from "viem";

/** The Safe versions this SDK records addresses for. */
export type SafeVersion = "1.4.1" | "1.5.0";
export const SAFE_VERSIONS: readonly SafeVersion[] = ["1.4.1", "1.5.0"];

export interface SafeContracts {
  /** Safe version these addresses belong to. */
  readonly version: SafeVersion;
  /** `Safe.sol` — the L1 singleton. */
  readonly singleton: Address;
  /** `SafeL2.sol` — emits events for indexers without tracing; what Safe{Wallet} deploys on L2s. */
  readonly l2Singleton: Address;
  readonly proxyFactory: Address;
  /** `MultiSend` — can DELEGATECALL onward. Never the target of a governance batch. */
  readonly multiSend: Address;
  /** `MultiSendCallOnly` — the batch target: DELEGATECALLed by the Safe, it can only CALL. */
  readonly multiSendCallOnly: Address;
  /** `CompatibilityFallbackHandler` — ERC-1271 / ERC-165 on the proxy. */
  readonly fallbackHandler: Address;
  readonly signMessageLib: Address;
  readonly createCall: Address;
  readonly simulateTxAccessor: Address;
}

/** The canonical v1.4.1 deployment, identical on every EVM chain that has it (deterministic CREATE2). */
const CANONICAL_1_4_1: SafeContracts = {
  version: "1.4.1",
  singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  l2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  signMessageLib: "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9",
  createCall: "0x9b35Af71d77eaf8d7e40252370304687390A1A52",
  simulateTxAccessor: "0x3d4BA2E0884aa488718476ca2FB8Efc291A46199",
};

/**
 * The canonical v1.5.0 deployment (`@safe-global/safe-deployments` 1.37.63, `released: true`),
 * the same addresses on every chain below.
 *
 * READ ON CHAIN 2026-10-12 (`cast code`, public RPCs: 999 rpc.hyperliquid.xyz/evm at block
 * 48,331,146 · 56 bsc-dataseed1.defibit.io at 127,182,911 · 4663 rpc.mainnet.chain.robinhood.com
 * at 86,550,811 · 8453 mainnet.base.org at 52,503,085): on all four, Safe 21,451 bytes ·
 * SafeL2 22,231 · SafeProxyFactory 3,321 · MultiSend 640 · MultiSendCallOnly 421 ·
 * CompatibilityFallbackHandler 6,294 · SignMessageLib 966 · CreateCall 1,099 ·
 * SimulateTxAccessor 850; the SafeL2 answers `VERSION() == "1.5.0"`. The governance Safe
 * `0xeEd9…8c8B` points at this SafeL2 and this fallback handler on all four chains
 * (apps/admin/src/lib/safeContracts.ts, 2026-10-11).
 */
const CANONICAL_1_5_0: SafeContracts = {
  version: "1.5.0",
  singleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
  l2Singleton: "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
  proxyFactory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b",
  multiSend: "0x218543288004CD07832472D464648173c77D7eB7",
  multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
  fallbackHandler: "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4",
  signMessageLib: "0x4FfeF8222648872B3dE295Ba1e49110E61f5b5aa",
  createCall: "0x2Ef5ECfbea521449E4De05EDB1ce63B75eDA90B4",
  simulateTxAccessor: "0x07EfA797c55B5DdE3698d876b277aBb6B893654C",
};

/**
 * Chains where the canonical v1.4.1 contracts were READ at these addresses
 * (`docs/chain-certification.md`, "Safe infra"): code present, singletons answer
 * `VERSION() == "1.4.1"`. This is third-party Safe infrastructure; a chain listed
 * here says nothing about whether Gully Core is deployed on it. HyperEVM (999): all
 * nine contracts read with code on 2026-10-09 (`eth_getCode` at each address).
 *
 * THIS IS THE BATCH-TARGET SET (`GullyCoreDeployment.safe`): see the header.
 */
/**
 * Gully Chain Testnet's Safe v1.4.1 set. The canonical creation code and salts, deployed through the
 * Arachnid deterministic deployer on 2026-10-26 (the public deployment record); the addresses differ
 * from `CANONICAL_1_4_1` because the chain's deployer is not the canonical Safe singleton factory. The
 * governance Safe of record (`0xC552...b240`) is a proxy of `l2Singleton`: read on chain 2026-11-05
 * (`VERSION()` = 1.4.1, storage slot 0 = `0x7666...23Ec`).
 */
const GULLY_TESTNET_1_4_1: SafeContracts = {
  version: "1.4.1",
  singleton: "0x639245e8476E03e789a244f279b5843b9633b2E7",
  l2Singleton: "0x76667330c237Fb40f28d74563cdAAae4b06C23Ec",
  proxyFactory: "0xd9d2Ba03a7754250FDD71333F444636471CACBC4",
  multiSend: "0x7B21BBDBdE8D01Df591fdc2dc0bE9956Dde1e16C",
  multiSendCallOnly: "0x32228dDEA8b9A2bd7f2d71A958fF241D79ca5eEC",
  fallbackHandler: "0xcB4a8d3609A7CCa2D9c063a742f75c899BF2f7b5",
  signMessageLib: "0x309C7b0A0D2f250Be322739753386911E1187C4E",
  createCall: "0x8BbCaE989A0Bdf15c8E783357a0E5848e36233d0",
  simulateTxAccessor: "0xB59bD9861a97F9c309B7b73338503507580625D2",
};

export const SAFE_CONTRACTS: Readonly<Record<number, SafeContracts>> = {
  485590: GULLY_TESTNET_1_4_1,
  /* Kinetiq Elysium (99901): the Gully-route set, 1.4.1 + passkey 0.2.1, the same nine addresses as Gully Chain testnet (the Gully Core contracts repo PR #402
     l3/safe/chains/99901.json); all 15 exact-match verified on verify.gullychain.xyz, 2026-11-09 (Multisig lane). */
  99901: GULLY_TESTNET_1_4_1,
  /* Anubis (6714): all nine read with code on 2026-11-07 (rpc.anubispace.org; sizes as the Base Sepolia note below).
     Reached through the Safe singleton factory, so the addresses are Safe's canonical ones. Governance Safe VERSION 1.4.1. */
  6714: CANONICAL_1_4_1,
  /* BNB Smart Chain (56): all nine read with code on 2026-10-10, both singletons `VERSION() == "1.4.1"`. */
  56: CANONICAL_1_4_1,
  999: CANONICAL_1_4_1,
  4663: CANONICAL_1_4_1,
  8453: CANONICAL_1_4_1,
  11155111: CANONICAL_1_4_1,
  /* Base Sepolia (84532), Gully Core's testnet from 2026-10-15: all nine read with code on 2026-10-15
     (`cast code`, base-sepolia-rpc.publicnode.com at block 48,153,875: Safe 23,579 bytes · SafeL2 24,421 ·
     SafeProxyFactory 3,054 · MultiSend 629 · MultiSendCallOnly 410 · CompatibilityFallbackHandler 5,637 ·
     SignMessageLib 966 · CreateCall 1,099 · SimulateTxAccessor 850); both singletons answer
     `VERSION() == "1.4.1"`. */
  84532: CANONICAL_1_4_1,
};

/**
 * Chains where every canonical v1.5.0 contract was read with code (2026-10-12, sizes in the
 * constant's note). Sepolia is NOT listed: its 1.5.0 set has not been read.
 *
 * Base Sepolia (84532) read 2026-10-15 at block 48,153,875 (base-sepolia-rpc.publicnode.com): all nine
 * sizes identical to the constant's note (21,451 / 22,231 / 3,321 / 640 / 421 / 6,294 / 966 / 1,099 / 850).
 * The governance Safe `0xeEd9…8c8B` exists there (created by the testnet run, 123-byte proxy, VERSION 1.5.0,
 * threshold 2), which is what makes this set the batch target on that chain.
 */
export const SAFE_CONTRACTS_1_5_0: Readonly<Record<number, SafeContracts>> = {
  56: CANONICAL_1_5_0,
  999: CANONICAL_1_5_0,
  4663: CANONICAL_1_5_0,
  8453: CANONICAL_1_5_0,
  84532: CANONICAL_1_5_0,
};

export const SAFE_CONTRACT_CHAIN_IDS: readonly number[] = Object.keys(SAFE_CONTRACTS).map(Number);
/**
 * The version the governance Safe of record runs (`0xeEd9…8c8B`, v1.5.0, 2 of 3; read on chain
 * on every Gully Core chain). A reader that has the proxy at hand should still prefer the proxy's
 * own `VERSION()` through `safeContractsForVersion`; this constant is what the SDK expects.
 */
export const GOVERNANCE_SAFE_VERSION: SafeVersion = "1.4.1";

export const SAFE_CONTRACT_1_5_0_CHAIN_IDS: readonly number[] = Object.keys(SAFE_CONTRACTS_1_5_0).map(Number);

/**
 * The BATCH-TARGET set for a chain (`SAFE_CONTRACTS`, the v1.4.1 libraries today), or `undefined`
 * where it has not been verified. Not the governance Safe's own singleton: see
 * `governanceSafeContracts`.
 */
export function safeContractsFor(chainId: number): SafeContracts | undefined {
  return SAFE_CONTRACTS[chainId];
}

export function requireSafeContracts(chainId: number): SafeContracts {
  const c = SAFE_CONTRACTS[chainId];
  if (!c) throw new Error(`Safe batch-target contracts (v1.4.1 libraries) have not been verified on chain ${chainId}; read eth_getCode at the canonical addresses before adding it to SAFE_CONTRACTS`);
  return c;
}

/**
 * The verified set for ONE Safe version on a chain, or `undefined` where that version has not
 * been read there. Pass the proxy's own `VERSION()`; a version outside `SafeVersion` is a Safe
 * this SDK records nothing for, which a caller reports rather than guesses around.
 */
export function safeContractsForVersion(chainId: number, version: string): SafeContracts | undefined {
  if (version === "1.4.1") return SAFE_CONTRACTS[chainId];
  if (version === "1.5.0") return SAFE_CONTRACTS_1_5_0[chainId];
  return undefined;
}

/**
 * The contracts the governance Safe of record RUNS on a chain (its singleton and fallback
 * handler are the `GOVERNANCE_SAFE_VERSION` set), or `undefined` where that set has not been
 * read on the chain. For hashing and batching use `GullyCoreDeployment.safe` (the batch target).
 */
export function governanceSafeContracts(chainId: number): SafeContracts | undefined {
  return safeContractsForVersion(chainId, GOVERNANCE_SAFE_VERSION);
}

/**
 * Every published `MultiSendCallOnly` this SDK knows on a chain (any recorded version): the set a
 * governance batch's DELEGATECALL target must belong to. The first entry is the batch target
 * `buildSafeTx` is given today (v1.4.1).
 */
export function publishedMultiSendCallOnly(chainId: number): readonly Address[] {
  const out: Address[] = [];
  for (const table of [SAFE_CONTRACTS, SAFE_CONTRACTS_1_5_0]) {
    const c = table[chainId];
    if (c && !out.some((a) => a.toLowerCase() === c.multiSendCallOnly.toLowerCase())) out.push(c.multiSendCallOnly);
  }
  return out;
}

/**
 * Safe EIP-712 `SafeTx` type (1.3.0 and later, 1.4.1 and 1.5.0 included). The domain is
 * `{ chainId, verifyingContract }` (no name, no version). `safeTxHash` is
 * `hashTypedData({ domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message })`,
 * and it is what an owner's `eth_signTypedData_v4` signs and what
 * `execTransaction` recovers each signature against.
 */
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
