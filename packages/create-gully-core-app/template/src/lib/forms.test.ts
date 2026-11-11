// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  addressOrNull,
  bpsToPercent,
  claimsFileName,
  claimsFileUrls,
  daysToSeconds,
  percentToBps,
  scheduleFromForm,
  splitDraftFromRows,
  unixToUtcInput,
  utcInputToUnix,
} from "./forms";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("percentages", () => {
  it("parse exactly to basis points", () => {
    expect(percentToBps("50")).toBe(5000);
    expect(percentToBps("12.5")).toBe(1250);
    expect(percentToBps("0.01")).toBe(1);
    expect(percentToBps("100")).toBe(10_000);
    expect(percentToBps(" 33.33 ")).toBe(3333);
  });

  it("refuse zero, more than 100, three decimals and junk", () => {
    for (const bad of ["0", "0.00", "100.01", "101", "1.234", "-5", "5%", "", "1e2"]) expect(percentToBps(bad)).toBeNull();
  });

  it("print back without float noise", () => {
    expect(bpsToPercent(1250)).toBe("12.5%");
    expect(bpsToPercent(1205)).toBe("12.05%");
    expect(bpsToPercent(10_000)).toBe("100%");
    expect(bpsToPercent(1)).toBe("0.01%");
  });
});

describe("split form", () => {
  it("builds a draft whose weights are basis points summing to 10000", () => {
    const r = splitDraftFromRows(" Team ", [
      { address: A, percent: "60", label: "alice" },
      { address: ` ${B} `, percent: "40", label: "" },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.totalBps).toBe(10_000);
    expect(r.draft).toEqual({
      name: "Team",
      payees: [
        { address: A, weight: 6000, label: "alice" },
        { address: B, weight: 4000, label: "" },
      ],
    });
  });

  it("refuses shares that do not add up to exactly 100%", () => {
    const r = splitDraftFromRows("T", [
      { address: A, percent: "60", label: "" },
      { address: B, percent: "30", label: "" },
    ]);
    expect(r.draft).toBeNull();
    expect(r.problems[0]?.message).toMatch(/90%/);
  });

  it("names the row with an unreadable share", () => {
    const r = splitDraftFromRows("T", [
      { address: A, percent: "abc", label: "" },
      { address: B, percent: "100", label: "" },
    ]);
    expect(r.draft).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.row).toBe(0);
  });
});

describe("dates", () => {
  it("reads a datetime-local value as UTC, whatever the viewer's zone", () => {
    expect(utcInputToUnix("2026-10-01T14:05")).toBe(BigInt(Date.UTC(2026, 9, 1, 14, 5) / 1000));
    expect(utcInputToUnix("2026-10-01T14:05:30")).toBe(BigInt(Date.UTC(2026, 9, 1, 14, 5, 30) / 1000));
    expect(utcInputToUnix("")).toBeNull();
    expect(utcInputToUnix("tomorrow")).toBeNull();
  });

  it("round-trips through the input format", () => {
    const t = 1_790_000_000n;
    expect(utcInputToUnix(unixToUtcInput(t))).toBe(t - (t % 60n));
  });

  it("converts whole days only", () => {
    expect(daysToSeconds("2")).toBe(172_800n);
    expect(daysToSeconds("0")).toBe(0n);
    expect(daysToSeconds("1.5")).toBeNull();
    expect(daysToSeconds("-1")).toBeNull();
  });
});

describe("lock schedule", () => {
  const at = "2027-01-01T00:00";
  const t = BigInt(Date.UTC(2027, 0, 1) / 1000);

  it("a time-lock is start == cliff == end", () => {
    expect(scheduleFromForm({ mode: "timelock", at, cliffDays: "x", durationDays: "x" })).toEqual({ start: t, cliff: t, end: t });
  });

  it("a vesting schedule is start, start + cliff, start + duration", () => {
    expect(scheduleFromForm({ mode: "vesting", at, cliffDays: "30", durationDays: "365" })).toEqual({
      start: t,
      cliff: t + 30n * 86_400n,
      end: t + 365n * 86_400n,
    });
  });

  it("refuses a cliff past the end, a zero duration and a missing date", () => {
    expect(scheduleFromForm({ mode: "vesting", at, cliffDays: "400", durationDays: "365" })).toHaveProperty("error");
    expect(scheduleFromForm({ mode: "vesting", at, cliffDays: "0", durationDays: "0" })).toHaveProperty("error");
    expect(scheduleFromForm({ mode: "timelock", at: "", cliffDays: "0", durationDays: "0" })).toHaveProperty("error");
  });
});

describe("claims file location", () => {
  it("fetches https as is", () => {
    expect(claimsFileUrls("https://example.com/claims.json")).toEqual(["https://example.com/claims.json"]);
  });

  it("resolves ipfs through the SDK's allow-listed gateways", () => {
    const urls = claimsFileUrls("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/claims.json");
    expect(urls).not.toBeNull();
    expect(urls!.length).toBeGreaterThan(0);
    expect(urls!.every((u) => u.startsWith("https://") && u.endsWith("/claims.json"))).toBe(true);
  });

  it("refuses plain http, data URIs and empty input (the page asks for an upload instead)", () => {
    for (const bad of ["http://example.com/c.json", "data:application/json,{}", "", "claims.json"]) expect(claimsFileUrls(bad)).toBeNull();
  });

  it("names the file by drop, or by root before the drop exists", () => {
    expect(claimsFileName(999, null, "0xabcdef0123456789")).toBe("gullycore-drop-999-abcdef01.json");
    expect(claimsFileName(999, "0xABCDEF0000000000000000000000000000000001", "0x00")).toBe("gullycore-drop-999-0xabcdef0000000000000000000000000000000001.json");
  });
});

describe("addresses", () => {
  it("checksums input or returns null", () => {
    expect(addressOrNull(" 0x00000000000000000000000000000000000dc0de ")).toBe("0x00000000000000000000000000000000000Dc0De");
    expect(addressOrNull("0x1234")).toBeNull();
  });
});
