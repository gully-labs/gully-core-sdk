// SPDX-License-Identifier: MIT
/**
 * What the scaffolder needs to know, and what it refuses to guess.
 *
 * Two of these are load-bearing enough that a wrong value is worse than no
 * value, so neither has a default:
 *
 *   * `chainId` — the app reads and writes one chain. Gully Core's shared core is
 *     deployed on a specific list of them and nowhere else, and pointing a UI
 *     at a chain with no Vault produces a screen full of failed reads with no
 *     explanation. Picking one for the tenant would be picking wrong.
 *   * `feeWallet` — the address the front end's swap fee is paid to. A default
 *     here would either be the zero address (fee silently burned) or ours
 *     (fee silently ours). Both are unacceptable, so it is required whenever a
 *     non-zero fee is configured.
 */

import { ArgError } from "./util/args.js";

/** Chains where Gully Core's shared core is deployed. Keep in step with the SDK's
    address book — `test/scaffold.test.ts` asserts that, so it cannot silently drift.
    A chain is added here in the same commit that records its addresses in
    `@gullylabs/core-sdk`, and its name is the address book's. */
export const SUPPORTED_CHAINS: ReadonlyMap<number, string> = new Map<number, string>([
  [8453, "Base"],
  [56, "BNB Chain"],
  [4663, "Robinhood Chain"],
  [99901, "Kinetiq Elysium"],
  [6714, "Anubis Network"],
  [485590, "Gully Chain Testnet"],
]);

/**
 * Chains on `@gullylabs/core-sdk`'s target list where Gully Core is announced but NOT
 * deployed yet. Accepted, because the generated app renders one honest "Coming
 * soon on <chain>" page there and starts working, unedited, the day the SDK
 * address book records the chain. Keep in step with the template's
 * `src/config/deployments.ts` (`UNDEPLOYED_CHAIN_IDS`).
 *
 * EMPTY on purpose (2026-10-11). A chain the SDK lists but Gully Core is not launching on is NOT "coming
 * soon", and saying so would be an invented claim; it is refused with the list
 * of deployed chains instead.
 */
export const UNDEPLOYED_CHAINS: ReadonlyMap<number, string> = new Map<number, string>([]);

/** Chain aliases accepted on the command line, so `--chain base` works. */
const CHAIN_ALIASES: ReadonlyMap<string, number> = new Map([
  ["elysium", 99901],
  ["kinetiq", 99901],
  ["99901", 99901],
  ["anubis", 6714],
  ["6714", 6714],
  ["gullytestnet", 485590],
  ["testnet", 485590],
  ["485590", 485590],
  ["bnb", 56],
  ["bsc", 56],
  ["binance", 56],
  ["56", 56],
  ["robinhood", 4663],
  ["4663", 4663],
  ["base", 8453],
  ["8453", 8453],
]);

export type FeatureFlag = "swap" | "pools" | "launchpad" | "splits" | "locks" | "airdrops";

export const ALL_FEATURES: readonly FeatureFlag[] = ["swap", "pools", "launchpad", "splits", "locks", "airdrops"];

/**
 * Named bundles, because "DEX only / launchpad only / both" is how tenants
 * think. The Gully Core utilities ride along where they belong: locks and airdrops
 * with either product, Team splits with the launchpad (a launch can pay its
 * creator share to one).
 */
const FEATURE_BUNDLES: ReadonlyMap<string, readonly FeatureFlag[]> = new Map([
  ["dex", ["swap", "pools", "locks", "airdrops"]],
  ["launchpad", ["launchpad", "splits", "locks", "airdrops"]],
  ["both", ALL_FEATURES],
  ["all", ALL_FEATURES],
]);

export interface ScaffoldOptions {
  /** Directory the project is written to. */
  readonly directory: string;
  /** npm package name for the generated app. */
  readonly packageName: string;
  /** Human-facing product name, used in the UI and the browser title. */
  readonly appName: string;
  readonly chainId: number;
  readonly chainName: string;
  /** False on a chain Gully Core is not deployed on yet (the app renders "not deployed"). */
  readonly chainDeployed: boolean;
  /** Recipient of the front end's swap fee. Zero address means no fee is taken. */
  readonly feeWallet: string;
  /** Front-end swap fee in basis points of the swap OUTPUT. */
  readonly feeBps: number;
  readonly features: readonly FeatureFlag[];
  /** Printed in the next-steps block. Not used to run anything. */
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun";
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The client-side ceiling `@gullylabs/core-widgets` enforces on an integrator fee.
 *
 * Mirrored here so the scaffolder rejects an impossible value at scaffold time
 * rather than at the moment a user presses Swap. If the two ever disagree the
 * widget is authoritative — it is the one that builds the calldata.
 */
export const MAX_FEE_BPS = 100;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Syntactic address validation only.
 *
 * The scaffolder has no runtime dependencies, so it cannot compute an EIP-55
 * checksum (that needs keccak). The generated app checks the checksum with
 * viem's `getAddress` at boot, and `npm run gullycore:verify` checks the address has
 * code on the configured chain. Both of those catch what this cannot.
 */
export function looksLikeAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

export function normalizeChain(input: string): number {
  const key = input.trim().toLowerCase().replace(/[\s_-]/g, "");
  const id = CHAIN_ALIASES.get(key);
  if (id === undefined) {
    const list = (m: ReadonlyMap<number, string>) =>
      [...m.entries()].map(([chainId, name]) => `${name} (${chainId})`).join(", ");
    const deployed = SUPPORTED_CHAINS.size > 0 ? list(SUPPORTED_CHAINS) : "no chain yet";
    throw new ArgError(
      `Unknown chain "${input}". Gully Core's shared core is deployed on: ${deployed}. ` +
        (UNDEPLOYED_CHAINS.size > 0 ? `Coming soon: ${list(UNDEPLOYED_CHAINS)}. ` : "") +
        "A full fork can target any EIP-1153 chain, but that is a different product — see the README.",
    );
  }
  return id;
}

export function normalizeFeatures(input: string): readonly FeatureFlag[] {
  const raw = input.trim().toLowerCase();
  const bundle = FEATURE_BUNDLES.get(raw);
  if (bundle !== undefined) return bundle;

  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new ArgError("--features must name at least one feature");
  }

