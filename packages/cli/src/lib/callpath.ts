// SPDX-License-Identifier: MIT
/**
 * Calldata the SDK does not build yet: a single-pool swap through the UniversalRouter and position-manager
 * action plans.
 *
 * The same encoding as `packages/widgets/src/callpath` (`plan.ts`, `swap.ts`, `liquidity.ts`), which the app
 * uses and which carries React as a peer, so this CLI cannot depend on it. Command and action ids mirror the
 * contracts' `Commands.sol` and `Actions.sol`. `test/callpath.test.ts` pins a swap against the SDK's own
 * `verifySwapCalldata`. Moving this into the SDK would let both share one copy.
 */

import type { PoolKey } from "@gullylabs/core-sdk";
import { CL_POSITION_MANAGER_ABI, UNIVERSAL_ROUTER_ABI } from "@gullylabs/core-sdk/trading";
import { concatHex, encodeAbiParameters, encodeFunctionData, isAddressEqual, keccak256, type Address, type Hex } from "viem";

const INFI_SWAP = "0x10";
const ACTIONS = {
  CL_DECREASE_LIQUIDITY: 0x01,
  CL_MINT_POSITION: 0x02,
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
  BIN_ADD_LIQUIDITY: 0x19,
  BIN_REMOVE_LIQUIDITY: 0x1a,
  BIN_SWAP_EXACT_IN_SINGLE: 0x1c,
} as const;

const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";

const POOL_KEY = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "hooks", type: "address" },
  { name: "poolManager", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "parameters", type: "bytes32" },
] as const;

type Step = readonly [number, Hex];

/** `abi.encode(bytes actions, bytes[] params)`, the strict form the periphery decodes. */
function encodePlan(steps: readonly Step[]): Hex {
  const actions = concatHex(steps.map(([a]) => `0x${a.toString(16).padStart(2, "0")}` as Hex));
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, steps.map(([, p]) => p)]);
}

function struct(key: PoolKey): { currency0: Address; currency1: Address; hooks: Address; poolManager: Address; fee: number; parameters: Hex } {
  return { currency0: key.currency0, currency1: key.currency1, hooks: key.hooks, poolManager: key.poolManager, fee: key.fee, parameters: key.parameters };
}

export interface EncodedCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

const CURRENCY_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;
const CURRENCY_PAIR = [{ type: "address" }, { type: "address" }] as const;
const CURRENCY_PAIR_TO = [{ type: "address" }, { type: "address" }, { type: "address" }] as const;

/**
 * An exact-input swap through one pool: pays `tokenIn` from the caller (Permit2 for an ERC-20, msg.value for
 * native) and takes the output to `recipient`, floored at `minOut` in the swap action and, when the recipient
 * is the caller, again in TAKE_ALL.
 */
export function buildPoolSwap(args: {
  readonly router: Address;
  readonly kind: "CL" | "Bin";
  readonly key: PoolKey;
  readonly tokenIn: Address;
  readonly amountIn: bigint;
  readonly minOut: bigint;
  readonly recipient: Address;
  readonly sender: Address;
  readonly deadline: bigint;
}): EncodedCall {
  const zeroForOne = isAddressEqual(args.key.currency0, args.tokenIn);
  const tokenOut = zeroForOne ? args.key.currency1 : args.key.currency0;
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOL_KEY },
          { name: "swapDirection", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: struct(args.key), swapDirection: zeroForOne, amountIn: args.amountIn, amountOutMinimum: args.minOut, hookData: "0x" }],
  );
  const take: Step = isAddressEqual(args.recipient, args.sender)
    ? [ACTIONS.TAKE_ALL, encodeAbiParameters(CURRENCY_AMOUNT, [tokenOut, args.minOut])]
    : [ACTIONS.TAKE, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [tokenOut, args.recipient, 0n])];
  const plan = encodePlan([
    [args.kind === "CL" ? ACTIONS.CL_SWAP_EXACT_IN_SINGLE : ACTIONS.BIN_SWAP_EXACT_IN_SINGLE, swap],
    [ACTIONS.SETTLE_ALL, encodeAbiParameters(CURRENCY_AMOUNT, [args.tokenIn, args.amountIn])],
    take,
  ]);
  return {
    to: args.router,
    data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [INFI_SWAP, [plan], args.deadline] }),
    value: isAddressEqual(args.tokenIn, NATIVE) ? args.amountIn : 0n,
  };
}

function modify(positionManager: Address, steps: readonly Step[], deadline: bigint, value: bigint): EncodedCall {
  return { to: positionManager, data: encodeFunctionData({ abi: CL_POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [encodePlan(steps), deadline] }), value };
}

/** The unspent native side goes back to the caller in the same transaction. */
function sweepNative(): Step {
  return [ACTIONS.SWEEP, encodeAbiParameters(CURRENCY_PAIR, [NATIVE, MSG_SENDER])];
}

export function buildClMint(args: {
  readonly positionManager: Address;
  readonly key: PoolKey;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly amount0Max: bigint;
  readonly amount1Max: bigint;
  readonly owner: Address;
  readonly deadline: bigint;
  readonly value: bigint;
}): EncodedCall {
  const mint = encodeAbiParameters(
    [{ type: "tuple", components: POOL_KEY }, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [struct(args.key), args.tickLower, args.tickUpper, args.liquidity, args.amount0Max, args.amount1Max, args.owner, "0x"],
  );
  const steps: Step[] = [
    [ACTIONS.CL_MINT_POSITION, mint],
    [ACTIONS.SETTLE_PAIR, encodeAbiParameters(CURRENCY_PAIR, [args.key.currency0, args.key.currency1])],
  ];
  if (args.value > 0n) steps.push(sweepNative());
  return modify(args.positionManager, steps, args.deadline, args.value);
}

export function buildClDecrease(args: {
  readonly positionManager: Address;
  readonly key: PoolKey;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly deadline: bigint;
}): EncodedCall {
  const decrease = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [args.tokenId, args.liquidity, args.amount0Min, args.amount1Min, "0x"]);
  const take = encodeAbiParameters(CURRENCY_PAIR_TO, [args.key.currency0, args.key.currency1, MSG_SENDER]);
  return modify(args.positionManager, [[ACTIONS.CL_DECREASE_LIQUIDITY, decrease], [ACTIONS.TAKE_PAIR, take]], args.deadline, 0n);
}

