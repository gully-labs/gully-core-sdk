// SPDX-License-Identifier: MIT
/**
 * The CL LP locker's position ids for one pool (or every pool), from its
 * `PositionLocked` logs, scanned in windows so an RPC that caps `eth_getLogs`
 * ranges still returns every log rather than an error or a truncated list.
 *
 * A window that fails is split in half and retried, down to `minWindow`; a
 * window that still fails throws - a partial scan is never passed off as a
 * complete one.
 */

import type { Address, Hex, PublicClient } from "viem";
import { findClLpLockerTokenIds } from "@gullylabs/core-sdk/lock";

export interface ScanOptions {
  readonly fromBlock: bigint;
  readonly toBlock?: bigint;
  /** First window size; default 500,000 blocks. */
  readonly window?: bigint;
  /** Smallest window before giving up; default 2,000 blocks. */
  readonly minWindow?: bigint;
}

/** Pure: `[from, to]` split into consecutive windows of at most `size` blocks. */
export function blockWindows(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  if (size <= 0n) throw new RangeError("window size must be positive");
  const out: { from: bigint; to: bigint }[] = [];
  for (let a = from; a <= to; a += size) out.push({ from: a, to: a + size - 1n > to ? to : a + size - 1n });
  return out;
}

export async function scanClLpLockerTokenIds(client: PublicClient, locker: Address, opts: ScanOptions, poolId?: Hex): Promise<bigint[]> {
  const to = opts.toBlock ?? (await client.getBlockNumber());
  const minWindow = opts.minWindow ?? 2_000n;
  const seen = new Set<string>();
  const out: bigint[] = [];
  const scan = async (from: bigint, until: bigint): Promise<void> => {
    try {
      const found = await findClLpLockerTokenIds(client, locker, { fromBlock: from, toBlock: until }, poolId);
      for (const f of found) {
        const k = f.tokenId.toString();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(f.tokenId);
        }
      }
    } catch (error) {
      const span = until - from + 1n;
      if (span <= minWindow) throw error;
      const mid = from + span / 2n;
      await scan(from, mid - 1n);
      await scan(mid, until);
    }
  };
  for (const w of blockWindows(opts.fromBlock, to, opts.window ?? 500_000n)) await scan(w.from, w.to);
  return out;
}
