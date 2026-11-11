// SPDX-License-Identifier: MIT
/* ============================================================================
   GULLY CORE'S FEE RULES, AS NUMBERS A CALLER CAN NAME.

   Every figure here restates something a CONTRACT enforces (or, for the builder
   pool fee, something Gully's fee controller sets). The contracts are the
   authority; this module exists so a form, a fee table or a quote can show the
   rule before a transaction is built, and so no surface restates it by hand.

   Sources:
     - `LaunchpadKitV2` release 2 (the public deployment record):
       `MIN_TRADE_FEE_PIPS`, `PROTOCOL_TRADE_SHARE_BPS`, `TAX_SECONDS_FOREVER`,
       `LAUNCH_TOTAL_SUPPLY`.
     - `LaunchTaxModule` (both launch guards): `MAX_TAX_BPS`, `MIN_PROTOCOL_BPS`,
       `TAX_FOREVER`.
     - Decisions 2026-11-02 / 2026-11-03 (the fee picker, holder rewards)
       and 2026-11-05 (the builder pool fee).

   WHAT DIFFERS FROM THE UPSTREAM KIT THIS PRODUCT WAS PORTED FROM. Upstream
   settled every preset at 0.30%, let the creator and a tenant choose the
   protocol's share of the locked-LP fee inside [20%, 50%], capped a creator tax
   at 180 days and let the creator pick the supply. Gully Core release 2 settles
   at 1%, fixes the protocol's share at exactly 50%, has no tax expiry ceiling
   (a tax may last forever) and mints exactly 1,000,000,000 tokens.
   ============================================================================ */

/** Basis points per whole. */
const BPS = 10_000;

export const GULLY_LAUNCH_RULES = {
  /** The steady trade fee of every launch, in pips of 1e6: 1%. `LaunchpadKitV2.MIN_TRADE_FEE_PIPS`. */
  MIN_TRADE_FEE_PIPS: 10_000,
  /** The same fee in basis points: 100. */
  TRADE_FEE_BPS: 100,
  /** The protocol's share of the trade fee, exactly: 50%. `LaunchpadKitV2.PROTOCOL_TRADE_SHARE_BPS`. */
  PROTOCOL_TRADE_SHARE_BPS: 5_000,
  /** `TaxParams.taxSeconds` meaning "the tax never ends". `LaunchpadKitV2.TAX_SECONDS_FOREVER` (uint32 max). */
  TAX_SECONDS_FOREVER: 4_294_967_295,
  /** Every launch mints exactly this many base units (1,000,000,000 tokens, 18 decimals). */
  LAUNCH_TOTAL_SUPPLY: 1_000_000_000n * 10n ** 18n,
  /** The creator tax's cap per direction: 10%. `LaunchTaxModule.MAX_TAX_BPS`. */
  MAX_TAX_BPS: 1_000,
  /** The protocol's cut of every creator tax: 10%. `LaunchTaxModule.MIN_PROTOCOL_BPS` (the floor, used as the value). */
  TAX_PROTOCOL_BPS: 1_000,
  /** On Gully terms, a Launchpad's share of the fee or the tax is at most 20%. `LaunchpadKitV2.GULLY_MAX_INTEGRATOR_BPS`. */
  MAX_INTEGRATOR_BPS: 2_000,
} as const;

/**
 * The total trade fee a creator may pick, in basis points: 1%, 1.5%, 2% ... 11%, in 0.5% steps
 * (2026-11-03).
 * The number is the TOTAL a trader pays: the 1% trade fee plus the creator tax (total - 1%).
 */
export const TOTAL_FEE_CHOICES_BPS: readonly number[] = Object.freeze(
  Array.from({ length: 21 }, (_, i) => GULLY_LAUNCH_RULES.TRADE_FEE_BPS + i * 50),
);
/** The default pick: 2% total, that is the 1% trade fee and a 1% creator tax (2026-11-03). */
export const DEFAULT_TOTAL_FEE_BPS = 200;

export function isTotalFeeChoice(totalBps: number): boolean {
  return TOTAL_FEE_CHOICES_BPS.includes(totalBps);
}

/** The creator tax (buy and sell rate, bps) a total fee choice implies: total - 1%. */
export function taxBpsForTotalFee(totalBps: number): number {
  if (!isTotalFeeChoice(totalBps)) {
    throw new Error(`${totalBps} bps is not a fee choice: pick 100 to 1100 in steps of 50.`);
  }
  return totalBps - GULLY_LAUNCH_RULES.TRADE_FEE_BPS;
}

/** Where one trade's fee goes, each figure in hundredths of a basis point of the trade (so 0.05% stays an integer). */
export interface LaunchFeeBreakdown {
  /** The total a trader pays, bps of the trade. */
  readonly totalBps: number;
  /** The creator tax part of it, bps of the trade (0 when the total is 1%). */
  readonly taxBps: number;
  /** To the creator, after holder rewards and a Launchpad's share. */
  readonly creatorCentiBps: number;
  /** To the token's holders (the creator's choice, taken from the creator's side only). */
  readonly holdersCentiBps: number;
  /** To the Launchpad or DEX the launch was made through (0 without one). Taken from the creator's side only. */
  readonly integratorCentiBps: number;
  /** To Gully: half of the 1% trade fee plus 10% of the creator tax. Never touched by any other share. */
  readonly protocolCentiBps: number;
}

