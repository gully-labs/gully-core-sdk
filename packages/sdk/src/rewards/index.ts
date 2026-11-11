// SPDX-License-Identifier: MIT
/**
 * Liquidity rewards: `GullyCoreLiquidityRewardsHook` (packages/lp-rewards).
 *
 * A CL Gully Core that streams project-funded reward tokens to IN-RANGE liquidity,
 * per second, in proportion to each position's share of the eligible liquidity in
 * range during those seconds. The hook measures it itself from its liquidity and
 * swap callbacks; nobody off chain decides who earned what.
 *
 * - A pool has at most 3 reward tokens, each with one stream. The pool's owner
 *   (whoever configured it) starts and extends streams; anyone may top one up.
 *   Nothing funded can be withdrawn by the funder while anyone can earn it.
 * - Positions held by the canonical CL position manager are claimed by the NFT's
 *   owner or an approved address. Burning a position destroys the NFT first, so
 *   claim BEFORE burning, or burn with `hookData` naming a recipient (then the
 *   rewards become that address's credit, pulled with `claimCredit`).
 * - The protocol takes a share of every funding (1% at launch, immutable cap 3%),
 *   paid only to the governance Safe.
 *
 * Rates here are in REWARD-TOKEN UNITS. Nothing in this module prices anything:
 * a dollar APR needs a price for the reward token AND for the pool's tokens, from
 * a source, and is the caller's to compute.
 *
 * Independently authored against the contract's compiled ABI (`./abi.ts`) and its
 * documented rules (`packages/lp-rewards/src/*.sol`, GPL). Validation restates the
 * contract's own checks so a wallet is never asked to sign a call it will refuse;
 * the contract stays the authority.
 *
 * NOTHING HERE IS DEPLOYED. `GullyCoreDeployment.lpRewardsHook` is absent or
 * `null` on every chain until the hook is deployed and read back.
 *
 * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
 * The API may change in a minor release before the first deployment.
 */

import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";

import { isNativeCurrency } from "../types/currency.js";
import { getHooksRegistrationBitmap, getTickSpacing } from "../types/parameters.js";
import { poolKeyToId, type PoolKey } from "../types/poolKey.js";
import { LP_REWARDS_ABI } from "./abi.js";

export { LP_REWARDS_ABI };

/* ---------------------------------------------------------- constants --- */

/** The standalone hook's registration bitmap: beforeInitialize, beforeAdd/RemoveLiquidity, afterSwap. */
export const LP_REWARDS_BITMAP = 0x0095;
/** `LiquidityRewardsModule.MAX_REWARD_TOKENS`. */
export const LP_REWARDS_MAX_TOKENS = 3;
/** `MIN_STREAM_DURATION` / `MAX_STREAM_DURATION`, seconds. */
export const LP_REWARDS_MIN_DURATION = 86_400;
export const LP_REWARDS_MAX_DURATION = 365 * 86_400;
/** `MIN_TOPUP_REMAINING`, seconds: a top-up needs this much of the stream left. */
export const LP_REWARDS_MIN_TOPUP_REMAINING = 3_600;
/** `ABSOLUTE_MAX_PROTOCOL_FEE_BPS`: compile-time ceiling of the protocol's share of funding. */
export const LP_REWARDS_ABSOLUTE_MAX_FEE_BPS = 300;
/** `kind()`: the domain-separated identity off-chain readers check instead of an address list. */
export const LP_REWARDS_KIND: Hex = keccak256(stringToHex("gullycore.liquidity-rewards.cl.v1"));
const MAX_TICK = 887_272;
const MAX_UINT128 = 2n ** 128n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;
const Q64 = 1n << 64n;
const DAY = 86_400n;

/* -------------------------------------------------------------- types --- */

/** Core's own position key: `sender` is whoever called `modifyLiquidity`. */
export interface RewardsPositionKey {
  readonly sender: Address;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly salt: Hex;
}

/** One reward token's stream on one pool, as `streams(poolId)` reports it NOW. */
export interface RewardStream {
  readonly token: Address;
  /** Reward units per second, << 64. */
  readonly rateX64: bigint;
  /** Effective finish: includes the seconds with no eligible liquidity so far. */
  readonly periodFinish: bigint;
  readonly lastUpdate: bigint;
  readonly undistributed: bigint;
  readonly accruedUnpaid: bigint;
  readonly refundRecipient: Address;
}

/** A call ready for a wallet: target, calldata and the exact native value to attach. */
export interface RewardsTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** Thrown by every builder for an input the contract would refuse. `field` names the input. */
export class RewardsInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "RewardsInputError";
    this.field = field;
  }
}

/* ------------------------------------------------------------ helpers --- */

