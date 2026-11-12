// SPDX-License-Identifier: MIT
/**
 * Pure guards for the liquidity flow: what a deposit will take from the wallet,
 * and whether the wallet holds it.
 *
 * WHY THIS EXISTS. Without it an add that the wallet cannot pay reaches gas
 * estimation and comes back as `TRANSFER_FROM_FAILED` (or an out-of-funds
 * error for native), after the visitor may already have signed an approval
 * for tokens they do not hold. The widget checks the balances first and says
 * "Insufficient <SYMBOL>" before anything is signed.
 *
 * WHAT IS COMPARED, exactly:
 *   - native: the transaction's `value`, which is the side's slippage-bounded
 *     MAXIMUM (the adapter sends the whole cap and the position manager refunds
 *     the rest). No gas reserve is invented on top: the wallet refuses a
 *     transaction it cannot pay gas for, and a made-up margin would refuse
 *     deposits that fit.
 *   - ERC-20: the QUOTED amount, which is what the position manager pulls at
 *     the current price. The slippage cap is only an allowance ceiling; a wallet
 *     holding the quoted amount but not the cap can still deposit.
 */

import { isAddressEqual, zeroAddress } from "viem";
import type { TokenInfo } from "../adapters/protocol.js";

/** True for the chain's native asset. */
export function isNativeToken(token: TokenInfo): boolean {
  return token.isNative === true || isAddressEqual(token.address, zeroAddress);
}

/** One side of a deposit: the token and what the wallet must hold of it. */
export interface DepositRequirement {
  readonly token: TokenInfo;
  readonly required: bigint;
}

/**
 * What an add-liquidity takes from the wallet, per token, in pool order. A side
 * that deposits nothing is left out.
 */
export function depositRequirements(
  quote: {
    readonly pool: { readonly token0: TokenInfo; readonly token1: TokenInfo };
    readonly amount0: bigint;
    readonly amount1: bigint;
  },
  amount0Max: bigint,
  amount1Max: bigint,
): readonly DepositRequirement[] {
  const out: DepositRequirement[] = [];
  const side = (token: TokenInfo, quoted: bigint, max: bigint): void => {
    const required = isNativeToken(token) ? max : quoted;
    if (required > 0n) out.push({ token, required });
  };
  side(quote.pool.token0, quote.amount0, amount0Max);
  side(quote.pool.token1, quote.amount1, amount1Max);
  return out;
}

/**
 * The first token the wallet holds too little of, or `null` when every balance
 * covers its requirement. `balances[i]` is the wallet's balance of
 * `requirements[i].token`; a `null` balance (not read) is never reported as a
 * shortfall - the widget does not claim what it has not read.
 */
export function findShortfall(
  requirements: readonly DepositRequirement[],
  balances: readonly (bigint | null)[],
): TokenInfo | null {
  for (const [i, requirement] of requirements.entries()) {
    const balance = balances[i] ?? null;
    if (balance !== null && balance < requirement.required) return requirement.token;
  }
  return null;
}

/** Refusal raised before an approval or a deposit the wallet cannot pay. Nothing was signed. */
export class InsufficientBalanceError extends Error {
  readonly token: TokenInfo;

  constructor(token: TokenInfo) {
    super(`Insufficient ${token.symbol}: the wallet holds less than this deposit needs. Nothing was signed.`);
    this.name = "InsufficientBalanceError";
    this.token = token;
  }
}
