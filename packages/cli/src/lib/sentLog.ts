// SPDX-License-Identifier: MIT
/**
 * Every transaction hash this process has broadcast, in order.
 *
 * WHY. A transaction that was sent is on the chain whether or not the command finished: the receipt wait can
 * time out, a read-back can fail, a later step can revert. The JSON document (success or failure) must name
 * every hash that left this process, so a script can always look the transaction up. `send()` records the hash
 * the moment the node returns it, before anything else can throw.
 */

import type { Hex } from "viem";

const sent: Hex[] = [];

export function recordSent(hash: Hex): void {
  if (!sent.includes(hash)) sent.push(hash);
}

export function sentHashes(): readonly Hex[] {
  return [...sent];
}

/** Tests only. */
export function resetSent(): void {
  sent.length = 0;
}
