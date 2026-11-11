// SPDX-License-Identifier: MIT
/**
 * Limit orders and DCA: `GullyCoreRangeOrders` and `GullyCoreDCA`.
 *
 * LIMIT ORDERS. A sell of currency0 rests ABOVE the price as liquidity in one
 * tick-spacing `[tickLower, tickLower + tickSpacing)`; it is filled once the pool's
 * tick reaches `tickUpper`. A sell of currency1 rests BELOW the price and is filled
 * once the tick drops under `tickLower`. Orders at the same pool, level and side
 * share one position (an EPOCH); anyone may `execute` a crossed epoch and earns the
 * tips its makers escrowed; each maker then `withdraw`s. A fill can be MISSED: if
 * price crosses and comes back before anyone executes, the position converts back.
 *
 * DCA. A plan escrows `slices x (amountPerSlice + tipPerSlice)` of the input
 * currency and swaps `amountPerSlice` exact-input through ONE pool the user names,
 * every `interval` seconds, whenever anyone executes a due slice. A slice whose
 * net output is below `amountPerSlice x minPriceX96 / 2^96` reverts and waits.
 *
 * Independently authored against the contracts' compiled ABI (`./abi.ts`) and
 * their documented rules (`packages/orders/src/*.sol`, GPL). Validation here
 * restates the contracts' own checks so a wallet is never asked to sign a call
 * the contract will refuse; the contract stays the authority.
 *
 * NOTHING HERE IS DEPLOYED. `GullyCoreDeployment.rangeOrders` and `.dca` are
 * `null` on every chain until the contracts are deployed and read back.
 *
 * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
 * The API may change in a minor release before the first deployment.
 */

import {
  encodeFunctionData,
  getAbiItem,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { isNativeCurrency } from "../types/currency.js";
import { getHooksRegistrationBitmap, getTickSpacing } from "../types/parameters.js";
import type { PoolKey } from "../types/poolKey.js";
import { MAX_TICK, MIN_TICK } from "../launchpad/tickMath.js";
import { DCA_ABI, RANGE_ORDERS_ABI } from "./abi.js";

export { DCA_ABI, RANGE_ORDERS_ABI };

/* ---------------------------------------------------------- constants --- */

/** `OrdersFeeBase.MAX_INTEGRATOR_BPS`: an integrator's own share, frozen per order or plan. */
export const ORDERS_MAX_INTEGRATOR_BPS = 10;
/** `OrdersFeeBase.ABSOLUTE_MAX_PROTOCOL_FEE_BPS`: compile-time ceiling of the protocol fee. */
export const ORDERS_ABSOLUTE_MAX_PROTOCOL_FEE_BPS = 50;
/** `GullyCoreDCA.MIN_INTERVAL` (seconds). */
export const DCA_MIN_INTERVAL = 60;
/** `GullyCoreDCA.MAX_SLICES`. */
export const DCA_MAX_SLICES = 10_000;
/**
 * `GullyCoreRangeOrders.FORBIDDEN_HOOK_BITS`: before/after remove liquidity (4, 5) and
 * the add/remove returns-delta bits (12, 13). A pool whose hook registers any of them
 * could block or tax a removal and trap an order, so the contract refuses it.
 */
export const RANGE_ORDERS_FORBIDDEN_HOOK_BITS = (1 << 4) | (1 << 5) | (1 << 12) | (1 << 13);
/**
 * The hook bitmaps of every Gully Core CL launch-guard generation (`0x0041`, `0x08C1`,
 * `0x0CC1`). `GullyCoreRangeOrders.place` refuses a key that carries one of them, and a key
 * whose hook is a launch guard it was told about at construction (`isLaunchGuard`):
 * limit orders are not available on launch pools.
 */
export const RANGE_ORDERS_LAUNCH_GUARD_BITMAPS: readonly number[] = [0x0041, 0x08c1, 0x0cc1];

/**
 * Whether `GullyCoreRangeOrders` refuses this key as a launch pool. `launchGuards`, when
 * given, are the chain's CL launch-guard addresses (the address book's
 * `clLaunchGuardHook`); the bitmap rule needs no list. The contract's own
 * `isLaunchPool(key)` is the authority.
 */
export function isLaunchPoolKey(key: PoolKey, launchGuards: readonly Address[] = []): boolean {
  if (RANGE_ORDERS_LAUNCH_GUARD_BITMAPS.includes(getHooksRegistrationBitmap(key.parameters))) return true;
  const hook = key.hooks.toLowerCase();
  return launchGuards.some((g) => g.toLowerCase() === hook);
}

const Q96 = 1n << 96n;
const MAX_UINT32 = 2n ** 32n - 1n;
const MAX_UINT64 = 2n ** 64n - 1n;
const MAX_UINT128 = 2n ** 128n - 1n;
const MAX_INT128 = 2n ** 127n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;
const BPS = 10_000n;

/** A call ready for a wallet: target, calldata and the exact native value to attach. */
export interface OrdersTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** Thrown by every builder for an input the contract would refuse. `field` names the input. */
export class OrdersInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "OrdersInputError";
    this.field = field;
  }
}

