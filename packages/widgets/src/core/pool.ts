// SPDX-License-Identifier: MIT
/**
 * What a pool key already says about a pool.
 *
 * `PoolInfo.tickSpacing` and `PoolInfo.binStep` are optional because a host
 * that lists pools from an indexer may not fill them in - but both live in the
 * key's `parameters` word, so nothing needs to guess. These read the key when
 * the field is absent, and every range editor and quote goes through them.
 */

import {
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import { readBinPoolKeyParameters, readCLPoolKeyParameters, type PoolId } from "@gullylabs/core-sdk";
import type { PoolInfo } from "../adapters/protocol.js";

/** The tick spacing of a concentrated-liquidity pool, from the info or its key. */
export function tickSpacingOf(pool: PoolInfo): number {
  if (pool.tickSpacing !== undefined) return pool.tickSpacing;
  return readCLPoolKeyParameters(pool.key).tickSpacing;
}

/** The bin step of a liquidity-book pool, from the info or its key. */
export function binStepOf(pool: PoolInfo): number {
  if (pool.binStep !== undefined) return pool.binStep;
  return readBinPoolKeyParameters(pool.key).binStep;
}

/**
 * `BinTokenLibrary.toTokenId`: the fungible token id `BinPositionManager`
 * mints for one bin of one pool, `keccak256(abi.encode(poolId, binId))`.
 */
export function binTokenId(poolId: PoolId, binId: number): bigint {
  const encoded: Hex = encodeAbiParameters(
    [
      { name: "poolId", type: "bytes32" },
      { name: "binId", type: "uint256" },
    ],
    [poolId, BigInt(binId)],
  );
  return BigInt(keccak256(encoded));
}

/**
 * The reserves a holder's shares of one bin are worth right now, rounded
 * DOWN exactly as `BinPool.burn` computes them (`amount * shares / totalShares`).
 */
export function binShareAmounts(args: {
  readonly shares: bigint;
  readonly totalShares: bigint;
  readonly reserveX: bigint;
  readonly reserveY: bigint;
}): { amount0: bigint; amount1: bigint } {
  if (args.totalShares === 0n || args.shares === 0n) return { amount0: 0n, amount1: 0n };
  return {
    amount0: (args.reserveX * args.shares) / args.totalShares,
    amount1: (args.reserveY * args.shares) / args.totalShares,
  };
}
