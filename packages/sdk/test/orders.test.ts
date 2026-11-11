// SPDX-License-Identifier: MIT
/**
 * Limit orders and DCA: level snapping, the price bound's exact arithmetic, every
 * builder decoded back from its calldata, the refusals that restate the contracts'
 * own checks, and the readers against a stub client. No chain, no network; every
 * address is obviously fake.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from "viem";

import {
  DCA_ABI,
  OrdersInputError,
  RANGE_ORDERS_ABI,
  RANGE_ORDERS_FORBIDDEN_HOOK_BITS,
  buildCancelDca,
  buildCancelLimitOrder,
  buildCreateDca,
  buildExecuteDcaSlice,
  buildExecuteEpoch,
  buildExecuteEpochs,
  buildPlaceLimitOrder,
  buildWithdrawLimitOrder,
  dcaEscrow,
  isEpochCrossed,
  minOutFromPriceX96,
  minPriceX96FromBound,
  minPriceX96FromSpot,
  priceToTick,
  readDuePlans,
  readEpoch,
  readMakerOrders,
  readOpenEpochs,
  readOrder,
  readOwnerPlans,
  readPlan,
  snapLimitLevel,
  tickToPrice,
} from "../src/orders/index.js";
import * as sdk from "../src/index.js";
import { encodeCLPoolParameters } from "../src/types/parameters.js";
import type { PoolKey } from "../src/types/poolKey.js";
import { GULLYCORE_DEPLOYMENTS } from "../src/deployments/index.js";

const fake = (n: number): Address => getAddress(`0x${"dc0de".padStart(35, "0")}${n.toString(16).padStart(5, "0")}`);
const ORDERS = fake(1);
const DCA = fake(2);
const CL = fake(3);
const TOKEN = fake(4);
const MAKER = fake(5);
const INTEGRATOR = fake(6);
const Q96 = 1n << 96n;

const key = (over: Partial<PoolKey> = {}, spacing = 10, bitmap = 0): PoolKey => ({
  currency0: zeroAddress,
  currency1: TOKEN,
  hooks: zeroAddress,
  poolManager: CL,
  fee: 3000,
  parameters: encodeCLPoolParameters(bitmap, spacing),
  ...over,
});

const refuses = (f: () => unknown, field: string): void => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(OrdersInputError);
    expect((e as OrdersInputError).field).toBe(field);
    return;
  }
  throw new Error(`expected a refusal on ${field}`);
};

/* ------------------------------------------------------------- snapping --- */

