// SPDX-License-Identifier: MIT
/**
 * Chain and deployment configuration.
 *
 * Gully Core targets many chains, and nothing in this package knows which one
 * you are on. There are no bundled RPC URLs and no address book: every address
 * and every transport arrives from the embedder through a {@link ChainConfig}.
 * That is deliberate - a hardcoded address is a bug that ships to every host.
 */

import { getAddress, isAddress, type Address, type Transport } from "viem";

/** Native asset metadata for a chain. */
export interface NativeCurrencyConfig {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Deployed contract addresses.
 *
 * Only `vault` and at least one pool manager are structurally required. The
 * rest are required by the operations that use them, and the widgets fail with
 * a named error rather than a decoding failure when one is missing.
 */
export interface ContractAddresses {
  /** The singleton that custodies every token in the protocol. */
  readonly vault: Address;
  /** Concentrated-liquidity pool manager. */
  readonly clPoolManager?: Address;
  /** Liquidity-book (bin) pool manager. */
  readonly binPoolManager?: Address;
  /** Universal router - the entry point for swaps and integrator fees. */
  readonly universalRouter?: Address;
  /** Position manager for concentrated-liquidity positions. */
  readonly clPositionManager?: Address;
  /** Position manager for liquidity-book positions. */
  readonly binPositionManager?: Address;
  /** Permit2, used by the router to pull the input currency. */
  readonly permit2?: Address;
  /**
   * The chain's canonical wrapped native (WETH9-style: WETH, WBNB, WHYPE), from the SDK address book's
   * `weth`. With it set, a pool quoted in the wrapped native can also be paid in, and pay out, the native
   * coin: the router wraps / unwraps inside the swap transaction. Leave it unset and the native coin only
   * trades against pools whose key names native itself.
   */
  readonly wrappedNative?: Address;
  /** Off-path CL quoter (`CLQuoter`), if one is deployed. Quotes concentrated-liquidity hops. */
  readonly quoter?: Address;
  /** Off-path `BinQuoter`, if one is deployed. Quotes liquidity-book hops. */
  readonly binQuoter?: Address;
  /**
   * `LaunchGuardHook`, the hook that backs the launch widget.
   *
   * Not a launchpad and not a sale contract: it is the hook a launch pool names
   * in its `PoolKey`, and the launch widget reads its per-pool schedule. Leave
   * it unset on a chain where no `LaunchGuardHook` is deployed — the widget
   * renders a "not configured on this chain" state, which is the truth. Setting
   * it to an address that is not a `LaunchGuardHook` produces read failures,
   * not a fallback.
   */
  readonly launchGuardHook?: Address;
  /**
   * How `launchGuardHook` measures time: `"timestamp"` for the current build,
   * `"contract-block"` for the earlier block-numbered build.
   * Take it from `GullyCoreDeployment.durationClocks.launchGuardHook` in the SDK.
   * When omitted, the live adapter uses the SDK record if the address matches it,
   * and otherwise asks the hook (`CLOCK_MODE()`), never guessing.
   */
  readonly launchGuardHookClock?: "timestamp" | "contract-block";
  /**
   * `BinLaunchGuardHook`: the launch guard a Bin (liquidity-book) launch pool
   * names in its `PoolKey`. Same schedule, same gates, same `getLaunch` shape
   * as the CL guard; only ever built on `block.timestamp`. Leave it unset where
   * none is deployed.
   */
  readonly binLaunchGuardHook?: Address;
  /**
   * `LaunchpadKitV2`, the locked-launch kit. With it set, a launch can be
   * looked up by its TOKEN (`legsOf(token)` names every pool the launch
   * opened) instead of by one pool id. The pools themselves must still be in
   * the host's pool list: the singleton enumerates nothing.
   */
  readonly launchpadKitV2?: Address;
}

/** Everything the widgets need to know about the chain they are pointed at. */
export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  readonly nativeCurrency: NativeCurrencyConfig;
  readonly contracts: ContractAddresses;
  /**
   * EARLIER kit v2 generations still served on this chain (the SDK's `launchpadV2Retired`), newest
   * first. A hook address is part of pool identity, so a superseded kit's launch pools trade forever:
   * a pool naming one of these guards is a launch pool, and a token launched on one of these kits is
   * looked up there. `contracts` stays the CURRENT generation. Omitted: the current generation only.
   */
  readonly retiredLaunchGenerations?: readonly RetiredLaunchGeneration[];
  /**
   * viem transport for reads. Omitted when the host drives reads itself (for
   * example through wagmi).
   */
  readonly transport?: Transport;
  readonly blockExplorerUrl?: string;
  /** Seconds added to `block.timestamp` for transaction deadlines. */
  readonly defaultDeadlineSeconds?: number;
}

/** One earlier kit v2 generation: its kit and its two launch guards (all timestamp-clocked). */
export interface RetiredLaunchGeneration {
  readonly launchpadKitV2?: Address;
  readonly launchGuardHook?: Address;
  readonly binLaunchGuardHook?: Address;
}

/** Names of the addresses a caller can require. */
export type ContractName = keyof ContractAddresses;

/** Raised when the chain config cannot support a requested operation. */
export class ChainConfigError extends Error {
  readonly chainId: number;
  readonly contract: ContractName | null;