/**
 * Split one trade's total fee between the creator, the holders, a Launchpad and Gully.
 *
 * `holdersBps` is the holder reward in bps OF THE TRADE (0.5% steps, at most the creator's side);
 * `integratorShareBps` is the Launchpad's share in bps of the fee itself (0..2000: `maxIntegratorBps`
 * on the lockers and guards), applied to the trade fee and to the tax alike and paid out of the creator's side. Gully's part is fixed whatever the others are.
 *
 * Example (2026-11-03): total 3%, holders 1% -> creator 1.3%, holders 1.0%, Gully 0.7%
 * (0.5% trade fee half + 0.2% tax cut).
 */
export function launchFeeBreakdown(args: {
  readonly totalBps: number;
  readonly holdersBps?: number;
  readonly integratorShareBps?: number;
}): LaunchFeeBreakdown {
  const taxBps = taxBpsForTotalFee(args.totalBps);
  const holdersBps = args.holdersBps ?? 0;
  const integratorShareBps = args.integratorShareBps ?? 0;
  if (integratorShareBps < 0 || integratorShareBps > 2_000) throw new Error("A Launchpad's share is 0 to 2000 bps (20%) of the fee.");
  const tradeFeeCenti = GULLY_LAUNCH_RULES.TRADE_FEE_BPS * 100;
  const protocolTrade = (tradeFeeCenti * GULLY_LAUNCH_RULES.PROTOCOL_TRADE_SHARE_BPS) / BPS;
  const protocolTax = (taxBps * 100 * GULLY_LAUNCH_RULES.TAX_PROTOCOL_BPS) / BPS;
  const protocolCentiBps = protocolTrade + protocolTax;
  const creatorSide = args.totalBps * 100 - protocolCentiBps;
  /* The integrator's share is bps of the whole fee on chain (the split sums to 10000 with the protocol's);
     shown here as its part of the trade: share x (trade fee + tax). */
  const integratorCentiBps = Math.floor((args.totalBps * 100 * integratorShareBps) / BPS);
  const holdersCentiBps = holdersBps * 100;
  if (holdersBps < 0 || holdersBps % 50 !== 0) throw new Error("Holder rewards are picked in 0.5% steps of the trade.");
  if (holdersCentiBps + integratorCentiBps > creatorSide) {
    throw new Error("Holder rewards and the Launchpad's share come out of the creator's side and cannot exceed it.");
  }
  return {
    totalBps: args.totalBps,
    taxBps,
    creatorCentiBps: creatorSide - holdersCentiBps - integratorCentiBps,
    holdersCentiBps,
    integratorCentiBps,
    protocolCentiBps,
  };
}

/* ============================================================================
   BUILDER AND PARTNER POOLS (2026-11-05).

   On a pool that is NOT a kit launch (a DEX pool, a hook pool, a stock market
   pool) Gully takes 0.30% of every trade as the core protocol fee, set by
   Gully's fee controller on the shared pool managers. A kit launch pays Gully
   its 0.50% through the launch guard instead and carries NO extra 0.30%. The
   builder's own fee sits on top (the pool's LP fee, a hook fee, or the
   Launchpad's fee share). The Safe can lower the 0.30% per pool; nothing can
   raise it above the core's 0.40% cap (`ProtocolFeeLibrary.MAX_PROTOCOL_FEE`).
   The number below is the DEFAULT a surface shows; the rate in force on a pool
   is `poolManager.getSlot0(id).protocolFee` and must be read for a real quote.
   ============================================================================ */

export const BUILDER_POOL_RULES = {
  /** Gully's default protocol fee on builder and partner pools, pips of 1e6 per direction: 0.30%. */
  PROTOCOL_FEE_PIPS: 3_000,
  /** The core's immutable cap on a protocol fee, pips per direction: 0.40%. */
  MAX_PROTOCOL_FEE_PIPS: 4_000,
  /** Kit launch pools carry no core protocol fee: their 0.50% is taken by the launch guard. */
  KIT_LAUNCH_PROTOCOL_FEE_PIPS: 0,
} as const;

export interface BuilderPoolFeeView {
  /** What Gully takes, pips of the trade. */
  readonly protocolPips: number;
  /** What the pool's LPs (and through a hook or a fee share, the builder) earn, pips of the trade. */
  readonly lpPips: number;
  /** What a trader pays in all, pips: protocol + lp - protocol x lp / 1e6 (the core's own formula). */
  readonly totalPips: number;
}

/**
 * The fee a trader pays on a builder pool with LP fee `lpFeePips`, and who gets what.
 * `protocolFeePips` defaults to Gully's 0.30%; pass the pool's own `protocolFee` once it is read
 * (the Safe may have lowered it for that pool).
 */
export function builderPoolFees(args: { readonly lpFeePips: number; readonly protocolFeePips?: number }): BuilderPoolFeeView {
  const protocolPips = args.protocolFeePips ?? BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS;
  if (protocolPips < 0 || protocolPips > BUILDER_POOL_RULES.MAX_PROTOCOL_FEE_PIPS) {
    throw new Error(`A protocol fee is 0 to ${BUILDER_POOL_RULES.MAX_PROTOCOL_FEE_PIPS} pips (the core's cap).`);
  }
  if (args.lpFeePips < 0 || args.lpFeePips > 1_000_000) throw new Error("An LP fee is 0 to 1,000,000 pips.");
  const totalPips = protocolPips + args.lpFeePips - Math.floor((protocolPips * args.lpFeePips) / 1_000_000);
  return { protocolPips, lpPips: totalPips - protocolPips, totalPips };
}

/** Percent text for pips of 1e6 ("0.30%"), two decimals, for fee tables. */
export function pipsPercentText(pips: number): string {
  return `${(pips / 10_000).toFixed(2)}%`;
}
/** Percent text for hundredths of a bp ("1.30%"). */
export function centiBpsPercentText(centiBps: number): string {
  return `${(centiBps / 10_000).toFixed(2)}%`;
}