export function buildBinAdd(args: {
  readonly positionManager: Address;
  readonly key: PoolKey;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly amount0Max: bigint;
  readonly amount1Max: bigint;
  readonly activeId: number;
  readonly idSlippage: number;
  readonly deltaIds: readonly number[];
  readonly distributionX: readonly bigint[];
  readonly distributionY: readonly bigint[];
  readonly to: Address;
  readonly deadline: bigint;
  readonly value: bigint;
}): EncodedCall {
  const add = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOL_KEY },
          { name: "amount0", type: "uint128" },
          { name: "amount1", type: "uint128" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
          { name: "activeIdDesired", type: "uint256" },
          { name: "idSlippage", type: "uint256" },
          { name: "deltaIds", type: "int256[]" },
          { name: "distributionX", type: "uint256[]" },
          { name: "distributionY", type: "uint256[]" },
          { name: "minLiquidities", type: "uint256[]" },
          { name: "to", type: "address" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: struct(args.key),
        amount0: args.amount0,
        amount1: args.amount1,
        amount0Max: args.amount0Max,
        amount1Max: args.amount1Max,
        activeIdDesired: BigInt(args.activeId),
        idSlippage: BigInt(args.idSlippage),
        deltaIds: args.deltaIds.map((d) => BigInt(d)),
        distributionX: [...args.distributionX],
        distributionY: [...args.distributionY],
        minLiquidities: args.deltaIds.map(() => 0n),
        to: args.to,
        hookData: "0x",
      },
    ],
  );
  const steps: Step[] = [
    [ACTIONS.BIN_ADD_LIQUIDITY, add],
    [ACTIONS.SETTLE_PAIR, encodeAbiParameters(CURRENCY_PAIR, [args.key.currency0, args.key.currency1])],
  ];
  if (args.value > 0n) steps.push(sweepNative());
  return modify(args.positionManager, steps, args.deadline, args.value);
}

export function buildBinRemove(args: {
  readonly positionManager: Address;
  readonly key: PoolKey;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly ids: readonly number[];
  readonly amounts: readonly bigint[];
  readonly from: Address;
  readonly deadline: bigint;
}): EncodedCall {
  const remove = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOL_KEY },
          { name: "amount0Min", type: "uint128" },
          { name: "amount1Min", type: "uint128" },
          { name: "ids", type: "uint256[]" },
          { name: "amounts", type: "uint256[]" },
          { name: "from", type: "address" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: struct(args.key), amount0Min: args.amount0Min, amount1Min: args.amount1Min, ids: args.ids.map((i) => BigInt(i)), amounts: [...args.amounts], from: args.from, hookData: "0x" }],
  );
  const take = encodeAbiParameters(CURRENCY_PAIR_TO, [args.key.currency0, args.key.currency1, MSG_SENDER]);
  return modify(args.positionManager, [[ACTIONS.BIN_REMOVE_LIQUIDITY, remove], [ACTIONS.TAKE_PAIR, take]], args.deadline, 0n);
}

/** Each side's share per bin, summing to exactly 1e18. Bins below the active id hold only Y, above only X. */
export function uniformBins(binsPerSide: number): { deltaIds: number[]; distributionX: bigint[]; distributionY: bigint[] } {
  const ONE = 10n ** 18n;
  const deltaIds: number[] = [];
  for (let d = -binsPerSide; d <= binsPerSide; d++) deltaIds.push(d);
  const count = BigInt(binsPerSide + 1);
  const each = ONE / count;
  const dust = ONE - each * count;
  /* The active bin takes the rounding dust on both sides. */
  return {
    deltaIds,
    distributionX: deltaIds.map((d) => (d < 0 ? 0n : d === 0 ? each + dust : each)),
    distributionY: deltaIds.map((d) => (d > 0 ? 0n : d === 0 ? each + dust : each)),
  };
}

/** The id the Bin position manager mints for one bin of one pool: `keccak256(abi.encode(poolId, binId))`. */
export function binPositionId(poolId: Hex, binId: number): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, BigInt(binId)])));
}

const Q96 = 1n << 96n;

/** `LiquidityAmounts.getLiquidityForAmounts`: the most liquidity these amounts buy in the range. */
export function liquidityForAmounts(sqrtPrice: bigint, sqrtLower: bigint, sqrtUpper: bigint, amount0: bigint, amount1: bigint): bigint {
  const for0 = (a: bigint, b: bigint): bigint => (amount0 * ((a * b) / Q96)) / (b - a);
  const for1 = (a: bigint, b: bigint): bigint => (amount1 * Q96) / (b - a);
  if (sqrtPrice <= sqrtLower) return for0(sqrtLower, sqrtUpper);
  if (sqrtPrice >= sqrtUpper) return for1(sqrtLower, sqrtUpper);
  const l0 = for0(sqrtPrice, sqrtUpper);
  const l1 = for1(sqrtLower, sqrtPrice);
  return l0 < l1 ? l0 : l1;
}
