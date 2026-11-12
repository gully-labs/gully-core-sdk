// SPDX-License-Identifier: MIT
/**
 * What a launch pool charges a trade, from the quote to the lines a trader reads.
 *
 * Three things are under test:
 *
 * 1. `core/launchCharges.ts`, pure: the no-impact reference a quote is compared
 *    with is net of EVERY charge, so price impact is never a fee or a tax; and
 *    the fee and the tax are two lines, never one.
 * 2. The live adapter's `quoteSwap` through a launch pool of either kind, driven
 *    by a fake `PublicClient` (the same contract as in viemAdapter.test.ts: it
 *    answers only what the test declared and throws for anything else).
 * 3. A trade the pool can only fill in part: a plain state with the most that
 *    fills, where the pool quoted that amount, and never a raw revert.
 *
 * Revert data is ENCODED from the SDK's generated ABIs, so a fixture cannot drift
 * from the contracts' interface. Nothing here is a chain, and every address is
 * made up: the launch pools that take the fee themselves are deployed nowhere.
 * Every expected figure is worked out in the comment beside it.
 */

import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Address, type Hex, type PublicClient } from "viem";
import {
  CL_QUOTER_ABI,
  DYNAMIC_FEE_FLAG,
  LAUNCH_GUARD_BITMAPS,
  LAUNCH_GUARD_HOOK_ABI,
  WRAPPED_ERROR_ABI,
  createBinPoolKey,
  createCLPoolKey,
  poolKeyToId,
  type PoolKey,
} from "@gullylabs/core-sdk";

import { createViemAdapter } from "../src/adapters/viem.js";
import { SwapTooLargeError, UnsupportedOperationError, type LaunchCharges, type LaunchFeeParts, type PoolInfo, type TokenInfo } from "../src/adapters/protocol.js";
import type { ChainConfig } from "../src/config/chain.js";
import { describeError, swapNotFilledOf } from "../src/core/errors.js";
import { feeLine, launchFeeTakenBy, launchFeeWords, spotAfterCharges, taxLine, tooLargeMessage } from "../src/core/launchCharges.js";
import { buildQuoteBreakdown } from "../src/core/math.js";
import { resolveIntegratorConfig } from "../src/config/integrator.js";
import { buildSwapQuoteView } from "../src/components/swap/state.js";

/* ------------------------------------------------------------------------ */
/* spotAfterCharges                                                         */
/* ------------------------------------------------------------------------ */

/** A pool at a flat price of 2 out per 1 in, so every figure below can be checked by hand. */
const twoForOne = (amount: bigint): bigint => amount * 2n;
/** And the other way, 1 out per 2 in. */
const oneForTwo = (amount: bigint): bigint => amount / 2n;

/** A launch that leaves the pool nothing: the launch takes the whole fee on a buy as on a sell. */
const allToLaunch = (feePips: number): LaunchFeeParts => ({ poolPips: 0, launchPips: feePips });
/** A buy through a launch that leaves the pool a quarter of the fee. */
const quarterToPool = (feePips: number): LaunchFeeParts => ({ poolPips: feePips / 4, launchPips: feePips - feePips / 4 });

