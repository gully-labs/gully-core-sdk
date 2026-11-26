// SPDX-License-Identifier: MIT
/* ============================================================================
   A launch with a locked, vesting creator allocation:
   `GullyCoreCreatorVesting.launchVested(params, vesting)` and
   `launchVestedAndBuy(params, vesting, buy)` (gully-ops
   l3/gully-core/packages/launch-periphery; not audited, testnet only).

   The rules are the contract's constants, restated here and kept equal by the
   test suite:

     * ALLOCATION 1..500 bps (at most 5% of supply). `seedSupply` must be
       exactly `totalSupply - allocation` and `allocationRecipient` zero: the
       kit mints the allocation to the vesting contract, which locks it.
     * SCHEDULE: nothing for 30 days, then linear over 180 days. In
       `GullyCoreTokenLock` terms `start == cliff == launch + 30 days` and
       `end == cliff + 180 days`. Nobody can shorten it.
     * THE TOKEN ADDRESS is in the vesting contract's namespace:
       `predictLaunchToken(launcher, userSalt, withBuy)` on the contract. Pass it
       back as `expectedToken`.
     * VALUE = the kit's launch fee + the token lock's `feeWei()` (+ `amountIn`
       for a native first buy). `maxFeesWei` bounds the two fees.
     * A CREATOR LOCK is the token lock whose `creator` field is the vesting
       contract (it is the one that called `lock`).

   Nothing here sends anything.
   ============================================================================ */

import { encodeFunctionData, parseAbi, type Abi, type Address, type Hex } from "viem";

import type { LaunchBuyParamsV2 } from "./launchAndBuy.js";

export const CREATOR_VESTING_MAX_ALLOCATION_BPS = 500;
export const CREATOR_VESTING_CLIFF_SECONDS = 30n * 86_400n;
export const CREATOR_VESTING_DURATION_SECONDS = 180n * 86_400n;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const LAUNCH_PARAMS =
  "(string name, string symbol, string metadataURI, bytes32 userSalt, uint256 totalSupply, uint256 seedSupply, address allocationRecipient, address creator, address launchOperator, address launchSteward, address tenant, address integrator, uint16 integratorBps, uint256 integratorLaunchFeeWei, uint16 creatorBps, uint16 protocolBps, (uint8 preset, uint24 initialFeeBips, uint24 finalFeeBips, uint32 decaySeconds, bool enabled, uint32 startDelaySeconds) schedule, (uint16 buyBps, uint16 sellBps, uint32 taxSeconds, uint16 creatorBps, uint16 protocolBps, uint16 integratorBps) tax, (uint8 kind, address quote, uint16 weightBps, uint128 maxBuyPerTx, (int24 tickSpacing, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) cl, (uint16 binStep, uint24 activeId, uint8 shape, uint16 binCount, uint24[] offsets, uint64[] weights, uint16 floorBins) bin)[] legs, (string description, string websiteURI, string xHandle, string telegramHandle) listing)";
const VESTING = "(uint16 allocationBps, uint256 maxFeesWei, address expectedToken, address beneficiary)";
const BUY =
  "(uint8 legIndex, uint256 amountIn, uint256 minAmountOut, address recipient, address expectedToken, uint256 maxLaunchFeeWei, uint24 maxLpFeePips)";

/**
 * The parts of `GullyCoreCreatorVesting` an app calls. Typed as `Abi` on purpose: the launch struct is too deep for
 * viem's literal inference (TS2589); the test pins the selectors to the compiled contract's.
 */
