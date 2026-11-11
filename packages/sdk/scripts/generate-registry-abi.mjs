// SPDX-License-Identifier: MIT
/**
 * Emits the hook-registry ABIs the SDK's `registry` module reads and encodes.
 *
 * Same licence firewall as `generate-events.mjs` and `generate-launchpad-abi.mjs`:
 * this reads the *ABI JSON* out of the Foundry build artifacts of the
 * GPL-licensed Solidity packages and emits MIT-licensed TypeScript. It never
 * reads Solidity sources, comments or NatSpec, so nothing expressive crosses the
 * boundary.
 *
 * Two constants, deliberately:
 *
 * - `GULLYCORE_HOOK_REGISTRY_ABI` is the whole deployed surface. Unlike the
 *   launchpad kit, the registry has no internal plumbing worth hiding - every
 *   function on it is a view a listing UI wants or a state change a curator
 *   makes, and the inherited AccessControl members are how a UI discovers who
 *   may curate. Curating this one would only mean re-curating it every time the
 *   contract grows a view.
 * - `GULLYCORE_HOOK_REGISTRY_EVENTS_ABI` is the six events declared by
 *   `IGullyCoreRegistry`, without the inherited role-management events. That is
 *   the exact set an indexer needs to rebuild registry state from logs, so it is
 *   worth having as its own log-filter-sized constant.
 *
 * Usage: node scripts/generate-registry-abi.mjs [--check]
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitModule, renderAbiModule } from "./lib/curated-abi.mjs";

const SCRIPT = "generate-registry-abi.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const REPO_PACKAGES = resolve(PKG_ROOT, "..");
const REGISTRY_OUT = join(REPO_PACKAGES, "registry", "foundry-out");
const OUT_FILE = join(PKG_ROOT, "src", "registry", "generated", "abi.ts");

const SOURCES = [
  {
    constant: "GULLYCORE_HOOK_REGISTRY_ABI",
    doc: "`GullyCoreRegistry` - the on-chain hook marketplace, full deployed surface.",
    contract: "GullyCoreRegistry",
    artifact: join(REGISTRY_OUT, "GullyCoreRegistry.sol", "GullyCoreRegistry.json"),
    keep: { function: null, event: null, error: null },
  },
  {
    constant: "GULLYCORE_LAUNCH_REGISTRY_ABI",
    doc: "`GullyCoreLaunchRegistry` - launches, their listings and launchpad provenance, full deployed surface.",
    contract: "GullyCoreLaunchRegistry",
    artifact: join(REGISTRY_OUT, "GullyCoreLaunchRegistry.sol", "GullyCoreLaunchRegistry.json"),
    keep: { function: null, event: null, error: null },
  },
  {
    constant: "GULLYCORE_HOOK_REGISTRY_EVENTS_ABI",
    doc:
      "Events declared by `IGullyCoreRegistry`. Between them the entire registry " +
      "state is reconstructible from logs alone.",
    contract: "IGullyCoreRegistry",
    artifact: join(REGISTRY_OUT, "IGullyCoreRegistry.sol", "IGullyCoreRegistry.json"),
    keep: {
      event: [
        "GullyCoreRegistered",
        "GullyCoreMetadataUpdated",
        "GullyCoreVerificationChanged",
        "GullyCoreListingChanged",
        "GullyCoreStewardTransferred",
        "GullyCorePermissionsRefreshed",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const checkOnly = process.argv.slice(2).includes("--check");
  const { contents, slices } = renderAbiModule(SCRIPT, SOURCES);

  const upToDate = emitModule(OUT_FILE, contents, checkOnly);

  if (checkOnly) {
    if (!upToDate) {
      console.error("Generated registry ABIs are stale. Run `npm run generate`.");
      process.exit(1);
    }
    console.log("registry ABIs are up to date.");
    return;
  }

  for (const { source, abi } of slices) {
    console.log(`  ${source.constant.padEnd(32)} ${String(abi.length).padStart(3)} members`);
  }
  const total = slices.reduce((n, s) => n + s.abi.length, 0);
  console.log(`generated ${total} ABI members into src/registry/generated/abi.ts`);
}

main();
