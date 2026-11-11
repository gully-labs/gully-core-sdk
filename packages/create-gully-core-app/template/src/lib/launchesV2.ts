// SPDX-License-Identifier: MIT
/**
 * Launches created by the configured `LaunchpadKitV2`, and the kit's limits.
 *
 * ---------------------------------------------------------------------------
 * WHAT A V2 LAUNCH IS
 * ---------------------------------------------------------------------------
 *
 * One transaction mints a NEW token (the kit's factory deploys it, so there is
 * nothing to approve and nothing to hold beforehand), opens one to `maxLegs()`
 * pools for it — single-sided CL ranges above the opening price, or shaped
 * Bin distributions — seeds every pool from the token's own supply, and locks
 * every seeded position forever in a Gully Core locker. Buyers trade against that
 * liquidity from the first block; there is no curve contract, no graduation
 * and no migration.
 *
 * The positions cannot be withdrawn by anyone. Every leg carries a launch guard
 * whose fee starts high and decays to a final rate over a window measured on
 * `block.timestamp`, and that TRADING FEE is split three ways, frozen forever:
 * creator, integrator (this app's `fee.wallet`, when it is named) and the
 * protocol. Who charges it depends on the launch, and never changes for it:
 *
 *   * the pool, as an LP fee the locked position earns and the locker pays out;
 *   * or the guard itself, in the pool's quote currency on every trade, into a
 *     pot the guard pays out. On a buy the guard leaves a share of the fee to
 *     the pool as its LP fee, which the locked position earns; on a sell the
 *     pool's LP fee is zero. The share is the guard's own and may be zero.
 *
 * `leg.guardGeneration` says which, read off the guard, and `leg.lpShareBps` /
 * `leg.feeParts` say how the fee is divided (`null` when the guard did not
 * answer: not known, never zero); `lib/launchWords.ts` turns them into what the
 * screens print.
 *
 * Nothing here is a sale. There is no cap, no allocation, no claim — do not
 * render a progress bar. What exists is a schedule per pool, a fee right now,
 * and the split of that fee.
 *
 * ---------------------------------------------------------------------------
 * ONE IMPLEMENTATION
 * ---------------------------------------------------------------------------
 *
 * Every read here is `@gullylabs/core-sdk`'s (`readKitV2Env`, `readKitV2Limits`,
 * `readKitV2Launches`, `readKitV2Earnings`), the same code the Gully Core dapp's
 * hosted pad sites and the widgets use. This module only supplies what the SDK
 * cannot know: which kit and tenant `gullycore.config.ts` names, the app's direct
 * terms (`fee.wallet`, `launch.*`), the configured token list as candidate
 * quotes, and the log-scan start block. Everything time-shaped is
 * `block.timestamp` seconds; the SDK refuses a kit whose `CLOCK_MODE()` says
 * otherwise (`KitV2ClockError`), and `now` is the chain's own timestamp read
 * by `eth_call`, never this machine's wall clock.
 */

import {
  NATIVE_ADDRESS,
  readKitV2Earnings,
  readKitV2Env as readKitV2EnvOf,
  readKitV2Launches,
  readKitV2Limits,
  type EarningsV2,
  type KitV2Env,
  type KitV2Limits,
  type LaunchScanV2,
} from "@gullylabs/core-sdk";
import type { Address } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "./client";

export { NATIVE_ADDRESS, KitV2ClockError, launchPhase } from "@gullylabs/core-sdk";
export type {
  EarningsV2,
  KitV2Env,
  LaunchLegV2,
  LaunchPhase,
  LaunchRecordV2,
  LaunchScanV2,
  LegKindWord as LegKindName,
  TokenMeta,
} from "@gullylabs/core-sdk";

/**
 * Every number a launch is validated against, read off the deployed contracts.
 *
 * `integrator.source` is `"tenant"` when the terms are the kit's STORED config
 * for `chain.launchTenant`, and `"direct"` when they come from `gullycore.config.ts`
 * (`fee.wallet`, `launch.*`) and nothing on chain enforces them.
 */
