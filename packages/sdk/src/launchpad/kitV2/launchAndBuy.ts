// SPDX-License-Identifier: MIT
/* ============================================================================
   A launch and the creator's first buy, in one transaction:
   `GullyCoreLaunchAndBuy.launchAndBuy(params, buy)`.

   The contract is a plain caller of `LaunchpadKitV2.createLaunch`, so the
   launch itself is exactly what `buildLaunchV2` builds. Three things differ,
   and each is handled here rather than left to a screen:

     * THE TOKEN ADDRESS MOVES. Through this contract the kit's caller is the
       contract, which folds the real caller into the salt itself:
       `kit.predictLaunchToken(launchAndBuy, keccak256(abi.encode(launcher, userSalt)))`.
       The contract's own `predictLaunchToken(launcher, userSalt)` is the
       authority; both routes are read and must agree before any pool id is
       derived from the address, and the address is passed back to the contract
       as `expectedToken`, which it checks before it creates anything.
     * THE START IS NOW. The contract refuses a delayed start
       (`StartDelayMustBeZero`): the buy lands at the open, at the opening fee.
     * TWO BOUNDS. `maxLaunchFeeWei` is the limits' `safeValue` (the kit is paid
       the fee in force, read in the same call), and `maxLpFeePips` is the fee
       the schedule opens at (`openingFeePips`, the contract's own
       `previewOpeningFee` rule). The guard's fee and any creator tax come out
       of `amountIn` before the pool trades, so `minAmountOut` is a real bound:
       read it by simulating with 0 and send what the simulation bought.

   `msg.value` is the launch value plus `amountIn` for a natively quoted leg; for
   an ERC-20 quote the contract pulls `amountIn` from the sender, who must have
   approved it (`approval`). Nothing here sends anything.
   ============================================================================ */