describe("spotAfterCharges", () => {
  it("a pool that charges the fee: the fee off the input, the tax off what is received", () => {
    // 1_000_000 in, 1% fee -> 990_000 traded -> 1_980_000 out; 3% tax -> 59_400 -> 1_920_600
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "pool", inputIsQuote: true, atSpot: twoForOne })).toBe(1_920_600n);
    // The direction is not read for such a pool: it charges the same way both ways.
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "pool", inputIsQuote: false, atSpot: twoForOne })).toBe(1_920_600n);
  });

  it("a launch that takes the whole fee, on a BUY: fee and tax off the quote paid in, the rest trades", () => {
    // 1_000_000 in: fee 10_000 + tax 30_000 = 40_000 taken -> 960_000 traded -> 1_920_000 out
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: allToLaunch(10_000), inputIsQuote: true, atSpot: twoForOne })).toBe(1_920_000n);
  });

  it("a launch that leaves the pool a share, on a BUY: the launch's part and the tax off the amount paid, the pool's part off what is left", () => {
    /* 1_000_000 in at a 1% fee, a quarter of it the pool's, and a 3% tax.
       launch: 0.75% = 7_500, tax 30_000 -> 962_500 reaches the pool.
       pool:   0.25% of 962_500 = 2_406.25, rounded up as a pool rounds it = 2_407 -> 960_093 trade -> 1_920_186 out. */
    const out = spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: quarterToPool(10_000), inputIsQuote: true, atSpot: twoForOne });
    expect(out).toBe(1_920_186n);
    /* More than with the whole fee taken off the amount paid (1_920_000): the buyer pays a little LESS than the fee, never more. */
    expect(out! > 1_920_000n).toBe(true);
    /* And less than if the pool's part were not charged at all (962_500 * 2). */
    expect(out! < 1_925_000n).toBe(true);
  });

  it("a BUY through a launch that did not say how its fee is divided has no reference at all", () => {
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: null, inputIsQuote: true, atSpot: twoForOne })).toBeNull();
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", inputIsQuote: true, atSpot: twoForOne })).toBeNull();
    /* Not even with no fee to divide: what was not read is not known. */
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 0, taxBps: 0, feeTakenBy: "launch", feeParts: null, inputIsQuote: true, atSpot: twoForOne })).toBeNull();
  });

  it("a launch that takes the fee, on a SELL: everything trades, the whole fee and the tax off the quote paid out", () => {
    // 1_000_000 tokens in -> 500_000 quote out; fee 5_000 + tax 5% = 25_000 -> 470_000
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 500, feeTakenBy: "launch", feeParts: allToLaunch(10_000), inputIsQuote: false, atSpot: oneForTwo })).toBe(470_000n);
    /* A sell is the same whatever the launch leaves the pool on buys, and whether or not that was read:
       the pool charges a sell nothing. */
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 500, feeTakenBy: "launch", feeParts: null, inputIsQuote: false, atSpot: oneForTwo })).toBe(470_000n);
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 500, feeTakenBy: "launch", inputIsQuote: false, atSpot: oneForTwo })).toBe(470_000n);
  });

  it("a pool that charges the fee never reads the parts", () => {
    const base = { amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "pool" as const, inputIsQuote: true, atSpot: twoForOne };
    expect(spotAfterCharges({ ...base, feeParts: quarterToPool(10_000) })).toBe(1_920_600n);
    expect(spotAfterCharges({ ...base, feeParts: null })).toBe(1_920_600n);
  });

  it("on a sell the charges are worked out on the quote paid out, not on the tokens paid in", () => {
    /* The two agree to the unit on round numbers and part on small ones, which is where a wrong
       base shows. 21 tokens at 3 quote per 7 tokens = 9 quote out; 1% of 9 and 5% of 9 both floor
       to 0, so 9 is received. Charged on the 21 paid in instead, the tax would floor to 1, 20
       tokens would trade, and 8 would be received. */
    const threeForSeven = (amount: bigint): bigint => (amount * 3n) / 7n;
    expect(spotAfterCharges({ amountIn: 21n, feePips: 10_000, taxBps: 500, feeTakenBy: "launch", feeParts: allToLaunch(10_000), inputIsQuote: false, atSpot: threeForSeven })).toBe(9n);
  });

  it("the fee and the tax are each a rate on the same amount: neither is charged on the other", () => {
    // Compounded it would be 1_000_000 * 0.99 * 0.97 = 960_300 traded. It is 960_000.
    const out = spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: allToLaunch(10_000), inputIsQuote: true, atSpot: (a) => a });
    expect(out).toBe(960_000n);
    expect(out).not.toBe(960_300n);
  });

  it("floors each charge on its own, as the contracts do", () => {
    // 999 in: fee floor(999 * 10_000 / 1e6) = 9; tax floor(999 * 300 / 1e4) = 29 -> 961 traded
    expect(spotAfterCharges({ amountIn: 999n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: allToLaunch(10_000), inputIsQuote: true, atSpot: (a) => a })).toBe(961n);
  });

  it("no charge at all is the spot itself", () => {
    for (const feeTakenBy of ["pool", "launch"] as const) {
      for (const inputIsQuote of [true, false]) {
        expect(spotAfterCharges({ amountIn: 12_345n, feePips: 0, taxBps: 0, feeTakenBy, feeParts: allToLaunch(0), inputIsQuote, atSpot: twoForOne })).toBe(24_690n);
      }
    }
  });

  it("at the opening fee of a launch (50%) with the tax at its cap (10%)", () => {
    // Buy 1_000_000: 500_000 + 100_000 taken -> 400_000 traded
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 500_000, taxBps: 1_000, feeTakenBy: "launch", feeParts: allToLaunch(500_000), inputIsQuote: true, atSpot: (a) => a })).toBe(400_000n);
    // Sell to 1_000_000 quote: 600_000 taken -> 400_000 received
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 500_000, taxBps: 1_000, feeTakenBy: "launch", feeParts: allToLaunch(500_000), inputIsQuote: false, atSpot: (a) => a })).toBe(400_000n);
  });

  it("at the opening fee with the pool's share at its cap (half): the buyer pays less than the fee by the most it ever can", () => {
    /* Buy 1_000_000 at 50%, half the pool's, no tax: the launch takes 25% = 250_000 -> 750_000 reaches the pool;
       the pool charges 25% of that = 187_500 -> 562_500 trade. Fee paid 437_500, against 500_000 at the whole rate:
       62_500 less, which is 6.25% of the trade. */
    expect(spotAfterCharges({ amountIn: 1_000_000n, feePips: 500_000, taxBps: 0, feeTakenBy: "launch", feeParts: { poolPips: 250_000, launchPips: 250_000 }, inputIsQuote: true, atSpot: (a) => a })).toBe(562_500n);
  });
});

