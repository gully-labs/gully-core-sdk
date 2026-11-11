// SPDX-License-Identifier: MIT
/**
 * The slippage guard every swap and liquidity command shares.
 *
 * Default 0.5%. Anything above 5% is refused unless `--accept-high-slippage` is passed, and 50% is refused
 * always: a floor that low is not a floor. The same flag is the only way past a price impact above 5%.
 */

import { applySlippage } from "@gullylabs/core-sdk/trading";

import { EXIT, UserError } from "../util/log.js";
import { bpsPercent, parsePercentBps } from "./amounts.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const HIGH_SLIPPAGE_BPS = 500;
export const MAX_SLIPPAGE_BPS = 5_000;

export const SLIPPAGE_FLAGS = {
  slippage: { kind: "string", describe: "how far the result may fall short, percent", placeholder: "<pct>", defaultLabel: "0.5" },
  "accept-high-slippage": { kind: "boolean", describe: "allow slippage or price impact above 5% (never above 50%)" },
} as const;

/** `--slippage`, else the config's, else 0.5%, in basis points, with the guard applied. */
export function slippageBps(flag: string | undefined, configured: string | undefined, accept: boolean): number {
  const text = flag ?? configured;
  const bps = text === undefined ? DEFAULT_SLIPPAGE_BPS : parsePercentBps(text, "slippage", MAX_SLIPPAGE_BPS);
  if (bps > HIGH_SLIPPAGE_BPS && !accept) {
    throw new UserError(`slippage of ${bpsPercent(bps)} is above the ${bpsPercent(HIGH_SLIPPAGE_BPS)} guard`, "lower --slippage, or pass --accept-high-slippage if you mean it", EXIT.REFUSED);
  }
  return bps;
}

export function assertPriceImpact(impactBps: number | null, accept: boolean): void {
  if (impactBps !== null && impactBps > HIGH_SLIPPAGE_BPS && !accept) {
    throw new UserError(`price impact of ${bpsPercent(impactBps)} is above the ${bpsPercent(HIGH_SLIPPAGE_BPS)} guard`, "trade less, or pass --accept-high-slippage if you mean it", EXIT.REFUSED);
  }
}

/** A minimum out must be positive and no looser than the slippage asked for. Checked before signing. */
export function assertMinOut(minOut: bigint, quoted: bigint, bps: number): void {
  if (minOut <= 0n) throw new UserError("the minimum out is zero: this trade has no floor", "refused; trade more, or check the pool", EXIT.REFUSED);
  const floor = applySlippage(quoted, bps);
  if (minOut < floor) throw new UserError(`the minimum out ${minOut} is below the ${floor} that ${bpsPercent(bps)} allows`, "refused: the route's floor is looser than the slippage you set", EXIT.REFUSED);
}
