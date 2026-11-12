// SPDX-License-Identifier: MIT
/**
 * Permit2 by SIGNATURE (owner, 2026-10-11: "I had to do 2 transactions just to sell the token how can we
 * cut it to 1?").
 *
 * A first swap of an ERC-20 used to need three steps: `token.approve(Permit2)`, `Permit2.approve(router)`
 * and the swap. The second step is a transaction only because the widget sent it as one. Permit2 also
 * takes the same grant as an EIP-712 `PermitSingle` SIGNATURE, which the UniversalRouter applies itself
 * through its `PERMIT2_PERMIT` command, first in the swap's own command list. So the grant costs a
 * signature (no gas, no transaction) and rides in the swap.
 *
 * What is signed is exactly what the transaction step used to grant: the router as spender, the input
 * token, `MAX_UINT160`, expiring in 30 days, at Permit2's current nonce for (owner, token, router). The
 * router passes `msg.sender` to Permit2 as the owner, so only the signer's own transaction can use it. The
 * SDK's `verifySwapCalldata` accepts the command only first, only for `tokenIn`, only to the router the
 * transaction is addressed to, and for at least `amountIn`.
 *
 * The one-time `token.approve(Permit2)` stays a transaction (an ERC-20 with no EIP-2612 has no other way),
 * at the maximum, so it is asked once per token per wallet.
 */

import { encodeAbiParameters, type Address, type Hex } from "viem";

/** Permit2's `uint160` ceiling: the same grant `Permit2.approve(token, router, MAX_UINT160, …)` made. */
export const PERMIT_MAX_AMOUNT = (1n << 160n) - 1n;
/** How long the granted allowance lasts (Permit2 `expiration`). */
export const PERMIT_EXPIRATION_SECONDS = 30 * 24 * 60 * 60;
/** How long the signature itself may be used (Permit2 `sigDeadline`). */
export const PERMIT_SIG_DEADLINE_SECONDS = 30 * 60;

export interface PermitSingle {
  readonly details: { readonly token: Address; readonly amount: bigint; readonly expiration: number; readonly nonce: number };
  readonly spender: Address;
  readonly sigDeadline: bigint;
}

export interface SignedPermit {
  readonly permit: PermitSingle;
  readonly signature: Hex;
}

/** The permit a swap of `token` through `spender` asks the wallet to sign, at Permit2's `nonce`. */
export function buildPermitSingle(o: { readonly token: Address; readonly spender: Address; readonly nonce: number; readonly nowSeconds: number }): PermitSingle {
  return {
    details: { token: o.token, amount: PERMIT_MAX_AMOUNT, expiration: o.nowSeconds + PERMIT_EXPIRATION_SECONDS, nonce: o.nonce },
    spender: o.spender,
    sigDeadline: BigInt(o.nowSeconds + PERMIT_SIG_DEADLINE_SECONDS),
  };
}

/** Permit2's EIP-712 typed data for `permit`, as a wallet's `signTypedData` takes it. */
export function permitTypedData(chainId: number, permit2: Address, permit: PermitSingle) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: permit2 },
    types: {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    primaryType: "PermitSingle" as const,
    message: {
      details: { token: permit.details.token, amount: permit.details.amount, expiration: permit.details.expiration, nonce: permit.details.nonce },
      spender: permit.spender,
      sigDeadline: permit.sigDeadline,
    },
  };
}

export type PermitTypedData = ReturnType<typeof permitTypedData>;

const PERMIT_SINGLE_INPUT = [
  {
    type: "tuple",
    components: [
      {
        name: "details",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
  },
  { type: "bytes" },
] as const;

/** The `PERMIT2_PERMIT` command's input: `abi.encode(PermitSingle, signature)`. */
export function encodePermitInput(signed: SignedPermit): Hex {
  return encodeAbiParameters(PERMIT_SINGLE_INPUT, [
    { details: { ...signed.permit.details }, spender: signed.permit.spender, sigDeadline: signed.permit.sigDeadline },
    signed.signature,
  ]);
}
