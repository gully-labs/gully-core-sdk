// SPDX-License-Identifier: MIT
/* ============================================================================
   WHAT GULLY TAKES FROM A LAUNCH, BY WHOSE LAUNCHPAD IT WAS MADE ON.

   Two cases (2026-11-05):

     GULLY TERMS     a Launchpad the Gully governance Safe has designated AND that
                     has opted in itself (kre8 on Gully Chain). The release 2 rules:
                     the 1% trade fee split 50/50 with Gully, 10% of the creator
                     tax, the launch fee, and NO core protocol fee on the pool.
     OUTSIDE TERMS   every other Launchpad, DEX and builder, and a launch made
                     with no Launchpad at all. Gully takes a flat 0.30% of every
                     trade as the core protocol fee and nothing else: no share of
                     the pool fee, no share of the creator tax, no launch fee.
                     The creator and the Launchpad's owner split the pool fee and
                     the tax as the Launchpad configures.

   Both keep the 1% minimum trade fee and the fixed 1,000,000,000 supply.

   THE RULE IS NOT EVERY CHAIN. Outside terms need kit release 3 and the fee
   controller V5 (live on Gully Chain Testnet since 2026-11-06). A chain still on
   release 2 charges EVERY launch the Gully terms, whoever's Launchpad it was
   made on. So this module keeps the two
   apart: `FEE_TERMS` and `feeTermsTable` state the rule, and `readChainFeeTerms`
   reads which release a chain's kit is, what it charges today and whether a
   given Launchpad is designated. A surface shows the rule AND what the chain
   charges, and never presents the first as the second.

   How a release is told, never by address or date:
     release 3   the kit answers `gullyDesignated(address)`
     release 2   it does not, and answers `MIN_TRADE_FEE_PIPS()` (kitV2/rules.ts)
     release 1   neither
   and the builder fee in force is the installed protocol fee controller's
   `builderFee()` (V5); a V4 controller does not answer it.
   ============================================================================ */
import type { Address, PublicClient } from "viem";

import { isRevertError } from "../chains/revert.js";
import { readTenantConfig } from "../launchpad/kitV2/fees.js";
import { readKitV2Rules } from "../launchpad/kitV2/rules.js";
import type { KitV2Rules } from "../launchpad/kitV2/validate.js";
import { BUILDER_POOL_RULES, GULLY_LAUNCH_RULES, pipsPercentText } from "./gully.js";

export type LaunchTermsKind = "gully" | "outside";

export interface LaunchTerms {
  readonly kind: LaunchTermsKind;
  /** Gully's share of the pool's trade fee, bps of that fee. */
  readonly protocolTradeShareBps: number;
  /** Gully's share of a creator tax, bps of the tax. */
  readonly taxProtocolBps: number;
  /** The core protocol fee on the pool, pips of every trade per direction. */
  readonly coreProtocolFeePips: number;
  /** Whether Gully's launch fee is charged. */
  readonly gullyLaunchFee: boolean;
}

/** The rule, both cases. */
export const FEE_TERMS: Readonly<Record<LaunchTermsKind, LaunchTerms>> = {
  gully: {
    kind: "gully",
    protocolTradeShareBps: GULLY_LAUNCH_RULES.PROTOCOL_TRADE_SHARE_BPS,
    taxProtocolBps: GULLY_LAUNCH_RULES.TAX_PROTOCOL_BPS,
    coreProtocolFeePips: BUILDER_POOL_RULES.KIT_LAUNCH_PROTOCOL_FEE_PIPS,
    gullyLaunchFee: true,
  },
  outside: {
    kind: "outside",
    protocolTradeShareBps: 0,
    taxProtocolBps: 0,
    coreProtocolFeePips: BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS,
    gullyLaunchFee: false,
  },
};

