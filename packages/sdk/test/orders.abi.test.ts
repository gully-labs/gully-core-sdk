// SPDX-License-Identifier: MIT
/**
 * The orders ABIs in `src/orders/abi.ts` against the compiled artifacts, when a build of
 * `packages/orders` exists on disk (skipped otherwise: CI for this package does not build
 * Solidity). Constructor and `internalType` are left out of the SDK copy on purpose.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DCA_ABI, RANGE_ORDERS_ABI } from "../src/orders/abi.js";

const OUT = fileURLToPath(new URL("../../orders/foundry-out/", import.meta.url));

function strip(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(strip);
  if (x !== null && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (k !== "internalType") o[k] = strip(v);
    return o;
  }
  return x;
}

const sorted = (abi: readonly unknown[]): unknown[] =>
  [...abi].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

for (const [name, abi] of [
  ["GullyCoreRangeOrders", RANGE_ORDERS_ABI],
  ["GullyCoreDCA", DCA_ABI],
] as const) {
  const path = `${OUT}${name}.sol/${name}.json`;
  describe(`${name} ABI`, () => {
    it.skipIf(!existsSync(path))("matches the compiled artifact entry for entry", () => {
      const artifact = (JSON.parse(readFileSync(path, "utf8")) as { abi: Array<{ type: string }> }).abi.filter((e) => e.type !== "constructor");
      expect(sorted(abi as readonly unknown[])).toEqual(sorted(strip(artifact) as unknown[]));
    });
  });
}
