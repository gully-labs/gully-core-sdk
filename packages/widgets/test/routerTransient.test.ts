// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { isTransientRouterError, RoutedQuoteError } from "../src/core/routed.js";

describe("isTransientRouterError (a cold engine is asked again, a refusal is not)", () => {
  it("retries a timeout, an unreachable API and a 5xx", () => {
    expect(isTransientRouterError(new RoutedQuoteError("TIMEOUT", "Request exceeded 10000 ms", 503))).toBe(true);
    expect(isTransientRouterError(new RoutedQuoteError("UNREACHABLE", "x"))).toBe(true);
    expect(isTransientRouterError(new RoutedQuoteError("HTTP_502", "x", 502))).toBe(true);
  });
  it("never retries a refusal, a bad body or a non-router error", () => {
    expect(isTransientRouterError(new RoutedQuoteError("NOT_FOUND", "x", 404))).toBe(false);
    expect(isTransientRouterError(new RoutedQuoteError("FILL_ROUTER_MISMATCH", "x"))).toBe(false);
    expect(isTransientRouterError(new RoutedQuoteError("BAD_RESPONSE", "x"))).toBe(false);
    expect(isTransientRouterError(new RoutedQuoteError("INVALID", "x", 422))).toBe(false);
    expect(isTransientRouterError(new Error("x"))).toBe(false);
  });
});