describe("price impact excludes every charge", () => {
  const integrator = resolveIntegratorConfig(undefined);

  it("a quote that lost nothing to impact reads 0, whatever the fee and the tax", () => {
    for (const feeTakenBy of ["pool", "launch"] as const) {
      for (const inputIsQuote of [true, false]) {
        for (const feeParts of [allToLaunch(10_000), quarterToPool(10_000)]) {
          const spot = spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy, feeParts, inputIsQuote, atSpot: twoForOne })!;
          const b = buildQuoteBreakdown({ amountIn: 1_000_000n, grossAmountOut: spot, spotAmountOut: spot, lpFeePips: 10_000, slippageBps: 50, integrator });
          expect(b.priceImpactBps, `${feeTakenBy} ${inputIsQuote} ${feeParts.poolPips}`).toBe(0);
        }
      }
    }
  });

  it("a buy whose fee's division was not read shows no impact, never one that holds part of a fee", () => {
    const spot = spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: null, inputIsQuote: true, atSpot: twoForOne });
    const b = buildQuoteBreakdown({ amountIn: 1_000_000n, grossAmountOut: 1_900_000n, spotAmountOut: spot, lpFeePips: 10_000, slippageBps: 50, integrator });
    expect(b.priceImpactBps).toBeNull();
  });

  it("worked out with the whole fee as the launch's, a quote through a pool that takes a share would read an impact that is not there", () => {
    /* What the line must NOT do. The pool fills at the charged spot exactly (1_920_186, no impact at all).
       Against a reference that took the whole 1% off the amount paid (1_920_000) the quote is ABOVE the
       reference, and against one that ignored the pool's part (1_925_000) it reads 25 bps of impact
       that is in fact the pool's fee. */
    const right = spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: quarterToPool(10_000), inputIsQuote: true, atSpot: twoForOne })!;
    expect(buildQuoteBreakdown({ amountIn: 1_000_000n, grossAmountOut: right, spotAmountOut: right, lpFeePips: 10_000, slippageBps: 50, integrator }).priceImpactBps).toBe(0);
    expect(buildQuoteBreakdown({ amountIn: 1_000_000n, grossAmountOut: right, spotAmountOut: 1_925_000n, lpFeePips: 10_000, slippageBps: 50, integrator }).priceImpactBps).toBe(25);
  });

  it("the impact is the impact: 2% worse than the charged spot reads 200 bps, not 200 plus the fee", () => {
    const spot = spotAfterCharges({ amountIn: 1_000_000n, feePips: 10_000, taxBps: 300, feeTakenBy: "launch", feeParts: allToLaunch(10_000), inputIsQuote: true, atSpot: twoForOne })!;
    const quoted = (spot * 98n) / 100n;
    const b = buildQuoteBreakdown({ amountIn: 1_000_000n, grossAmountOut: quoted, spotAmountOut: spot, lpFeePips: 10_000, slippageBps: 50, integrator });
    expect(b.priceImpactBps).toBe(200);
  });

  it("measured against a spot that ignored the charges, the same quote would read 592 bps", () => {
    /* What the line must NOT show: 1_920_000 * 0.98 = 1_881_600 against the uncharged 2_000_000
       is 5.92% "impact", of which 4% is the fee and the tax. */
    const b = buildQuoteBreakdown({ amountIn: 1_000_000n, grossAmountOut: 1_881_600n, spotAmountOut: 2_000_000n, lpFeePips: 10_000, slippageBps: 50, integrator });
    expect(b.priceImpactBps).toBe(592);
  });
});

/* ------------------------------------------------------------------------ */
/* the lines                                                                */
/* ------------------------------------------------------------------------ */

const ETH: TokenInfo = { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", decimals: 18, isNative: true };
const MOCHI: TokenInfo = { address: "0x00000000000000000000000000000000000000bb", symbol: "MOCHI", name: "Mochi", decimals: 18 };

/** A trade through a launch that takes the fee itself; `feeParts` is this trade's division as read (`null`: not read). */
const byLaunch = (taxBps: number | null, quote: TokenInfo | null = ETH, feeParts: LaunchFeeParts | null = allToLaunch(10_000)): LaunchCharges => ({
  feeTakenBy: "launch",
  quote,
  taxBps,
  feeParts,
});
const byPool = (taxBps: number | null, quote: TokenInfo | null = ETH): LaunchCharges => ({ feeTakenBy: "pool", quote, taxBps });

describe("the trading-fee line", () => {
  it("an ordinary pool: the pool's fee, as before", () => {
    expect(feeLine({ lpFeePips: 3_000, lpFeeUnknown: false }, undefined, "compact")).toEqual({
      label: "Pool fee",
      value: "0.3%",
      hint: "Set by the pool, paid to its liquidity providers, taken from the input.",
    });
  });

  it("a hook-set fee that was not read: said so, in each style's own words, never a number", () => {
    expect(feeLine({ lpFeePips: 0, lpFeeUnknown: true }, undefined, "compact").value).toBe("set by hook");
    expect(feeLine({ lpFeePips: 0, lpFeeUnknown: true }, undefined, "details").value).toBe("dynamic (hook-set)");
  });

  it("a launch pool whose pool charges the fee: still the pool's fee", () => {
    expect(feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byPool(300), "compact")).toMatchObject({ label: "Pool fee", value: "1%" });
  });

  it("a launch that takes this trade's whole fee: a trading fee, and the currency it is paid in", () => {
    const line = feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(300), "compact");
    expect(line.label).toBe("Trading fee");
    expect(line.value).toBe("1% · paid in ETH");
    expect(line.hint).toBe("Taken by the launch in ETH on this trade. The quoted output already includes it.");
  });

  it("a buy whose fee the pool shares: the WHOLE fee is the figure, and the hint says who receives which part", () => {
    const line = feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(300, ETH, quarterToPool(10_000)), "details");
    expect(line.label).toBe("Trading fee");
    /* Never the pool's 0.25%, never the launch's 0.75%: what the trade pays. */
    expect(line.value).toBe("1% · paid in ETH");
    expect(line.hint).toBe(
      "Paid in ETH: 0.25% goes to the pool's liquidity providers and the launch takes 0.75%. On a sell the launch takes all of it. The quoted output already includes it.",
    );
  });

  it("a division that was not read: the fee is still the fee, and the hint says the division is not known", () => {
    const line = feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(300, ETH, null), "compact");
    expect(line).toMatchObject({ label: "Trading fee", value: "1% · paid in ETH" });
    expect(line.hint).toBe("Paid in ETH. How it is divided between the pool's liquidity providers and the launch could not be read. The quoted output already includes it.");
    expect(line.hint).not.toMatch(/zero|0%|nothing/);
    /* Charges written before the parts existed carry none: the same words, never an assumed division. */
    expect(feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, { feeTakenBy: "launch", quote: ETH, taxBps: 0 }, "compact").hint).toBe(line.hint);
  });

  it("launchFeeWords names the currency it is given, or the pool's quote currency", () => {
    expect(launchFeeWords(quarterToPool(3_000), "in the pool's quote currency")).toBe(
      "Paid in the pool's quote currency: 0.075% goes to the pool's liquidity providers and the launch takes 0.225%. On a sell the launch takes all of it.",
    );
    expect(launchFeeWords(allToLaunch(3_000), "in USDC")).toBe("Taken by the launch in USDC on this trade.");
  });

  it("names the quote, whatever it is", () => {
    const NVDA: TokenInfo = { address: "0x00000000000000000000000000000000000000cc", symbol: "NVDA", name: "NVIDIA", decimals: 18 };
    expect(feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(0, NVDA), "details").value).toBe("1% · paid in NVDA");
  });

  it("leaves the currency unsaid when the launch's record was not read, and still never prints the pool's zero", () => {
    const line = feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(null, null, null), "compact");
    expect(line).toMatchObject({ label: "Trading fee", value: "1%" });
    expect(line.hint).toContain("in the pool's quote currency");
    expect(line.hint).toContain("could not be read");
  });

  it("at a launch's opening the fee is what it is", () => {
    expect(feeLine({ lpFeePips: 500_000, lpFeeUnknown: false }, byLaunch(0), "compact").value).toBe("50% · paid in ETH");
  });
});