/**
 * The typed refusal for a limit order on a launch pool (the contract's
 * `LaunchPoolNotSupported`). A subclass, so `instanceof OrdersInputError` still holds.
 */
export class LimitOrdersNotOnLaunchPoolsError extends OrdersInputError {
  readonly hook: Address;
  constructor(hook: Address) {
    super("key", "Limit orders are not available on launch pools.");
    this.name = "LimitOrdersNotOnLaunchPoolsError";
    this.hook = hook;
  }
}

const fail = (field: string, message: string): never => {
  throw new OrdersInputError(field, message);
};

function assertAddressField(a: Address | undefined, field: string): void {
  if (a === undefined || !/^0x[0-9a-fA-F]{40}$/.test(a)) fail(field, `${field} is not an address.`);
}

function assertIntegrator(integrator: Address | undefined, integratorBps: number | undefined): { integrator: Address; integratorBps: number } {
  const bps = integratorBps ?? 0;
  if (!Number.isInteger(bps) || bps < 0) fail("integratorBps", "integratorBps must be a whole number of basis points, 0 or more.");
  if (bps > ORDERS_MAX_INTEGRATOR_BPS) {
    fail("integratorBps", `integratorBps is ${bps}; the contract caps an integrator's share at ${ORDERS_MAX_INTEGRATOR_BPS} bps.`);
  }
  const who = integrator ?? zeroAddress;
  assertAddressField(who, "integrator");
  if (bps !== 0 && who.toLowerCase() === zeroAddress) fail("integrator", "A non-zero integrator share needs an integrator address.");
  return { integrator: who, integratorBps: bps };
}

function assertUint(v: bigint, max: bigint, field: string, what: string): void {
  if (typeof v !== "bigint" || v < 0n || v > max) fail(field, `${field} must be ${what}.`);
}

function nonZeroRecipient(to: Address, field = "to"): void {
  assertAddressField(to, field);
  if (to.toLowerCase() === zeroAddress) fail(field, `${field} cannot be the zero address.`);
}

/* ----------------------------------------------------------- tick math --- */

const floorTo = (t: number, s: number): number => Math.floor(t / s) * s + 0; // `+ 0` turns -0 into 0
const ceilTo = (t: number, s: number): number => Math.ceil(t / s) * s + 0;

export type SnapResult = { readonly tickLower: number; readonly tickUpper: number } | { readonly error: string };

/**
 * The order level for a target tick: one tick-spacing range on the grid, snapped AWAY
 * from the current price so the whole range sits at or beyond the target (a sell of
 * currency0 never fills below it, a sell of currency1 never above it), and valid for
 * `place`: the contract requires `currentTick < tickLower` to sell currency0 and
 * `currentTick >= tickUpper` to sell currency1. A target inside the spacing that holds
 * the current tick moves to the first valid level. A target on the wrong side of the
 * price is an error: that is a market order, not a limit order.
 */
export function snapLimitLevel(args: {
  readonly targetTick: number;
  readonly tickSpacing: number;
  readonly currentTick: number;
  readonly sellCurrency0: boolean;
}): SnapResult {
  const { targetTick: t, tickSpacing: s, currentTick: cur, sellCurrency0 } = args;
  if (!Number.isInteger(s) || s < 1) return { error: `tickSpacing must be a positive integer, got ${s}.` };
  if (!Number.isInteger(t) || !Number.isInteger(cur)) return { error: "Ticks must be integers." };
  let lower: number;
  if (sellCurrency0) {
    if (t < cur) return { error: "The target is below the current price; a sell of currency0 rests above it." };
    lower = ceilTo(t, s);
    if (lower <= cur) lower = floorTo(cur, s) + s;
  } else {
    if (t > cur) return { error: "The target is above the current price; a sell of currency1 rests below it." };
    let upper = floorTo(t, s);
    if (upper > cur) upper = floorTo(cur, s);
    lower = upper - s;
  }
  const upper = lower + s;
  if (lower < MIN_TICK || upper > MAX_TICK) return { error: `The level [${lower}, ${upper}) is outside [${MIN_TICK}, ${MAX_TICK}].` };
  return { tickLower: lower, tickUpper: upper };
}

/**
 * The price of currency0 in currency1, in whole units, at `tick`: `1.0001^tick x
 * 10^(decimals0 - decimals1)`. A float, for display only; never feed it back into a
 * contract argument.
 */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/**
 * The greatest tick whose price (currency0 in currency1, whole units) is at or below
 * `price`. Throws for a price that is not positive and finite, or outside the tick range.
 * Snap the result with {@link snapLimitLevel} before using it as a level.
 */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  if (!Number.isFinite(price) || price <= 0) throw new RangeError(`price must be positive and finite, got ${price}`);
  const raw = Math.log(price) - (decimals0 - decimals1) * Math.LN10;
  const exact = raw / Math.log(1.0001);
  const nearest = Math.round(exact);
  // Float noise around an exact tick (tickToPrice(t) back to t) must not drop one tick.
  const tick = Math.abs(exact - nearest) < 1e-7 ? nearest : Math.floor(exact);
  if (tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`price ${price} is outside the tick range`);
  return tick + 0;
}

