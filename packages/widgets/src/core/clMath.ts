// SPDX-License-Identifier: MIT
/**
 * Concentrated-liquidity arithmetic, transcribed from the pool's own formulas.
 *
 * The live adapter uses this to turn desired amounts into a liquidity figure
 * (`quoteAddLiquidity`), a position's liquidity back into the amounts a
 * withdrawal returns (`quoteRemoveLiquidity`, `listPositions`) and its
 * uncollected fees. Nothing here estimates: a wrong constant would render a
 * number that LOOKS real and is not, so the constants are copied verbatim from
 * `TickMath.sol` and {@link assertTickMathSelfConsistent} checks the
 * transcription against values the chain publishes.
 *
 * Rounding directions match the contracts: an add rounds **up** (the pool takes
 * one wei more), a remove rounds **down** (it returns one wei less).
 *
 * - `TickMath.getSqrtRatioAtTick`
 * - `SqrtPriceMath.getAmount{0,1}Delta`
 * - `LiquidityAmounts.getLiquidityForAmounts`
 * - `Tick.getFeeGrowthInside` + `CLPosition.update` (fees owed)
 */

/** 2^96. */
export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;
const U256_MOD = 1n << 256n;

/** Lowest tick a pool can quote. */
export const MIN_TICK = -887272;
/** Highest tick a pool can quote. */
export const MAX_TICK = 887272;

const RATIOS: readonly [bigint, bigint][] = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/** `TickMath.getSqrtRatioAtTick`. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick out of range: ${tick}`);
  }
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  for (const [bit, factor] of RATIOS) {
    if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Downcast from Q128.128 to Q96.64, rounding up.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  return product % denominator === 0n ? product / denominator : product / denominator + 1n;
}

function divRoundingUp(a: bigint, b: bigint): bigint {
  return a % b === 0n ? a / b : a / b + 1n;
}

function sorted(a: bigint, b: bigint): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

/** `SqrtPriceMath.getAmount0Delta`. */
export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
  const numerator1 = liquidity << 96n;
  const numerator2 = upper - lower;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, upper), lower)
    : (numerator1 * numerator2) / upper / lower;
}

/** `SqrtPriceMath.getAmount1Delta`. */
export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
  return roundUp
    ? mulDivRoundingUp(liquidity, upper - lower, Q96)
    : (liquidity * (upper - lower)) / Q96;
}

/** `LiquidityAmounts.getLiquidityForAmount0`. */
export function getLiquidityForAmount0(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
): bigint {
  const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
  const intermediate = (lower * upper) / Q96;
  return (amount0 * intermediate) / (upper - lower);
}

/** `LiquidityAmounts.getLiquidityForAmount1`. */
export function getLiquidityForAmount1(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount1: bigint,
): bigint {
  const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
  return (amount1 * Q96) / (upper - lower);
}

