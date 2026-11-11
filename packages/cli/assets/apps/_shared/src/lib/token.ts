// SPDX-License-Identifier: MIT
/** Token facts read from the chain, never guessed. */

import { erc20Abi, formatUnits, zeroAddress, type Address } from "viem";

import type { Ctx } from "./chain.js";

export interface TokenFacts {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly native: boolean;
}

export async function tokenFacts(ctx: Ctx, token: Address): Promise<TokenFacts> {
  if (token === zeroAddress) {
    const n = ctx.chain.nativeCurrency;
    return { address: token, symbol: n.symbol, decimals: n.decimals, native: true };
  }
  const [symbol, decimals] = await Promise.all([
    ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address: token, symbol: symbol ?? token, decimals, native: false };
}

export function amount(t: TokenFacts, v: bigint): string {
  return `${formatUnits(v, t.decimals)} ${t.symbol}`;
}

export async function balanceOf(ctx: Ctx, t: TokenFacts, who: Address): Promise<bigint> {
  return t.native
    ? ctx.client.getBalance({ address: who })
    : ctx.client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

export async function allowance(ctx: Ctx, t: TokenFacts, owner: Address, spender: Address): Promise<bigint> {
  if (t.native) return 0n;
  return ctx.client.readContract({ address: t.address, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}
