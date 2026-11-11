// SPDX-License-Identifier: MIT
/* ============================================================================
   What a Kit v2 launch costs in native currency, and the tenant it runs under.

   `createLaunch` is payable and requires

       msg.value >= launchFeeWei() + integratorLaunchFeeWei

   and REFUNDS any excess to `msg.sender` at the end of the call. Two things make
   "just read launchFeeWei()" not quite enough:

   1. A SCHEDULED INCREASE. The Safe may announce a higher fee; it becomes the fee
      BY ITSELF at `effectiveAt` (no apply transaction). `launchFeeWei()` answers
      for the block it is read in, `pendingLaunchFee()` returns the announced
      value and its timestamp. A transaction signed before `effectiveAt` and
      mined after it pays the new fee or reverts `InsufficientLaunchFee`. Sending
      the higher of the two is safe: the surplus comes back in the same call.

   2. THE TENANT. A launch naming a tenant must restate that tenant's stored
      `integrator`, `integratorBps` and `integratorLaunchFeeWei` exactly
      (`TenantConfigMismatch`), and the tenant must be `active`. So the integrator
      fee is READ from `tenantConfig(tenant)`, never typed.

   Nothing here is a price. These are wei amounts; a USD figure would need an
   oracle the kit does not have.
   ============================================================================ */

import type { Address, PublicClient } from "viem";

import { LAUNCHPAD_KIT_V2_ABI } from "../generated/abi.js";
import { PRESET_NAMES, type PresetName } from "../presets.js";
import { isRevertError } from "../../chains/revert.js";
import { BIN_SHAPE_NAMES, type BinShapeName, type KitV2Caps, type TenantConfigV2 } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** `pendingLaunchFee()`, with its `(0, 0)` "none" answer turned into `null`. */
export interface PendingLaunchFee {
  readonly feeWei: bigint;
  /** Unix seconds (`block.timestamp`). */
  readonly effectiveAt: bigint;
}

export interface LaunchValueQuote {
  /** The protocol launch fee a launch in the block that was read pays. */
  readonly launchFeeWei: bigint;
  /** The tenant's (or the direct launcher's chosen) integrator fee. */
  readonly integratorFeeWei: bigint;
  /** `launchFeeWei + integratorFeeWei`: the minimum `msg.value` right now. */
  readonly minimumValue: bigint;
  /** An announced increase not yet in force, or `null`. */
  readonly pending: PendingLaunchFee | null;
  /**
   * Which terms this launch is on. Release 3 kits price a launch per tenant: `"outside"` pays no Gully launch
   * fee and no share of the fee or the tax, `"gully"` (designated by the Safe AND opted in) pays the release 2
   * terms. `null` or absent on a release 1 or 2 kit, which has one set of terms for every launch.
   */
  readonly terms?: "gully" | "outside" | null;
  /**
   * `max(minimumValue, pending.feeWei + integratorFeeWei)`: a value that cannot
   * revert `InsufficientLaunchFee` whichever side of `effectiveAt` the transaction
   * lands. The kit refunds the difference to the sender in the same call.
   */
  readonly safeValue: bigint;
}

/** Pure form of the quote, from values already read. */
export function computeLaunchValue(args: {
  readonly launchFeeWei: bigint;
  readonly pending: PendingLaunchFee | null;
  readonly integratorFeeWei: bigint;
}): LaunchValueQuote {
  if (args.launchFeeWei < 0n || args.integratorFeeWei < 0n) throw new RangeError("fees are non-negative");
  const minimumValue = args.launchFeeWei + args.integratorFeeWei;
  const atPending = args.pending === null ? 0n : args.pending.feeWei + args.integratorFeeWei;
  return {
    launchFeeWei: args.launchFeeWei,
    integratorFeeWei: args.integratorFeeWei,
    minimumValue,
    pending: args.pending,
    safeValue: atPending > minimumValue ? atPending : minimumValue,
  };
}

/** `pendingLaunchFee()` decoded. `(0, 0)` means none. */
export function decodePendingLaunchFee(raw: readonly [bigint, bigint]): PendingLaunchFee | null {
  const [feeWei, effectiveAt] = raw;
  return effectiveAt === 0n ? null : { feeWei, effectiveAt };
}

