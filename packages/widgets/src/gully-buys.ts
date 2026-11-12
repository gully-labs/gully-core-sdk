// SPDX-License-Identifier: MIT
/**
 * `buys.js`: the standalone buy alert bundle, hosted at `https://gullycore.xyz/buys.js`.
 *
 * One `<script>` tag registers `<gully-buys>` (see `./buys/element.ts`) on any
 * page: no React, no bundler, no wallet, no key. Everything it needs (viem's
 * log reader, the MIT SDK's market reader and address book) is inside, so it
 * reads the chain through Gully RPC's keyless project and the Gully Core API's
 * public reads.
 *
 * ```html
 * <script src="https://gullycore.xyz/buys.js" defer></script>
 * <gully-buys chain="8453" token="0x…" layout="strip"></gully-buys>
 * ```
 *
 * Built by `vite.buys.config.ts` as `dist/buys.js` (IIFE, global `GullyBuys`)
 * and `dist/buys.mjs` (ESM).
 */

import { defineGullyBuys } from "./buys/element.js";

defineGullyBuys();

export { BUYS_TAG, parseBuysAttributes, buysSnippet, emojiCount, fmtUsd, fmtAmount } from "./buys/model.js";
export { GullyBuysElement, defineGullyBuys, BUYS_CSS } from "./buys/element.js";
export { BuysSource } from "./buys/source.js";