/* --------------------------------------------------------- price bound --- */

/** `GullyCoreDCA`'s own `minOutPerSlice`: `floor(amountPerSlice x minPriceX96 / 2^96)`. */
export function minOutFromPriceX96(amountPerSlice: bigint, minPriceX96: bigint): bigint {
  return (amountPerSlice * minPriceX96) / Q96;
}

/**
 * The least `minPriceX96` (net output per unit of input, Q96) whose contract-computed
 * minimum is at least `minOutPerSlice`: `ceil(minOut x 2^96 / amountPerSlice)`. Exact.
 * Throws for a zero bound, which the contract refuses (and which would leave every slice
 * unprotected).
 */
export function minPriceX96FromBound(args: { readonly amountPerSlice: bigint; readonly minOutPerSlice: bigint }): bigint {
  const { amountPerSlice: a, minOutPerSlice: m } = args;
  if (a <= 0n) fail("amountPerSlice", "amountPerSlice must be above zero.");
  if (m <= 0n) fail("minOutPerSlice", "minOutPerSlice must be above zero: the contract refuses a zero bound.");
  const p = (m * Q96 + a - 1n) / a;
  if (p > MAX_UINT256) fail("minOutPerSlice", "The bound does not fit a uint256.");
  return p;
}

export type SpotPrice =
  /** Output per unit of input in RAW units, as a ratio (e.g. from a quote: out / in). */
  | { readonly spotOutPerIn: { readonly num: bigint; readonly den: bigint }; readonly toleranceBps: number }
  /** The pool's `sqrtPriceX96` and the swap direction (`zeroForOne`: currency0 in, currency1 out). */
  | { readonly sqrtPriceX96: bigint; readonly zeroForOne: boolean; readonly toleranceBps: number };

/**
 * A proposed `minPriceX96` from spot: the spot output per unit of input, less
 * `toleranceBps`, rounded down. Exact bigint arithmetic.
 *
 * Spot is the marginal price before any fee. The bound is NET of the protocol and
 * integrator fees, so `toleranceBps` must cover the pool's LP fee, the protocol fee,
 * the integrator share, price impact AND the price drift the user is willing to accept
 * between slices. It is the whole of a slice's sandwich protection: a slice runs at a
 * predictable time, so a searcher can move price to the bound first.
 */
export function minPriceX96FromSpot(args: SpotPrice): bigint {
  const tol = args.toleranceBps;
  if (!Number.isInteger(tol) || tol < 0 || tol >= 10_000) fail("toleranceBps", "toleranceBps must be a whole number from 0 to 9999.");
  const keep = BPS - BigInt(tol);
  let num: bigint;
  let den: bigint;
  if ("spotOutPerIn" in args) {
    num = args.spotOutPerIn.num;
    den = args.spotOutPerIn.den;
    if (num <= 0n || den <= 0n) fail("spotOutPerIn", "spotOutPerIn needs a positive numerator and denominator.");
    num *= Q96;
  } else {
    const s = args.sqrtPriceX96;
    if (s <= 0n || s >= 2n ** 160n) fail("sqrtPriceX96", "sqrtPriceX96 must be a positive uint160.");
    // price0in1 = s^2 / 2^192.  zeroForOne: out/in = s^2/2^192 -> Q96: s^2/2^96.  else: 2^192/s^2 -> Q96: 2^288/s^2.
    if (args.zeroForOne) {
      num = s * s;
      den = Q96;
    } else {
      num = 2n ** 288n;
      den = s * s;
    }
  }
  const p = (num * keep) / (den * BPS);
  if (p === 0n) fail("toleranceBps", "The bound rounds to zero at this price; the contract refuses a zero bound.");
  if (p > MAX_UINT256) fail("spotOutPerIn", "The bound does not fit a uint256.");
  return p;
}

/* ------------------------------------------------------ limit builders --- */

export interface PlaceLimitOrderArgs {
  /** The `GullyCoreRangeOrders` contract. */
  readonly address: Address;
  /** A CL pool key on Gully Core's CL pool manager. */
  readonly key: PoolKey;
  /** The level, on the pool's tick-spacing grid (see {@link snapLimitLevel}). */
  readonly tickLower: number;
  /** `true`: sell currency0 (rests above price). `false`: sell currency1 (rests below). */
  readonly zeroForOne: boolean;
  /** Raw units of the sold currency. Any rounding remainder is refunded in the same call. */
  readonly amountIn: bigint;
  /** Raw units of the sold currency escrowed for whoever executes the fill. Default 0. */
  readonly tip?: bigint;
  readonly integrator?: Address;
  readonly integratorBps?: number;
  /** When given, refuse a level already in range (the contract's `OrderInRange`). */
  readonly currentTick?: number;
  /** When given, refuse a key on any other pool manager (the contract's `WrongPoolManager`). */
  readonly clPoolManager?: Address;
  /** The chain's CL launch guards, for the address half of the launch-pool refusal. */
  readonly launchGuards?: readonly Address[];
}

/**
 * `place(PlaceParams)`. For a native sold currency `value = amountIn + tip` (the contract
 * requires exactly that); otherwise 0 and the wallet must have approved `amountIn + tip`.
 */
