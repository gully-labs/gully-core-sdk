// SPDX-License-Identifier: MIT
/**
 * `gullycore-embed.js`: the standalone, framework-free embed bundle.
 *
 * One `<script>` tag registers `<gullycore-lock-badge>` (see `./embed/lockBadge.ts`)
 * on any page - no React, no bundler, no wallet. Everything it needs (viem, the
 * MIT SDK's lock readers and the address book) is inside the bundle, so it
 * reads the chain directly through the chain's public RPCs, or the `rpc`
 * attribute's.
 *
 * ```html
 * <script src="https://<gullycore site>/embed/gullycore-embed.js" defer></script>
 * <gullycore-lock-badge chain="999" pool="0x…" site="https://<gullycore site>"></gullycore-lock-badge>
 * ```
 *
 * Built by `vite.embed.config.ts` as `dist/gullycore-embed.js` (IIFE, global
 * `GullyCoreEmbed`) and `dist/gullycore-embed.mjs` (ESM).
 */

import { defineGullyCoreLockBadge } from "./embed/lockBadge.js";

defineGullyCoreLockBadge();

export { LOCK_BADGE_TAG, GullyCoreLockBadgeElement, defineGullyCoreLockBadge, parseLockBadgeAttributes } from "./embed/lockBadge.js";