/** The hook's address in a deployment record, or `null` where it is not deployed. */
export function lpRewardsHookOf(deployment: { readonly lpRewardsHook?: Address | null } | null | undefined): Address | null {
  const a = deployment?.lpRewardsHook ?? null;
  return a === null || a.toLowerCase() === zeroAddress ? null : a;
}

/** True when `key` is a pool of the rewards hook at `hook` (address AND the bitmap in the key). */
export function isRewardsPool(key: Pick<PoolKey, "hooks" | "parameters">, hook: Address | null): boolean {
  if (hook === null) return false;
  if (key.hooks.toLowerCase() !== hook.toLowerCase()) return false;
  return getHooksRegistrationBitmap(key.parameters) === LP_REWARDS_BITMAP;
}

/** The key of a position held by the canonical CL position manager: `salt = bytes32(tokenId)`. */
export function nftPositionKey(positionManager: Address, tokenId: bigint, tickLower: number, tickUpper: number): RewardsPositionKey {
  if (tokenId < 0n || tokenId > MAX_UINT256) throw new RewardsInputError("tokenId", "token id out of range");
  return { sender: positionManager, tickLower, tickUpper, salt: `0x${tokenId.toString(16).padStart(64, "0")}` as Hex };
}

/** Whether a position of width `tickUpper - tickLower` qualifies on a pool with `minWidthTicks`. */
export function isWideEnough(tickLower: number, tickUpper: number, minWidthTicks: number): boolean {
  return tickUpper > tickLower && tickUpper - tickLower >= minWidthTicks;
}

/** Reward units paid per day to the WHOLE eligible range at this rate (floor). */
export function rewardsPerDay(rateX64: bigint): bigint {
  return (rateX64 * DAY) / Q64;
}

/**
 * Reward units per day a position of `liquidity` earns while IN RANGE, if the eligible liquidity in
 * range stays `eligibleLiquidity` (it includes the position's own liquidity once it is in range;
 * pass `includesPosition = false` for a position not yet added). `null` when there is no liquidity
 * to divide by: nothing is being paid to anybody at that moment.
 */
export function positionRewardsPerDay(
  rateX64: bigint,
  eligibleLiquidity: bigint,
  liquidity: bigint,
  includesPosition = true,
): bigint | null {
  const denom = includesPosition ? eligibleLiquidity : eligibleLiquidity + liquidity;
  if (denom === 0n || liquidity === 0n) return null;
  return (rateX64 * DAY * liquidity) / (Q64 * denom);
}

/** Seconds left on a stream at `now` (0 once finished). */
export function secondsLeft(stream: Pick<RewardStream, "periodFinish">, now: bigint): bigint {
  return stream.periodFinish > now ? stream.periodFinish - now : 0n;
}

/* --------------------------------------------------------------- reads --- */

export async function readRewardStreams(client: PublicClient, hook: Address, poolId: Hex): Promise<readonly RewardStream[]> {
  const out = (await client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "streams", args: [poolId] })) as readonly {
    token: Address;
    rateX64: bigint;
    periodFinish: bigint;
    lastUpdate: bigint;
    undistributed: bigint;
    accruedUnpaid: bigint;
    refundRecipient: Address;
  }[];
  return out.map((s) => ({
    token: s.token,
    rateX64: s.rateX64,
    periodFinish: BigInt(s.periodFinish),
    lastUpdate: BigInt(s.lastUpdate),
    undistributed: s.undistributed,
    accruedUnpaid: s.accruedUnpaid,
    refundRecipient: s.refundRecipient,
  }));
}

export interface RewardsPoolState {
  readonly owner: Address;
  readonly initialized: boolean;
  readonly tickSpacing: number;
  readonly lastTick: number;
  readonly minWidthTicks: number;
  readonly eligibleLiquidity: bigint;
  readonly zeroLiquiditySince: bigint;
  readonly rewardTokens: readonly Address[];
}

export async function readRewardsPool(client: PublicClient, hook: Address, poolId: Hex): Promise<RewardsPoolState> {
  const [owner, cfg, eligible, zeroSince, tokens] = await Promise.all([
    client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "poolOwner", args: [poolId] }),
    client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "poolConfig", args: [poolId] }),
    client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "eligibleLiquidity", args: [poolId] }),
    client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "zeroLiquiditySince", args: [poolId] }),
    client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "rewardTokens", args: [poolId] }),
  ]);
  const [initialized, tickSpacing, lastTick, minWidthTicks] = cfg as readonly [boolean, number, number, number, bigint];
  return {
    owner: owner as Address,
    initialized,
    tickSpacing: Number(tickSpacing),
    lastTick: Number(lastTick),
    minWidthTicks: Number(minWidthTicks),
    eligibleLiquidity: eligible as bigint,
    zeroLiquiditySince: BigInt(zeroSince as bigint | number),
    rewardTokens: tokens as readonly Address[],
  };
}