/** A `TenantConfig` with its two bitmasks expanded into names. */
export interface DecodedTenantConfig {
  readonly integrator: Address;
  readonly integratorBps: number;
  readonly integratorLaunchFeeWei: bigint;
  readonly allowedPresets: readonly PresetName[];
  /** Empty means the tenant forbids Bin legs entirely. */
  readonly allowedBinShapes: readonly BinShapeName[];
  readonly restrictQuotes: boolean;
  readonly active: boolean;
  /** Highest creator-tax rate (buy or sell, bps) a launch through this tenant may set. 0 forbids a tax. */
  readonly maxTaxBps: number;
  /** The tax's integrator bucket (bps of the tax) a launch through this tenant must restate. */
  readonly taxIntegratorBps: number;
  /** Release 3: the tenant's own half of Gully terms. Always `false` on a release 1 or 2 kit. */
  readonly gullyTerms: boolean;
  /** `false` for a tenant that never called `setTenantConfig`: every field is zero. */
  readonly configured: boolean;
}

function maskNames<T extends string>(mask: number, names: readonly T[]): T[] {
  return names.filter((_, i) => ((mask >> i) & 1) === 1);
}

/** Decodes `tenantConfig(tenant)`. Bit i of `allowedPresets` allows `Preset(i)`; of `allowedBinShapes`, `BinShape(i)`. */
export function decodeTenantConfig(c: Omit<TenantConfigV2, "gullyTerms"> & { readonly gullyTerms?: boolean }): DecodedTenantConfig {
  return {
    integrator: c.integrator,
    integratorBps: c.integratorBps,
    integratorLaunchFeeWei: c.integratorLaunchFeeWei,
    allowedPresets: maskNames(c.allowedPresets, PRESET_NAMES),
    allowedBinShapes: maskNames(c.allowedBinShapes, BIN_SHAPE_NAMES),
    restrictQuotes: c.restrictQuotes,
    active: c.active,
    maxTaxBps: c.maxTaxBps,
    taxIntegratorBps: c.taxIntegratorBps,
    gullyTerms: c.gullyTerms ?? false,
    configured: c.allowedPresets !== 0,
  };
}

/** The struct a release 1 or 2 kit and pad return: nine fields, no `gullyTerms`. A retired kit stays served, so it stays readable. */
const RETIRED_TENANT_COMPONENTS = [
  { name: "integrator", type: "address" },
  { name: "integratorBps", type: "uint16" },
  { name: "integratorLaunchFeeWei", type: "uint96" },
  { name: "allowedPresets", type: "uint8" },
  { name: "allowedBinShapes", type: "uint8" },
  { name: "restrictQuotes", type: "bool" },
  { name: "active", type: "bool" },
  { name: "maxTaxBps", type: "uint16" },
  { name: "taxIntegratorBps", type: "uint16" },
] as const;

/** `tenantConfig(address)` on a retired kit. These nine fields lead the release 3 struct too, so it reads either. */
export const RETIRED_KIT_TENANT_ABI = [
  { type: "function", name: "tenantConfig", stateMutability: "view", inputs: [{ name: "tenant", type: "address" }], outputs: [{ name: "", type: "tuple", components: RETIRED_TENANT_COMPONENTS }] },
] as const;

/** `tenantConfig()` on a pad of a retired factory. */
export const RETIRED_PAD_TENANT_ABI = [
  { type: "function", name: "tenantConfig", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "tuple", components: RETIRED_TENANT_COMPONENTS }] },
] as const;

/** `tenantConfig(tenant)` on any served kit, decoded. A release 3 answer is one word longer than the older struct. */
export async function readTenantConfig(client: PublicClient, kit: Address, tenant: Address): Promise<DecodedTenantConfig> {
  const raw = await client
    .readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_ABI, functionName: "tenantConfig", args: [tenant] })
    .catch(() => client.readContract({ address: kit, abi: RETIRED_KIT_TENANT_ABI, functionName: "tenantConfig", args: [tenant] }));
  return decodeTenantConfig(raw);
}

