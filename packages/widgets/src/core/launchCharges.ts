// SPDX-License-Identifier: MIT
/**
 * What a launch pool charges a trade, in the shape a swap surface needs: the
 * output a trade would fetch with NO price impact (so impact can be shown net of
 * every fee), and the fee and tax lines, each on its own.
 *
 * ## Two kinds of launch pool
 *
 * A launch pool's fee is set per trade by the launch's own contract. Who then
 * CHARGES it differs, and a pool stays the kind it was created as:
 *
 * - `"pool"`: the fee is the pool's own fee. The pool takes it from the amount
 *   paid in, whatever that currency is, and its liquidity providers earn it. A
 *   creator tax, where there is one, comes out of the amount received.
 * - `"launch"`: the fee and the creator tax are paid in the pool's quote
 *   currency on every trade: from the amount paid on a buy, from the amount
 *   received on a sell. The launch takes them itself, with one exception: on a
 *   BUY it leaves a share of the trading fee to the pool, which charges that
 *   part as its own fee and pays it to its liquidity providers. On a SELL the
 *   pool charges nothing and the launch takes the whole fee.
 *
 *   That share is fixed per launch contract and may be zero. It is READ, never
 *   assumed (`LaunchCharges.feeParts`). Where it could not be read the trading
 *   fee is still known, the division is not, and a buy gets no price impact
 *   figure: one worked out from a guessed division would hide part of a fee
 *   inside the impact, or part of the impact inside a fee.
 *
 * In both the quoted output already reflects every charge, because the quoter
 * runs the launch's contract. What differs is how much of the gap between the
 * quoted output and the spot output is a CHARGE rather than price impact, and
 * that is what `spotAfterCharges` works out.
 *
 * Pure: integer arithmetic only, no chain, no clock. The rounding is the
 * contracts': what the launch takes is floored, each charge on its own, and
 * the pool's own fee is rounded up.
 */

import { guardBuyCharges, guardGenerationOfKey, guardQuoteTake } from "@gullylabs/core-sdk";

import type { LaunchCharges, LaunchFeeParts, PoolInfo, TokenInfo } from "../adapters/protocol.js";
import { formatPercentFromBps, formatPercentFromPips } from "./format.js";

const PIPS = 1_000_000n;
const BPS = 10_000n;

/** Inputs to {@link spotAfterCharges}. */
export interface SpotAfterChargesInput {
  /** The amount paid in, smallest units of the input token. */
  readonly amountIn: bigint;
  /** The trading fee in force, in pips (1_000_000 = 100%): the whole fee, both parts where it has two. */
  readonly feePips: number;
  /**
   * Only read for `"launch"`: how this trade's fee is divided between the pool
   * and the launch, as read. `null` or absent: not known. A BUY then has no
   * answer. A sell does not need it: the launch takes the whole fee on a sell.
   */
  readonly feeParts?: LaunchFeeParts | null;
  /** The creator tax this trade pays, in bps; 0 for none. */
  readonly taxBps: number;
  /** Who charges the trading fee. See the header. */
  readonly feeTakenBy: "pool" | "launch";
  /** Whether the input token is the pool's quote currency (a buy). Only read for `"launch"`. */
  readonly inputIsQuote: boolean;
  /** Converts an input amount to output at the pool's CURRENT price, with no fee and no impact. */
  readonly atSpot: (amountIn: bigint) => bigint;
}

/**
 * The output `amountIn` would fetch at the current price after every charge and
 * with no price impact: the reference a quote is compared with to isolate the
 * impact. A quote below it lost the difference to impact; none of the
 * difference is a fee.
 *
 * `null` for a buy through a launch whose division of the fee was not read:
 * there is then no reference that is net of every charge, and none is made up.
 */
export function spotAfterCharges(input: SpotAfterChargesInput): bigint | null {
  const { amountIn, feePips, taxBps } = input;
  if (amountIn < 0n) throw new RangeError(`amountIn must not be negative: ${amountIn}`);
  if (input.feeTakenBy === "pool") {
    /* The pool's fee comes off the input; the tax comes off what is received. */
    const afterFee = amountIn - (amountIn * BigInt(feePips)) / PIPS;
    const out = input.atSpot(afterFee);
    return out - (out * BigInt(taxBps)) / BPS;
  }
  const parts = input.feeParts ?? null;
  if (input.inputIsQuote) {
    /* A buy: the launch takes its part of the fee and the tax from the quote paid in, the pool charges
       its part on what is left, and the rest trades. Without the parts there is nothing to work out. */
    if (parts === null) return null;
    const charges = guardBuyCharges({
      amount: amountIn,
      parts: { buyLpPips: parts.poolPips, buyGuardPips: parts.launchPips, sellGuardPips: feePips },
      taxBps,
    });
    return input.atSpot(charges.traded);
  }
  /* A sell: the pool trades everything and charges nothing, and the launch takes the whole fee and
     the tax from the quote it pays out. */
  const quoteOut = input.atSpot(amountIn);
  return quoteOut - guardQuoteTake({ amount: quoteOut, feePips: parts === null ? feePips : parts.launchPips, taxBps, exactInput: true }).take;
}