describe("the creator-tax line", () => {
  it("is its own line, for a launch pool of either kind, read from the quote", () => {
    expect(taxLine("buy", undefined, byPool(300))).toMatchObject({ label: "Creator tax (buy)", value: "3.00%" });
    expect(taxLine("sell", undefined, byLaunch(500))).toMatchObject({ label: "Creator tax (sell)", value: "5.00% · taken in ETH" });
  });

  it("says where it is taken only where that is one currency for every trade", () => {
    expect(taxLine("buy", undefined, byPool(300))!.value).not.toContain("taken in");
    expect(taxLine("buy", undefined, byLaunch(300))!.hint).toContain("in ETH on buys and sells");
    expect(taxLine("buy", undefined, byPool(300))!.hint).toContain("on this swap");
  });

  it("a rate of zero prints none, never 0%, and names no currency", () => {
    expect(taxLine("buy", undefined, byLaunch(0))!.value).toBe("none");
    expect(taxLine("buy", undefined, byPool(0))!.value).toBe("none");
  });

  it("there is no line when there is nothing to read: no launch, or a launch with no readable tax", () => {
    expect(taxLine("buy", undefined, undefined)).toBeNull();
    expect(taxLine("buy", undefined, byPool(null))).toBeNull();
    expect(taxLine("buy", undefined, byLaunch(null))).toBeNull();
  });

  it("the host's own reading wins, per side", () => {
    expect(taxLine("buy", { buyBps: 100, sellBps: 900 }, byLaunch(300))!.value).toBe("1.00% · taken in ETH");
    expect(taxLine("sell", { buyBps: 100, sellBps: 900 }, byLaunch(300))!.value).toBe("9.00% · taken in ETH");
    expect(taxLine("sell", { buyBps: 100, sellBps: 900 }, undefined)!.value).toBe("9.00%");
    expect(taxLine("buy", null, byLaunch(300))!.value).toBe("none");
  });
});

describe("what a host is handed", () => {
  const integrator = resolveIntegratorConfig(undefined);
  const view = (launch: LaunchCharges | undefined) => {
    const quote = {
      route: [{ poolId: `0x${"11".repeat(32)}` as Hex, poolType: "CL" as const, tokenIn: ETH, tokenOut: MOCHI, lpFeePips: 10_000, hooks: ETH.address }],
      amountIn: 1_000n,
      grossAmountOut: 900n,
      spotAmountOut: 950n,
      lpFeeAmount: 0n,
      lpFeePips: 10_000,
      ...(launch === undefined ? {} : { launch }),
      estimatedGas: null,
      source: "live" as const,
    };
    const breakdown = buildQuoteBreakdown({ amountIn: 1_000n, grossAmountOut: 900n, spotAmountOut: 950n, lpFeePips: 10_000, slippageBps: 50, integrator });
    return buildSwapQuoteView({ tokenIn: ETH, tokenOut: MOCHI, quote, breakdown, rate: 0.9, status: "success", isRefreshing: false, isMock: false, updatedAt: 1 })!;
  };

  it("the fee under the name the widget prints it under, and the tax as a number", () => {
    expect(view(byLaunch(300))).toMatchObject({ fee: { label: "Trading fee", value: "1% · paid in ETH" }, creatorTaxBps: 300 });
    expect(view(byPool(300))).toMatchObject({ fee: { label: "Pool fee", value: "1%" }, creatorTaxBps: 300 });
    expect(view(undefined)).toMatchObject({ fee: { label: "Pool fee", value: "1%" }, creatorTaxBps: null });
  });
});

/* ------------------------------------------------------------------------ */
/* the adapter                                                              */
/* ------------------------------------------------------------------------ */

const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const CL_MANAGER = "0x00000000000000000000000000000000000000a2" as const;
const BIN_MANAGER = "0x00000000000000000000000000000000000000a3" as const;
const CL_QUOTER = "0x00000000000000000000000000000000000000c1" as const;
const BIN_QUOTER = "0x00000000000000000000000000000000000000c2" as const;
const CL_GUARD = "0x00000000000000000000000000000000000000d1" as const;
const BIN_GUARD = "0x00000000000000000000000000000000000000d2" as const;
const OWNER = "0x00000000000000000000000000000000000000ff" as const;

/** sqrtPriceX96 of a price of exactly 4 token1 per token0: sqrt(4) * 2^96. */
const SQRT_PRICE_4 = 2n * 2n ** 96n;

