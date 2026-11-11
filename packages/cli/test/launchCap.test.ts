/* What a scripted `gullycore launch` opens at when no flag names a market cap.

   The SDK's $3,500 default, and only where there are dollars to state it in: a pool quoted in the
   chain's native currency, on a chain whose native/USD price was read. Everywhere else the answer is
   `null` and the command refuses, because a round number of the quote would open a pool, with its
   liquidity locked for good, at a cap nobody chose. */
import { describe, expect, it } from "vitest";

import { DEFAULT_OPENING_MARKET_CAP_USD, formatUsdAmount, type NativeUsdResult } from "@gullylabs/core-sdk/price";

import { isNativeQuote, scriptedDefaultCap } from "../src/commands/launch.js";

const priced = { ok: true } as unknown as NativeUsdResult;
const unpriced = { ok: false, detail: "no source" } as unknown as NativeUsdResult;
const ZERO = "0x0000000000000000000000000000000000000000";
const TOKEN = "0x1111111111111111111111111111111111111111";

describe("isNativeQuote", () => {
  it("reads the native currency however it was written", () => {
    for (const q of ["native", "Native", " NATIVE ", ZERO]) expect(isNativeQuote(q)).toBe(true);
  });

  it("does not mistake a token for it", () => {
    for (const q of [TOKEN, "", "eth"]) expect(isNativeQuote(q)).toBe(false);
  });
});

describe("scriptedDefaultCap", () => {
  it("is the SDK's default, in dollars, for a natively quoted pool with a price", () => {
    const whole = formatUsdAmount(DEFAULT_OPENING_MARKET_CAP_USD).replace(/\.00$/, "");
    expect(whole).toBe("3500");
    for (const q of ["native", "Native", ZERO]) expect(scriptedDefaultCap(priced, q)).toEqual({ mode: "usd", value: "3500" });
  });

  it("is nothing at all without a price: never a round number of the quote", () => {
    expect(scriptedDefaultCap(unpriced, "native")).toBeNull();
    /* `--no-usd` hands the command a null read. */
    expect(scriptedDefaultCap(null, "native")).toBeNull();
  });

  it("is nothing for a pool quoted in another token, priced chain or not", () => {
    expect(scriptedDefaultCap(priced, TOKEN)).toBeNull();
    expect(scriptedDefaultCap(unpriced, TOKEN)).toBeNull();
  });
});
