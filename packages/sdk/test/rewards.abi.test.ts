// SPDX-License-Identifier: MIT
/**
 * The rewards ABI in `src/rewards/abi.ts` against the compiled artifact, when a build of
 * `packages/lp-rewards` exists on disk (skipped otherwise: CI for this package does not build
 * Solidity). Constructor and `internalType` are left out of the SDK copy on purpose.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LP_REWARDS_ABI } from "../src/rewards/abi.js";

const PATH = fileURLToPath(
  new URL("../../lp-rewards/foundry-out/GullyCoreLiquidityRewardsHook.sol/GullyCoreLiquidityRewardsHook.json", import.meta.url),
);

function strip(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(strip);
  if (x !== null && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (k !== "internalType") o[k] = strip(v);
    return o;
  }
  return x;
}

const sorted = (abi: readonly unknown[]): unknown[] => [...abi].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("GullyCoreLiquidityRewardsHook ABI", () => {
  it.skipIf(!existsSync(PATH))("matches the compiled artifact entry for entry", () => {
    const artifact = (JSON.parse(readFileSync(PATH, "utf8")) as { abi: Array<{ type: string }> }).abi.filter((e) => e.type !== "constructor");
    expect(sorted(LP_REWARDS_ABI as readonly unknown[])).toEqual(sorted(strip(artifact) as unknown[]));
  });
});