/**
 * What Gully takes from one trade, in pips of the trade (1e6 = the whole trade), for a launch whose total
 * fee is `totalBps` (the 1% trade fee plus the creator tax) under each case.
 *   gully:   half of the 1% trade fee + 10% of the tax
 *   outside: 0.30% of the trade, whatever the fee and the tax are
 */
export function gullyTakePips(kind: LaunchTermsKind, totalBps: number): number {
  const taxBps = Math.max(0, totalBps - GULLY_LAUNCH_RULES.TRADE_FEE_BPS);
  const t = FEE_TERMS[kind];
  const fromFee = (GULLY_LAUNCH_RULES.TRADE_FEE_BPS * 100 * t.protocolTradeShareBps) / 10_000;
  const fromTax = (taxBps * 100 * t.taxProtocolBps) / 10_000;
  return fromFee + fromTax + t.coreProtocolFeePips;
}

export interface FeeTermsRow {
  readonly key: "trade-fee" | "creator-tax" | "core-fee" | "launch-fee" | "floor" | "supply";
  readonly label: string;
  /** On a Gully-designated Launchpad. */
  readonly gully: string;
  /** On any other Launchpad, DEX or builder. */
  readonly outside: string;
}

/** The rule as a table a surface can print: one row per thing Gully does or does not take. */
export function feeTermsTable(): readonly FeeTermsRow[] {
  const half = `${GULLY_LAUNCH_RULES.PROTOCOL_TRADE_SHARE_BPS / 100}%`;
  const fee = pipsPercentText(GULLY_LAUNCH_RULES.MIN_TRADE_FEE_PIPS);
  return [
    { key: "trade-fee", label: `Gully's share of the ${fee} trade fee`, gully: `${half} of it (${pipsPercentText(GULLY_LAUNCH_RULES.MIN_TRADE_FEE_PIPS / 2)} of every trade)`, outside: "None" },
    { key: "creator-tax", label: "Gully's share of a creator tax", gully: `${GULLY_LAUNCH_RULES.TAX_PROTOCOL_BPS / 100}% of the tax`, outside: "None" },
    { key: "core-fee", label: "Protocol fee on the pool", gully: "None", outside: `${pipsPercentText(BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS)} of every trade` },
    { key: "launch-fee", label: "Gully launch fee", gully: "Charged once per launch", outside: "None" },
    { key: "floor", label: "Minimum trade fee", gully: fee, outside: fee },
    { key: "supply", label: "Supply of a launch", gully: "1,000,000,000", outside: "1,000,000,000" },
  ];
}

/* ------------------------------------------------------------------ the chain --- */

