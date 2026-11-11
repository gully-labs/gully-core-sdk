// SPDX-License-Identifier: MIT
/** A token from what the user typed: `native`, a symbol the address book lists, or an address. */

import { getDeployment, type GullyCoreDeployment, type TokenInfo } from "@gullylabs/core-sdk";
import { readTokenMeta } from "@gullylabs/core-sdk/launchpad";
import { erc20Abi, getAddress, isAddress, zeroAddress, type Address } from "viem";

import { assertNativeValue, type ChainContext } from "./chain.js";
import { UserError } from "../util/log.js";

export interface ResolvedToken {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly native: boolean;
  readonly isTestToken: boolean;
  readonly note?: string;
}

export function bookTokens(d: GullyCoreDeployment): readonly TokenInfo[] {
  return d.tokens as readonly TokenInfo[];
}

function fromBook(t: TokenInfo): ResolvedToken {
  return { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, native: false, isTestToken: t.isTestToken, ...(t.note !== undefined ? { note: t.note } : {}) };
}

export function nativeToken(ctx: ChainContext): ResolvedToken {
  const n = ctx.chain.nativeCurrency;
  return { address: zeroAddress, symbol: n.symbol, name: n.name, decimals: n.decimals, native: true, isTestToken: !ctx.isMainnet };
}

/**
 * A symbol only ever resolves from the address book: a name typed on a command line must never land on
 * whatever token some list calls that. Anything else needs its address.
 */
export async function resolveToken(ctx: ChainContext, text: string, what: string): Promise<ResolvedToken> {
  const t = text.trim();
  if (t.toLowerCase() === "native" || t.toLowerCase() === ctx.chain.nativeCurrency.symbol.toLowerCase() || /^0x0{40}$/.test(t)) assertNativeValue(ctx);
  const d = ctx.deployment ?? getDeployment(ctx.chainId);
  if (t.toLowerCase() === "native" || t.toLowerCase() === ctx.chain.nativeCurrency.symbol.toLowerCase()) return nativeToken(ctx);
  const book = d === undefined || d === null ? [] : bookTokens(d);
  if (isAddress(t)) {
    const address = getAddress(t);
    if (address === zeroAddress) return nativeToken(ctx);
    const known = book.find((b) => b.address.toLowerCase() === address.toLowerCase());
    if (known !== undefined) return fromBook(known);
    const meta = await readTokenMeta(ctx.client, address);
    if (meta === null) throw new UserError(`${what}: ${address} does not answer as an ERC-20 on ${ctx.name}`);
    return { address: meta.address, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, native: false, isTestToken: false };
  }
  const bySymbol = book.filter((b) => b.symbol.toLowerCase() === t.toLowerCase());
  if (bySymbol.length === 1) return fromBook(bySymbol[0] as TokenInfo);
  const listed = book.map((b) => b.symbol).join(", ");
  throw new UserError(`${what}: "${t}" is not a token on ${ctx.name}'s address book`, `use native, ${listed === "" ? "or" : `${listed}, or`} a token address`);
}

/** What `holder` has of a token, in raw units. */
export async function balanceOf(ctx: ChainContext, token: ResolvedToken, holder: Address): Promise<bigint> {
  if (token.native) return ctx.client.getBalance({ address: holder });
  return ctx.client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
}