  const out: FeatureFlag[] = [];
  for (const part of parts) {
    if (!(ALL_FEATURES as readonly string[]).includes(part)) {
      throw new ArgError(
        `Unknown feature "${part}". Use one of ${ALL_FEATURES.join(", ")}, ` +
          "or a bundle: dex, launchpad, both.",
      );
    }
    const flag = part as FeatureFlag;
    if (!out.includes(flag)) out.push(flag);
  }
  return out;
}

/**
 * Derives an npm-safe package name from a directory or product name.
 *
 * Falls back to `gullycore-dex` rather than emitting an invalid name — a
 * package.json npm refuses to read is a worse first impression than a generic
 * name the tenant renames in ten seconds.
 */
export function toPackageName(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-_.]+/, "")
    .replace(/[-_.]+$/, "");
  return slug.length === 0 ? "gullycore-dex" : slug.slice(0, 214);
}

/** A readable product name from a directory name: `acme-swap` becomes `Acme Swap`. */
export function toAppName(input: string): string {
  const words = input
    .trim()
    .replace(/[-_.]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "Gully Core DEX";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export interface ResolveInput {
  readonly directory: string;
  readonly appName?: string | undefined;
  readonly chain?: string | undefined;
  readonly feeWallet?: string | undefined;
  readonly feeBps?: string | undefined;
  readonly features?: string | undefined;
  readonly packageManager?: string | undefined;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * Validates raw CLI input into a complete option set.
 *
 * Throws rather than filling a gap with a plausible-looking default. The one
 * exception is `feeBps`, which defaults to 0: a scaffold that silently starts
 * charging a tenant's users is worse than one that earns nothing until asked.
 */
export function resolveOptions(input: ResolveInput): ScaffoldOptions {
  const directory = input.directory.trim();
  if (directory.length === 0) {
    throw new ArgError("A project directory is required: npm create @gullylabs/core-app <directory>");
  }

  const chainId = normalizeChain(input.chain ?? "");
  const chainName = SUPPORTED_CHAINS.get(chainId) ?? UNDEPLOYED_CHAINS.get(chainId);
  if (chainName === undefined) {
    throw new ArgError(`chain ${chainId} is in the alias table but in neither chain list`);
  }
  const chainDeployed = SUPPORTED_CHAINS.has(chainId);

  const feeBpsRaw = input.feeBps ?? "0";
  const feeBps = Number(feeBpsRaw);
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new ArgError(
      `--fee-bps must be a whole number of basis points, received "${feeBpsRaw}". ` +
        "There is no sub-basis-point precision on chain.",
    );
  }
  if (feeBps > MAX_FEE_BPS) {
    throw new ArgError(
      `--fee-bps ${feeBps} exceeds the ${MAX_FEE_BPS} bps (${MAX_FEE_BPS / 100}%) ceiling ` +
        "@gullylabs/core-widgets enforces on an integrator fee.",
    );
  }

  const feeWalletRaw = (input.feeWallet ?? "").trim();
  if (feeBps > 0 && feeWalletRaw.length === 0) {
    throw new ArgError(
      `--fee-bps is ${feeBps} but no --fee-wallet was given. A fee with no destination ` +
        "would be forfeited, so this is refused rather than defaulted.",
    );
  }
  const feeWallet = feeWalletRaw.length === 0 ? ZERO_ADDRESS : feeWalletRaw;
  if (!looksLikeAddress(feeWallet)) {
    throw new ArgError(`--fee-wallet is not a 20-byte hex address: "${feeWalletRaw}"`);
  }
  if (feeBps > 0 && feeWallet.toLowerCase() === ZERO_ADDRESS) {
    throw new ArgError(
      `--fee-bps is ${feeBps} but --fee-wallet is the zero address. The fee would be burned.`,
    );
  }

  const features = normalizeFeatures(input.features ?? "both");

  const packageManager = (input.packageManager ?? "npm").trim().toLowerCase();
  if (!PACKAGE_MANAGERS.has(packageManager)) {
    throw new ArgError(
      `--package-manager must be one of ${[...PACKAGE_MANAGERS].join(", ")}, received "${packageManager}"`,
    );
  }

  const dirBase = directory.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? directory;
  const appName = (input.appName ?? "").trim() || toAppName(dirBase);

  return {
    directory,
    packageName: toPackageName(dirBase),
    appName,
    chainId,
    chainName,
    chainDeployed,
    feeWallet,
    feeBps,
    features,
    packageManager: packageManager as ScaffoldOptions["packageManager"],
  };
}