/**
 * The `msg.value` quote for a launch.
 *
 * - `tenant` set: the integrator fee is the tenant's stored one, and a tenant
 *   that is not `active` throws (the launch would revert `TenantNotActive`).
 * - `tenant` absent or zero: a direct launch; `integratorLaunchFeeWei` is the
 *   caller's own choice (default 0) and must not exceed `maxIntegratorLaunchFeeWei()`.
 */
export async function readLaunchValue(
  client: PublicClient,
  kit: Address,
  opts: { readonly tenant?: Address; readonly integratorLaunchFeeWei?: bigint } = {},
): Promise<LaunchValueQuote & { readonly tenant: DecodedTenantConfig | null }> {
  const [launchFeeWei, pendingRaw] = await Promise.all([
    client.readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_ABI, functionName: "launchFeeWei" }),
    client.readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_ABI, functionName: "pendingLaunchFee" }),
  ]);
  const pending = decodePendingLaunchFee(pendingRaw);

  const tenantAddress = opts.tenant;
  if (tenantAddress !== undefined && tenantAddress.toLowerCase() !== ZERO) {
    const [tenant, terms] = await Promise.all([readTenantConfig(client, kit, tenantAddress), readLaunchTerms(client, kit, tenantAddress)]);
    if (!tenant.active) {
      throw new Error(`tenant ${tenantAddress} has no active config on ${kit}; the launch would revert TenantNotActive`);
    }
    if (opts.integratorLaunchFeeWei !== undefined && opts.integratorLaunchFeeWei !== tenant.integratorLaunchFeeWei) {
      throw new Error(
        `integratorLaunchFeeWei ${opts.integratorLaunchFeeWei} differs from tenant ${tenantAddress}'s stored ` +
          `${tenant.integratorLaunchFeeWei}; the launch would revert TenantConfigMismatch`,
      );
    }
    return { ...quoteOnTerms(terms, launchFeeWei, pending, tenant.integratorLaunchFeeWei), tenant };
  }

  const integratorFeeWei = opts.integratorLaunchFeeWei ?? 0n;
  if (integratorFeeWei > 0n) {
    const cap = await client.readContract({
      address: kit,
      abi: LAUNCHPAD_KIT_V2_ABI,
      functionName: "maxIntegratorLaunchFeeWei",
    });
    if (integratorFeeWei > cap) {
      throw new Error(`integratorLaunchFeeWei ${integratorFeeWei} is above the kit's cap ${cap} (IntegratorFeeAboveCap)`);
    }
  }
  return { ...quoteOnTerms(await readLaunchTerms(client, kit, ZERO_ADDRESS), launchFeeWei, pending, integratorFeeWei), tenant: null };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Which terms a launch under `tenant` is on: `null` on a kit without per-tenant terms (no `gullyDesignated`).
 * Gully terms take two keys: the Safe designated the tenant AND the tenant opted in. Both are read.
 */
async function readLaunchTerms(client: PublicClient, kit: Address, tenant: Address): Promise<"gully" | "outside" | null> {
  try {
    const designated = await client.readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_ABI, functionName: "gullyDesignated", args: [tenant] });
    if (!designated || tenant === ZERO_ADDRESS) return "outside";
    return (await readTenantConfig(client, kit, tenant)).gullyTerms ? "gully" : "outside";
  } catch (error) {
    if (isRevertError(error, { zeroData: true })) return null;
    throw error;
  }
}

/** The quote on the terms: an outside launch pays no Gully launch fee, today or after a pending increase. */
function quoteOnTerms(terms: "gully" | "outside" | null, launchFeeWei: bigint, pending: PendingLaunchFee | null, integratorFeeWei: bigint): LaunchValueQuote {
  const outside = terms === "outside";
  return { ...computeLaunchValue({ launchFeeWei: outside ? 0n : launchFeeWei, pending: outside ? null : pending, integratorFeeWei }), terms };
}

/** The deployment's launch caps, read off the kit. The authority over `KIT_V2_DEPLOY_SCRIPT_CAPS`. */
export async function readKitV2Caps(client: PublicClient, kit: Address): Promise<KitV2Caps> {
  const [maxLegs, maxBinsPerLeg] = await Promise.all([
    client.readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_ABI, functionName: "maxLegs" }),
    client.readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_ABI, functionName: "maxBinsPerLeg" }),
  ]);
  return { maxLegs, maxBinsPerLeg };
}
