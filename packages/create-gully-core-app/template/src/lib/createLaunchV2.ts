// SPDX-License-Identifier: MIT
/**
 * Building a `LaunchpadKitV2.createLaunch` transaction.
 *
 * The kit mints the token, so there is no approval step and nothing the
 * launcher must hold: the only thing the wallet sends is native currency for
 * the launch fees (`msg.value`), and the kit refunds any surplus in the same
 * call. Everything else — the pools, the seeded positions, the locks, the
 * registry record — is a consequence of the argument built here.
 *
 * Three things this module refuses to guess:
 *
 *   * **The token address.** A leg's pool id contains the launch token's
 *     address, and so does the CL side rule (which side of the price the range
 *     must sit on) and the Bin id mapping. The kit makes the address
 *     predictable from the launcher and a salt, and the SDK cross-checks its
 *     own computation against the kit's `predictLaunchToken` before any pool
 *     id is derived from it.
 *   * **The opening price's encoding.** A CL leg takes a `sqrtPriceX96`, a Bin
 *     leg an `activeId`; both fold in token order and decimals, and both are
 *     snapped — a CL price onto the range edge, a Bin price onto a bin. The
 *     snapped price is returned so the screen can show what will be set, not
 *     what was typed.
 *   * **The tenant's terms.** With a tenant configured, `integrator`,
 *     `integratorBps` and `integratorLaunchFeeWei` are the STORED values, read
 *     off the kit; the kit reverts a launch that restates them differently.
 *
 * Nothing here sends anything. The result carries calldata for a wallet and
 * the SDK's findings against it; the caller simulates the exact bytes first.
 */

import {
  BIN_SHAPE,
  EMPTY_BIN_LEG,
  EMPTY_CL_LEG,
  LAUNCHPAD_KIT_V2_ABI,
  LEG_KIND,
  NO_TAX,
  PRESET,
  binActiveIdForLaunch,
  binLaunchPriceAtId,
  computeKitV2LegKey,
  kitV2CLLaunchRange,
  launchSplitBounds,
  predictLaunchTokenChecked,
  priceFromSqrtPriceX96,
  sqrtPriceForLaunch,
  validateLaunchParamsV2,
  type BinShapeName,
  type KitV2LegKey,
  type LaunchParamsV2,
  type LaunchV2Issue,
  type LegParamsV2,
} from "@gullylabs/core-sdk";
import { encodeFunctionData, type Address, type Hex } from "viem";

import { publicClient } from "./client";
import { NATIVE_ADDRESS, type KitV2Bounds } from "./launchesV2";

/** The kit's factory mints 18-decimal tokens (`LaunchToken` is a plain ERC-20). */
export const LAUNCH_TOKEN_DECIMALS = 18;

export interface LegDraftV2 {
  readonly kind: "CL" | "Bin";
  /** The zero address for the chain's native asset. */
  readonly quote: Address;
  readonly quoteDecimals: number;
  /** Share of `seedSupply` this leg seeds, in basis points. All legs must sum to 10000. */
  readonly weightBps: number;
  /** Opening price: whole quote tokens per whole launch token. */
  readonly quotePerLaunchToken: string;
  /** Raw quote units. `0n` means uncapped. */
  readonly maxBuyPerTx: bigint;
  /* CL */
  readonly tickSpacing: number;
  /** Width of the single-sided range, in tick spacings. */
  readonly widthInSpacings: number;
  /* Bin */
  readonly binStep: number;
  readonly shape: BinShapeName;
  readonly binCount: number;
}

export interface LaunchDraftV2 {
  readonly name: string;
  readonly symbol: string;
  readonly metadataURI: string;
  /** Raw 18-decimal units. */
  readonly totalSupply: bigint;
  readonly seedSupply: bigint;
  /** Receives `totalSupply - seedSupply`. Required when that is non-zero. */
  readonly allocationRecipient: Address;
  readonly creator: Address;
  readonly operator: Address;
  readonly steward: Address;
  /** The protocol's share of the trading fee, in basis points, inside the contracts' bounds. */
  readonly protocolBps: number;
  readonly schedule: {
    readonly preset: number;
    readonly initialFeeBips: number;
    readonly finalFeeBips: number;
    readonly decaySeconds: number;
    readonly startDelaySeconds: number;
  };
  readonly legs: readonly LegDraftV2[];
  /**
   * The registry listing: exactly `LaunchMetadata`'s four strings. The two handles
   * are bare (`gullycore`, no "@", no URL) and the registry refuses anything
   * else with `InvalidHandle`. No icon member: `iconURI` was removed 2026-09-24.
   */
  readonly listing: {
    readonly description: string;
    readonly websiteURI: string;
    readonly xHandle: string;
    readonly telegramHandle: string;
  };
  /** Folded with the launcher into the token's CREATE2 salt. Random per form session. */
  readonly userSalt: Hex;
  /** The account that will send the transaction. Determines the token address. */
  readonly launcher: Address;
}

