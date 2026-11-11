// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { sortRows, windowProgress } from "./chart";

describe("sortRows", () => {
  const rows = [{ v: 2 }, { v: null }, { v: 5 }, { v: 1 }];
  it("sorts descending and ascending", () => {
    expect(sortRows(rows, (r) => r.v, "desc").map((r) => r.v)).toEqual([5, 2, 1, null]);
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.v)).toEqual([1, 2, 5, null]);
  });
  it("sinks an unread value whatever the direction, and does not mutate", () => {
    expect(sortRows(rows, (r) => r.v, "asc").at(-1)?.v).toBeNull();
    expect(rows.map((r) => r.v)).toEqual([2, null, 5, 1]);
  });
});

describe("windowProgress", () => {
  it("clamps to 0..1", () => {
    expect(windowProgress(100, 200, 50)).toBe(0);
    expect(windowProgress(100, 200, 150)).toBe(0.5);
    expect(windowProgress(100, 200, 900)).toBe(1);
  });
  it("treats a zero-length window as a step at its start", () => {
    expect(windowProgress(100, 100, 99)).toBe(0);
    expect(windowProgress(100, 100, 100)).toBe(1);
  });
});