describe("snapLimitLevel", () => {
  const ok = (r: ReturnType<typeof snapLimitLevel>) => {
    if ("error" in r) throw new Error(r.error);
    return r;
  };
  /** The contract's own `OrderInRange` check, restated: what `place` accepts. */
  const valid = (r: { tickLower: number; tickUpper: number }, cur: number, sell0: boolean, s: number) =>
    r.tickLower % s === 0 && r.tickUpper === r.tickLower + s && (sell0 ? cur < r.tickLower : cur >= r.tickUpper);

  it("sell currency0: snaps UP to the grid, the whole range at or above the target", () => {
    expect(ok(snapLimitLevel({ targetTick: 123, tickSpacing: 10, currentTick: 50, sellCurrency0: true }))).toEqual({ tickLower: 130, tickUpper: 140 });
    expect(ok(snapLimitLevel({ targetTick: 120, tickSpacing: 10, currentTick: 50, sellCurrency0: true }))).toEqual({ tickLower: 120, tickUpper: 130 });
  });

  it("sell currency1: snaps DOWN, the whole range at or below the target", () => {
    expect(ok(snapLimitLevel({ targetTick: 23, tickSpacing: 10, currentTick: 100, sellCurrency0: false }))).toEqual({ tickLower: 10, tickUpper: 20 });
    expect(ok(snapLimitLevel({ targetTick: 20, tickSpacing: 10, currentTick: 100, sellCurrency0: false }))).toEqual({ tickLower: 10, tickUpper: 20 });
  });

  it("negative ticks floor and ceil toward the correct side (no truncation toward zero)", () => {
    expect(ok(snapLimitLevel({ targetTick: -15, tickSpacing: 10, currentTick: -100, sellCurrency0: true }))).toEqual({ tickLower: -10, tickUpper: 0 });
    expect(ok(snapLimitLevel({ targetTick: -15, tickSpacing: 10, currentTick: 0, sellCurrency0: false }))).toEqual({ tickLower: -30, tickUpper: -20 });
    const z = ok(snapLimitLevel({ targetTick: -5, tickSpacing: 10, currentTick: -50, sellCurrency0: true }));
    expect(Object.is(z.tickLower, -0)).toBe(false);
    expect(z.tickLower).toBe(0);
  });

  it("edge equality: a level the contract would call in range moves to the first valid one", () => {
    // sell0 requires current < tickLower: current exactly on a grid tick moves one spacing up.
    const a = ok(snapLimitLevel({ targetTick: 100, tickSpacing: 10, currentTick: 100, sellCurrency0: true }));
    expect(a).toEqual({ tickLower: 110, tickUpper: 120 });
    // sell1 requires current >= tickUpper: equality is allowed.
    const b = ok(snapLimitLevel({ targetTick: 100, tickSpacing: 10, currentTick: 100, sellCurrency0: false }));
    expect(b).toEqual({ tickLower: 90, tickUpper: 100 });
    // A target inside the current spacing.
    expect(ok(snapLimitLevel({ targetTick: 104, tickSpacing: 10, currentTick: 103, sellCurrency0: true }))).toEqual({ tickLower: 110, tickUpper: 120 });
    expect(ok(snapLimitLevel({ targetTick: 102, tickSpacing: 10, currentTick: 103, sellCurrency0: false }))).toEqual({ tickLower: 90, tickUpper: 100 });
    expect(ok(snapLimitLevel({ targetTick: -103, tickSpacing: 10, currentTick: -103, sellCurrency0: false }))).toEqual({ tickLower: -120, tickUpper: -110 });
  });

  it("every snapped level is one the contract accepts", () => {
    for (const s of [1, 10, 60, 200]) {
      for (let cur = -450; cur <= 450; cur += 37) {
        for (let d = 0; d <= 500; d += 43) {
          expect(valid(ok(snapLimitLevel({ targetTick: cur + d, tickSpacing: s, currentTick: cur, sellCurrency0: true })), cur, true, s)).toBe(true);
          expect(valid(ok(snapLimitLevel({ targetTick: cur - d, tickSpacing: s, currentTick: cur, sellCurrency0: false })), cur, false, s)).toBe(true);
        }
      }
    }
  });

  it("refuses the wrong side of the price, a bad spacing and the tick bounds", () => {
    expect("error" in snapLimitLevel({ targetTick: 10, tickSpacing: 10, currentTick: 50, sellCurrency0: true })).toBe(true);
    expect("error" in snapLimitLevel({ targetTick: 90, tickSpacing: 10, currentTick: 50, sellCurrency0: false })).toBe(true);
    expect("error" in snapLimitLevel({ targetTick: 90, tickSpacing: 0, currentTick: 50, sellCurrency0: true })).toBe(true);
    expect("error" in snapLimitLevel({ targetTick: 887_270, tickSpacing: 10, currentTick: 0, sellCurrency0: true })).toBe(true);
    expect("error" in snapLimitLevel({ targetTick: -887_270, tickSpacing: 10, currentTick: 0, sellCurrency0: false })).toBe(true);
  });
});

describe("tickToPrice / priceToTick", () => {
  it("tick 0 is 1 at equal decimals and scales by the decimal gap", () => {
    expect(tickToPrice(0, 18, 18)).toBe(1);
    expect(tickToPrice(0, 18, 6)).toBeCloseTo(1e12, 0);
    expect(tickToPrice(6932, 18, 18)).toBeCloseTo(2, 3);
  });

  it("round-trips exact ticks, positive and negative, across decimals", () => {
    for (const t of [-200_000, -12_345, -1, 0, 1, 99, 12_345, 200_000]) {
      for (const [d0, d1] of [[18, 18], [18, 6], [6, 18]] as const) expect(priceToTick(tickToPrice(t, d0, d1), d0, d1)).toBe(t);
    }
  });

  it("floors a price between ticks and refuses nonsense", () => {
    const mid = (tickToPrice(100, 18, 18) + tickToPrice(101, 18, 18)) / 2;
    expect(priceToTick(mid, 18, 18)).toBe(100);
    expect(() => priceToTick(0, 18, 18)).toThrow(RangeError);
    expect(() => priceToTick(-1, 18, 18)).toThrow(RangeError);
    expect(() => priceToTick(Number.NaN, 18, 18)).toThrow(RangeError);
  });
});

