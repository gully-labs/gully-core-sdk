// SPDX-License-Identifier: MIT
/* ============================================================================
   What a release 2 `LaunchpadKitV2` FIXES for every launch, read off the kit.

   Release 2 (Gully Core, 2026-11-04) added four public constants to the kit:
   `MIN_TRADE_FEE_PIPS` (1%), `PROTOCOL_TRADE_SHARE_BPS` (50%),
   `TAX_SECONDS_FOREVER` (uint32 max) and `LAUNCH_TOTAL_SUPPLY` (1e9 tokens).
   A release 1 kit has none of them, and its launches follow the older rules
   (0.30% steady fee, a protocol share chosen in [20%, 50%], a 180-day tax
   ceiling, any supply). So the presence of these constants is how a surface
   tells the two apart: never by address, never by date.

   The ABI below is hand-written from the four getters' signatures, which solc
   derives mechanically from `uint24 public constant` and friends; it is checked
   against the deployed kit's verified ABI by tools/abi-check.mjs.
   ============================================================================ */
import type { Address, PublicClient } from "viem";

import { isRevertError } from "../../chains/revert.js";
import type { KitV2Rules } from "./validate.js";

export const LAUNCHPAD_KIT_V2_RULES_ABI = [
  { type: "function", name: "MIN_TRADE_FEE_PIPS", inputs: [], outputs: [{ name: "", type: "uint24" }], stateMutability: "view" },
  { type: "function", name: "PROTOCOL_TRADE_SHARE_BPS", inputs: [], outputs: [{ name: "", type: "uint16" }], stateMutability: "view" },
  { type: "function", name: "TAX_SECONDS_FOREVER", inputs: [], outputs: [{ name: "", type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "LAUNCH_TOTAL_SUPPLY", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "error", name: "TradeFeeBelowFloor", inputs: [{ name: "finalFeeBips", type: "uint24" }, { name: "minimum", type: "uint24" }] },
  { type: "error", name: "TotalSupplyFixed", inputs: [{ name: "totalSupply", type: "uint256" }, { name: "required", type: "uint256" }] },
  { type: "error", name: "ProtocolShareFixed", inputs: [{ name: "protocolBps", type: "uint16" }, { name: "required", type: "uint16" }] },
] as const;

/** `TAX_FOREVER()` on a release 2 launch guard: the `expiresAt` of a tax that never ends (uint40 max). */
export const LAUNCH_GUARD_TAX_FOREVER_ABI = [
  { type: "function", name: "TAX_FOREVER", inputs: [], outputs: [{ name: "", type: "uint40" }], stateMutability: "view" },
] as const;

/** uint40 max: the `expiresAt` a release 2 guard stores for a forever tax. */
export const TAX_EXPIRES_NEVER = 1_099_511_627_775;

/** Whether a stored tax expiry means "never" (`TAX_FOREVER`). */
export function taxNeverExpires(expiresAt: number | bigint): boolean {
  return BigInt(expiresAt) >= BigInt(TAX_EXPIRES_NEVER);
}

/**
 * The kit's fixed values, or `null` for a kit that has none (release 1: the calls revert).
 * A transport failure is NOT a null: it throws, so "could not read" is never shown as "the old rules".
 */
export async function readKitV2Rules(client: PublicClient, kit: Address): Promise<KitV2Rules | null> {
  const read = async <N extends "MIN_TRADE_FEE_PIPS" | "PROTOCOL_TRADE_SHARE_BPS" | "LAUNCH_TOTAL_SUPPLY">(functionName: N): Promise<bigint | number | null> => {
    try {
      return (await client.readContract({ address: kit, abi: LAUNCHPAD_KIT_V2_RULES_ABI, functionName })) as bigint | number;
    } catch (error) {
      if (isRevertError(error, { zeroData: true })) return null;
      throw error;
    }
  };
  const [fee, share, supply] = await Promise.all([read("MIN_TRADE_FEE_PIPS"), read("PROTOCOL_TRADE_SHARE_BPS"), read("LAUNCH_TOTAL_SUPPLY")]);
  if (fee === null || share === null || supply === null) return null;
  return { minTradeFeePips: Number(fee), protocolTradeShareBps: Number(share), launchTotalSupply: BigInt(supply) };
}