/** What `claim` would pay now, per reward token, in `rewardTokens` order. */
export async function readEarned(client: PublicClient, hook: Address, poolId: Hex, pos: RewardsPositionKey): Promise<readonly bigint[]> {
  return (await client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "earned", args: [poolId, pos] })) as readonly bigint[];
}

export async function readCredit(client: PublicClient, hook: Address, account: Address, token: Address): Promise<bigint> {
  return (await client.readContract({ address: hook, abi: LP_REWARDS_ABI, functionName: "credit", args: [account, token] })) as bigint;
}

/* ------------------------------------------------------------ builders --- */

const tx = (to: Address, data: Hex, value = 0n): RewardsTx => ({ to, data, value });

export interface ConfigureRewardsInput {
  readonly rewardTokens: readonly Address[];
  /** Fixed for the life of the pool. The design's UI default is 10 tick spacings. */
  readonly minWidthTicks: number;
}

/** Before the pool exists. The first caller owns the pool's rewards configuration. */
export function buildConfigureRewards(hook: Address, key: PoolKey, input: ConfigureRewardsInput): RewardsTx {
  if (key.hooks.toLowerCase() !== hook.toLowerCase()) throw new RewardsInputError("key.hooks", "the pool key does not name this hook");
  if (getHooksRegistrationBitmap(key.parameters) !== LP_REWARDS_BITMAP) {
    throw new RewardsInputError("key.parameters", `the key's bitmap must be 0x${LP_REWARDS_BITMAP.toString(16).padStart(4, "0")}`);
  }
  if (input.rewardTokens.length > LP_REWARDS_MAX_TOKENS) throw new RewardsInputError("rewardTokens", "at most 3 reward tokens");
  const seen = new Set<string>();
  for (const t of input.rewardTokens) {
    if (seen.has(t.toLowerCase())) throw new RewardsInputError("rewardTokens", "a reward token is listed twice");
    seen.add(t.toLowerCase());
  }
  if (!Number.isInteger(input.minWidthTicks) || input.minWidthTicks < 0 || input.minWidthTicks > 2 * MAX_TICK) {
    throw new RewardsInputError("minWidthTicks", "minWidthTicks must be an integer in [0, 1774544]");
  }
  const spacing = getTickSpacing(key.parameters);
  if (spacing < 1) throw new RewardsInputError("key.parameters", "tick spacing must be at least 1");
  return tx(
    hook,
    encodeFunctionData({
      abi: LP_REWARDS_ABI,
      functionName: "configureRewards",
      args: [key, { rewardTokens: [...input.rewardTokens], minWidthTicks: input.minWidthTicks }],
    }),
  );
}

export function buildAllowRewardToken(hook: Address, key: PoolKey, token: Address): RewardsTx {
  return tx(hook, encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "allowRewardToken", args: [key, token] }));
}

function positive(field: string, v: bigint): void {
  if (v <= 0n || v > MAX_UINT128) throw new RewardsInputError(field, `${field} must be in [1, 2^128 - 1]`);
}

/** Pool owner. Native rewards attach `amount` as value; ERC-20 rewards need an allowance to the hook. */
export function buildStartStream(
  hook: Address,
  key: PoolKey,
  input: { readonly token: Address; readonly amount: bigint; readonly durationSeconds: number; readonly refundRecipient: Address },
): RewardsTx {
  positive("amount", input.amount);
  const d = input.durationSeconds;
  if (!Number.isInteger(d) || d < LP_REWARDS_MIN_DURATION || d > LP_REWARDS_MAX_DURATION) {
    throw new RewardsInputError("durationSeconds", "a stream runs between 1 and 365 days");
  }
  if (input.refundRecipient.toLowerCase() === zeroAddress) throw new RewardsInputError("refundRecipient", "a refund recipient is required");
  return tx(
    hook,
    encodeFunctionData({
      abi: LP_REWARDS_ABI,
      functionName: "startStream",
      args: [key, input.token, input.amount, d, input.refundRecipient],
    }),
    isNativeCurrency(input.token) ? input.amount : 0n,
  );
}

/**
 * Pool owner. `newFinish` (unix seconds) may not be before the current finish, and the new rate may
 * not be below the current one: pass the stream as read so the check runs here first.
 */
