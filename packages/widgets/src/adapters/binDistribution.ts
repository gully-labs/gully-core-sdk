// SPDX-License-Identifier: MIT
/**
 * How a bin mint spreads its two amounts across a span of bins.
 *
 * `BinPool.mint` takes, per bin, the share of `amount0` (X) and of `amount1`
 * (Y) it receives, each scaled to 1e18. Bins strictly below the active id can
 * only hold Y, bins strictly above it only X, and the active bin holds both.
 * A share that sums to more than 1e18 on either side reverts; one that sums to
 * less leaves part of the amount undeposited. The uniform spread here sums each
 * side to EXACTLY 1e18 by pushing the rounding dust into that side's last bin.
 *
 * The active bin's composition is the pool's, not the depositor's: a deposit
 * whose X:Y ratio differs from the active bin's reserves pays the pool's
 * composition fee on the difference. This helper does not fold that in; the
 * amounts a quote reports are what the position manager pulls.
 */

import type { BinLiquidityShare } from "./protocol.js";
import { BIN_DISTRIBUTION_SCALE } from "../callpath/constants.js";

/** Spreads liquidity evenly across a bin span, as a bin mint requires. */
export function buildUniformBinDistribution(
  binIdLower: number,
  binIdUpper: number,
  activeId: number,
): BinLiquidityShare[] {
  if (binIdLower > binIdUpper) {
    throw new RangeError(`binIdLower ${binIdLower} exceeds binIdUpper ${binIdUpper}`);
  }
  const ids: number[] = [];
  for (let id = binIdLower; id <= binIdUpper; id += 1) ids.push(id);

  const xBins = ids.filter((id) => id >= activeId).length;
  const yBins = ids.filter((id) => id <= activeId).length;
  // The last bin on each side takes the rounding dust so the side sums to 1e18.
  const lastX = binIdUpper;
  const lastY = Math.min(activeId, binIdUpper);

  const shares: BinLiquidityShare[] = [];
  let xAssigned = 0n;
  let yAssigned = 0n;
  for (const id of ids) {
    const rawX = id >= activeId && xBins > 0 ? BIN_DISTRIBUTION_SCALE / BigInt(xBins) : 0n;
    const rawY = id <= activeId && yBins > 0 ? BIN_DISTRIBUTION_SCALE / BigInt(yBins) : 0n;
    const distributionX = id === lastX && rawX > 0n ? BIN_DISTRIBUTION_SCALE - xAssigned : rawX;
    const distributionY = id === lastY && rawY > 0n ? BIN_DISTRIBUTION_SCALE - yAssigned : rawY;
    xAssigned += distributionX;
    yAssigned += distributionY;
    shares.push({ binId: id, deltaId: id - activeId, distributionX, distributionY });
  }
  return shares;
}