export function buildPlaceLimitOrder(a: PlaceLimitOrderArgs): OrdersTx {
  assertAddressField(a.address, "address");
  const key = a.key;
  if (a.clPoolManager !== undefined && key.poolManager.toLowerCase() !== a.clPoolManager.toLowerCase()) {
    fail("key", "The key's pool manager is not Gully Core's CL pool manager.");
  }
  const bitmap = getHooksRegistrationBitmap(key.parameters);
  if ((bitmap & RANGE_ORDERS_FORBIDDEN_HOOK_BITS) !== 0) {
    fail("key", `This pool's hook (bitmap 0x${bitmap.toString(16)}) can block or tax a removal, so an order there could be trapped. The contract refuses it.`);
  }
  if (isLaunchPoolKey(key, a.launchGuards)) throw new LimitOrdersNotOnLaunchPoolsError(key.hooks);
  if (typeof a.amountIn !== "bigint" || a.amountIn <= 0n) fail("amountIn", "amountIn must be above zero.");
  const tip = a.tip ?? 0n;
  assertUint(tip, MAX_UINT128, "tip", "a uint128");
  if (a.amountIn + tip > MAX_UINT256) fail("amountIn", "amountIn + tip does not fit a uint256.");
  const { integrator, integratorBps } = assertIntegrator(a.integrator, a.integratorBps);
  const spacing = getTickSpacing(key.parameters);
  if (spacing < 1) fail("key", "The key carries no positive tick spacing; is it a CL key?");
  if (!Number.isInteger(a.tickLower) || a.tickLower % spacing !== 0) {
    fail("tickLower", `tickLower ${a.tickLower} is not a multiple of the pool's tick spacing ${spacing}.`);
  }
  if (a.tickLower < MIN_TICK || a.tickLower + spacing > MAX_TICK) fail("tickLower", `tickLower ${a.tickLower} is out of bounds.`);
  if (a.currentTick !== undefined) {
    const inRange = a.zeroForOne ? a.currentTick >= a.tickLower : a.currentTick < a.tickLower + spacing;
    if (inRange) {
      fail("tickLower", a.zeroForOne
        ? "The level is at or below the current price; a sell of currency0 must rest above it."
        : "The level is at or above the current price; a sell of currency1 must rest below it.");
    }
  }
  const sold = a.zeroForOne ? key.currency0 : key.currency1;
  const data = encodeFunctionData({
    abi: RANGE_ORDERS_ABI,
    functionName: "place",
    args: [
      {
        key: {
          currency0: key.currency0,
          currency1: key.currency1,
          hooks: key.hooks,
          poolManager: key.poolManager,
          fee: key.fee,
          parameters: key.parameters,
        },
        tickLower: a.tickLower,
        zeroForOne: a.zeroForOne,
        amountIn: a.amountIn,
        tip,
        integrator,
        integratorBps,
      },
    ],
  });
  return { to: a.address, data, value: isNativeCurrency(sold) ? a.amountIn + tip : 0n };
}

function assertId(id: bigint, field: string): void {
  if (typeof id !== "bigint" || id <= 0n || id > MAX_UINT256) fail(field, `${field} must be a positive id.`);
}

/** `cancel(orderId, to)`: the maker only, before the fill. Everything the order holds goes to `to`. */
export function buildCancelLimitOrder(a: { readonly address: Address; readonly orderId: bigint; readonly to: Address }): OrdersTx {
  assertAddressField(a.address, "address");
  assertId(a.orderId, "orderId");
  nonZeroRecipient(a.to);
  return { to: a.address, data: encodeFunctionData({ abi: RANGE_ORDERS_ABI, functionName: "cancel", args: [a.orderId, a.to] }), value: 0n };
}

/** `withdraw(orderId, to)`: the maker only, after the fill. Proceeds net of the frozen fees go to `to`. */
export function buildWithdrawLimitOrder(a: { readonly address: Address; readonly orderId: bigint; readonly to: Address }): OrdersTx {
  assertAddressField(a.address, "address");
  assertId(a.orderId, "orderId");
  nonZeroRecipient(a.to);
  return { to: a.address, data: encodeFunctionData({ abi: RANGE_ORDERS_ABI, functionName: "withdraw", args: [a.orderId, a.to] }), value: 0n };
}

/** `execute(epochId)`: anyone; reverts unless the epoch is crossed. Pays the caller the epoch's tips. */
export function buildExecuteEpoch(a: { readonly address: Address; readonly epochId: bigint }): OrdersTx {
  assertAddressField(a.address, "address");
  assertId(a.epochId, "epochId");
  return { to: a.address, data: encodeFunctionData({ abi: RANGE_ORDERS_ABI, functionName: "execute", args: [a.epochId] }), value: 0n };
}

/** `executeMany(epochIds)`: anyone; fills every crossed epoch in the list and skips the rest. */
export function buildExecuteEpochs(a: { readonly address: Address; readonly epochIds: readonly bigint[] }): OrdersTx {
  assertAddressField(a.address, "address");
  if (a.epochIds.length === 0) fail("epochIds", "epochIds is empty.");
  const seen = new Set<bigint>();
  for (const id of a.epochIds) {
    assertId(id, "epochIds");
    if (seen.has(id)) fail("epochIds", `epoch ${id} is listed twice.`);
    seen.add(id);
  }
  return { to: a.address, data: encodeFunctionData({ abi: RANGE_ORDERS_ABI, functionName: "executeMany", args: [a.epochIds] }), value: 0n };
}

