// SPDX-License-Identifier: MIT
/**
 * Simulate, then (only with --execute) send. Every SDK builder returns
 * `{ to, data, value }`; those exact bytes are what is simulated and signed.
 */

import { BaseError, decodeErrorResult, formatUnits, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";

import type { Ctx } from "./chain.js";

export interface Step {
  readonly label: string;
  readonly call: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  /** True when this step only works once an earlier step of the plan is mined (e.g. after an approval). */
  readonly afterPrevious?: boolean;
}

function revertData(err: unknown): Hex | undefined {
  let e: unknown = err;
  for (let i = 0; i < 8 && e !== undefined && e !== null; i++) {
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x")) return d as Hex;
    if (d !== null && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return (d as { data: Hex }).data;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The revert, named from the given ABIs when possible. */
export function explain(err: unknown, abis: readonly Abi[]): string {
  const data = revertData(err);
  if (data !== undefined && data.length >= 10) {
    for (const abi of abis) {
      try {
        const d = decodeErrorResult({ abi, data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        // not this ABI's error
      }
    }
    return `revert ${data.slice(0, 10)}`;
  }
  return err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
}

export function native(ctx: Ctx, v: bigint): string {
  return `${formatUnits(v, ctx.chain.nativeCurrency.decimals)} ${ctx.chain.nativeCurrency.symbol}`;
}

/**
 * Run a plan in order. Dry run: simulate every step that can be simulated now
 * and report what would be sent. --execute: simulate, send, wait, check the
 * status, one step at a time; the first failure stops the plan.
 */
export async function runPlan(ctx: Ctx, steps: readonly Step[], abis: readonly Abi[]): Promise<TransactionReceipt[]> {
  const receipts: TransactionReceipt[] = [];
  let unsentEarlier = false;
  for (const [i, step] of steps.entries()) {
    const tag = `[${i + 1}/${steps.length}] ${step.label}`;
    console.log(`${tag}\n      to ${step.call.to}, value ${native(ctx, step.call.value)}`);
    if (ctx.from === null) {
      console.log("      not simulated: set PRIVATE_KEY, or FROM for a dry run, to simulate as a sender");
      unsentEarlier = true;
      continue;
    }
    if (unsentEarlier && step.afterPrevious === true) {
      console.log("      not simulated: it needs the step above to be mined first");
      continue;
    }
    try {
      await ctx.client.call({ account: ctx.from, to: step.call.to, data: step.call.data, value: step.call.value });
    } catch (err) {
      throw new Error(`${tag}: the simulation reverted: ${explain(err, abis)}. Nothing was sent.`);
    }
    if (!ctx.execute) {
      console.log("      simulated OK; not sent (dry run: add --execute to send)");
      unsentEarlier = true;
      continue;
    }
    if (ctx.wallet === null || ctx.account === null) throw new Error("--execute needs PRIVATE_KEY.");
    const hash = await ctx.wallet.sendTransaction({
      account: ctx.account,
      chain: ctx.chain,
      to: step.call.to,
      data: step.call.data,
      value: step.call.value,
    });
    const receipt = await ctx.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${tag}: reverted on chain in ${hash}. Later steps were not sent.`);
    console.log(`      sent: ${hash} (block ${receipt.blockNumber})`);
    receipts.push(receipt);
  }
  return receipts;
}