function launchPool(kind: "CL" | "BIN", generation: "lp-fee" | "quote-fee"): PoolInfo {
  /* The native currency sorts first, so it is currency0: the quote. MOCHI, the launch token, is currency1. */
  const common = { currency0: ETH.address, currency1: MOCHI.address, fee: DYNAMIC_FEE_FLAG };
  const key: PoolKey =
    kind === "CL"
      ? createCLPoolKey({ ...common, hooks: CL_GUARD, poolManager: CL_MANAGER, tickSpacing: 60, hooksRegistrationBitmap: LAUNCH_GUARD_BITMAPS[generation].CL })
      : createBinPoolKey({ ...common, hooks: BIN_GUARD, poolManager: BIN_MANAGER, binStep: 25, hooksRegistrationBitmap: LAUNCH_GUARD_BITMAPS[generation].Bin });
  return { id: poolKeyToId(key), key, poolType: kind, token0: ETH, token1: MOCHI, lpFeePips: key.fee, hooks: key.hooks, ...(kind === "CL" ? { tickSpacing: 60 } : { binStep: 25 }) };
}

const CHAIN: ChainConfig = {
  chainId: 31337,
  name: "Fake",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  contracts: {
    vault: VAULT,
    clPoolManager: CL_MANAGER,
    binPoolManager: BIN_MANAGER,
    quoter: CL_QUOTER,
    binQuoter: BIN_QUOTER,
    launchGuardHook: CL_GUARD,
    launchGuardHookClock: "timestamp",
    binLaunchGuardHook: BIN_GUARD,
  },
};

/** A revert as viem raises it from a simulation: the data is on the `ContractFunctionRevertedError` in the chain of causes. */
function revertWith(data: Hex): BaseError {
  const cause = new ContractFunctionRevertedError({ abi: CL_QUOTER_ABI, data, functionName: "quoteExactInputSingle" });
  return new BaseError('The contract function "quoteExactInputSingle" reverted.', { cause });
}

/** A quote the launch refused: the quoter, around core's wrapper, around the guard's own error. */
function notFilled(expected: bigint, traded: bigint): BaseError {
  const bare = encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "SwapNotFilled", args: [expected, traded] });
  const wrapped = encodeErrorResult({ abi: WRAPPED_ERROR_ABI, errorName: "WrappedError", args: [CL_GUARD, "0x12345678", bare, "0x"] });
  return revertWith(encodeErrorResult({ abi: CL_QUOTER_ABI, errorName: "UnexpectedRevertBytes", args: [wrapped] }));
}

interface World {
  /** What the quoter answers for an exact amount in, or the error it raises. Absent: an unexpected amount, which throws. */
  readonly quote: (amountIn: bigint, zeroForOne: boolean) => bigint | Error;
  readonly currentFee: number;
  /**
   * What the launch leaves the pool of a buy's fee, in bps, as it answers `LP_SHARE_BPS` and
   * `currentFeeParts`. Absent: it leaves nothing (0). `"reverts"`: it answers neither.
   */
  readonly lpShareBps?: number | "reverts";
  readonly taxRates: readonly [number, number] | "reverts";
  readonly launchTokenIsCurrency0?: boolean;
  /** `getLaunch` answers an unclaimed record. */
  readonly unclaimed?: boolean;
}

function fakeClient(world: World) {
  const quoted: bigint[] = [];
  const reads: string[] = [];
  const client = {
    quoted,
    reads,
    async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
      if (req.functionName !== "quoteExactInputSingle") throw new Error(`fake: unexpected simulateContract ${req.functionName}`);
      const params = req.args[0] as { exactAmount: bigint; zeroForOne: boolean };
      quoted.push(params.exactAmount);
      const answer = world.quote(params.exactAmount, params.zeroForOne);
      if (answer instanceof Error) throw answer;
      return { result: [answer, 100_000n] as const };
    },
    async readContract(req: { address: Address; functionName: string }): Promise<unknown> {
      reads.push(req.functionName);
      switch (req.functionName) {
        case "currentFee":
          return BigInt(world.currentFee);
        case "LP_SHARE_BPS":
          if (world.lpShareBps === "reverts") throw revertWith("0x");
          return world.lpShareBps ?? 0;
        case "currentFeeParts": {
          if (world.lpShareBps === "reverts") throw revertWith("0x");
          const lp = Math.floor((world.currentFee * (world.lpShareBps ?? 0)) / 10_000);
          return [lp, world.currentFee - lp, world.currentFee] as const;
        }
        case "currentTaxRates":
          if (world.taxRates === "reverts") throw revertWith("0x");
          return world.taxRates;
        case "getLaunch":
          return {
            owner: world.unclaimed === true ? ETH.address : OWNER,
            startTime: 1n,
            decaySeconds: 60,
            enabled: true,
            initialFeeBips: 500_000,
            finalFeeBips: 10_000,
            maxBuyPerTx: 0n,
            launchTokenIsCurrency0: world.launchTokenIsCurrency0 ?? false,
            launched: true,
          };
        case "getSlot0":
          return req.address === CL_MANAGER ? [SQRT_PRICE_4, 0, 0, 0] : [8_388_608, 0, 0];
        default:
          throw new Error(`fake: unexpected readContract ${req.functionName} at ${req.address}`);
      }
    },
  };
  return client;
}

const adapterFor = (client: ReturnType<typeof fakeClient>, pools: readonly PoolInfo[]) =>
  createViemAdapter({ chain: CHAIN, publicClient: client as unknown as PublicClient, tokens: [ETH, MOCHI], pools });