/* ---------------------------------------------------------- price bound --- */

describe("minPriceX96", () => {
  it("from a bound: the least Q96 price whose contract minimum covers it, exactly", () => {
    for (const [a, m] of [[1000n, 1n], [10n ** 18n, 2_500_000n], [3n, 7n], [7n, 3n], [10n ** 6n, 10n ** 24n]] as const) {
      const p = minPriceX96FromBound({ amountPerSlice: a, minOutPerSlice: m });
      expect(minOutFromPriceX96(a, p)).toBeGreaterThanOrEqual(m);
      expect(minOutFromPriceX96(a, p - 1n)).toBeLessThan(m);
    }
    expect(minPriceX96FromBound({ amountPerSlice: 2n, minOutPerSlice: 1n })).toBe(Q96 / 2n);
    refuses(() => minPriceX96FromBound({ amountPerSlice: 0n, minOutPerSlice: 1n }), "amountPerSlice");
    refuses(() => minPriceX96FromBound({ amountPerSlice: 1n, minOutPerSlice: 0n }), "minOutPerSlice");
  });

  it("from a spot ratio, less the tolerance, rounded down", () => {
    expect(minPriceX96FromSpot({ spotOutPerIn: { num: 3n, den: 1n }, toleranceBps: 0 })).toBe(3n * Q96);
    expect(minPriceX96FromSpot({ spotOutPerIn: { num: 2n, den: 1n }, toleranceBps: 100 })).toBe((2n * Q96 * 9900n) / 10_000n);
    expect(minPriceX96FromSpot({ spotOutPerIn: { num: 1n, den: 3n }, toleranceBps: 50 })).toBe((Q96 * 9950n) / 30_000n);
  });

  it("from sqrtPriceX96 in both directions", () => {
    // sqrtPrice = 2 x 2^96: price0in1 = 4. currency0 in -> 4 out; currency1 in -> 1/4 out.
    const s = 2n * Q96;
    expect(minPriceX96FromSpot({ sqrtPriceX96: s, zeroForOne: true, toleranceBps: 0 })).toBe(4n * Q96);
    expect(minPriceX96FromSpot({ sqrtPriceX96: s, zeroForOne: false, toleranceBps: 0 })).toBe(Q96 / 4n);
    expect(minPriceX96FromSpot({ sqrtPriceX96: s, zeroForOne: true, toleranceBps: 2500 })).toBe(3n * Q96);
    expect(minPriceX96FromSpot({ sqrtPriceX96: Q96, zeroForOne: false, toleranceBps: 0 })).toBe(Q96);
  });

  it("refuses a tolerance outside [0, 9999], a zero ratio and a bound that rounds to zero", () => {
    refuses(() => minPriceX96FromSpot({ spotOutPerIn: { num: 1n, den: 1n }, toleranceBps: 10_000 }), "toleranceBps");
    refuses(() => minPriceX96FromSpot({ spotOutPerIn: { num: 1n, den: 1n }, toleranceBps: -1 }), "toleranceBps");
    refuses(() => minPriceX96FromSpot({ spotOutPerIn: { num: 0n, den: 1n }, toleranceBps: 0 }), "spotOutPerIn");
    refuses(() => minPriceX96FromSpot({ spotOutPerIn: { num: 1n, den: 2n ** 200n }, toleranceBps: 0 }), "toleranceBps");
    refuses(() => minPriceX96FromSpot({ sqrtPriceX96: 0n, zeroForOne: true, toleranceBps: 0 }), "sqrtPriceX96");
  });
});

/* ------------------------------------------------------- limit builders --- */