/** What one leg resolved to, for the screen. */
export interface ResolvedLegV2 {
  readonly key: KitV2LegKey;
  readonly kind: "CL" | "Bin";
  /** The opening price the pool will actually be born at, quote per launch token. */
  readonly openingPrice: string;
  /** How far the snap moved the typed price, as a fraction (0.01 = 1%). */
  readonly snapFraction: number;
}

export interface CreateLaunchV2Call {
  readonly to: Address;
  readonly data: Hex;
  /** `msg.value`: the SDK's `safeValue`, so a scheduled fee increase cannot make the call revert. */
  readonly value: bigint;
  readonly token: Address;
  readonly params: LaunchParamsV2;
  readonly legs: readonly ResolvedLegV2[];
  /** The SDK's findings. Any `error` means the kit would revert; the caller must not send. */
  readonly issues: readonly LaunchV2Issue[];
}

const BPS = 10_000;

function fraction(typed: string, actual: number): number {
  const t = Number(typed);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.abs(actual - t) / t;
}

function resolveCLLeg(
  leg: LegDraftV2,
  token: Address,
  is0: boolean,
): { cl: LegParamsV2["cl"]; openingPrice: string; snapFraction: number } {
  const price = sqrtPriceForLaunch({
    launchToken: token,
    quoteToken: leg.quote,
    launchDecimals: LAUNCH_TOKEN_DECIMALS,
    quoteDecimals: leg.quoteDecimals,
    quotePerLaunchToken: leg.quotePerLaunchToken,
  });
  /* Snap the price onto the range edge so the first buy meets liquidity instead
     of crossing an empty gap up to one spacing wide. The snapped price is what
     the pool is initialized at, and it is what gets shown. */
  const cl = kitV2CLLaunchRange({
    launchTokenIsCurrency0: is0,
    sqrtPriceX96: price.sqrtPriceX96,
    tickSpacing: leg.tickSpacing,
    widthInSpacings: leg.widthInSpacings,
    snapPrice: true,
  });
  const [decimals0, decimals1] = is0 ? [LAUNCH_TOKEN_DECIMALS, leg.quoteDecimals] : [leg.quoteDecimals, LAUNCH_TOKEN_DECIMALS];
  const poolPrice = priceFromSqrtPriceX96(cl.sqrtPriceX96, decimals0, decimals1, 18);
  /* The pool prices currency1 per currency0; a human wants quote per launch token. */
  const opening = is0 ? Number(poolPrice) : 1 / Number(poolPrice);
  return { cl, openingPrice: opening.toPrecision(8), snapFraction: fraction(leg.quotePerLaunchToken, opening) };
}

function resolveBinLeg(
  leg: LegDraftV2,
  is0: boolean,
): { bin: LegParamsV2["bin"]; openingPrice: string; snapFraction: number } {
  const typed = Number(leg.quotePerLaunchToken);
  if (!Number.isFinite(typed) || typed <= 0) {
    throw new RangeError(`the opening price must be a positive number, received "${leg.quotePerLaunchToken}"`);
  }
  const activeId = binActiveIdForLaunch({
    launchTokenIsCurrency0: is0,
    launchDecimals: LAUNCH_TOKEN_DECIMALS,
    quoteDecimals: leg.quoteDecimals,
    quotePerLaunchToken: typed,
    binStep: leg.binStep,
  });
  const opening = binLaunchPriceAtId(activeId, {
    launchTokenIsCurrency0: is0,
    launchDecimals: LAUNCH_TOKEN_DECIMALS,
    quoteDecimals: leg.quoteDecimals,
    binStep: leg.binStep,
  });
  const bin: LegParamsV2["bin"] = {
    binStep: leg.binStep,
    activeId,
    shape: BIN_SHAPE[leg.shape],
    binCount: leg.binCount,
    offsets: [],
    weights: [],
    floorBins: 0,
  };
  return { bin, openingPrice: opening.toPrecision(8), snapFraction: fraction(leg.quotePerLaunchToken, opening) };
}

