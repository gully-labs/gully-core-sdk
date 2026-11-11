// SPDX-License-Identifier: MIT
/* ============================================================================
   The coding-agent prompts (`prompts/*.md`) ship in the npm tarball and are
   pasted into other people's agents. Every name they tell an agent to import
   must be a real export, or the agent invents the rest. This reads each
   `import { ... } from "@gullylabs/core-sdk[/router]"` block in the prompts
   and checks the names against the SDK's own entry points, and checks the
   contract limits the launchpad prompt states against the guard source.
   ============================================================================ */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as root from "../src/index.js";
import * as router from "../src/router/index.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const PROMPTS = ["../prompts/launchpad-integration.md", "../prompts/dex-integration.md"];

function importsOf(text: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(@gullylabs\/core-sdk(?:\/[a-z]+)?)"/g)) {
    const names = m[1]!.split(",").map((n) => n.trim().replace(/^type\s+/, "")).filter(Boolean);
    out.push({ from: m[2]!, names });
  }
  return out;
}

describe("coding-agent prompts", () => {
  for (const rel of PROMPTS) {
    const text = readFileSync(here(rel), "utf8");

    it(`${rel}: imports at least one block`, () => {
      expect(importsOf(text).length).toBeGreaterThan(0);
    });

    it(`${rel}: every imported name is an SDK export`, () => {
      for (const { from, names } of importsOf(text)) {
        const mod: Record<string, unknown> = from.endsWith("/router") ? router : root;
        for (const n of names) expect(mod[n], `${n} from ${from}`).toBeDefined();
      }
    });

    it(`${rel}: never states an install line without saying nothing is published yet`, () => {
      if (text.includes("npm install @gullylabs/core-sdk")) expect(text).toMatch(/NOTHING IS PUBLISHED ON NPM YET/);
    });

    it(`${rel}: describes Kit v2 durations, never block counts`, () => {
      expect(text).not.toMatch(/blockTimeCentis|startBlock|decayBlocks/);
    });
  }

  /* The contracts live in https://github.com/gully-labs/gully-core (packages/). Name that folder in GULLYCORE_CONTRACTS_DIR to
     check the prompt against the Solidity; without it only the prompt's own wording is checked. */
  const CONTRACTS = process.env["GULLYCORE_CONTRACTS_DIR"];
  it.skipIf(!CONTRACTS)("the launchpad prompt's limits are the guards' constants", () => {
    const cl = readFileSync(`${CONTRACTS}/hooks/src/launch/LaunchGuardHook.sol`, "utf8");
    const bin = readFileSync(`${CONTRACTS}/hooks/src/launch/BinLaunchGuardHook.sol`, "utf8");
    const tax = readFileSync(`${CONTRACTS}/hooks/src/launch/LaunchTaxModule.sol`, "utf8");
    const all = cl + bin + tax;
    expect(cl).toMatch(/MAX_INITIAL_FEE = 500_000/); // 50% on a CL leg
    expect(bin).toMatch(/MAX_INITIAL_FEE = LPFeeLibrary\.TEN_PERCENT_FEE/); // 10% on a Bin leg
    expect(all).toMatch(/MIN_DECAY_SECONDS = 60;/);
    expect(all).toMatch(/MAX_START_DELAY_SECONDS = 30 days;/);
    expect(all).toMatch(/MAX_TAX_BPS = 1_000;/);
    expect(all).toMatch(/TAX_FOREVER = type\(uint40\)\.max;/);
    /* Release 3: the guards' floors are 0 and the terms live in the kit (LaunchPolicy). */
    expect(all).toMatch(/MIN_PROTOCOL_BPS = 0;/);
    expect(all).toMatch(/MIN_FEE_PROTOCOL_BPS = 0;/);
    const policy = readFileSync(`${CONTRACTS}/launchpad/src/libraries/LaunchPolicy.sol`, "utf8");
    expect(policy).toMatch(/GULLY_TAX_PROTOCOL_FLOOR_BPS = 1_000;/);
    expect(policy).toMatch(/GULLY_MAX_INTEGRATOR_BPS = 2_000;/);
  });

  it("the launchpad prompt states Gully Core's rules", () => {
    /* Whitespace folded, so re-wrapping the prompt does not break the check. */
    const lp = readFileSync(here("../prompts/launchpad-integration.md"), "utf8").replace(/\s+/g, " ");
    for (const phrase of ["up to 50% on a CL leg", "10% on a Bin leg", "at least 60 seconds", "at most 30 days", "at most 10% per side", "may last forever", "exactly 50%", "protocol at least 10%", "0.30%", "1,000,000,000"]) {
      expect(lp, phrase).toContain(phrase);
    }
  });
});