describe("limit order builders", () => {
  const place = (over: Partial<Parameters<typeof buildPlaceLimitOrder>[0]> = {}) =>
    buildPlaceLimitOrder({ address: ORDERS, key: key(), tickLower: 100, zeroForOne: true, amountIn: 10n ** 18n, tip: 5n, ...over });

  it("place: native sold currency carries amountIn + tip; the calldata decodes to the inputs", () => {
    const tx = place({ integrator: INTEGRATOR, integratorBps: 7, currentTick: 50, clPoolManager: CL });
    expect(tx.to).toBe(ORDERS);
    expect(tx.value).toBe(10n ** 18n + 5n);
    const d = decodeFunctionData({ abi: RANGE_ORDERS_ABI, data: tx.data });
    expect(d.functionName).toBe("place");
    const p = (d.args as readonly [Record<string, unknown>])[0];
    expect(p).toMatchObject({ tickLower: 100, zeroForOne: true, amountIn: 10n ** 18n, tip: 5n, integrator: INTEGRATOR, integratorBps: 7 });
    expect((p["key"] as Record<string, unknown>)["poolManager"]).toBe(CL);
  });

  it("place: an ERC-20 sold currency carries no value; defaults are no tip and no integrator", () => {
    const tx = buildPlaceLimitOrder({ address: ORDERS, key: key(), tickLower: -100, zeroForOne: false, amountIn: 1000n, currentTick: 0 });
    expect(tx.value).toBe(0n);
    const p = (decodeFunctionData({ abi: RANGE_ORDERS_ABI, data: tx.data }).args as readonly [Record<string, unknown>])[0];
    expect(p).toMatchObject({ tip: 0n, integrator: zeroAddress, integratorBps: 0 });
  });

  it("place refuses what the contract refuses", () => {
    refuses(() => place({ amountIn: 0n }), "amountIn");
    refuses(() => place({ tickLower: 105 }), "tickLower");
    refuses(() => place({ integratorBps: 11, integrator: INTEGRATOR }), "integratorBps");
    refuses(() => place({ integratorBps: 1 }), "integrator");
    refuses(() => place({ tip: 2n ** 128n }), "tip");
    refuses(() => place({ currentTick: 100 }), "tickLower"); // sell0: current >= tickLower is in range
    refuses(() => place({ zeroForOne: false, currentTick: 105 }), "tickLower"); // sell1: current < tickUpper (110)
    expect(() => place({ zeroForOne: false, currentTick: 110 })).not.toThrow();
    refuses(() => place({ clPoolManager: fake(99) }), "key");
    refuses(() => place({ tickLower: -887_280 }), "tickLower");
    for (const bit of [4, 5, 12, 13]) refuses(() => place({ key: key({ hooks: fake(77) }, 10, 1 << bit) }), "key");
    expect(RANGE_ORDERS_FORBIDDEN_HOOK_BITS).toBe(0x3030);
    expect(() => place({ key: key({ hooks: fake(77) }, 10, (1 << 6) | (1 << 7)) })).not.toThrow();
  });

  it("cancel, withdraw, execute and executeMany decode back to their arguments", () => {
    const c = decodeFunctionData({ abi: RANGE_ORDERS_ABI, data: buildCancelLimitOrder({ address: ORDERS, orderId: 3n, to: MAKER }).data });
    expect([c.functionName, c.args]).toEqual(["cancel", [3n, MAKER]]);
    const w = decodeFunctionData({ abi: RANGE_ORDERS_ABI, data: buildWithdrawLimitOrder({ address: ORDERS, orderId: 4n, to: MAKER }).data });
    expect([w.functionName, w.args]).toEqual(["withdraw", [4n, MAKER]]);
    const e = decodeFunctionData({ abi: RANGE_ORDERS_ABI, data: buildExecuteEpoch({ address: ORDERS, epochId: 9n }).data });
    expect([e.functionName, e.args]).toEqual(["execute", [9n]]);
    const m = decodeFunctionData({ abi: RANGE_ORDERS_ABI, data: buildExecuteEpochs({ address: ORDERS, epochIds: [1n, 2n, 5n] }).data });
    expect([m.functionName, m.args]).toEqual(["executeMany", [[1n, 2n, 5n]]]);
    for (const tx of [buildExecuteEpoch({ address: ORDERS, epochId: 1n }), buildCancelLimitOrder({ address: ORDERS, orderId: 1n, to: MAKER })]) expect(tx.value).toBe(0n);
  });

  it("refuses a zero recipient, a zero id and an empty or duplicated batch", () => {
    refuses(() => buildCancelLimitOrder({ address: ORDERS, orderId: 1n, to: zeroAddress }), "to");
    refuses(() => buildWithdrawLimitOrder({ address: ORDERS, orderId: 0n, to: MAKER }), "orderId");
    refuses(() => buildExecuteEpochs({ address: ORDERS, epochIds: [] }), "epochIds");
    refuses(() => buildExecuteEpochs({ address: ORDERS, epochIds: [1n, 1n] }), "epochIds");
  });
});