/**
 * Encodes `createLaunch` and reports every objection the SDK can raise to it.
 *
 * The token address is the kit's own answer, cross-checked. The integrator
 * terms are `bounds.integrator`, which is the stored tenant config when a
 * tenant is set and `gullycore.config.ts` otherwise.
 */
export async function buildCreateLaunchV2(draft: LaunchDraftV2, bounds: KitV2Bounds): Promise<CreateLaunchV2Call> {
  const env = bounds.env;
  const client = publicClient();

  const token = await predictLaunchTokenChecked(client, env.kit, draft.launcher, draft.userSalt);

  const legs: LegParamsV2[] = [];
  const resolved: ResolvedLegV2[] = [];
  for (const leg of draft.legs) {
    const key = computeKitV2LegKey({
      env,
      token,
      quote: leg.quote,
      kind: leg.kind === "CL" ? LEG_KIND.CL : LEG_KIND.Bin,
      tickSpacingOrBinStep: leg.kind === "CL" ? leg.tickSpacing : leg.binStep,
    });
    const is0 = key.launchTokenIsCurrency0;
    if (leg.kind === "CL") {
      const r = resolveCLLeg(leg, token, is0);
      legs.push({ kind: LEG_KIND.CL, quote: leg.quote, weightBps: leg.weightBps, maxBuyPerTx: leg.maxBuyPerTx, cl: r.cl, bin: EMPTY_BIN_LEG });
      resolved.push({ key, kind: "CL", openingPrice: r.openingPrice, snapFraction: r.snapFraction });
    } else {
      const r = resolveBinLeg(leg, is0);
      legs.push({ kind: LEG_KIND.Bin, quote: leg.quote, weightBps: leg.weightBps, maxBuyPerTx: leg.maxBuyPerTx, cl: EMPTY_CL_LEG, bin: r.bin });
      resolved.push({ key, kind: "Bin", openingPrice: r.openingPrice, snapFraction: r.snapFraction });
    }
  }

  const integrator = bounds.integrator;
  const creatorBps = BPS - draft.protocolBps - integrator.bps;
  const custom = draft.schedule.preset === PRESET.Custom;

  const params: LaunchParamsV2 = {
    name: draft.name,
    symbol: draft.symbol,
    metadataURI: draft.metadataURI,
    userSalt: draft.userSalt,
    totalSupply: draft.totalSupply,
    seedSupply: draft.seedSupply,
    allocationRecipient: draft.seedSupply < draft.totalSupply ? draft.allocationRecipient : NATIVE_ADDRESS,
    creator: draft.creator,
    launchOperator: draft.operator,
    launchSteward: draft.steward,
    tenant: bounds.tenantAddress ?? NATIVE_ADDRESS,
    integrator: integrator.address,
    integratorBps: integrator.bps,
    integratorLaunchFeeWei: integrator.launchFeeWei,
    creatorBps: creatorBps < 0 ? 0 : creatorBps,
    protocolBps: draft.protocolBps,
    schedule: {
      preset: draft.schedule.preset,
      /* A named preset supplies the fee fields itself; the kit ignores what is
         sent for them. They are zeroed so nobody reads a Custom-looking value. */
      initialFeeBips: custom ? draft.schedule.initialFeeBips : 0,
      finalFeeBips: custom ? draft.schedule.finalFeeBips : 0,
      decaySeconds: custom ? draft.schedule.decaySeconds : 0,
      enabled: true,
      startDelaySeconds: draft.schedule.startDelaySeconds,
    },
    legs,
    listing: draft.listing,
    /* This wizard launches WITHOUT a creator tax (buy/sell hook fee): every
       field zero, which the guards read as "no tax". A tax is a frozen,
       launch-long term with its own bounds; add it here deliberately, from
       the SDK's `buildLaunchParamsV2`, rather than by default. */
    tax: NO_TAX,
  };

  const issues = validateLaunchParamsV2(params, {
    caps: bounds.caps,
    token,
    kit: env.kit,
    maxIntegratorLaunchFeeWei: bounds.maxIntegratorLaunchFeeWei,
    /* The lockers' bounds, and the launch contract's own where it takes the fee: the tighter of each. */
    lockerBounds: launchSplitBounds(bounds),
    ...(bounds.tenant === null ? {} : { tenantConfig: bounds.tenant, tenantAllowedQuotes: bounds.tenantAllowedQuotes }),
  });

  const data = encodeFunctionData({ abi: LAUNCHPAD_KIT_V2_ABI, functionName: "createLaunch", args: [params] });

  return { to: env.kit, data, value: bounds.value.safeValue, token, params, legs: resolved, issues };
}
