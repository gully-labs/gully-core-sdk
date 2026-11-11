// SPDX-License-Identifier: MIT
/* ============================================================================
   THE MARKET-CAP ARITHMETIC.

   This is the half of the native-price work with no network in it, and it is the
   half that decides what a creator's pool opens at. CLAUDE.md names the failure
   mode exactly: "a 5 ETH cap on a 1e9 supply means typing 0.000000005. One zero
   out is 10x, permanent, and the LP is locked forever."

   So the assertions below are not smoke tests. Each one pins a scale — token
   decimals, quote decimals, feed decimals, USD decimals — against a figure worked
   out independently of the implementation, because a conversion that is wrong by
   10^6 passes every test that only checks it against itself.
   ============================================================================ */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENING_MARKET_CAP_USD,
  formatUsdAmount,
  marketCapFromOpeningPrice,
  nativeMarketCapFromOpeningPrice,
  openingPriceFromMarketCap,
  openingPriceFromNativeMarketCap,
  usdWholeDollars,
  type NativeUsdRate,
  type UsdAmount,
} from "../src/price/marketCap.js";

/** $2,000.00 per ETH at Chainlink's usual 8 decimals. Round, so the maths is checkable. */
const ETH_AT_2000: NativeUsdRate = { answer: 200_000_000_000n, answerDecimals: 8 };
/** $1.00, for the stablecoin-quoted cases. */
const ONE_DOLLAR: NativeUsdRate = { answer: 100_000_000n, answerDecimals: 8 };

const USD_3500: UsdAmount = { amount: 350_000n, decimals: 2 };