/* --------------------------------------------------------- DCA builders --- */

describe("limit orders are refused on launch pools", () => {
  const GUARD = getAddress("0x00000000000000000000000000000000000000a1");
  const withBitmap = (bitmap: number, hooks: Address = GUARD): PoolKey => {
    const k = key();
    const p = BigInt(k.parameters) | BigInt(bitmap);
    return { ...k, hooks, parameters: `0x${p.toString(16).padStart(64, "0")}` };
  };
  it("names the three guard generations", () => {
    expect(sdk.RANGE_ORDERS_LAUNCH_GUARD_BITMAPS).toEqual([0x0041, 0x08c1, 0x0cc1]);
  });
  it("refuses each guard bitmap with the typed error", () => {
    for (const bitmap of [0x0041, 0x08c1, 0x0cc1]) {
      const k = withBitmap(bitmap);
      expect(sdk.isLaunchPoolKey(k)).toBe(true);
      let thrown: unknown;
      try {
        buildPlaceLimitOrder({ address: ORDERS, key: k, tickLower: 100, zeroForOne: true, amountIn: 1n });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(sdk.LimitOrdersNotOnLaunchPoolsError);
      expect(thrown).toBeInstanceOf(sdk.OrdersInputError);
      expect((thrown as InstanceType<typeof sdk.LimitOrdersNotOnLaunchPoolsError>).hook).toBe(GUARD);
      expect((thrown as Error).message).toBe("Limit orders are not available on launch pools.");
    }
  });
  it("refuses a listed guard whatever its bitmap, and only when listed", () => {
    const k = withBitmap(0x0080);
    expect(sdk.isLaunchPoolKey(k)).toBe(false);
    expect(sdk.isLaunchPoolKey(k, [GUARD.toLowerCase() as Address])).toBe(true);
    expect(() => buildPlaceLimitOrder({ address: ORDERS, key: k, tickLower: 100, zeroForOne: true, amountIn: 1n })).not.toThrow();
    expect(() =>
      buildPlaceLimitOrder({ address: ORDERS, key: k, tickLower: 100, zeroForOne: true, amountIn: 1n, launchGuards: [GUARD] }),
    ).toThrow(sdk.LimitOrdersNotOnLaunchPoolsError);
  });
  it("leaves an ordinary pool alone", () => {
    expect(sdk.isLaunchPoolKey(key())).toBe(false);
    expect(sdk.isLaunchPoolKey(withBitmap(0x08c0))).toBe(false);
  });
});

describe("DCA builders", () => {
  const NOW = 1_800_000_000n;
  const create = (over: Partial<Parameters<typeof buildCreateDca>[0]> = {}) =>
    buildCreateDca({
      address: DCA,
      key: key(),
      zeroForOne: true,
      amountPerSlice: 10n ** 17n,
      tipPerSlice: 10n ** 14n,
      slices: 10,
      interval: 3600,
      deadline: NOW + 86_400n,
      minPriceX96: Q96,
      recipient: MAKER,
      now: NOW,
      ...over,
    });

  it("create: native input carries slices x (amountPerSlice + tipPerSlice); the calldata decodes to the inputs", () => {
    const tx = create({ integrator: INTEGRATOR, integratorBps: 10 });
    expect(tx.to).toBe(DCA);
    expect(tx.value).toBe(10n * (10n ** 17n + 10n ** 14n));
    expect(tx.value).toBe(dcaEscrow({ slices: 10, amountPerSlice: 10n ** 17n, tipPerSlice: 10n ** 14n }));
    const d = decodeFunctionData({ abi: DCA_ABI, data: tx.data });
    expect(d.functionName).toBe("create");
    expect((d.args as readonly [Record<string, unknown>])[0]).toMatchObject({
      zeroForOne: true,
      amountPerSlice: 10n ** 17n,
      tipPerSlice: 10n ** 14n,
      slices: 10,
      interval: 3600,
      startAt: 0n,
      deadline: NOW + 86_400n,
      minPriceX96: Q96,
      recipient: MAKER,
      integrator: INTEGRATOR,
      integratorBps: 10,
    });
  });

  it("create: an ERC-20 input carries no value", () => {
    expect(create({ zeroForOne: false }).value).toBe(0n);
  });

  it("create refuses what the contract refuses", () => {
    refuses(() => create({ amountPerSlice: 0n }), "amountPerSlice");
    refuses(() => create({ amountPerSlice: 2n ** 127n }), "amountPerSlice");
    refuses(() => create({ minPriceX96: 0n }), "minPriceX96");
    refuses(() => create({ recipient: zeroAddress }), "recipient");
    refuses(() => create({ slices: 0 }), "slices");
    refuses(() => create({ slices: 10_001 }), "slices");
    refuses(() => create({ interval: 59 }), "interval");
    refuses(() => create({ integratorBps: 11, integrator: INTEGRATOR }), "integratorBps");
    refuses(() => create({ integratorBps: 2 }), "integrator");
    refuses(() => create({ startAt: NOW - 1n }), "startAt");
    refuses(() => create({ deadline: NOW }), "deadline");
    refuses(() => create({ startAt: NOW + 100n, deadline: NOW + 100n }), "deadline");
    refuses(() => create({ poolManagers: [fake(98)] }), "key");
    // The deadline must leave room for the last slice: 10 slices hourly need 9 hours after the start.
    refuses(() => create({ deadline: NOW + 9n * 3600n - 1n }), "deadline");
    expect(() => create({ deadline: NOW + 9n * 3600n })).not.toThrow();
    expect(() => create({ slices: 1, interval: 60, deadline: NOW + 1n })).not.toThrow();
  });

  it("cancel and execute decode back to their arguments and carry no value", () => {
    const c = buildCancelDca({ address: DCA, planId: 2n, to: MAKER });
    expect(decodeFunctionData({ abi: DCA_ABI, data: c.data })).toMatchObject({ functionName: "cancel", args: [2n, MAKER] });
    const x = buildExecuteDcaSlice({ address: DCA, planId: 2n });
    expect(decodeFunctionData({ abi: DCA_ABI, data: x.data })).toMatchObject({ functionName: "execute", args: [2n] });
    expect([c.value, x.value]).toEqual([0n, 0n]);
    refuses(() => buildCancelDca({ address: DCA, planId: 2n, to: zeroAddress }), "to");
  });
});

/* ---------------------------------------------------------------- reads --- */

const POOL_ID = `0x${"ab".repeat(32)}` as const;
const epochRow = (o: Record<string, unknown> = {}) => ({
  poolId: POOL_ID,
  tickLower: 100,
  tickUpper: 110,
  zeroForOne: true,
  filled: false,
  liquidity: 5n,
  liquidityAtFill: 0n,
  proceeds: 0n,
  acc0X128: 0n,
  acc1X128: 0n,
  held0: 0n,
  held1: 0n,
  tipTotal: 3n,
  ...o,
});
const EMPTY_EPOCH = epochRow({ poolId: `0x${"00".repeat(32)}`, tickLower: 0, tickUpper: 0, liquidity: 0n, tipTotal: 0n });
const orderRow = (o: Record<string, unknown> = {}) => ({
  maker: MAKER,
  epochId: 1n,
  feeBps: 10,
  integratorBps: 0,
  integrator: zeroAddress,
  liquidity: 5n,
  tip: 3n,
  snap0X128: 0n,
  snap1X128: 0n,
  ...o,
});
const planRow = (o: Record<string, unknown> = {}) => ({
  owner: MAKER,
  recipient: MAKER,
  zeroForOne: true,
  feeBps: 10,
  integratorBps: 0,
  integrator: zeroAddress,
  interval: 3600,
  slicesLeft: 3,
  nextAt: 100n,
  deadline: 10_000n,
  amountPerSlice: 1000n,
  tipPerSlice: 1n,
  minPriceX96: Q96 * 2n,
  key: key(),
  ...o,
});

function stub(state: {
  epochs?: Record<string, unknown>;
  orders?: Record<string, unknown>;
  plans?: Record<string, unknown>;
  crossed?: Record<string, boolean>;
  due?: Record<string, boolean>;
  logs?: Record<string, Array<{ args: Record<string, unknown>; blockNumber?: bigint }>>;
}) {
  const calls: unknown[] = [];
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: readonly bigint[] }) => {
      calls.push(["read", functionName, args]);
      const id = String(args[0]);
      if (functionName === "getEpoch") return state.epochs?.[id] ?? EMPTY_EPOCH;
      if (functionName === "getOrder") return state.orders?.[id] ?? orderRow({ maker: zeroAddress });
      if (functionName === "getPlan") return state.plans?.[id] ?? planRow({ owner: zeroAddress });
      if (functionName === "isCrossed") return state.crossed?.[id] ?? false;
      if (functionName === "isDue") return state.due?.[id] ?? false;
      throw new Error(`unexpected read ${functionName}`);
    },
    getLogs: async (q: { event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint | string }) => {
      calls.push(["logs", q.event.name, q.args, q.fromBlock, q.toBlock]);
      return (state.logs?.[q.event.name] ?? [])
        .filter((l) => (q.toBlock === "latest" || (l.blockNumber ?? 10n) <= (q.toBlock as bigint)) && (l.blockNumber ?? 10n) >= q.fromBlock)
        .map((l) => ({ blockNumber: l.blockNumber ?? 10n, transactionHash: `0x${"11".repeat(32)}`, logIndex: 0, ...l }));
    },
    getBlockNumber: async () => 250n,
  };
  return { client: client as unknown as PublicClient, calls };
}

