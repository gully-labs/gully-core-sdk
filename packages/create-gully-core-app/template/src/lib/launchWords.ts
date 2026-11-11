// SPDX-License-Identifier: MIT
/**
 * What a launch's trading fee is called on screen, in which currency it is
 * paid, and where each earning sits.
 *
 * ---------------------------------------------------------------------------
 * THE ONE FACT BEHIND EVERY WORD HERE
 * ---------------------------------------------------------------------------
 *
 * A launch pays its trading fee one of two ways, and stays that way for good:
 *
 *   * THE POOL CHARGES IT. The fee is the pool's LP fee, taken from whatever a
 *     trade pays in (the quote on a buy, the launch token on a sell). The
 *     locked position earns it, and the locker splits it (`collectFees`, then
 *     `claim`). A creator tax is taken from what the trade receives.
 *   * THE LAUNCH CONTRACT TAKES IT. The fee and any creator tax are paid in
 *     the pool's QUOTE currency on every trade, buys and sells alike. What the
 *     launch contract takes goes into a per-pool pot (`settleFee` /
 *     `settleTax`, then `claim`; `claimFrom` does all of it). On a BUY it
 *     leaves a share of the trading fee to the pool's liquidity providers,
 *     which the locked position earns and the locker pays out; on a SELL it
 *     takes all of it. That share is fixed in the launch contract and may be
 *     zero, in which case the locked position earns nothing.
 *
 * Which one it is comes from the SDK, which reads it off the launch contract
 * itself (`leg.guardGeneration`, `limits.feeSplit`), and so does the share
 * (`leg.lpShareBps`, `limits.lpShareBps`). Nothing here guesses: a launch
 * whose kind could not be read keeps the first wording, which claims nothing
 * about the currency, and a share that could not be read is said as not read,
 * never as zero.
 *
 * Pure. No reads. Tested in `launchWords.test.ts`.
 */

import type { EarningsCreditV2, EarningsPotV2, GuardGenerationRead, LaunchLegV2 } from "@gullylabs/core-sdk";

/** Whether the launch contract takes the trading fee (and the tax) itself, in the quote currency. */
export function feeIsInQuote(generation: GuardGenerationRead): boolean {
  return generation === "quote-fee";
}

/**
 * The share of a buy's trading fee that goes to the pool's liquidity providers,
 * as it was read: basis points (zero is a real answer), `"differs"` when it was
 * read for every pool in question and is not the same for all, `null` when it
 * was not read for at least one of them.
 */
export type LpShareRead = number | "differs" | null;

