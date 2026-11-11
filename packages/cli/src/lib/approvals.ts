// SPDX-License-Identifier: MIT
/**
 * Permit2 approvals for a spender that pulls through it (the router, the position managers).
 *
 * Exact amount, one hour. Never an unlimited grant. Built here from what the user asked for, so an API
 * response never decides what a wallet approves.
 */

import { buildErc20Approve, readErc20Allowance } from "@gullylabs/core-sdk/lock";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import type { ChainContext } from "./chain.js";
import type { FlowTx } from "./flow.js";

export const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export function encodePermit2Approve(token: Address, spender: Address, amount: bigint, expiration: number): Hex {
  return encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [token, spender, amount, expiration] });
}

/** The approvals `owner` still needs so `spender` can pull `amount` of `token` through Permit2. */
export async function permit2Steps(
  ctx: ChainContext,
  args: { readonly owner: Address; readonly token: Address; readonly symbol: string; readonly spender: Address; readonly amount: bigint; readonly permit2: Address; readonly now: bigint },
): Promise<FlowTx[]> {
  const steps: FlowTx[] = [];
  const base = { chainId: ctx.chainId, from: args.owner };
  const toPermit2 = await readErc20Allowance(ctx.client, args.token, args.owner, args.permit2);
  if (toPermit2 < args.amount) {
    steps.push({ label: `approve ${args.symbol} to Permit2 (exact amount)`, tx: { ...base, ...buildErc20Approve({ token: args.token, spender: args.permit2, amount: args.amount }) } });
  }
  const [granted, expiration] = await ctx.client.readContract({ address: args.permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [args.owner, args.token, args.spender] });
  if (granted < args.amount || BigInt(expiration) <= args.now) {
    const data = encodePermit2Approve(args.token, args.spender, args.amount, Number(args.now + 3_600n));
    steps.push({ label: `grant ${args.symbol} through Permit2 (exact amount, 1 hour)`, tx: { ...base, to: args.permit2, data, value: 0n }, afterPrevious: steps.length > 0 });
  }
  return steps;
}