/* -------------------------------------------------------- DCA builders --- */

export interface CreateDcaArgs {
  /** The `GullyCoreDCA` contract. */
  readonly address: Address;
  /** A CL or Bin pool key on Gully Core's pool managers. Fixed for the life of the plan. */
  readonly key: PoolKey;
  /** `true`: currency0 in, currency1 out. */
  readonly zeroForOne: boolean;
  /** Raw input units per slice. */
  readonly amountPerSlice: bigint;
  /** Raw input units per slice paid to whoever executes it. Default 0. */
  readonly tipPerSlice?: bigint;
  readonly slices: number;
  /** Seconds between slices, at least {@link DCA_MIN_INTERVAL}. */
  readonly interval: number;
  /** Unix seconds of the first slice; 0 or absent = the block the plan is created in. */
  readonly startAt?: bigint;
  /** Unix seconds after which no slice runs. Must be after `startAt`. */
  readonly deadline: bigint;
  /** Least net output per unit of input, Q96 (see {@link minPriceX96FromBound}, {@link minPriceX96FromSpot}). */
  readonly minPriceX96: bigint;
  /** Who receives every slice's output. */
  readonly recipient: Address;
  readonly integrator?: Address;
  readonly integratorBps?: number;
  /** Unix seconds now, when known: refuses a `startAt` in the past and a deadline that cannot fit the slices. */
  readonly now?: bigint;
  /** When given, refuse a key on any other pool manager (the contract's `WrongPoolManager`). */
  readonly poolManagers?: readonly Address[];
}

/** The escrow a plan takes: `slices x (amountPerSlice + tipPerSlice)`. */
export function dcaEscrow(a: { readonly slices: number; readonly amountPerSlice: bigint; readonly tipPerSlice?: bigint }): bigint {
  return BigInt(a.slices) * (a.amountPerSlice + (a.tipPerSlice ?? 0n));
}

/**
 * `create(CreateParams)`. For a native input `value` is the whole escrow,
 * `slices x (amountPerSlice + tipPerSlice)`; otherwise 0 and the wallet must have
 * approved that escrow.
 */
export function buildCreateDca(a: CreateDcaArgs): OrdersTx {
  assertAddressField(a.address, "address");
  const key = a.key;
  if (a.poolManagers !== undefined && !a.poolManagers.some((m) => m.toLowerCase() === key.poolManager.toLowerCase())) {
    fail("key", "The key's pool manager is not one of Gully Core's pool managers.");
  }
  if (typeof a.amountPerSlice !== "bigint" || a.amountPerSlice <= 0n) fail("amountPerSlice", "amountPerSlice must be above zero.");
  if (a.amountPerSlice > MAX_INT128) fail("amountPerSlice", "amountPerSlice must fit an int128.");
  const tip = a.tipPerSlice ?? 0n;
  assertUint(tip, MAX_UINT128, "tipPerSlice", "a uint128");
  if (typeof a.minPriceX96 !== "bigint" || a.minPriceX96 <= 0n) fail("minPriceX96", "minPriceX96 must be above zero: the contract refuses a zero bound.");
  if (a.minPriceX96 > MAX_UINT256) fail("minPriceX96", "minPriceX96 must fit a uint256.");
  nonZeroRecipient(a.recipient, "recipient");
  if (!Number.isInteger(a.slices) || a.slices < 1 || a.slices > DCA_MAX_SLICES) fail("slices", `slices must be a whole number from 1 to ${DCA_MAX_SLICES}.`);
  if (!Number.isInteger(a.interval) || a.interval < DCA_MIN_INTERVAL || BigInt(a.interval) > MAX_UINT32) {
    fail("interval", `interval must be a whole number of seconds, at least ${DCA_MIN_INTERVAL}.`);
  }
  const startAt = a.startAt ?? 0n;
  assertUint(startAt, MAX_UINT64, "startAt", "a uint64 (0 = now)");
  assertUint(a.deadline, MAX_UINT64, "deadline", "a uint64");
  const start = startAt === 0n ? a.now : startAt;
  if (a.now !== undefined && startAt !== 0n && startAt < a.now) fail("startAt", "startAt is in the past.");
  if (start !== undefined && a.deadline <= start) fail("deadline", "The deadline must be after the first slice.");
  if (start === undefined && a.deadline === 0n) fail("deadline", "The deadline must be after the first slice.");
  if (start !== undefined) {
    const last = start + BigInt(a.interval) * BigInt(a.slices - 1);
    if (last > a.deadline) {
      fail("deadline", `The deadline falls before the last slice could run (${a.slices} slices every ${a.interval}s from ${start} end at ${last}); the rest would be refunded only on cancel.`);
    }
  }
  const { integrator, integratorBps } = assertIntegrator(a.integrator, a.integratorBps);
  const escrow = dcaEscrow({ slices: a.slices, amountPerSlice: a.amountPerSlice, tipPerSlice: tip });
  const input = a.zeroForOne ? key.currency0 : key.currency1;
  const data = encodeFunctionData({
    abi: DCA_ABI,
    functionName: "create",
    args: [
      {
        key: {
          currency0: key.currency0,
          currency1: key.currency1,
          hooks: key.hooks,
          poolManager: key.poolManager,
          fee: key.fee,
          parameters: key.parameters,
        },
        zeroForOne: a.zeroForOne,
        amountPerSlice: a.amountPerSlice,
        tipPerSlice: tip,
        slices: a.slices,
        interval: a.interval,
        startAt,
        deadline: a.deadline,
        minPriceX96: a.minPriceX96,
        recipient: a.recipient,
        integrator,
        integratorBps,
      },
    ],
  });
  return { to: a.address, data, value: isNativeCurrency(input) ? escrow : 0n };
}

