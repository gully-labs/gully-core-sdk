// SPDX-License-Identifier: MIT
/**
 * The Gully Core Solana address book. A copy of records/gully-core-solana-<cluster>.json (kept equal by
 * test/solana.test.ts and scripts/sync-check.mjs, which also compares it with the gully-ops record and the
 * `solana` block of https://gullycore.xyz/manifest.json). Solana is DEVNET ONLY: no mainnet entry exists until
 * Gully Core is deployed on Solana mainnet.
 */
import type { SolanaAddress } from "./codec.js";

export type GullyCoreSolanaCluster = "devnet";

export interface GullyCoreSolanaDeployment {
  readonly family: "solana";
  readonly cluster: GullyCoreSolanaCluster;
  readonly key: "solana-devnet";
  readonly name: string;
  /** devnet: devnet SOL has no value. */
  readonly kind: "devnet";
  readonly rpc: string;
  readonly explorer: string;
  readonly explorerQuery: string;
  readonly programs: { readonly cpSwap: SolanaAddress; readonly launch: SolanaAddress };
  readonly governance: {
    readonly kind: "squads";
    readonly multisig: SolanaAddress;
    readonly threshold: number;
    readonly members: number;
    readonly upgradeAuthority: SolanaAddress;
    readonly vaults: { readonly admin: SolanaAddress; readonly treasury: SolanaAddress };
  };
  readonly feeSettings: SolanaAddress;
  readonly configs: { readonly builder: SolanaAddress; readonly kre8: SolanaAddress };
  readonly fees: {
    readonly builderFeeRate: number;
    readonly builderFeeCap: number;
    readonly kre8TradeFeeRate: number;
    readonly kre8CreatorFeeRate: number;
    readonly creatorTaxShareRate: number;
    readonly launchFeeLamports: number;
    readonly launchFeeUsd: number;
    readonly antiSnipeStartRate: number;
    readonly antiSnipeDurationSeconds: number;
    readonly raiseNoticeSeconds: number;
  };
  readonly router: { readonly url: string; readonly mainnetQuotes: string; readonly feeBpsOtherVenues: number; readonly feeBpsGullyCorePools: number };
  /** Wrapped SOL mint, the quote of every Gully Core Solana pool. */
  readonly wsol: SolanaAddress;
}

const DEVNET: GullyCoreSolanaDeployment = {
    family: "solana",
    cluster: "devnet",
    key: "solana-devnet",
    name: "Solana Devnet",
    kind: "devnet",
    rpc: "https://api.devnet.solana.com",
    explorer: "https://explorer.solana.com",
    explorerQuery: "?cluster=devnet",
    programs: { cpSwap: "JBguvgwdAn4RexixPqBu8y4hfMzRZi3hm5y5oisnyEzR", launch: "7qWhkFQxe58ojmUSUwDh24rFtjmJdscGnp5AUM37SGNa" },
    governance: {
      kind: "squads",
      multisig: "95GbCxFc7wEMpnvq7ME7Sk8FX86YsBSRWBeVRkFbDv46",
      threshold: 2,
      members: 3,
      upgradeAuthority: "8PFcZhTgnfmnHBwaVkQyMQUQNPD8T7frrmhvNVNJ7dJK",
      vaults: { admin: "8PFcZhTgnfmnHBwaVkQyMQUQNPD8T7frrmhvNVNJ7dJK", treasury: "6qFWns54ZqgDb8sLH6cPqW8tHqr6qeDJ4Z9zXjc8gEsg" },
    },
    feeSettings: "G3kRG1HAMUcZoCqtzE56QagpocCjgrKm4a3VqC52eA1j",
    configs: { builder: "2VU7HYxokxJEYM9xhwL8njBnikJQG4hHrADZQb3ZKRFf", kre8: "4vfW7KeiMQ2WwBei9LH4kx67Nd19FLstoXUeww4jsqdy" },
    fees: {
      builderFeeRate: 3000,
      builderFeeCap: 4000,
      kre8TradeFeeRate: 10000,
      kre8CreatorFeeRate: 5000,
      creatorTaxShareRate: 100000,
      launchFeeLamports: 13800000,
      launchFeeUsd: 2,
      antiSnipeStartRate: 500000,
      antiSnipeDurationSeconds: 60,
      raiseNoticeSeconds: 604800,
    },
    router: { url: "https://api.gullylabs.xyz/solana-router/devnet", mainnetQuotes: "https://api.gullylabs.xyz/solana-router/dev", feeBpsOtherVenues: 15, feeBpsGullyCorePools: 0 },
    wsol: "So11111111111111111111111111111111111111112",
};

export const GULLYCORE_SOLANA_DEPLOYMENTS: Readonly<Record<GullyCoreSolanaCluster, GullyCoreSolanaDeployment>> = Object.freeze({ devnet: Object.freeze(DEVNET) });

export const GULLYCORE_SOLANA_CLUSTERS: readonly GullyCoreSolanaCluster[] = Object.freeze(["devnet"]);

export function isGullyCoreSolanaCluster(c: string): c is GullyCoreSolanaCluster {
  return (GULLYCORE_SOLANA_CLUSTERS as readonly string[]).includes(c);
}

/** Same name as the EVM `getDeployment(chainId)`: the Solana deployment for a cluster, or undefined. */
export function getDeployment(cluster: string): GullyCoreSolanaDeployment | undefined {
  return isGullyCoreSolanaCluster(cluster) ? GULLYCORE_SOLANA_DEPLOYMENTS[cluster] : undefined;
}

/** Same name as the EVM `requireDeployment(chainId)`: throws for a cluster Gully Core is not on (mainnet today). */
export function requireDeployment(cluster: string): GullyCoreSolanaDeployment {
  const d = getDeployment(cluster);
  if (!d) throw new Error(`Gully Core is not deployed on Solana ${cluster} (devnet only today)`);
  return d;
}

export function explorerAddressUrl(cluster: GullyCoreSolanaCluster, address: string): string {
  const d = GULLYCORE_SOLANA_DEPLOYMENTS[cluster];
  return `${d.explorer}/address/${address}${d.explorerQuery}`;
}

export function explorerTxUrl(cluster: GullyCoreSolanaCluster, signature: string): string {
  const d = GULLYCORE_SOLANA_DEPLOYMENTS[cluster];
  return `${d.explorer}/tx/${signature}${d.explorerQuery}`;
}