export type KitV2Bounds = KitV2Limits;

/** Thrown by every reader here when `chain.launchpadKitV2` is null. */
export class LaunchpadV2NotConfiguredError extends Error {
  constructor() {
    super(
      "No LaunchpadKitV2 is configured. Set chain.launchpadKitV2 in gullycore.config.ts " +
        "(npm run gullycore:verify reports Gully Core's shared instance), or turn features.launchpad off.",
    );
    this.name = "LaunchpadV2NotConfiguredError";
  }
}

let envCache: { kit: Address; env: KitV2Env } | null = null;

/** `chain.launchpadKitV2`, or throw the error every screen renders as "not configured". */
export function requireKitV2(): Address {
  const kit = resolveConfig().launchpadKitV2;
  if (kit === null) throw new LaunchpadV2NotConfiguredError();
  return kit;
}

/** The kit's wiring. Cached per kit for the life of the page: every field is an immutable. */
export async function readKitV2Env(): Promise<KitV2Env> {
  const kit = requireKitV2();
  if (envCache !== null && envCache.kit === kit) return envCache.env;
  const env = await readKitV2EnvOf(publicClient(), kit);
  envCache = { kit, env };
  return env;
}

/**
 * The kit's, guards', lockers' and factory's limits, plus the terms a launch
 * through this app will carry. Nothing here is hardcoded.
 *
 * With `chain.launchTenant` set, the SDK reads that tenant's stored config and
 * throws if it is not active — the right outcome, since a launch would revert
 * `TenantNotActive`. Without one, the direct terms are `fee.wallet` and
 * `launch.*`, or nothing when `fee.wallet` is unset.
 */
export async function readKitV2Bounds(): Promise<KitV2Bounds> {
  const cfg = resolveConfig();
  const env = await readKitV2Env();
  return readKitV2Limits(publicClient(), env.kit, {
    env,
    tenant: cfg.launchTenant,
    ...(cfg.fee.wallet === NATIVE_ADDRESS
      ? {}
      : { direct: { integrator: cfg.fee.wallet, integratorBps: cfg.launch.integratorBps, integratorLaunchFeeWei: cfg.launch.integratorLaunchFeeWei } }),
    candidateQuotes: [NATIVE_ADDRESS, ...cfg.tokens.map((t) => t.address)],
  });
}

/**
 * Every launch the configured v2 kit has created, newest first, scanned from
 * `core.deployedAtBlock` (the RPC's log clock; never compared to a schedule).
 *
 * Throws `LaunchpadV2NotConfiguredError` when no kit is configured — a state
 * the caller must render as such, distinct from "no launches yet".
 */
export async function readLaunchesV2(): Promise<LaunchScanV2> {
  const cfg = resolveConfig();
  const env = await readKitV2Env();
  return readKitV2Launches(publicClient(), env.kit, { env, fromBlock: cfg.core.deployedAtBlock, chainId: cfg.core.chainId });
}

/**
 * Everything `account` can claim from v2 launches, read live.
 *
 * `claimable` is what the lockers already hold for the account, per currency;
 * `collectFees(lockId)` is permissionless and turns a position's accrued LP
 * fees into those balances. The guards' balances and unsettled pots (creator
 * tax, and the trading fee where the guard takes it) are in `tax` and `fee`.
 * The currencies scanned are the ones this kit's launches trade in — read from
 * the same logs as the launch list, not typed.
 *
 * Pass the result to the SDK's `planKitV2Earnings` for what to show and which
 * call moves each amount; do not add `guardClaimable` to `tax.claimable`, they
 * are the same balance.
 */
export async function readEarningsV2(account: Address): Promise<EarningsV2> {
  const scan = await readLaunchesV2();
  return readKitV2Earnings(publicClient(), scan, account);
}