/** `cancel(planId, to)`: the plan's owner, any time. Every unit of remaining escrow goes to `to`. */
export function buildCancelDca(a: { readonly address: Address; readonly planId: bigint; readonly to: Address }): OrdersTx {
  assertAddressField(a.address, "address");
  assertId(a.planId, "planId");
  nonZeroRecipient(a.to);
  return { to: a.address, data: encodeFunctionData({ abi: DCA_ABI, functionName: "cancel", args: [a.planId, a.to] }), value: 0n };
}

/** `execute(planId)`: anyone, when the slice is due. Pays the caller the slice's tip. */
export function buildExecuteDcaSlice(a: { readonly address: Address; readonly planId: bigint }): OrdersTx {
  assertAddressField(a.address, "address");
  assertId(a.planId, "planId");
  return { to: a.address, data: encodeFunctionData({ abi: DCA_ABI, functionName: "execute", args: [a.planId] }), value: 0n };
}

/* --------------------------------------------------------------- reads --- */

/** `GullyCoreRangeOrders.getEpoch`, as stored. */
export interface EpochState {
  readonly epochId: bigint;
  readonly poolId: Hex;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** `true`: the epoch sells currency0. */
  readonly zeroForOne: boolean;
  readonly filled: boolean;
  /** Before the fill: the position's liquidity. After: the liquidity not yet withdrawn. */
  readonly liquidity: bigint;
  readonly liquidityAtFill: bigint;
  /** Output-currency principal the fill produced. */
  readonly proceeds: bigint;
  readonly acc0X128: bigint;
  readonly acc1X128: bigint;
  readonly held0: bigint;
  readonly held1: bigint;
  /** Input-currency tips escrowed by the epoch's live orders. */
  readonly tipTotal: bigint;
}

/** `GullyCoreRangeOrders.getOrder`, as stored. */
export interface LimitOrderState {
  readonly orderId: bigint;
  readonly maker: Address;
  readonly epochId: bigint;
  readonly feeBps: number;
  readonly integratorBps: number;
  readonly integrator: Address;
  readonly liquidity: bigint;
  readonly tip: bigint;
  readonly snap0X128: bigint;
  readonly snap1X128: bigint;
}

type RawEpoch = Omit<EpochState, "epochId" | "tickLower" | "tickUpper"> & { readonly tickLower: number | bigint; readonly tickUpper: number | bigint };

/** The epoch, or `null` when no epoch has that id (its two ticks are equal, as the contract checks). */
export async function readEpoch(client: PublicClient, a: { readonly address: Address; readonly epochId: bigint }): Promise<EpochState | null> {
  const e = (await client.readContract({ address: a.address, abi: RANGE_ORDERS_ABI, functionName: "getEpoch", args: [a.epochId] })) as unknown as RawEpoch;
  const tickLower = Number(e.tickLower);
  const tickUpper = Number(e.tickUpper);
  if (tickLower === tickUpper) return null;
  return {
    epochId: a.epochId,
    poolId: e.poolId,
    tickLower,
    tickUpper,
    zeroForOne: e.zeroForOne,
    filled: e.filled,
    liquidity: e.liquidity,
    liquidityAtFill: e.liquidityAtFill,
    proceeds: e.proceeds,
    acc0X128: e.acc0X128,
    acc1X128: e.acc1X128,
    held0: e.held0,
    held1: e.held1,
    tipTotal: e.tipTotal,
  };
}

/** The order, or `null` when it never existed or was cancelled or withdrawn (the contract deletes it). */
export async function readOrder(client: PublicClient, a: { readonly address: Address; readonly orderId: bigint }): Promise<LimitOrderState | null> {
  const o = (await client.readContract({ address: a.address, abi: RANGE_ORDERS_ABI, functionName: "getOrder", args: [a.orderId] })) as unknown as Omit<
    LimitOrderState,
    "orderId" | "epochId" | "feeBps" | "integratorBps"
  > & { readonly epochId: bigint; readonly feeBps: number | bigint; readonly integratorBps: number | bigint };
  if (o.maker.toLowerCase() === zeroAddress) return null;
  return {
    orderId: a.orderId,
    maker: o.maker,
    epochId: BigInt(o.epochId),
    feeBps: Number(o.feeBps),
    integratorBps: Number(o.integratorBps),
    integrator: o.integrator,
    liquidity: o.liquidity,
    tip: o.tip,
    snap0X128: o.snap0X128,
    snap1X128: o.snap1X128,
  };
}