describe("readers", () => {
  it("readEpoch / readOrder / readPlan return null for an id that does not exist", async () => {
    const { client } = stub({});
    expect(await readEpoch(client, { address: ORDERS, epochId: 9n })).toBeNull();
    expect(await readOrder(client, { address: ORDERS, orderId: 9n })).toBeNull();
    expect(await readPlan(client, { address: DCA, planId: 9n })).toBeNull();
  });

  it("readEpoch / readOrder / readPlan normalise what is stored", async () => {
    const { client } = stub({ epochs: { "1": epochRow() }, orders: { "2": orderRow() }, plans: { "3": planRow() } });
    expect(await readEpoch(client, { address: ORDERS, epochId: 1n })).toMatchObject({ epochId: 1n, tickLower: 100, tickUpper: 110, liquidity: 5n, tipTotal: 3n });
    expect(await readOrder(client, { address: ORDERS, orderId: 2n })).toMatchObject({ orderId: 2n, maker: MAKER, epochId: 1n, feeBps: 10 });
    const p = await readPlan(client, { address: DCA, planId: 3n });
    expect(p).toMatchObject({ planId: 3n, slicesLeft: 3, interval: 3600, minOutPerSlice: 2000n });
    expect(p?.key.poolManager).toBe(CL);
  });

  it("isEpochCrossed reads the contract's own view", async () => {
    const { client } = stub({ crossed: { "4": true } });
    expect(await isEpochCrossed(client, { address: ORDERS, epochId: 4n })).toBe(true);
    expect(await isEpochCrossed(client, { address: ORDERS, epochId: 5n })).toBe(false);
  });

  it("readMakerOrders filters OrderPlaced by maker and reports each order's state now", async () => {
    const placed = (orderId: bigint, epochId: bigint) => ({
      args: { orderId, epochId, maker: MAKER, amountIn: 100n, liquidity: 5n, tip: 3n, feeBps: 10, integrator: zeroAddress, integratorBps: 0 },
    });
    const { client, calls } = stub({
      epochs: { "1": epochRow(), "2": epochRow({ filled: true, liquidity: 5n, proceeds: 90n }) },
      orders: { "10": orderRow(), "11": orderRow({ epochId: 2n }) },
      logs: { OrderPlaced: [placed(10n, 1n), placed(11n, 2n), placed(12n, 1n)] },
    });
    const out = await readMakerOrders(client, { address: ORDERS, maker: MAKER, fromBlock: 5n });
    expect(out.map((o) => [o.orderId, o.status])).toEqual([
      [10n, "resting"],
      [11n, "filled"],
      [12n, "closed"],
    ]);
    expect(out[0]?.placed.amountIn).toBe(100n);
    expect(calls).toContainEqual(["logs", "OrderPlaced", { maker: MAKER }, 5n, "latest"]);
    // The epoch is read once per epoch, not once per order.
    expect(calls.filter((c) => (c as unknown[])[1] === "getEpoch")).toHaveLength(2);
  });

  it("readOpenEpochs keeps unfilled epochs that still hold liquidity, and chunks the scan when asked", async () => {
    const opened = (epochId: bigint, blockNumber: bigint) => ({ args: { epochId }, blockNumber });
    const { client, calls } = stub({
      epochs: { "1": epochRow(), "2": epochRow({ filled: true }), "3": epochRow({ liquidity: 0n }) },
      logs: { EpochOpened: [opened(1n, 10n), opened(2n, 120n), opened(3n, 240n), opened(4n, 249n)] },
    });
    const out = await readOpenEpochs(client, { address: ORDERS, fromBlock: 0n, maxBlockRange: 100n });
    expect(out.map((e) => e.epochId)).toEqual([1n]);
    expect(calls.filter((c) => (c as unknown[])[0] === "logs")).toHaveLength(3); // 0-99, 100-199, 200-250
  });

  it("readOwnerPlans keeps live plans; readDuePlans keeps the ones the contract calls due", async () => {
    const created = (planId: bigint) => ({ args: { planId, owner: MAKER } });
    const { client, calls } = stub({
      plans: { "1": planRow(), "2": planRow({ nextAt: 999_999n }) },
      due: { "1": true, "3": true },
      logs: { PlanCreated: [created(1n), created(2n), created(3n)] },
    });
    expect((await readOwnerPlans(client, { address: DCA, owner: MAKER, fromBlock: 0n })).map((p) => p.planId)).toEqual([1n, 2n]);
    expect(calls).toContainEqual(["logs", "PlanCreated", { owner: MAKER }, 0n, "latest"]);
    // Plan 3 reads due but no longer exists (finished between the two reads): left out.
    expect((await readDuePlans(client, { address: DCA, fromBlock: 0n })).map((p) => p.planId)).toEqual([1n]);
  });
});