describe("openingPriceFromMarketCap", () => {
  /* The worked example, computed by hand and then asserted:
       $3,500 / $2,000 per ETH               = 1.75 ETH of market cap
       1.75 ETH / 1e9 tokens                 = 1.75e-9 ETH per token
       1.75e-9 * 1e18                        = 1_750_000_000 wei per whole token
     Note the shape of the answer: nine significant figures below the decimal
     point, which is the range the "one zero out is 10x" warning lives in. */
  it("turns the $3.5K default into wei per token for a 1e9 supply", () => {
    const price = openingPriceFromMarketCap({
      usdTarget: USD_3500,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    });
    expect(price).toBe(1_750_000_000n);
  });

  /* A 6-decimal quote is the case a float implementation gets wrong quietly:
     USDG and USDC are 6 decimals paired against 18-decimal tokens, and CLAUDE.md
     calls that out in the address book for exactly this reason.
       $3,500 / $1.00 = 3,500 USDG of cap
       3,500 / 1e9 tokens = 3.5e-6 USDG per token
       3.5e-6 * 1e6 = 3.5 raw units -> 3 rounding DOWN, 4 rounding UP. */
  it("handles a 6-decimal quote, and the rounding direction is visible in it", () => {
    const args = {
      usdTarget: USD_3500,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ONE_DOLLAR,
      quoteDecimals: 6,
    } as const;
    expect(openingPriceFromMarketCap(args)).toBe(3n);
    expect(openingPriceFromMarketCap({ ...args, rounding: "down" })).toBe(3n);
    expect(openingPriceFromMarketCap({ ...args, rounding: "up" })).toBe(4n);
  });

  /* The token's own decimals must move the answer by exactly their power of ten
     and nothing else: same cap, same supply COUNT, different decimals. */
  it("scales with the token's decimals and with nothing else", () => {
    const base = {
      usdTarget: USD_3500,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    } as const;
    const at18 = openingPriceFromMarketCap({
      ...base,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
    });
    const at6 = openingPriceFromMarketCap({
      ...base,
      totalSupply: 1_000_000_000n * 10n ** 6n,
      tokenDecimals: 6,
    });
    const at0 = openingPriceFromMarketCap({ ...base, totalSupply: 1_000_000_000n, tokenDecimals: 0 });
    // One billion whole tokens is one billion whole tokens: the price per WHOLE
    // token is the same number regardless of how finely the token divides.
    expect(at18).toBe(1_750_000_000n);
    expect(at6).toBe(1_750_000_000n);
    expect(at0).toBe(1_750_000_000n);
  });

  /* An 18-decimal feed exists and is selected on some chains (BNB and Monad both
     publish one). The answer must not move because the FEED's scale did. */
  it("gives the same price from an 18-decimal feed as from an 8-decimal one", () => {
    const common = {
      usdTarget: USD_3500,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteDecimals: 18,
    } as const;
    const from8 = openingPriceFromMarketCap({ ...common, quoteUsd: ETH_AT_2000 });
    const from18 = openingPriceFromMarketCap({
      ...common,
      quoteUsd: { answer: 2000n * 10n ** 18n, answerDecimals: 18 },
    });
    expect(from18).toBe(from8);
  });

  /* USD scale is a free parameter too: cents, or a feed-shaped 8-decimal target. */
  it("gives the same price whatever scale the USD target is expressed in", () => {
    const common = {
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    } as const;
    expect(openingPriceFromMarketCap({ ...common, usdTarget: { amount: 3500n, decimals: 0 } })).toBe(1_750_000_000n);
    expect(openingPriceFromMarketCap({ ...common, usdTarget: { amount: 350_000n, decimals: 2 } })).toBe(1_750_000_000n);
    expect(
      openingPriceFromMarketCap({ ...common, usdTarget: { amount: 3500n * 10n ** 8n, decimals: 8 } }),
    ).toBe(1_750_000_000n);
  });

  /* A price of zero is a real answer and the caller has to handle it: a pool
     cannot open at zero, so the UI must say "this cap is unrepresentable at this
     supply" rather than sending it. Asserted so nobody "fixes" it into a 1n. */
  it("returns 0n rather than a minimum when the cap is below one raw quote unit per token", () => {
    const price = openingPriceFromMarketCap({
      usdTarget: USD_3500,
      totalSupply: 10n ** 30n,
      tokenDecimals: 18,
      quoteUsd: ONE_DOLLAR,
      quoteDecimals: 6,
    });
    expect(price).toBe(0n);
  });

  /* No intermediate may be a double. 2^53 is where a `number` stops counting by
     ones; this supply and this cap put the numerator far past it, and the answer
     is still exact to the unit. */
  it("stays exact well past 2**53", () => {
    const price = openingPriceFromMarketCap({
      usdTarget: { amount: 1n, decimals: 0 },
      totalSupply: 3n,
      tokenDecimals: 18,
      quoteUsd: { answer: 1n, answerDecimals: 0 },
      quoteDecimals: 18,
    });
    // 1 * 10^36 / 3 = 333...3 with 36 digits, truncated.
    expect(price).toBe((10n ** 36n) / 3n);
    expect(price.toString()).toBe("333333333333333333333333333333333333");
  });

  it("refuses inputs it cannot divide by, instead of returning something", () => {
    const base = {
      usdTarget: USD_3500,
      totalSupply: 1_000n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    } as const;
    expect(() => openingPriceFromMarketCap({ ...base, totalSupply: 0n })).toThrow(RangeError);
    expect(() => openingPriceFromMarketCap({ ...base, totalSupply: -1n })).toThrow(RangeError);
    expect(() =>
      openingPriceFromMarketCap({ ...base, quoteUsd: { answer: 0n, answerDecimals: 8 } }),
    ).toThrow(RangeError);
    expect(() =>
      openingPriceFromMarketCap({ ...base, quoteUsd: { answer: -1n, answerDecimals: 8 } }),
    ).toThrow(RangeError);
    expect(() => openingPriceFromMarketCap({ ...base, tokenDecimals: 1.5 })).toThrow(RangeError);
    expect(() => openingPriceFromMarketCap({ ...base, quoteDecimals: -1 })).toThrow(RangeError);
    expect(() => openingPriceFromMarketCap({ ...base, quoteDecimals: 37 })).toThrow(RangeError);
  });
});