describe("who charges a launch pool's fee, from its own key", () => {
  it("only the key of a launch that takes the fee itself says so", () => {
    expect(launchFeeTakenBy(launchPool("CL", "quote-fee"))).toBe("launch");
    expect(launchFeeTakenBy(launchPool("BIN", "quote-fee"))).toBe("launch");
    expect(launchFeeTakenBy(launchPool("CL", "lp-fee"))).toBe("pool");
    expect(launchFeeTakenBy(launchPool("BIN", "lp-fee"))).toBe("pool");
  });

  it("an older launch pool, whose key carries neither bitmap, stays what it always was", () => {
    const key = createCLPoolKey({ currency0: ETH.address, currency1: MOCHI.address, hooks: CL_GUARD, poolManager: CL_MANAGER, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooksRegistrationBitmap: 0x0041 });
    expect(launchFeeTakenBy({ key, poolType: "CL" })).toBe("pool");
  });
});

describe("quoteSwap through a launch pool", () => {
  it("a launch that takes the fee itself, on a buy: who, which currency, and a spot net of fee and tax", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 3_800_000n, currentFee: 10_000, taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });

    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 300, feeParts: { poolPips: 0, launchPips: 10_000 } });
    expect(quote.lpFeePips).toBe(10_000);
    // This launch leaves the pool nothing, as it answered: no LP fee is paid.
    expect(quote.lpFeeAmount).toBe(0n);
    // 1_000_000 - 10_000 (fee) - 30_000 (buy tax) = 960_000 traded, at 4 MOCHI per ETH = 3_840_000
    expect(quote.spotAmountOut).toBe(3_840_000n);
    expect(quote.grossAmountOut).toBe(3_800_000n);
    // The division was asked of the launch, for this pool.
    expect(client.reads).toContain("currentFeeParts");
  });

  it("a launch that leaves the pool a share, on a buy: each part as read, the pool's fee as an LP fee, and a spot net of both", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 3_800_000n, currentFee: 10_000, lpShareBps: 2_500, taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });

    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 300, feeParts: { poolPips: 2_500, launchPips: 7_500 } });
    // The fee the trade pays is the whole fee.
    expect(quote.lpFeePips).toBe(10_000);
    // launch 7_500 + tax 30_000 -> 962_500 reaches the pool; the pool's 0.25% of that, rounded up = 2_407
    expect(quote.lpFeeAmount).toBe(2_407n);
    // 962_500 - 2_407 = 960_093 traded, at 4 MOCHI per ETH = 3_840_372
    expect(quote.spotAmountOut).toBe(3_840_372n);
    // The impact is measured against THAT: (3_840_372 - 3_800_000) / 3_840_372 = 1.05%, none of it a fee.
    const b = buildQuoteBreakdown({ amountIn: quote.amountIn, grossAmountOut: quote.grossAmountOut, spotAmountOut: quote.spotAmountOut, lpFeePips: quote.lpFeePips, slippageBps: 50, integrator: resolveIntegratorConfig(undefined) });
    expect(b.priceImpactBps).toBe(105);
  });

  it("the same launch on a sell: the pool charges nothing and the launch takes the whole fee", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 230_000n, currentFee: 10_000, lpShareBps: 2_500, taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: MOCHI, tokenOut: ETH, amountIn: 1_000_000n });

    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 500, feeParts: { poolPips: 0, launchPips: 10_000 } });
    expect(quote.lpFeeAmount).toBe(0n);
    // 250_000 ETH out; fee 2_500 + sell tax 12_500 = 15_000 -> 235_000: a sell is what it was.
    expect(quote.spotAmountOut).toBe(235_000n);
  });

  it("a launch that does not say how its fee is divided: the fee is reported, the division is null, and a buy has no spot", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 3_800_000n, currentFee: 10_000, lpShareBps: "reverts", taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });

    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 300, feeParts: null });
    expect(quote.lpFeePips).toBe(10_000);
    expect(quote.grossAmountOut).toBe(3_800_000n);
    // No reference, so no impact: never one worked out from a guessed division.
    expect(quote.spotAmountOut).toBeNull();
    expect(buildQuoteBreakdown({ amountIn: quote.amountIn, grossAmountOut: quote.grossAmountOut, spotAmountOut: quote.spotAmountOut, lpFeePips: quote.lpFeePips, slippageBps: 50, integrator: resolveIntegratorConfig(undefined) }).priceImpactBps).toBeNull();
    // The price was not even read.
    expect(client.reads).not.toContain("getSlot0");
    // And the fee line says so.
    expect(feeLine({ lpFeePips: quote.lpFeePips, lpFeeUnknown: false }, quote.launch, "details").hint).toContain("could not be read");
  });

  it("a sell through such a launch still has its spot: the launch takes a sell's whole fee whatever it leaves the pool on buys", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 230_000n, currentFee: 10_000, lpShareBps: "reverts", taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: MOCHI, tokenOut: ETH, amountIn: 1_000_000n });
    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 500, feeParts: null });
    expect(quote.spotAmountOut).toBe(235_000n);
  });

  it("a launch whose pool charges the fee is never asked how the fee is divided", async () => {
    const pool = launchPool("CL", "lp-fee");
    const client = fakeClient({ quote: () => 3_700_000n, currentFee: 10_000, lpShareBps: "reverts", taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });
    expect(quote.launch).toEqual({ feeTakenBy: "pool", quote: ETH, taxBps: 300 });
    expect(client.reads).not.toContain("currentFeeParts");
    expect(client.reads).not.toContain("LP_SHARE_BPS");
  });

  it("the same launch on a sell: the sell rate, and the charges off the quote paid out", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 230_000n, currentFee: 10_000, taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: MOCHI, tokenOut: ETH, amountIn: 1_000_000n });

    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 500, feeParts: { poolPips: 0, launchPips: 10_000 } });
    // 1_000_000 MOCHI at 4 per ETH = 250_000 ETH out; fee 2_500 + sell tax 12_500 = 15_000 -> 235_000
    expect(quote.spotAmountOut).toBe(235_000n);
  });

  it("a launch whose pool charges the fee: the fee off the input, the tax off what is received", async () => {
    const pool = launchPool("CL", "lp-fee");
    const client = fakeClient({ quote: () => 3_700_000n, currentFee: 10_000, taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });

    expect(quote.launch).toEqual({ feeTakenBy: "pool", quote: ETH, taxBps: 300 });
    expect(quote.lpFeeAmount).toBe(10_000n);
    // 990_000 traded -> 3_960_000 MOCHI; 3% tax on what is received = 118_800 -> 3_841_200
    expect(quote.spotAmountOut).toBe(3_841_200n);
  });

  it("a launch with no tax: the spot is net of the fee alone, as it always was", async () => {
    const pool = launchPool("CL", "lp-fee");
    const client = fakeClient({ quote: () => 3_900_000n, currentFee: 10_000, taxRates: [0, 0] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });
    expect(quote.launch).toEqual({ feeTakenBy: "pool", quote: ETH, taxBps: 0 });
    expect(quote.spotAmountOut).toBe(3_960_000n);
  });

  it("a guard with no tax to read: the tax is unread, not none, and the spot leaves it out", async () => {
    const pool = launchPool("CL", "lp-fee");
    const client = fakeClient({ quote: () => 3_900_000n, currentFee: 10_000, taxRates: "reverts" });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });
    expect(quote.launch).toEqual({ feeTakenBy: "pool", quote: ETH, taxBps: null });
    expect(quote.spotAmountOut).toBe(3_960_000n);
  });

  it("the quote currency follows the launch's own record, not the token order", async () => {
    /* A launch token that sorts FIRST: the quote is then currency1, and paying MOCHI... is paying the quote. */
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 1n, currentFee: 10_000, taxRates: [300, 500], launchTokenIsCurrency0: true });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: MOCHI, tokenOut: ETH, amountIn: 1_000_000n });
    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: MOCHI, taxBps: 300, feeParts: { poolPips: 0, launchPips: 10_000 } });
  });

  it("a pool the launch has no record of: no direction, so no rate is picked for the trade", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 1n, currentFee: 10_000, taxRates: [300, 500], unclaimed: true });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });
    /* Nor can the fee's parts be picked: a buy and a sell are divided differently. */
    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: null, taxBps: null, feeParts: null });
  });

  it("reads which side is the launch token once per pool", async () => {
    const pool = launchPool("CL", "quote-fee");
    const client = fakeClient({ quote: () => 1n, currentFee: 10_000, taxRates: [300, 500] });
    const adapter = adapterFor(client, [pool]);
    await adapter.quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000n });
    await adapter.quoteSwap({ tokenIn: MOCHI, tokenOut: ETH, amountIn: 1_000n });
    expect(client.reads.filter((r) => r === "getLaunch")).toHaveLength(1);
    // The tax is a rate that ends with no transaction: it is read every time.
    expect(client.reads.filter((r) => r === "currentTaxRates")).toHaveLength(2);
    // So is the fee, and its parts with it.
    expect(client.reads.filter((r) => r === "currentFeeParts")).toHaveLength(2);
  });

  it("a Bin launch pool is read through the Bin guard", async () => {
    const pool = launchPool("BIN", "quote-fee");
    const client = fakeClient({ quote: () => 1n, currentFee: 10_000, taxRates: [300, 500] });
    const quote = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 1_000_000n });
    expect(quote.launch).toEqual({ feeTakenBy: "launch", quote: ETH, taxBps: 300, feeParts: { poolPips: 0, launchPips: 10_000 } });
  });
});