/**
 * Who charges a LAUNCH pool's trading fee, from the pool's own key.
 *
 * For a pool already known to be a launch pool (its hook is a launch guard):
 * the key carries the guard's own bitmap, and only the bitmap of a guard that
 * takes the fee itself answers `"launch"`. Every other launch pool, the older
 * builds included, is `"pool"`, which is what they have always been.
 */
export function launchFeeTakenBy(pool: Pick<PoolInfo, "key" | "poolType">): "pool" | "launch" {
  return guardGenerationOfKey(pool.key, pool.poolType === "CL" ? "CL" : "Bin") === "quote-fee" ? "launch" : "pool";
}

/** One line of a trade's details. */
export interface ChargeLine {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}

/**
 * The trading-fee line.
 *
 * `launch` is what the quote says about the launch pool it goes through, or
 * absent for any other pool. Where the launch takes the fee itself, the line
 * names it a trading fee, prints the WHOLE fee and says the currency; the hint
 * says who receives which part of it, or that the division could not be read.
 * The pool's own rate is never what is printed as the fee.
 */
export function feeLine(fee: { readonly lpFeePips: number; readonly lpFeeUnknown: boolean }, launch: LaunchCharges | undefined, style: "compact" | "details"): ChargeLine {
  if (launch !== undefined && launch.feeTakenBy === "launch" && !fee.lpFeeUnknown) {
    const paid = launch.quote === null ? "" : ` · paid in ${launch.quote.symbol}`;
    const where = launch.quote === null ? "in the pool's quote currency" : `in ${launch.quote.symbol}`;
    return {
      label: "Trading fee",
      value: `${formatPercentFromPips(fee.lpFeePips)}${paid}`,
      hint: `${launchFeeWords(launch.feeParts ?? null, where)} The quoted output already includes it.`,
    };
  }
  if (fee.lpFeeUnknown) {
    return {
      label: "Pool fee",
      value: style === "compact" ? "set by hook" : "dynamic (hook-set)",
      hint: "This pool's hook decides the fee inside the swap. The quoted output already includes it.",
    };
  }
  return { label: "Pool fee", value: formatPercentFromPips(fee.lpFeePips), hint: "Set by the pool, paid to its liquidity providers, taken from the input." };
}

/**
 * Who receives one trade's trading fee through a launch that takes the fee
 * itself, in plain words. `where` names the currency ("in ETH", or "in the
 * pool's quote currency").
 *
 * - parts not read: the fee is paid `where`, and the division is not known.
 * - the pool's part is zero (every sell, and a buy where the launch leaves the
 *   pool nothing): the launch takes all of this trade's fee.
 * - otherwise: each part, as a rate of the trade.
 */
export function launchFeeWords(parts: LaunchFeeParts | null, where: string): string {
  if (parts === null) {
    return `Paid ${where}. How it is divided between the pool's liquidity providers and the launch could not be read.`;
  }
  if (parts.poolPips === 0) return `Taken by the launch ${where} on this trade.`;
  return `Paid ${where}: ${formatPercentFromPips(parts.poolPips)} goes to the pool's liquidity providers and the launch takes ${formatPercentFromPips(parts.launchPips)}. On a sell the launch takes all of it.`;
}

/**
 * The creator-tax line for the current side, or `null` when there is nothing to
 * say about a tax.
 *
 * `host` is the rate the embedding page read itself (`SwapWidget`'s
 * `creatorTax`): it wins when given, since the page may know a pool the adapter
 * does not. Otherwise the quote's own reading is used. `undefined` on both
 * sides means no line at all; a rate of zero prints "none".
 */
export function taxLine(side: "buy" | "sell", host: { readonly buyBps: number; readonly sellBps: number } | null | undefined, launch: LaunchCharges | undefined): ChargeLine | null {
  let bps: number | null;
  if (host !== undefined) bps = host === null ? null : side === "buy" ? host.buyBps : host.sellBps;
  else if (launch !== undefined && launch.taxBps !== null) bps = launch.taxBps;
  else return null;

  const inQuote = launch !== undefined && launch.feeTakenBy === "launch";
  const taken = bps === null || bps === 0 || !inQuote || launch.quote === null ? "" : ` · taken in ${launch.quote.symbol}`;
  return {
    label: `Creator tax (${side})`,
    value: bps === null || bps === 0 ? "none" : `${formatPercentFromBps(bps)}${taken}`,
    hint: inQuote
      ? `Taken by the launch ${launch.quote === null ? "in the pool's quote currency" : `in ${launch.quote.symbol}`} on buys and sells, for the creator and the protocol. The quoted output already includes it.`
      : "Taken by the launch pool's hook on this swap, for the creator and the protocol. The quoted output already includes it.",
  };
}

/** The sentence for a trade the pool cannot fill, with the most it can where that was quoted. */
export function tooLargeMessage(tokenIn: Pick<TokenInfo, "symbol">, largest: string | null): string {
  return largest === null
    ? "This trade is larger than the pool can fill. Try a smaller amount."
    : `This trade is larger than the pool can fill. The most it can fill right now is ${largest} ${tokenIn.symbol}.`;
}