/* ------------------------------------------------------- address book --- */

describe("address book and root exports", () => {
  // Deployed 2026-10-15/16 through CreateX at the same vanity addresses on every chain that has them, read back
  // from chain by make-record; a chain whose run has not reached `orders` carries null for both (never a placeholder).
  const RANGE_ORDERS = "0x787888B35e67DC155E612c862c6A2f60f512D378";
  const DCA = "0x7878947dC3a69d03C3d9431d9bDC536d1e0A0878";
  it("records rangeOrders and dca together, at the CreateX addresses or null where not deployed yet", () => {
    for (const d of Object.values(GULLYCORE_DEPLOYMENTS)) {
      expect(d).toHaveProperty("rangeOrders");
      expect(d).toHaveProperty("dca");
      expect(d.rangeOrders === null).toBe(d.dca === null);
    }
    // Gully Chain Testnet, read back 2026-11-05 (the public deployment record). Gully's CreateX salts
    // differ from the upstream product's, so these are not the upstream addresses and must never be.
    expect(GULLYCORE_DEPLOYMENTS[485590].rangeOrders).toBe("0x66a92Db09eB576bb90C0d1C209AeB160bAdE91E9");
    expect(GULLYCORE_DEPLOYMENTS[485590].dca).toBe("0x5D39079CE27819682613b67D3EB13D88B3A1146F");
    expect(GULLYCORE_DEPLOYMENTS[485590].rangeOrders).not.toBe(RANGE_ORDERS);
    expect(GULLYCORE_DEPLOYMENTS[485590].dca).not.toBe(DCA);
  });

  it("exposes the module at the root, as a namespace and by name", () => {
    expect(sdk.orders.snapLimitLevel).toBe(snapLimitLevel);
    expect(sdk.buildPlaceLimitOrder).toBe(buildPlaceLimitOrder);
    expect(sdk.RANGE_ORDERS_ABI).toBe(RANGE_ORDERS_ABI);
    expect(sdk.DCA_ABI).toBe(DCA_ABI);
  });
});
