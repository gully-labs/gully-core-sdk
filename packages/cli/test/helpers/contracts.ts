// SPDX-License-Identifier: MIT
/**
 * The Solidity some tests check themselves against. It does not live in this repository: it is the public
 * gully-core repository, so GULLYCORE_CONTRACTS_ROOT points at a checkout of it. Without one those tests
 * skip, as parity.test.ts always has, and every other test still runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The checkout's root, or this repository's when a test runs without one. */
export const CONTRACTS_ROOT = process.env["GULLYCORE_CONTRACTS_ROOT"] ?? join(here, "..", "..", "..", "..");

const packages = join(CONTRACTS_ROOT, "packages");

/** Whether the contracts' sources are on disk. */
export const contractsAvailable = existsSync(join(packages, "hooks", "src", "base", "BaseCLHook.sol"));

/** A contract package's file, or "" when there is no checkout: only skipped tests read that. */
export function solidity(...path: string[]): string {
  return contractsAvailable ? readFileSync(join(packages, ...path), "utf8") : "";
}