/** `isCrossed(epochId)`: an unfilled, non-empty epoch whose level the pool's tick has crossed. */
export async function isEpochCrossed(client: PublicClient, a: { readonly address: Address; readonly epochId: bigint }): Promise<boolean> {
  return (await client.readContract({ address: a.address, abi: RANGE_ORDERS_ABI, functionName: "isCrossed", args: [a.epochId] })) as boolean;
}

/** Log scan options shared by the readers below. */
export interface LogScan {
  readonly address: Address;
  /** Start of the scan: the contract's deployment block (the `eth_getLogs` clock). */
  readonly fromBlock: bigint;
  /** Default: `latest`. */
  readonly toBlock?: bigint;
  /** Split the scan into requests of at most this many blocks (public endpoints cap the span). Default: one request. */
  readonly maxBlockRange?: bigint;
}

interface RawLog {
  readonly args: Record<string, unknown>;
  readonly blockNumber: bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: number | null;
}

async function scanLogs(client: PublicClient, scan: LogScan, event: AbiEvent, args?: Record<string, unknown>): Promise<RawLog[]> {
  const run = (fromBlock: bigint, toBlock: bigint | "latest") =>
    client.getLogs({ address: scan.address, event, ...(args ? { args } : {}), fromBlock, toBlock } as Parameters<PublicClient["getLogs"]>[0]) as unknown as Promise<RawLog[]>;
  if (scan.maxBlockRange === undefined) return run(scan.fromBlock, scan.toBlock ?? "latest");
  if (scan.maxBlockRange <= 0n) fail("maxBlockRange", "maxBlockRange must be at least 1.");
  const end = scan.toBlock ?? (await client.getBlockNumber());
  const out: RawLog[] = [];
  for (let from = scan.fromBlock; from <= end; from += scan.maxBlockRange) {
    const to = from + scan.maxBlockRange - 1n < end ? from + scan.maxBlockRange - 1n : end;
    out.push(...(await run(from, to)));
  }
  return out;
}

/** Reads run in bursts of this many (a batching transport folds each burst into few requests). */
const READ_BURST = 20;

async function mapBurst<T, R>(items: readonly T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_BURST) out.push(...(await Promise.all(items.slice(i, i + READ_BURST).map(fn))));
  return out;
}

const ev = (abi: typeof RANGE_ORDERS_ABI | typeof DCA_ABI, name: string): AbiEvent => getAbiItem({ abi: abi as never, name: name as never }) as unknown as AbiEvent;

export type MakerOrderStatus =
  /** Liquidity in the pool, waiting for price. */
  | "resting"
  /** The epoch was executed; the maker can `withdraw`. */
  | "filled"
  /** Cancelled or already withdrawn: the contract deleted it. */
  | "closed";

export interface MakerOrder {
  readonly orderId: bigint;
  readonly epochId: bigint;
  /** What `OrderPlaced` recorded. */
  readonly placed: {
    readonly amountIn: bigint;
    readonly liquidity: bigint;
    readonly tip: bigint;
    readonly feeBps: number;
    readonly integrator: Address;
    readonly integratorBps: number;
    readonly blockNumber: bigint | null;
    readonly transactionHash: Hex | null;
  };
  readonly status: MakerOrderStatus;
  /** Current state; `null` once closed. */
  readonly order: LimitOrderState | null;
  readonly epoch: EpochState | null;
}

/** Every order `maker` placed (from `OrderPlaced`, indexed by maker), each with its state now. */
export async function readMakerOrders(client: PublicClient, a: LogScan & { readonly maker: Address }): Promise<MakerOrder[]> {
  const logs = await scanLogs(client, a, ev(RANGE_ORDERS_ABI, "OrderPlaced"), { maker: a.maker });
  const epochCache = new Map<bigint, Promise<EpochState | null>>();
  const epochOf = (id: bigint) => {
    let p = epochCache.get(id);
    if (p === undefined) {
      p = readEpoch(client, { address: a.address, epochId: id });
      epochCache.set(id, p);
    }
    return p;
  };
  return mapBurst(logs, async (l) => {
    const g = l.args as {
      orderId: bigint;
      epochId: bigint;
      amountIn: bigint;
      liquidity: bigint;
      tip: bigint;
      feeBps: number;
      integrator: Address;
      integratorBps: number;
    };
    const [order, epoch] = await Promise.all([readOrder(client, { address: a.address, orderId: g.orderId }), epochOf(g.epochId)]);
    const status: MakerOrderStatus = order === null ? "closed" : epoch?.filled ? "filled" : "resting";
    return {
      orderId: g.orderId,
      epochId: g.epochId,
      placed: {
        amountIn: g.amountIn,
        liquidity: g.liquidity,
        tip: g.tip,
        feeBps: Number(g.feeBps),
        integrator: g.integrator,
        integratorBps: Number(g.integratorBps),
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
      },
      status,
      order,
      epoch,
    };
  });
}

