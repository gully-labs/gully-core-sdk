// SPDX-License-Identifier: MIT
/**
 * Bin price <-> id, against core's `PriceHelper` definition:
 *
 *     price(id) = (1 + binStep / 10_000) ^ (id - 2^23)
 *
 * The chain takes an id, never a price, so what these tests pin is that the id
 * a typed price snaps to is the one whose band contains it, in both token
 * orders and across decimals.
 */
import { describe, expect, it } from "vitest";

import {
  BIN_ID_ONE,
  MAX_BIN_ID,
  binActiveIdForLaunch,
  binBase,
  binIdFromRawPrice,
  binLaunchPriceAtId,
  binRawPriceFromId,
} from "../src/index.js";

describe("binRawPriceFromId", () => {
  it("is exactly 1 at core's REAL_ID_SHIFT, whatever the step", () => {
    expect(BIN_ID_ONE).toBe(8_388_608);
    for (const step of [1, 10, 25, 100, 1000, 65535]) expect(binRawPriceFromId(BIN_ID_ONE, step)).toBe(1);
  });

  it("multiplies by the base per id", () => {
    expect(binRawPriceFromId(BIN_ID_ONE + 1, 100)).toBeCloseTo(1.01, 12);
    expect(binRawPriceFromId(BIN_ID_ONE - 1, 100)).toBeCloseTo(1 / 1.01, 12);
    expect(binRawPriceFromId(BIN_ID_ONE + 100, 25)).toBeCloseTo(1.0025 ** 100, 9);
    expect(binBase(25)).toBe(1.0025);
  });

  it("refuses ids outside uint24 and bad steps", () => {
    expect(() => binRawPriceFromId(-1, 100)).toThrow(RangeError);
    expect(() => binRawPriceFromId(MAX_BIN_ID + 1, 100)).toThrow(RangeError);
    expect(() => binRawPriceFromId(BIN_ID_ONE, 0)).toThrow(RangeError);
    expect(() => binRawPriceFromId(BIN_ID_ONE, 70_000)).toThrow(RangeError);
  });
});

describe("binIdFromRawPrice", () => {
  it("round-trips every id it is handed, for several steps", () => {
    for (const step of [1, 10, 25, 100, 500]) {
      for (const offset of [-5000, -1000, -37, -1, 0, 1, 42, 1000, 5000]) {
        const id = BIN_ID_ONE + offset;
        expect(binIdFromRawPrice(binRawPriceFromId(id, step), step), `step ${step} id ${id}`).toBe(id);
      }
    }
  });

  it("truncates toward zero inside a band, like core", () => {
    // Between bins +1 and +2 at 1% steps: core's log ratio is 1.x -> id + 1.
    expect(binIdFromRawPrice(1.015, 100)).toBe(BIN_ID_ONE + 1);
    // Between bins -1 and -2: ratio is -1.x -> trunc gives -1.
    expect(binIdFromRawPrice(1 / 1.015, 100)).toBe(BIN_ID_ONE - 1);
  });

  it("refuses non-positive prices", () => {
    expect(() => binIdFromRawPrice(0, 100)).toThrow(RangeError);
    expect(() => binIdFromRawPrice(-1, 100)).toThrow(RangeError);
    expect(() => binIdFromRawPrice(Number.NaN, 100)).toThrow(RangeError);
  });
});

describe("binActiveIdForLaunch / binLaunchPriceAtId", () => {
  it("folds decimals in: an 18-decimal token quoted in a 6-decimal stable", () => {
    const input = { launchTokenIsCurrency0: true, launchDecimals: 18, quoteDecimals: 6, binStep: 100 };
    // 0.05 USDC per token, raw: 0.05 * 1e6 / 1e18 = 5e-14 currency1 per currency0.
    const id = binActiveIdForLaunch({ ...input, quotePerLaunchToken: 0.05 });
    expect(id).toBe(binIdFromRawPrice(5e-14, 100));
    const shown = binLaunchPriceAtId(id, input);
    // The id's own price is within one bin (1%) of the typed price. Core truncates
    // the log ratio toward zero, so below a raw price of 1 the snap is UPWARD
    // (toward 1); a UI must show this number, not the typed one.
    expect(shown).toBeLessThan(0.05 * 1.01);
    expect(shown).toBeGreaterThan(0.05 / 1.01);
  });

  it("takes the reciprocal when the launch token sorts second", () => {
    const first = binActiveIdForLaunch({
      launchTokenIsCurrency0: true,
      launchDecimals: 18,
      quoteDecimals: 18,
      quotePerLaunchToken: 4,
      binStep: 100,
    });
    const second = binActiveIdForLaunch({
      launchTokenIsCurrency0: false,
      launchDecimals: 18,
      quoteDecimals: 18,
      quotePerLaunchToken: 4,
      binStep: 100,
    });
    // 4 is not an exact power of 1.01, so the two truncations straddle REAL_ID_SHIFT
    // symmetrically to within one bin.
    expect(first).toBeGreaterThan(BIN_ID_ONE);
    expect(second).toBeLessThan(BIN_ID_ONE);
    expect(Math.abs(first - BIN_ID_ONE - (BIN_ID_ONE - second))).toBeLessThanOrEqual(1);
    // And rendering the chosen id in the human direction lands within a bin of 4 either way.
    for (const [id, is0] of [
      [first, true],
      [second, false],
    ] as const) {
      const shown = binLaunchPriceAtId(id, { launchTokenIsCurrency0: is0, launchDecimals: 18, quoteDecimals: 18, binStep: 100 });
      expect(shown).toBeGreaterThan(4 / 1.01);
      expect(shown).toBeLessThan(4 * 1.01);
    }
  });

  it("an exact power lands on its id in both directions", () => {
    const base = { launchDecimals: 18, quoteDecimals: 18, binStep: 100 };
    const price = 1.01 ** 7;
    expect(binActiveIdForLaunch({ ...base, launchTokenIsCurrency0: true, quotePerLaunchToken: price })).toBe(BIN_ID_ONE + 7);
    expect(binActiveIdForLaunch({ ...base, launchTokenIsCurrency0: false, quotePerLaunchToken: price })).toBe(BIN_ID_ONE - 7);
  });

  it("refuses a non-positive price and bad decimals", () => {
    const base = { launchTokenIsCurrency0: true, launchDecimals: 18, quoteDecimals: 18, binStep: 100 };
    expect(() => binActiveIdForLaunch({ ...base, quotePerLaunchToken: 0 })).toThrow(RangeError);
    expect(() => binActiveIdForLaunch({ ...base, launchDecimals: -1, quotePerLaunchToken: 1 })).toThrow(RangeError);
  });
});