/** `LiquidityAmounts.getLiquidityForAmounts`. */
export function getLiquidityForAmounts(
  sqrtRatioX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
  if (sqrtRatioX96 <= lower) return getLiquidityForAmount0(lower, upper, amount0);
  if (sqrtRatioX96 < upper) {
    const liquidity0 = getLiquidityForAmount0(sqrtRatioX96, upper, amount0);
    const liquidity1 = getLiquidityForAmount1(lower, sqrtRatioX96, amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(lower, upper, amount1);
}

/**
 * Amounts the pool will move for a liquidity change spanning `sqrtRatioX96`.
 *
 * `adding` selects the rounding direction: the contracts round **towards the
 * pool** either way, so an add costs one wei more and a remove returns one wei
 * less than the unrounded figure.
 */
export function amountsForLiquidity(
  sqrtRatioX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  adding: boolean,
): { amount0: bigint; amount1: bigint } {
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  if (sqrtRatioX96 <= lower) {
    return { amount0: getAmount0Delta(lower, upper, liquidity, adding), amount1: 0n };
  }
  if (sqrtRatioX96 < upper) {
    return {
      amount0: getAmount0Delta(sqrtRatioX96, upper, liquidity, adding),
      amount1: getAmount1Delta(lower, sqrtRatioX96, liquidity, adding),
    };
  }
  return { amount0: 0n, amount1: getAmount1Delta(lower, upper, liquidity, adding) };
}

/** Which tokens a CL range takes at the pool's current price. */
export type ClRangeSide = "both" | "token0-only" | "token1-only";

/**
 * Which tokens a deposit into `[tickLower, tickUpper)` takes at `sqrtRatioX96`:
 * a range entirely above the price holds only token0, one entirely below only
 * token1, and a range spanning the price holds both in a ratio the price fixes.
 */
export function clRangeSide(sqrtRatioX96: bigint, tickLower: number, tickUpper: number): ClRangeSide {
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  if (sqrtRatioX96 <= lower) return "token0-only";
  if (sqrtRatioX96 >= upper) return "token1-only";
  return "both";
}

/**
 * The other token's amount for a one-sided entry into an in-range CL
 * position: the liquidity the entered amount buys, and what that liquidity
 * costs of the other token (rounded up, as the position manager settles an
 * add). `null` when the range takes only one token - the other side is then
 * zero by construction, and no amount of it can be deposited.
 */
export function pairedAmountForRange(
  sqrtRatioX96: bigint,
  tickLower: number,
  tickUpper: number,
  entered: "token0" | "token1",
  amount: bigint,
): bigint | null {
  if (clRangeSide(sqrtRatioX96, tickLower, tickUpper) !== "both") return null;
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  if (amount <= 0n) return 0n;
  if (entered === "token0") {
    const liquidity = getLiquidityForAmount0(sqrtRatioX96, upper, amount);
    return getAmount1Delta(lower, sqrtRatioX96, liquidity, true);
  }
  const liquidity = getLiquidityForAmount1(lower, sqrtRatioX96, amount);
  return getAmount0Delta(sqrtRatioX96, upper, liquidity, true);
}

/** Wrap to uint256, reproducing Solidity `unchecked` subtraction. */
const u256 = (v: bigint): bigint => ((v % U256_MOD) + U256_MOD) % U256_MOD;

/** Fee growth recorded on one initialised tick (`Tick.Info`). */
export interface TickFeeGrowth {
  readonly feeGrowthOutside0X128: bigint;
  readonly feeGrowthOutside1X128: bigint;
}

/**
 * Fees a position has earned since it was last touched, exactly as
 * `CLPosition.update` credits them on the next `modifyLiquidity`.
 *
 * All subtractions wrap at 2^256 on purpose: the pool's own arithmetic is
 * `unchecked`, and fee-growth values are only meaningful modulo 2^256.
 */
export function uncollectedFees(args: {
  readonly liquidity: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly currentTick: number;
  readonly feeGrowthGlobal0X128: bigint;
  readonly feeGrowthGlobal1X128: bigint;
  readonly lower: TickFeeGrowth;
  readonly upper: TickFeeGrowth;
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside1LastX128: bigint;
}): { fees0: bigint; fees1: bigint } {
  const { currentTick, tickLower, tickUpper, lower, upper } = args;
  const g0 = args.feeGrowthGlobal0X128;
  const g1 = args.feeGrowthGlobal1X128;
  const below0 = currentTick >= tickLower ? lower.feeGrowthOutside0X128 : u256(g0 - lower.feeGrowthOutside0X128);
  const below1 = currentTick >= tickLower ? lower.feeGrowthOutside1X128 : u256(g1 - lower.feeGrowthOutside1X128);
  const above0 = currentTick < tickUpper ? upper.feeGrowthOutside0X128 : u256(g0 - upper.feeGrowthOutside0X128);
  const above1 = currentTick < tickUpper ? upper.feeGrowthOutside1X128 : u256(g1 - upper.feeGrowthOutside1X128);
  const inside0 = u256(g0 - below0 - above0);
  const inside1 = u256(g1 - below1 - above1);
  return {
    fees0: (u256(inside0 - args.feeGrowthInside0LastX128) * args.liquidity) / Q128,
    fees1: (u256(inside1 - args.feeGrowthInside1LastX128) * args.liquidity) / Q128,
  };
}

/**
 * Checks this transcription against values the chain publishes.
 *
 * @throws when the bit-magic constants have been corrupted.
 */
export function assertTickMathSelfConsistent(): void {
  if (getSqrtRatioAtTick(0) !== Q96) {
    throw new Error(`getSqrtRatioAtTick(0) is ${getSqrtRatioAtTick(0)}, expected 2^96 (${Q96})`);
  }
  // getSqrtRatioAtTick(MAX_TICK), published as TickMath.MAX_SQRT_RATIO.
  const maxSqrtRatio = 1461446703485210103287273052203988822378723970342n;
  if (getSqrtRatioAtTick(MAX_TICK) !== maxSqrtRatio) {
    throw new Error(
      `getSqrtRatioAtTick(MAX_TICK) is ${getSqrtRatioAtTick(MAX_TICK)}, expected ${maxSqrtRatio}`,
    );
  }
  const minSqrtRatio = 4295128739n;
  if (getSqrtRatioAtTick(MIN_TICK) !== minSqrtRatio) {
    throw new Error(
      `getSqrtRatioAtTick(MIN_TICK) is ${getSqrtRatioAtTick(MIN_TICK)}, expected ${minSqrtRatio}`,
    );
  }
}