/* ------------------------------------------------------------------------ */
/* a trade the pool cannot fill                                             */
/* ------------------------------------------------------------------------ */

describe("a trade larger than the pool can fill", () => {
  const pool = launchPool("CL", "quote-fee");

  it("is read out of the refusal, through everything wrapped around it", () => {
    expect(swapNotFilledOf(notFilled(9_600n, 6_000n))).toEqual({ expected: 9_600n, traded: 6_000n });
    expect(swapNotFilledOf(new Error("some other failure"))).toBeNull();
    expect(swapNotFilledOf(revertWith(encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "TradingNotOpen", args: [pool.id, 5n, 4n] })))).toBeNull();
  });

  it("is a SwapTooLargeError with the most that fills, once the pool has quoted that amount", async () => {
    /* 10_000 named, fee 1% + tax 3%: 9_600 had to trade, the pool traded 6_000.
       Largest X with X - floor(X/100) - floor(3X/100) <= 6_000: 6_250 -> 62 + 187 = 249 -> 6_001 (too much);
       6_249 -> 62 + 187 = 249 -> 6_000. So 6_249. */
    const client = fakeClient({
      quote: (amountIn) => (amountIn === 10_000n ? notFilled(9_600n, 6_000n) : amountIn === 6_249n ? 24_000n : new Error(`fake: unexpected amount ${amountIn}`)),
      currentFee: 10_000,
      taxRates: [300, 500],
    });
    const error = await adapterFor(client, [pool])
      .quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(SwapTooLargeError);
    const tooLarge = error as SwapTooLargeError;
    expect(tooLarge.largestAmountIn).toBe(6_249n);
    expect(tooLarge.amountIn).toBe(10_000n);
    expect(tooLarge.tokenIn).toBe(ETH);
    // The amount offered is one the pool was asked about, and answered.
    expect(client.quoted).toEqual([10_000n, 6_249n]);
  });

  it("sizes it from what the LAUNCH takes: the pool's own part of the fee is charged inside what the pool traded", async () => {
    /* The same refusal through a launch that leaves the pool a quarter of the 1% fee: the launch takes
       0.75% + 3% of the amount named. Largest X with X - floor(75X/10_000) - floor(3X/100) <= 6_000:
       6_233 -> 46 + 186 = 232 -> 6_001 (too much); 6_232 -> 46 + 186 = 232 -> 6_000. So 6_232,
       not the 6_249 the whole fee would give, which the pool could not fill. */
    const client = fakeClient({
      quote: (amountIn) => (amountIn === 10_000n ? notFilled(9_625n, 6_000n) : amountIn === 6_232n ? 24_000n : new Error(`fake: unexpected amount ${amountIn}`)),
      currentFee: 10_000,
      lpShareBps: 2_500,
      taxRates: [300, 500],
    });
    const error = (await adapterFor(client, [pool])
      .quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n })
      .then(() => null, (e: unknown) => e)) as SwapTooLargeError;
    expect(error).toBeInstanceOf(SwapTooLargeError);
    expect(error.largestAmountIn).toBe(6_232n);
    expect(client.quoted).toEqual([10_000n, 6_232n]);
  });

  it("offers no amount when the launch did not say how its fee is divided", async () => {
    const client = fakeClient({ quote: () => notFilled(9_600n, 6_000n), currentFee: 10_000, lpShareBps: "reverts", taxRates: [300, 500] });
    const error = (await adapterFor(client, [pool])
      .quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n })
      .then(() => null, (e: unknown) => e)) as SwapTooLargeError;
    expect(error).toBeInstanceOf(SwapTooLargeError);
    expect(error.largestAmountIn).toBeNull();
    // Nothing was sized, so nothing more was quoted.
    expect(client.quoted).toEqual([10_000n]);
  });

  it("offers no amount the pool did not quote", async () => {
    const client = fakeClient({
      quote: (amountIn) => (amountIn === 10_000n ? notFilled(9_600n, 6_000n) : notFilled(1n, 0n)),
      currentFee: 10_000,
      taxRates: [300, 500],
    });
    const error = (await adapterFor(client, [pool])
      .quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n })
      .then(() => null, (e: unknown) => e)) as SwapTooLargeError;
    expect(error).toBeInstanceOf(SwapTooLargeError);
    expect(error.largestAmountIn).toBeNull();
  });

  it("offers no amount when the tax could not be read, or the pool traded nothing", async () => {
    const unread = fakeClient({ quote: () => notFilled(9_600n, 6_000n), currentFee: 10_000, taxRates: "reverts" });
    const a = (await adapterFor(unread, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n }).then(() => null, (e: unknown) => e)) as SwapTooLargeError;
    expect(a).toBeInstanceOf(SwapTooLargeError);
    expect(a.largestAmountIn).toBeNull();
    expect(unread.quoted).toEqual([10_000n]);

    const empty = fakeClient({ quote: () => notFilled(9_600n, 0n), currentFee: 10_000, taxRates: [300, 500] });
    const b = (await adapterFor(empty, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n }).then(() => null, (e: unknown) => e)) as SwapTooLargeError;
    expect(b.largestAmountIn).toBeNull();
  });

  it("any other refusal is still a failure to quote, not this state", async () => {
    const other = revertWith(encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "TradingNotOpen", args: [pool.id, 5n, 4n] }));
    const client = fakeClient({ quote: () => other, currentFee: 10_000, taxRates: [300, 500] });
    const error = await adapterFor(client, [pool]).quoteSwap({ tokenIn: ETH, tokenOut: MOCHI, amountIn: 10_000n }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect(error).not.toBeInstanceOf(SwapTooLargeError);
  });
});

