// SPDX-License-Identifier: MIT
/* The address book, the public gully-core deployments and gullycore.xyz/manifest.json agree (scripts/sync-check.mjs).
   Network: runs when GULLYCORE_SYNC=1 (npm run sync-check runs the same checks as a script). Point
   GULLYCORE_DEPLOYMENTS / GULLYCORE_MANIFEST at local copies to run it offline. */
import { describe, expect, it } from "vitest";

import { GULLYCORE_DEPLOYMENTS } from "../src/deployments/index.js";
// @ts-expect-error plain .mjs script, no types
import { syncCheck } from "../scripts/sync-check.mjs";

describe.skipIf(process.env.GULLYCORE_SYNC !== "1")("sync: SDK records == gully-core deployments == manifest", () => {
  it("every chain, every contract", async () => {
    const rows = (await syncCheck({ book: GULLYCORE_DEPLOYMENTS })) as { chainId: unknown; check: string; ok: boolean; detail: string }[];
    const bad = rows.filter((r) => !r.ok);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(1 + 6 * 3);
  }, 60_000);
});