export const GULLYCORE_CREATOR_VESTING_ABI: Abi = parseAbi<readonly string[]>([
  `function launchVested(${LAUNCH_PARAMS} p, ${VESTING} v) payable returns ((address token, bytes32[] poolIds, uint256[] lockIds, uint40 startTime, uint256 protocolFeeWei, uint256 integratorFeeWei) result, uint256 lockId)`,
  `function launchVestedAndBuy(${LAUNCH_PARAMS} p, ${VESTING} v, ${BUY} b) payable returns ((address token, bytes32[] poolIds, uint256[] lockIds, uint40 startTime, uint256 protocolFeeWei, uint256 integratorFeeWei) result, uint256 lockId, uint256 quoteSpent, uint256 tokensBought, uint24 lpFeePips)`,
  "function predictLaunchToken(address launcher, bytes32 userSalt, bool withBuy) view returns (address)",
  "function feesFor(address tenant, uint256 integratorLaunchFeeWei) view returns (uint256)",
  "function allocationFor(uint256 totalSupply, uint16 allocationBps) pure returns (uint256)",
  "function scheduleFor(uint256 launchedAt) pure returns (uint48 cliff, uint48 end)",
  "function MAX_ALLOCATION_BPS() view returns (uint16)",
  "function CLIFF_SECONDS() view returns (uint48)",
  "function VESTING_SECONDS() view returns (uint48)",
  "function KIT() view returns (address)",
  "function LAUNCH_AND_BUY() view returns (address)",
  "function TOKEN_LOCK() view returns (address)",
  "event CreatorVestingLocked(address indexed token, address indexed beneficiary, uint256 indexed lockId, uint256 amount, uint16 allocationBps, uint48 cliff, uint48 end, bool withBuy)",
]);

/** `GullyCoreCreatorVesting.VestingParams`. */
export interface CreatorVestingParams {
  readonly allocationBps: number;
  readonly maxFeesWei: bigint;
  readonly expectedToken: Address;
  /** `ZERO` = the caller. */
  readonly beneficiary: Address;
}

/** The fields of a Kit v2 launch params object this module touches. */
export interface AllocationFields {
  readonly totalSupply: bigint;
  readonly seedSupply: bigint;
  readonly allocationRecipient: Address;
}

export function creatorAllocation(totalSupply: bigint, allocationBps: number): bigint {
  checkAllocationBps(allocationBps);
  return (totalSupply * BigInt(allocationBps)) / 10_000n;
}

export function checkAllocationBps(allocationBps: number): void {
  if (!Number.isInteger(allocationBps) || allocationBps < 1 || allocationBps > CREATOR_VESTING_MAX_ALLOCATION_BPS) {
    throw new RangeError(`creator allocation must be 1..${CREATOR_VESTING_MAX_ALLOCATION_BPS} bps (got ${allocationBps})`);
  }
}

/** `params` with the allocation carved out: the pools get the rest, the vesting contract the allocation. */
export function withCreatorAllocation<P extends AllocationFields>(params: P, allocationBps: number): P {
  return { ...params, seedSupply: params.totalSupply - creatorAllocation(params.totalSupply, allocationBps), allocationRecipient: ZERO };
}

/** The token lock's schedule a launch at `launchedAt` (unix seconds) gets. */
export function creatorVestingSchedule(launchedAt: bigint): { start: bigint; cliff: bigint; end: bigint } {
  const cliff = launchedAt + CREATOR_VESTING_CLIFF_SECONDS;
  return { start: cliff, cliff, end: cliff + CREATOR_VESTING_DURATION_SECONDS };
}

export function buildCreatorVestingParams(o: { allocationBps: number; maxFeesWei: bigint; expectedToken: Address; beneficiary?: Address }): CreatorVestingParams {
  checkAllocationBps(o.allocationBps);
  return { allocationBps: o.allocationBps, maxFeesWei: o.maxFeesWei, expectedToken: o.expectedToken, beneficiary: o.beneficiary ?? ZERO };
}

/** Calldata for `launchVested`. `params` must already carry the allocation (`withCreatorAllocation`). */
export function encodeLaunchVested(params: unknown, vesting: CreatorVestingParams): Hex {
  return encodeFunctionData({ abi: GULLYCORE_CREATOR_VESTING_ABI as Abi, functionName: "launchVested", args: [params as never, vesting] });
}

/** Calldata for `launchVestedAndBuy`. */
export function encodeLaunchVestedAndBuy(params: unknown, vesting: CreatorVestingParams, buy: LaunchBuyParamsV2): Hex {
  return encodeFunctionData({ abi: GULLYCORE_CREATOR_VESTING_ABI as Abi, functionName: "launchVestedAndBuy", args: [params as never, vesting, buy as never] });
}

/** A token lock made by the vesting contract (`getLock(id).creator == vesting`) is a creator allocation. */
export function isCreatorVestingLock(lock: { readonly creator: Address }, vesting: Address): boolean {
  return lock.creator.toLowerCase() === vesting.toLowerCase();
}
