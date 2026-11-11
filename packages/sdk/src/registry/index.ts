// SPDX-License-Identifier: MIT
/**
 * The on-chain hook registry.
 *
 * `GullyCoreRegistry` is the discovery and safety surface for Gully Core hooks: a
 * permissionless, free listing whose permission bitmaps are read off the hook
 * contracts themselves and whose curation is recorded on three independent
 * axes. This module is what a hook directory, a listing UI or an indexer builds
 * against.
 *
 * - `./generated/abi.js` - the contract ABIs, produced by
 *   `npm run generate:registry` from the compiled artifacts.
 * - `./types.js` - the data model: {@link GullyCoreRecord}, {@link GullyCoreMetadata},
 *   and the three axes {@link Verification}, {@link Listing}, {@link RiskClass}.
 *
 * Nothing is removed from the registry, ever, so a consumer should filter
 * rather than assume absence means safety - a `Malicious` tombstone with a
 * reason string is the warning, and it only exists because the record stays.
 */

import { keccak256, stringToBytes, type Hex } from "viem";

import { GULLYCORE_HOOK_REGISTRY_ABI, GULLYCORE_HOOK_REGISTRY_EVENTS_ABI } from "./generated/abi.js";

export * from "./generated/abi.js";
export * from "./types.js";

/**
 * `DEFAULT_ADMIN_ROLE`: decides who curates. Should be the timelock on any live
 * chain, never an EOA.
 */
export const DEFAULT_ADMIN_ROLE: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * `CURATOR_ROLE`: may move a hook along the verification ladder, set any listing
 * status, reassign a steward and correct metadata.
 *
 * Derived here rather than hardcoded; cross-check against the contract's own
 * `CURATOR_ROLE()` view if you ever need to be certain.
 */
export const CURATOR_ROLE: Hex = keccak256(stringToBytes("GULLYCORE_HOOK_REGISTRY_CURATOR"));

/**
 * `GUARDIAN_ROLE`: may only ever make a listing *more* cautious. It cannot grant
 * an audit badge, edit metadata, or clear an existing warning.
 */
export const GUARDIAN_ROLE: Hex = keccak256(stringToBytes("GULLYCORE_HOOK_REGISTRY_GUARDIAN"));

/** Registry ABIs re-exported under short names, matching `events`' `EventAbis`. */
export const RegistryAbis = {
  Registry: GULLYCORE_HOOK_REGISTRY_ABI,
  Events: GULLYCORE_HOOK_REGISTRY_EVENTS_ABI,
} as const;