/**
 * Every epoch (from `EpochOpened`) that is unfilled and still holds liquidity, i.e. one an
 * executor could fill once price crosses it. Use {@link isEpochCrossed} for which can be
 * filled now.
 */
export async function readOpenEpochs(client: PublicClient, a: LogScan): Promise<EpochState[]> {
  const logs = await scanLogs(client, a, ev(RANGE_ORDERS_ABI, "EpochOpened"));
  const ids = [...new Set(logs.map((l) => l.args["epochId"] as bigint))];
  const epochs = await mapBurst(ids, (id) => readEpoch(client, { address: a.address, epochId: id }));
  return epochs.filter((e): e is EpochState => e !== null && !e.filled && e.liquidity > 0n);
}

/** `GullyCoreDCA.getPlan`, as stored. */
export interface DcaPlanState {
  readonly planId: bigint;
  readonly owner: Address;
  readonly recipient: Address;
  readonly zeroForOne: boolean;
  readonly feeBps: number;
  readonly integratorBps: number;
  readonly integrator: Address;
  readonly interval: number;
  readonly slicesLeft: number;
  /** Unix seconds the next slice becomes due. */
  readonly nextAt: bigint;
  readonly deadline: bigint;
  readonly amountPerSlice: bigint;
  readonly tipPerSlice: bigint;
  readonly minPriceX96: bigint;
  /** `floor(amountPerSlice x minPriceX96 / 2^96)`: the least net output the next slice accepts. */
  readonly minOutPerSlice: bigint;
  readonly key: PoolKey;
}

/** The plan, or `null` when it never existed, was cancelled, or ran its last slice (the contract deletes it). */
export async function readPlan(client: PublicClient, a: { readonly address: Address; readonly planId: bigint }): Promise<DcaPlanState | null> {
  const p = (await client.readContract({ address: a.address, abi: DCA_ABI, functionName: "getPlan", args: [a.planId] })) as unknown as {
    owner: Address;
    recipient: Address;
    zeroForOne: boolean;
    feeBps: number | bigint;
    integratorBps: number | bigint;
    integrator: Address;
    interval: number | bigint;
    slicesLeft: number | bigint;
    nextAt: bigint;
    deadline: bigint;
    amountPerSlice: bigint;
    tipPerSlice: bigint;
    minPriceX96: bigint;
    key: { currency0: Address; currency1: Address; hooks: Address; poolManager: Address; fee: number | bigint; parameters: Hex };
  };
  if (p.owner.toLowerCase() === zeroAddress) return null;
  return {
    planId: a.planId,
    owner: p.owner,
    recipient: p.recipient,
    zeroForOne: p.zeroForOne,
    feeBps: Number(p.feeBps),
    integratorBps: Number(p.integratorBps),
    integrator: p.integrator,
    interval: Number(p.interval),
    slicesLeft: Number(p.slicesLeft),
    nextAt: BigInt(p.nextAt),
    deadline: BigInt(p.deadline),
    amountPerSlice: p.amountPerSlice,
    tipPerSlice: p.tipPerSlice,
    minPriceX96: p.minPriceX96,
    minOutPerSlice: minOutFromPriceX96(p.amountPerSlice, p.minPriceX96),
    key: {
      currency0: p.key.currency0,
      currency1: p.key.currency1,
      hooks: p.key.hooks,
      poolManager: p.key.poolManager,
      fee: Number(p.key.fee),
      parameters: p.key.parameters,
    },
  };
}

/** `isDue(planId)`: the schedule allows a slice now (the price bound can still refuse it). */
export async function isPlanDue(client: PublicClient, a: { readonly address: Address; readonly planId: bigint }): Promise<boolean> {
  return (await client.readContract({ address: a.address, abi: DCA_ABI, functionName: "isDue", args: [a.planId] })) as boolean;
}

async function planIds(client: PublicClient, scan: LogScan, owner?: Address): Promise<bigint[]> {
  const logs = await scanLogs(client, scan, ev(DCA_ABI, "PlanCreated"), owner ? { owner } : undefined);
  return [...new Set(logs.map((l) => l.args["planId"] as bigint))];
}

/** Every live plan `owner` created (from `PlanCreated`, indexed by owner). Finished and cancelled plans are left out. */
export async function readOwnerPlans(client: PublicClient, a: LogScan & { readonly owner: Address }): Promise<DcaPlanState[]> {
  const ids = await planIds(client, a, a.owner);
  const plans = await mapBurst(ids, (id) => readPlan(client, { address: a.address, planId: id }));
  return plans.filter((p): p is DcaPlanState => p !== null);
}

/** Every live plan whose next slice is due now, by the contract's own `isDue`. */
export async function readDuePlans(client: PublicClient, a: LogScan): Promise<DcaPlanState[]> {
  const ids = await planIds(client, a);
  const due = await mapBurst(ids, async (id) => ((await isPlanDue(client, { address: a.address, planId: id })) ? id : null));
  const plans = await mapBurst(
    due.filter((id): id is bigint => id !== null),
    (id) => readPlan(client, { address: a.address, planId: id }),
  );
  return plans.filter((p): p is DcaPlanState => p !== null);
}