  constructor(message: string, chainId: number, contract: ContractName | null = null) {
    super(`[@gullylabs/core-widgets] ${message}`);
    this.name = "ChainConfigError";
    this.chainId = chainId;
    this.contract = contract;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

function assertAddress(value: unknown, label: string, chainId: number, name: ContractName): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ChainConfigError(
      `chain ${chainId}: ${label} is not a valid address: ${JSON.stringify(value)}`,
      chainId,
      name,
    );
  }
  const checksummed = getAddress(value);
  if (checksummed === ZERO) {
    throw new ChainConfigError(
      `chain ${chainId}: ${label} is the zero address. Pass the deployed address ` +
        "from the address book.",
      chainId,
      name,
    );
  }
  return checksummed;
}

/**
 * Structural validation of a chain config.
 *
 * Checks shape only. It cannot tell you an address is wrong, just that it is
 * well-formed and present.
 */
export function assertValidChainConfig(config: ChainConfig): void {
  if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
    throw new ChainConfigError(
      `chainId must be a positive integer, received ${String(config.chainId)}`,
      Number(config.chainId) || 0,
    );
  }
  if (config.nativeCurrency.decimals < 0 || config.nativeCurrency.decimals > 36) {
    throw new ChainConfigError(
      `nativeCurrency.decimals is out of range: ${config.nativeCurrency.decimals}`,
      config.chainId,
    );
  }
  assertAddress(config.contracts.vault, "contracts.vault", config.chainId, "vault");
  if (!config.contracts.clPoolManager && !config.contracts.binPoolManager) {
    throw new ChainConfigError(
      `chain ${config.chainId}: at least one of contracts.clPoolManager or ` +
        "contracts.binPoolManager must be set",
      config.chainId,
    );
  }
}

/**
 * Reads a required address, failing with a message that names what is missing
 * and which operation needed it.
 */
export function requireContract(
  config: ChainConfig,
  name: ContractName,
  usedFor: string,
): Address {
  const value = config.contracts[name];
  if (value === undefined) {
    throw new ChainConfigError(
      `chain ${config.chainId} (${config.name}): contracts.${name} is not configured, ` +
        `but it is required to ${usedFor}.`,
      config.chainId,
      name,
    );
  }
  return assertAddress(value, `contracts.${name}`, config.chainId, name);
}

/**
 * The best reading of the clock the NEXT block will carry: the later of the
 * pending block's timestamp and the latest block's, ignoring whichever could
 * not be read; `null` when neither was.
 *
 * WHY THE PENDING BLOCK. `max(latest.timestamp, localNow)` covers an idle
 * chain whose clock matches wall time, and a chain whose clock is AHEAD of
 * wall time (a devnet after `evm_increaseTime`) while it is busy. It does not
 * cover the two together: a chain running ahead of wall time whose last block
 * is older than the deadline window. Its next block is stamped about
 * `localNow + offset`, later than `latest + window`, and `localNow` is below
 * `latest`, so neither term reaches it and the transaction arrives expired.
 * Nothing on the client can know the offset without asking the node; the
 * pending block is that question (anvil and geth-style nodes stamp it with the
 * next block's time). Where the RPC has no pending block it refuses or echoes
 * the latest, and the bound falls back to the latest block's - the residual
 * case is then that one combination on such an RPC, which the window's size
 * (20 minutes by default) makes rare, and the user's wallet reports as the
 * router's deadline error rather than a loss.
 */
export function nextBlockClock(pending: bigint | null, latest: bigint | null): bigint | null {
  if (pending === null) return latest;
  if (latest === null) return pending;
  return pending > latest ? pending : latest;
}

/**
 * Default transaction deadline: base + configured window, as a unix timestamp,
 * where base = max(chain clock, local clock).
 *
 * `nowSeconds` should be the chain's clock (the next block's, see
 * {@link nextBlockClock} and {@link chainDeadline}); the local clock is only
 * the fallback. The later of the two is used, so an idle chain whose last block
 * is old does not produce a deadline that has passed by the time the next
 * block is mined, and a chain ahead of wall time is not given a deadline in
 * its past.
 */
export function defaultDeadline(config: ChainConfig, nowSeconds?: number | bigint): bigint {
  const window = BigInt(config.defaultDeadlineSeconds ?? 20 * 60);
  const local = BigInt(Math.floor(Date.now() / 1000));
  const chain = nowSeconds === undefined ? local : BigInt(nowSeconds);
  return (chain > local ? chain : local) + window;
}

/**
 * The deadline for a transaction about to be built: the chain's clock (the
 * adapter's `getBlockTimestamp`, which the viem adapter reads from the pending
 * block where the RPC serves one) or the local clock, whichever is later, +
 * the configured window. A failed
 * block read falls back to the local clock rather than blocking the trade.
 */
export async function chainDeadline(
  config: ChainConfig,
  adapter: { getBlockTimestamp?(): Promise<bigint> },
): Promise<bigint> {
  if (adapter.getBlockTimestamp === undefined) return defaultDeadline(config);
  try {
    return defaultDeadline(config, await adapter.getBlockTimestamp());
  } catch {
    return defaultDeadline(config);
  }
}

/**
 * Explorer link for a transaction hash, or `null` when no explorer is set.
 *
 * The one place a widget builds an explorer link. An empty (or whitespace-only)
 * `blockExplorerUrl` is NO explorer: a host running against a local devnet
 * passes "" or leaves it out, and a link to "/tx/0x…" would open this page.
 * Callers render the bare hash instead.
 */
export function explorerTxUrl(config: Pick<ChainConfig, "blockExplorerUrl">, hash: string): string | null {
  const base = (config.blockExplorerUrl ?? "").trim().replace(/\/+$/, "");
  if (base === "") return null;
  return `${base}/tx/${hash}`;
}
