// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { groupAmountText, normalizeAmountText, parseAmount } from "../src/core/format.js";

const canon = (s: string) => {
  const r = normalizeAmountText(s);
  return r.ok ? r.canonical : `ERR:${r.message}`;
};

describe("normalizeAmountText (typed or pasted amounts, any locale)", () => {
  it("reads a balance pasted with grouping commas and a decimal point", () => {
    expect(canon("70,013.456206")).toBe("70013.456206");
    expect(normalizeAmountText("70,013.456206")).toMatchObject({ ok: true, changed: true });
  });
  it("reads the continental form: points group, the comma is the decimal", () => {
    expect(canon("70.013,456206")).toBe("70013.456206");
  });
  it("reads several commas as grouping", () => {
    expect(canon("1,000,000")).toBe("1000000");
  });
  it("reads a lone comma before other than three digits as the decimal", () => {
    expect(canon("0,5")).toBe("0.5");
    expect(canon("1,25")).toBe("1.25");
    expect(canon("0,500")).toBe("0.500");
  });
  it("reads a lone comma before exactly three digits as grouping", () => {
    expect(canon("70,013")).toBe("70013");
  });
  it("drops spaces and underscores", () => {
    expect(canon("1 000.5")).toBe("1000.5");
    expect(canon("1 000.5")).toBe("1000.5");
    expect(canon("1_000")).toBe("1000");
  });
  it("refuses two decimal points with a suggestion, never guesses", () => {
    const r = normalizeAmountText("70.013.456206");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.suggestion).toBe("70013.456206");
      expect(r.message).toContain("Did you mean 70013.456206?");
    }
  });
  it("reads points as grouping only when every group has three digits", () => {
    expect(canon("1.000.000")).toBe("1000000");
  });
  it("refuses grouping with a short group", () => {
    expect(normalizeAmountText("1,00,000").ok).toBe(false);
    expect(normalizeAmountText("12,34.5").ok).toBe(false);
  });
  it("leaves a plain amount unchanged (no echo needed)", () => {
    expect(normalizeAmountText("70013.456206")).toEqual({ ok: true, canonical: "70013.456206", changed: false });
    expect(normalizeAmountText("1.")).toEqual({ ok: true, canonical: "1.", changed: false });
  });
  it("refuses letters", () => {
    expect(normalizeAmountText("1e5").ok).toBe(false);
  });
  it("keeps every digit through parseAmount (the MAX chip's exact balance)", () => {
    const r = normalizeAmountText("70,013.456206123456789012");
    expect(r.ok && parseAmount(r.canonical, 18)).toEqual({ ok: true, value: 70013456206123456789012n });
  });
  it("groups the echo without losing digits", () => {
    expect(groupAmountText("70013.456206")).toBe("70,013.456206");
    expect(groupAmountText("1000000")).toBe("1,000,000");
    expect(groupAmountText("12")).toBe("12");
  });
});