import { decodeFunctionResult, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";

import { GULLYCORE_LAUNCH_AND_BUY_ABI } from "../generated/abi.js";
import { PRESET, PRESET_NAMES, PRESET_PARAMS } from "../presets.js";
import { kitV2LaunchSalt, predictLaunchTokenChecked } from "./address.js";
import { buildLaunchParamsV2, nativeQuoteIssues, type BuiltLaunchV2, type LaunchDraftV2 } from "./build.js";
import { NATIVE_ADDRESS, type KitV2Limits } from "./reads.js";
import type { LaunchV2Issue } from "./validate.js";

/** `GullyCoreLaunchAndBuy.BuyParams`, exactly as viem encodes it. */
export interface LaunchBuyParamsV2 {
  readonly legIndex: number;
  /** Exact input, raw units of the leg's quote. */
  readonly amountIn: bigint;
  /** Raw launch-token units the buyer accepts. */
  readonly minAmountOut: bigint;
  /** Who receives the bought tokens. */
  readonly recipient: Address;
  /** The launch-token address the buyer was shown; the contract refuses any other. */
  readonly expectedToken: Address;
  /** The most the kit may be paid (protocol + integrator launch fee). */
  readonly maxLaunchFeeWei: bigint;
  /** The most the guard may charge this first buy, in pips (1e6 = 100%). */
  readonly maxLpFeePips: number;
}

/** The buy as a form holds it. */
export interface LaunchBuyDraftV2 {
  readonly legIndex: number;
  readonly amountIn: bigint;
  /** `0n` to read what the buy returns by simulating; then the simulated amount. */
  readonly minAmountOut: bigint;
  /** Defaults to the launcher. */
  readonly recipient?: Address;
}

/** A `launchAndBuy` call for a wallet: the launch exactly as `buildLaunchV2` builds it, plus the buy. */
export interface BuiltLaunchAndBuyV2 extends BuiltLaunchV2 {
  /** `GullyCoreLaunchAndBuy`. */
  readonly to: Address;
  readonly kit: Address;
  readonly buy: LaunchBuyParamsV2;
  /** The leg's quote currency (`NATIVE_ADDRESS` for native). */
  readonly quote: Address;
  /** An ERC-20 quote must be approved to the contract for `amountIn` first; `null` for native. */
  readonly approval: { readonly token: Address; readonly spender: Address; readonly amount: bigint } | null;
}

/** What `launchAndBuy` returned, decoded from a simulation's return data. */
export interface LaunchAndBuyOutcome {
  readonly token: Address;
  readonly poolIds: readonly Hex[];
  /** Quote units the buyer paid: what the pool traded plus the guard's fee and any creator tax. */
  readonly quoteSpent: bigint;
  /** Launch-token units delivered to the recipient. */
  readonly tokensBought: bigint;
  /** The guard's fee at the open, in pips. */
  readonly lpFeePips: number;
}

/**
 * The fee the guard charges at the open (`elapsed == 0`), in pips: what
 * `GullyCoreLaunchAndBuy.previewOpeningFee` returns, from the same rule (a named
 * preset supplies its own numbers; a disabled schedule charges its final fee).
 */
export function openingFeePips(schedule: { readonly preset: number; readonly initialFeeBips: number; readonly finalFeeBips: number; readonly enabled?: boolean }): number {
  if (schedule.preset === PRESET.Custom) return schedule.enabled === false ? schedule.finalFeeBips : schedule.initialFeeBips;
  const name = PRESET_NAMES[schedule.preset];
  if (name === undefined || name === "Custom") throw new RangeError(`unknown preset ${schedule.preset}`);
  const p = PRESET_PARAMS[name];
  return p.enabled ? p.initialFeeBips : p.finalFeeBips;
}

/** `launchAndBuy(params, buy)` calldata. */
export function encodeLaunchAndBuyV2(params: BuiltLaunchV2["params"], buy: LaunchBuyParamsV2): Hex {
  return encodeFunctionData({ abi: GULLYCORE_LAUNCH_AND_BUY_ABI, functionName: "launchAndBuy", args: [params, buy] });
}

/** Decodes `launchAndBuy`'s return data (an `eth_call` of the exact bytes). */
export function decodeLaunchAndBuyResult(data: Hex): LaunchAndBuyOutcome {
  const [result, quoteSpent, tokensBought, lpFeePips] = decodeFunctionResult({ abi: GULLYCORE_LAUNCH_AND_BUY_ABI, functionName: "launchAndBuy", data });
  return { token: result.token, poolIds: result.poolIds, quoteSpent, tokensBought, lpFeePips };
}

/** The checks the contract makes before it calls the kit, as issues beside the kit's own. */
function buyIssues(draft: LaunchDraftV2, buy: LaunchBuyDraftV2, launchAndBuy: Address): LaunchV2Issue[] {
  const out: LaunchV2Issue[] = [];
  if (draft.schedule.startDelaySeconds !== 0) {
    out.push({ severity: "error", field: "schedule.startDelaySeconds", message: "A launch with a first buy opens when it is created: set the start delay to zero.", contractError: "StartDelayMustBeZero" });
  }
  if (!Number.isInteger(buy.legIndex) || buy.legIndex < 0 || buy.legIndex >= draft.legs.length) {
    out.push({ severity: "error", field: "buy.legIndex", message: `The buy names pool ${buy.legIndex + 1}, but the launch has ${draft.legs.length}.`, contractError: "LegIndexOutOfRange" });
  }
  if (buy.amountIn <= 0n) out.push({ severity: "error", field: "buy.amountIn", message: "The first buy must spend something.", contractError: "ZeroBuyAmount" });
  if (buy.amountIn > (1n << 127n) - 1n) out.push({ severity: "error", field: "buy.amountIn", message: "The first buy is larger than core can settle.", contractError: "BuyAmountTooLarge" });
  const self = launchAndBuy.toLowerCase();
  for (const [field, a] of [
    ["creator", draft.creator],
    ["allocationRecipient", draft.allocationRecipient],
  ] as const) {
    if (a.toLowerCase() === self) out.push({ severity: "error", field, message: "The launch-and-buy contract cannot be paid anything: it has no way to claim it.", contractError: "InvalidRecipient" });
  }
  return out;
}

/**
 * The whole call: predicts the token through the contract (kit, SDK and contract
 * cross-checked), builds and validates the launch, adds the buy and encodes
 * `launchAndBuy`.
 */
export async function buildLaunchAndBuyV2(
  client: PublicClient,
  contracts: { readonly launchAndBuy: Address; readonly kit: Address },
  draft: LaunchDraftV2,
  limits: KitV2Limits,
  buy: LaunchBuyDraftV2,
): Promise<BuiltLaunchAndBuyV2> {
  const { launchAndBuy, kit } = contracts;
  if (limits.env.kit.toLowerCase() !== kit.toLowerCase()) {
    throw new Error(`limits were read for kit ${limits.env.kit}, not ${kit}; read them for the kit the launch is sent to`);
  }
  const [viaKit, viaContract, contractKit] = await Promise.all([
    predictLaunchTokenChecked(client, kit, launchAndBuy, kitV2LaunchSalt(draft.launcher, draft.userSalt)),
    client.readContract({ address: launchAndBuy, abi: GULLYCORE_LAUNCH_AND_BUY_ABI, functionName: "predictLaunchToken", args: [draft.launcher, draft.userSalt] }),
    client.readContract({ address: launchAndBuy, abi: GULLYCORE_LAUNCH_AND_BUY_ABI, functionName: "KIT" }),
  ]);
  if (contractKit.toLowerCase() !== kit.toLowerCase()) {
    throw new Error(`GullyCoreLaunchAndBuy at ${launchAndBuy} launches through ${contractKit}, not ${kit}`);
  }
  if (viaKit.toLowerCase() !== viaContract.toLowerCase()) {
    throw new Error(`GullyCoreLaunchAndBuy at ${launchAndBuy} predicts ${viaContract} but the kit and the SDK give ${viaKit}; do not derive pool ids from either until that is explained.`);
  }
  const token = viaContract;
  const built = buildLaunchParamsV2(draft, { token, limits });
  const nativeIssues = await nativeQuoteIssues(client, draft);
  const leg = built.params.legs[buy.legIndex];
  const quote = leg?.quote ?? NATIVE_ADDRESS;
  const isNative = quote.toLowerCase() === NATIVE_ADDRESS;
  const params: LaunchBuyParamsV2 = {
    legIndex: buy.legIndex,
    amountIn: buy.amountIn,
    minAmountOut: buy.minAmountOut,
    recipient: buy.recipient ?? draft.launcher,
    expectedToken: token,
    maxLaunchFeeWei: limits.value.safeValue,
    maxLpFeePips: openingFeePips(built.params.schedule),
  };
  return {
    ...built,
    issues: [...built.issues, ...nativeIssues, ...buyIssues(draft, buy, launchAndBuy)],
    to: launchAndBuy,
    kit,
    token,
    data: encodeLaunchAndBuyV2(built.params, params),
    value: limits.value.safeValue + (isNative ? buy.amountIn : 0n),
    buy: params,
    quote,
    approval: isNative ? null : { token: quote, spender: launchAndBuy, amount: buy.amountIn },
  };
}