describe("marketCapFromOpeningPrice", () => {
  it("is the stated inverse of the worked example", () => {
    const cap = marketCapFromOpeningPrice({
      price: 1_750_000_000n,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    });
    expect(cap).toEqual({ amount: 350_000n, decimals: 2 });
    expect(formatUsdAmount(cap)).toBe("3500.00");
  });

  /* The creator trap, as a test: one zero fewer in the typed price is a tenth of
     the market cap, and the screen has to show that. */
  it("shows a mistyped price as a tenth of the cap", () => {
    const common = {
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    } as const;
    const right = marketCapFromOpeningPrice({ ...common, price: 1_750_000_000n });
    const typo = marketCapFromOpeningPrice({ ...common, price: 175_000_000n });
    expect(formatUsdAmount(right)).toBe("3500.00");
    expect(formatUsdAmount(typo)).toBe("350.00");
  });

  it("answers in whatever USD scale is asked for", () => {
    const common = {
      price: 1_750_000_000n,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    } as const;
    expect(marketCapFromOpeningPrice({ ...common, usdDecimals: 0 })).toEqual({ amount: 3500n, decimals: 0 });
    expect(marketCapFromOpeningPrice({ ...common, usdDecimals: 8 })).toEqual({
      amount: 3500n * 10n ** 8n,
      decimals: 8,
    });
  });

  /* The documented round-trip property. It is an INEQUALITY, not an equality, and
     the docs say so; a future change that makes it exact in one direction and not
     the other would break a UI that assumed the doc. */
  it("round-trips to at most the original target, with both defaults", () => {
    const supplies = [1n, 7n, 999_999_937n, 10n ** 9n, 10n ** 27n];
    for (const supply of supplies) {
      const price = openingPriceFromMarketCap({
        usdTarget: USD_3500,
        totalSupply: supply,
        tokenDecimals: 18,
        quoteUsd: ETH_AT_2000,
        quoteDecimals: 18,
      });
      const back = marketCapFromOpeningPrice({
        price,
        totalSupply: supply,
        tokenDecimals: 18,
        quoteUsd: ETH_AT_2000,
        quoteDecimals: 18,
      });
      expect(back.decimals).toBe(2);
      expect(back.amount).toBeLessThanOrEqual(USD_3500.amount);
    }
  });

  it("refuses a negative price and a zero supply", () => {
    const base = {
      price: 1n,
      totalSupply: 10n ** 18n,
      tokenDecimals: 18,
      quoteUsd: ETH_AT_2000,
      quoteDecimals: 18,
    } as const;
    expect(() => marketCapFromOpeningPrice({ ...base, price: -1n })).toThrow(RangeError);
    expect(() => marketCapFromOpeningPrice({ ...base, totalSupply: 0n })).toThrow(RangeError);
  });
});

describe("the native-only path, for chains with no USD source", () => {
  /* Tier 4's arithmetic. No oracle appears anywhere in it, which is the point:
     a chain Gully Core cannot price still gets a launch, priced in its own units. */
  it("converts a native cap to a price with no oracle in the path", () => {
    const price = openingPriceFromNativeMarketCap({
      quoteTarget: 5n * 10n ** 18n, // 5 ETH
      totalSupply: 1_000_000_000n * 10n ** 18n,
      tokenDecimals: 18,
    });
    // 5e18 wei / 1e9 tokens = 5e9 wei per whole token — the exact figure
    // CLAUDE.md says creators mistype as 0.000000005.
    expect(price).toBe(5_000_000_000n);
  });

  it("inverts exactly when the division is exact", () => {
    const totalSupply = 1_000_000_000n * 10n ** 18n;
    const cap = nativeMarketCapFromOpeningPrice({ price: 5_000_000_000n, totalSupply, tokenDecimals: 18 });
    expect(cap).toBe(5n * 10n ** 18n);
  });

  it("rounds as asked when it is not exact", () => {
    const args = { quoteTarget: 10n, totalSupply: 3n * 10n ** 18n, tokenDecimals: 18 } as const;
    expect(openingPriceFromNativeMarketCap(args)).toBe(3n);
    expect(openingPriceFromNativeMarketCap({ ...args, rounding: "up" })).toBe(4n);
  });
});

describe("USD amount helpers", () => {
  it("formats without ever constructing a Number", () => {
    expect(formatUsdAmount({ amount: 350_000n, decimals: 2 })).toBe("3500.00");
    expect(formatUsdAmount({ amount: 7n, decimals: 2 })).toBe("0.07");
    expect(formatUsdAmount({ amount: 0n, decimals: 2 })).toBe("0.00");
    expect(formatUsdAmount({ amount: 3500n, decimals: 0 })).toBe("3500");
    expect(formatUsdAmount({ amount: -350_000n, decimals: 2 })).toBe("-3500.00");
    // Past 2^53 cents, every digit still prints.
    expect(formatUsdAmount({ amount: 123_456_789_012_345_678_901n, decimals: 2 })).toBe("1234567890123456789.01");
  });

  it("refuses fractional dollars rather than rounding them", () => {
    expect(usdWholeDollars(3500)).toEqual({ amount: 350_000n, decimals: 2 });
    expect(() => usdWholeDollars(3500.5)).toThrow(RangeError);
  });

  /* The number, pinned. If this ever changes it should change in a diff
     somebody reviewed, not by drift. */
  it("pins the $3,500 default decided on 2026-09-20", () => {
    expect(DEFAULT_OPENING_MARKET_CAP_USD).toEqual({ amount: 350_000n, decimals: 2 });
    expect(formatUsdAmount(DEFAULT_OPENING_MARKET_CAP_USD)).toBe("3500.00");
  });
});