describe("what the trader reads", () => {
  it("the state in one plain sentence, with the amount in the token's own units", () => {
    const e = new SwapTooLargeError(ETH, 10n ** 19n, 6_249n * 10n ** 14n);
    expect(describeError(e, "quote")).toBe("This trade is larger than the pool can fill. The most it can fill right now is 0.6249 ETH.");
    expect(describeError(new SwapTooLargeError(ETH, 10n ** 19n, null), "quote")).toBe("This trade is larger than the pool can fill. Try a smaller amount.");
    expect(tooLargeMessage(MOCHI, "12")).toBe("This trade is larger than the pool can fill. The most it can fill right now is 12 MOCHI.");
  });

  it("the same refusal met while sending is the same sentence, never a selector or a revert string", () => {
    const text = describeError(notFilled(9_600n, 6_000n), "swap");
    expect(text).toBe("This trade is larger than the pool can fill. Try a smaller amount.");
    expect(text).not.toMatch(/0x|revert|SwapNotFilled|unrecognised/i);
  });

  it("no line and no sentence names how the contracts are built", () => {
    const copy = [
      ...Object.values(feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(300), "compact")),
      ...Object.values(feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(300, ETH, quarterToPool(10_000)), "details")),
      ...Object.values(feeLine({ lpFeePips: 10_000, lpFeeUnknown: false }, byLaunch(300, ETH, null), "details")),
      ...Object.values(taxLine("buy", undefined, byLaunch(300))!),
      tooLargeMessage(ETH, "1"),
      tooLargeMessage(ETH, null),
    ].join(" ");
    for (const word of ["generation", "guard", "bitmap", "deployed", "quote-fee", "lp-fee", "beforeSwap"]) expect(copy.toLowerCase(), word).not.toContain(word);
  });
});