/** Basis points as a percentage, exact, no trailing zeros: 2500 -> "25%", 1250 -> "12.5%". */
function sharePct(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac === "" ? "" : `.${frac}`}%`;
}

/** Who receives a trading fee that is paid in the quote, in plain sentences. Says only what was read. */
export function feeDividedLine(share: LpShareRead): string {
  if (share === null) return "How the trading fee is divided between the pool’s liquidity providers and the launch contract could not be read.";
  if (share === 0) return "The launch contract takes all of the trading fee, on buys and on sells.";
  const part = share === "differs" ? "part" : sharePct(share);
  return `On a buy, ${part} of the trading fee goes to the pool’s liquidity providers; the launch contract takes the rest. On a sell the launch contract takes all of it.`;
}

/** What the locked liquidity earns of such a fee, to follow "locked forever · ". */
export function lockedEarnsWords(share: LpShareRead): string {
  if (share === null) return "what it earns could not be read";
  if (share === 0) return "earns no trading fee";
  if (share === "differs") return "earns a part of the trading fee on buys";
  return `earns ${sharePct(share)} of the trading fee on buys`;
}

/**
 * The share that applies to a set of pools, from the shares read per pool type
 * (`limits.lpShareBps`) and the pool types in question. With no pool named,
 * both types are in question.
 */
export function lpShareOfPools(shares: { readonly CL: number | null; readonly Bin: number | null } | null | undefined, kinds: readonly ("CL" | "Bin")[]): LpShareRead {
  if (shares === null || shares === undefined) return null;
  const asked = kinds.length === 0 ? (["CL", "Bin"] as const) : [...new Set(kinds)];
  const read = asked.map((k) => shares[k]);
  if (read.some((s) => s === null)) return null;
  const distinct = [...new Set(read as number[])];
  return distinct.length === 1 ? (distinct[0] as number) : "differs";
}

/** The words for one pool's fee, and the split that governs it. */
export interface LegFeeWords {
  /** The label beside the fee in force. */
  readonly feeLabel: string;
  /** "paid in ETH", or `null` where the currency depends on the trade's direction. */
  readonly paidIn: string | null;
  /** The label beside the split. */
  readonly splitLabel: string;
  /** The caption under the split's bar. */
  readonly splitCaption: string;
  /** What the schedule falls back to when it is disabled. */
  readonly plainFee: string;
}

export function legFeeWords(generation: GuardGenerationRead, quoteSymbol: string): LegFeeWords {
  if (feeIsInQuote(generation)) {
    return {
      feeLabel: "Trading fee now",
      paidIn: `paid in ${quoteSymbol}`,
      splitLabel: "Trading fee split",
      splitCaption: `Trading fees, paid in ${quoteSymbol}, split fixed at launch`,
      plainFee: "plain trading fee applies",
    };
  }
  return {
    feeLabel: "Fee now",
    paidIn: null,
    splitLabel: "LP fee split",
    splitCaption: "Locked LP fees, split frozen at launch",
    plainFee: "plain LP fee applies",
  };
}

/** The three shares of a fee, and who the named parties are. */
export interface FeeShares {
  readonly creatorBps: number;
  readonly integratorBps: number;
  readonly protocolBps: number;
  readonly integrator: `0x${string}`;
}

/**
 * The split that governs a pool's trading fee: the launch contract's own where
 * it takes the fee, the locked position's otherwise. `null` when that one could
 * not be read; the other is never shown in its place.
 */
export function feeSplitOf(leg: Pick<LaunchLegV2, "guardGeneration" | "feeSplit" | "lock">): FeeShares | null {
  const s = feeIsInQuote(leg.guardGeneration) ? leg.feeSplit : leg.lock;
  return s === null ? null : { creatorBps: s.creatorBps, integratorBps: s.integratorBps, protocolBps: s.protocolBps, integrator: s.integrator };
}

/** Where a credited balance sits and what it is made of. */
export function creditLabel(c: Pick<EarningsCreditV2, "from" | "pools" | "holds">): string {
  if (c.from === "kit") return "Launch fees (kit)";
  if (c.from === "locker") return `${c.pools} locker · LP fees`;
  switch (c.holds) {
    case "trading-fees-and-tax":
      return `${c.pools} launch contract · trading fees and creator tax`;
    case "creator-tax":
      return `${c.pools} guard · creator tax`;
    default:
      return `${c.pools} guard`;
  }
}

/** What an unsettled pot is made of, for the account it is shown to. */
export function potLabel(p: Pick<EarningsPotV2, "fee" | "tax">): string {
  if (p.fee !== null && p.tax !== null) return "trading fee + creator tax";
  if (p.fee !== null) return "trading fee";
  return "creator tax";
}

/** The account's share of a pot, as a percentage of each part it has a share of. */
export function potShare(p: Pick<EarningsPotV2, "fee" | "tax">): string {
  const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const parts: string[] = [];
  if (p.fee !== null) parts.push(`${pct(p.fee.bps)} of the fee`);
  if (p.tax !== null) parts.push(`${pct(p.tax.bps)} of the tax`);
  return parts.join(" · ");
}

/** The words a launch form uses, for the kit it creates launches through. */
export interface KitFeeWords {
  readonly inQuote: boolean;
  /** "pool fee" / "trading fee". */
  readonly fee: string;
  /** "LP fees" / "trading fees". */
  readonly fees: string;
  /** The split fieldset's legend. */
  readonly splitLegend: string;
  /** Who splits the fee, and how, in one sentence. */
  readonly splitRule: string;
  /** What is the only ongoing revenue from a launch. */
  readonly revenue: string;
}

/**
 * `inQuote` is the kit's own answer (`limits.feeSplit !== null`): whether its
 * launches pay their trading fee in the quote currency. `lpShare` is the share
 * of a buy's fee the draft's pools leave to liquidity providers, as read
 * (`lpShareOfPools`); absent or `null`, it was not read, and the rule says so.
 */
export function kitFeeWords(inQuote: boolean, lpShare: LpShareRead = null): KitFeeWords {
  if (inQuote) {
    const paid = "Every trade pays the trading fee in the pool’s quote currency, buys and sells alike.";
    const split = "What the launch contract takes is split three ways with these numbers, forever.";
    return {
      inQuote: true,
      fee: "trading fee",
      fees: "trading fees",
      splitLegend: "Trading fee split (fixed when the launch is created)",
      splitRule:
        lpShare === null
          ? `${paid} ${feeDividedLine(null)} ${split} The liquidity stays locked.`
          : lpShare === 0
            ? `${paid} ${feeDividedLine(0)} ${split} The liquidity stays locked and earns no trading fee.`
            : `${paid} ${feeDividedLine(lpShare)} ${split} The liquidity stays locked, and its part of what buys pay is split the same way.`,
      revenue: "the trading fee split above is the only ongoing revenue anyone has from this launch",
    };
  }
  return {
    inQuote: false,
    fee: "pool fee",
    fees: "LP fees",
    splitLegend: "LP fee split (frozen at lock time)",
    splitRule: "The lockers split every position’s LP fees three ways with these numbers, forever.",
    revenue: "the LP fee split above is the only ongoing revenue anyone has from this launch",
  };
}
