// SPDX-License-Identifier: MIT
import type { NativeUsdQuote } from "@gullylabs/core-sdk";
import { describe, expect, it } from "vitest";

import { isNativeOrWrapped, usdCompact, usdNote, usdPerUnit, usdText, usdValueOf } from "./usdFormat";

const WETH = "0x5555555555555555555555555555555555555555";
const OTHER = "0x1234567890123456789012345678901234567890";
/** $3,500.00000000 per native unit, in a Chainlink feed's own shape. */
const QUOTE: NativeUsdQuote = {
  ok: true,
  answer: 350_000_000_000n,
  answerDecimals: 8,
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  provenance: { tier: "chainlink-onchain", source: "Chainlink", address: OTHER, chainId: 1, blockNumber: null, updatedAt: 0, ageSeconds: 130, staleAfterSeconds: 3600, roundId: null, description: null, label: "Chainlink ETH/USD", caveats: [] },
};

describe("which tokens may carry a dollar figure", () => {
  it("only the native coin and the wrapped native, whatever the casing", () => {
    expect(isNativeOrWrapped("0x0000000000000000000000000000000000000000", WETH)).toBe(true);
    expect(isNativeOrWrapped(WETH.toUpperCase().replace("0X", "0x"), WETH)).toBe(true);
    expect(isNativeOrWrapped(OTHER, WETH)).toBe(false);
    expect(isNativeOrWrapped(WETH, null)).toBe(false);
  });

  it("prices per unit and values an amount from the feed's own integers, null for everything else", () => {
    expect(usdPerUnit("0x0000000000000000000000000000000000000000", WETH, QUOTE)).toBe(3500);
    expect(usdPerUnit(OTHER, WETH, QUOTE)).toBeNull();
    expect(usdPerUnit(WETH, WETH, null)).toBeNull();
    expect(usdValueOf(10n ** 18n / 2n, 18, WETH, WETH, QUOTE)).toBe(1750);
    expect(usdValueOf(10n ** 18n, 18, OTHER, WETH, QUOTE)).toBeNull();
  });
});

describe("dollar formats", () => {
  it("an amount: cents up to ten million, dust says so, zero is $0", () => {
    expect(usdText(0)).toBe("$0");
    expect(usdText(0.004)).toBe("<$0.01");
    expect(usdText(0.27)).toBe("$0.27");
    expect(usdText(12345.678)).toBe("$12,345.68");
    expect(usdText(1_250_000)).toBe("$1.25M");
    expect(usdText(Number.NaN)).toBe("$0");
  });
  it("compact for large figures, trailing zeros dropped", () => {
    expect(usdCompact(3500)).toBe("$3.5K");
    expect(usdCompact(5000)).toBe("$5K");
    expect(usdCompact(1_250_000)).toBe("$1.25M");
    expect(usdCompact(3e9)).toBe("$3B");
    expect(usdCompact(12.5)).toBe("$12.5");
  });
  it("the provenance line names the source and the age in plain words", () => {
    expect(usdNote(QUOTE)).toBe("Dollar price from Chainlink ETH/USD, updated 2 min ago.");
    expect(usdNote({ ...QUOTE, provenance: { ...QUOTE.provenance, ageSeconds: 20 } })).toMatch(/20 s ago/);
    expect(usdNote({ ...QUOTE, provenance: { ...QUOTE.provenance, ageSeconds: 7200 } })).toMatch(/2 h ago/);
  });
});