export function buildExtendStream(
  hook: Address,
  key: PoolKey,
  input: { readonly token: Address; readonly amount: bigint; readonly newFinish: bigint; readonly now: bigint; readonly stream?: RewardStream },
): RewardsTx {
  positive("amount", input.amount);
  if (input.newFinish - input.now > BigInt(LP_REWARDS_MAX_DURATION)) throw new RewardsInputError("newFinish", "at most 365 days from now");
  const s = input.stream;
  if (s !== undefined) {
    if (s.periodFinish <= input.now) throw new RewardsInputError("token", "no stream is running for this token");
    if (input.newFinish < s.periodFinish) throw new RewardsInputError("newFinish", "the finish can only move out");
    // fee is not known here: check the rate on the gross amount; the contract checks the net one
    const newRate = ((s.undistributed + input.amount) << 64n) / (input.newFinish - input.now);
    if (newRate < s.rateX64) throw new RewardsInputError("amount", "the new rate would be below the current one");
  }
  return tx(
    hook,
    encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "extendStream", args: [key, input.token, input.amount, input.newFinish] }),
    isNativeCurrency(input.token) ? input.amount : 0n,
  );
}

/** Anyone. Raises a running stream's rate; never moves its finish. */
export function buildTopUp(hook: Address, key: PoolKey, token: Address, amount: bigint, stream?: RewardStream, now?: bigint): RewardsTx {
  positive("amount", amount);
  if (stream !== undefined && now !== undefined) {
    if (stream.periodFinish <= now) throw new RewardsInputError("token", "no stream is running for this token");
    if (stream.periodFinish - now < BigInt(LP_REWARDS_MIN_TOPUP_REMAINING)) {
      throw new RewardsInputError("token", "a stream needs at least one hour left to be topped up");
    }
  }
  return tx(
    hook,
    encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "topUp", args: [key, token, amount] }),
    isNativeCurrency(token) ? amount : 0n,
  );
}

export function buildClaim(hook: Address, poolId: Hex, pos: RewardsPositionKey, to: Address): RewardsTx {
  if (to.toLowerCase() === zeroAddress) throw new RewardsInputError("to", "a recipient is required");
  return tx(hook, encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "claim", args: [poolId, pos, to] }));
}

export function buildClaimCredit(hook: Address, token: Address, to: Address): RewardsTx {
  if (to.toLowerCase() === zeroAddress) throw new RewardsInputError("to", "a recipient is required");
  return tx(hook, encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "claimCredit", args: [token, to] }));
}

export function buildRecycle(hook: Address, poolId: Hex, pos: RewardsPositionKey): RewardsTx {
  return tx(hook, encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "recycle", args: [poolId, pos] }));
}

export function buildReclaim(hook: Address, poolId: Hex, token: Address): RewardsTx {
  return tx(hook, encodeFunctionData({ abi: LP_REWARDS_ABI, functionName: "reclaim", args: [poolId, token] }));
}

/** The 32 bytes a REMOVAL through the position manager carries to move a position's rewards to `recipient`. */
export function rewardsRecipientHookData(recipient: Address): Hex {
  if (recipient.toLowerCase() === zeroAddress) throw new RewardsInputError("recipient", "a recipient is required");
  return encodeAbiParameters([{ type: "address" }], [recipient]);
}

/** periphery `Actions`: CL_BURN_POSITION and TAKE_PAIR. */
const CL_BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;

/**
 * ONE position-manager transaction that burns `tokenId` and credits its rewards to `recipient` on the
 * way (the hook reads `hookData` on the removal), then takes both currencies to `takeTo`. Use it
 * instead of a plain burn on a rewards pool: a plain burn destroys the NFT before the liquidity is
 * removed, after which nobody can claim the position's rewards until they are recycled.
 */
export function buildBurnCreditingRewards(
  positionManager: Address,
  input: {
    readonly key: PoolKey;
    readonly tokenId: bigint;
    readonly recipient: Address;
    readonly takeTo: Address;
    readonly amount0Min?: bigint;
    readonly amount1Min?: bigint;
    readonly deadline: bigint;
  },
): RewardsTx {
  const hookData = rewardsRecipientHookData(input.recipient);
  const burn = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [input.tokenId, input.amount0Min ?? 0n, input.amount1Min ?? 0n, hookData],
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [input.key.currency0, input.key.currency1, input.takeTo],
  );
  const actions = `0x${CL_BURN_POSITION.toString(16).padStart(2, "0")}${TAKE_PAIR.toString(16).padStart(2, "0")}` as Hex;
  const payload = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [burn, take]]);
  return tx(
    positionManager,
    encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "modifyLiquidities",
          stateMutability: "payable",
          inputs: [
            { name: "payload", type: "bytes" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "modifyLiquidities",
      args: [payload, input.deadline],
    }),
  );
}

/** The pool id of a rewards pool key, for the reads above. */
export function rewardsPoolId(key: PoolKey): Hex {
  return poolKeyToId(key);
}