export const KIT_TENANT_TERMS_ABI = [
  { type: "function", name: "gullyDesignated", inputs: [{ name: "tenant", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "launchFeeWei", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

export const BUILDER_FEE_ABI = [{ type: "function", name: "builderFee", inputs: [], outputs: [{ name: "", type: "uint16" }], stateMutability: "view" }] as const;

export interface ChainFeeTerms {
  readonly kit: Address;
  /** Which kit release the chain's current kit is (see the header for how it is told). */
  readonly release: 1 | 2 | 3;
  /** The release 2+ constants, or null on a release 1 kit. */
  readonly rules: KitV2Rules | null;
  /** The kit's launch fee in wei, or null when it could not be read. */
  readonly launchFeeWei: bigint | null;
  /** The flat builder fee the installed fee controller charges, pips, or null when the controller has none (V4 and earlier). */
  readonly builderFeePips: number | null;
  /** Release 3 only: whether the Safe has designated `tenant`; null on release 1 and 2, and when no tenant was asked about. */
  readonly tenantDesignated: boolean | null;
  /**
   * Release 3 only: whether `tenant` is on Gully terms, which takes two keys: the Safe designated it AND
   * its own `tenantConfig(tenant).gullyTerms` is set. Null on release 1 and 2, and when no tenant was asked about.
   */
  readonly tenantOnGullyTerms: boolean | null;
  /**
   * Whether this chain can tell an outside Launchpad from a Gully one at all. False on release 1 and 2:
   * there, every launch is charged the Gully terms, whoever's Launchpad it was made on.
   */
  readonly perTenantTerms: boolean;
}

async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isRevertError(error, { zeroData: true })) return null;
    throw error;
  }
}

/**
 * Read what a chain charges a launch TODAY. Reads only: three or four `eth_call`s.
 *
 * `protocolFeeController` is the controller installed on the pool managers (the address book's
 * `feeController`); `tenant` is the Launchpad to ask about (its contract address), when there is one.
 * A transport failure is thrown; a contract that does not have a getter answers null for it.
 */
export async function readChainFeeTerms(
  client: PublicClient,
  args: { readonly kit: Address; readonly protocolFeeController?: Address | null; readonly tenant?: Address | null },
): Promise<ChainFeeTerms> {
  const probe = (args.tenant ?? "0x0000000000000000000000000000000000000001") as Address;
  const [rules, launchFeeWei, designated, builderFee] = await Promise.all([
    readKitV2Rules(client, args.kit),
    readOrNull(() => client.readContract({ address: args.kit, abi: KIT_TENANT_TERMS_ABI, functionName: "launchFeeWei" })),
    readOrNull(() => client.readContract({ address: args.kit, abi: KIT_TENANT_TERMS_ABI, functionName: "gullyDesignated", args: [probe] })),
    args.protocolFeeController ? readOrNull(() => client.readContract({ address: args.protocolFeeController as Address, abi: BUILDER_FEE_ABI, functionName: "builderFee" })) : Promise.resolve(null),
  ]);
  const release: 1 | 2 | 3 = designated !== null ? 3 : rules !== null ? 2 : 1;
  const tenantOnGullyTerms =
    release === 3 && args.tenant ? designated === true && (await readTenantConfig(client, args.kit, args.tenant as Address)).gullyTerms : null;
  return {
    kit: args.kit,
    release,
    rules,
    launchFeeWei: launchFeeWei === null ? null : BigInt(launchFeeWei),
    builderFeePips: builderFee === null ? null : Number(builderFee),
    tenantDesignated: release === 3 && args.tenant ? Boolean(designated) : null,
    tenantOnGullyTerms,
    perTenantTerms: release === 3,
  };
}

/**
 * Which case a launch made through an OUTSIDE Launchpad is charged on this chain today.
 * Release 3: outside terms. Release 1 and 2: the kit knows one set of terms, so the Gully terms apply to
 * every launch (the honest label until release 3 is live on the chain).
 */
export function termsChargedToOutsideLaunchpads(chain: Pick<ChainFeeTerms, "perTenantTerms">): LaunchTermsKind {
  return chain.perTenantTerms ? "outside" : "gully";
}

/** One sentence saying what the chain charges an outside Launchpad's launches today, for a caption under the table. */
export function chainTermsSentence(chain: ChainFeeTerms, chainName: string): string {
  if (chain.perTenantTerms) {
    const fee = chain.builderFeePips === null ? "the protocol fee its fee controller sets" : `${pipsPercentText(chain.builderFeePips)} of every trade`;
    return `${chainName} runs launch kit release 3: a launch on your Launchpad pays Gully ${fee} and nothing else, unless Gully has designated the Launchpad and it has opted in.`;
  }
  if (chain.release === 2 && chain.rules !== null) {
    const share = `${chain.rules.protocolTradeShareBps / 100}%`;
    return `${chainName} runs launch kit release 2, which has one set of terms for every Launchpad: today a launch here pays Gully ${share} of the ${pipsPercentText(chain.rules.minTradeFeePips)} trade fee, ${GULLY_LAUNCH_RULES.TAX_PROTOCOL_BPS / 100}% of any creator tax and the launch fee, whoever's Launchpad it is made on. The flat ${pipsPercentText(BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS)} for outside Launchpads starts with release 3.`;
  }
  return `${chainName} runs an earlier launch kit; its launches follow that kit's own terms.`;
}
