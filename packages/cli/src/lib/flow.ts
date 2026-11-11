// SPDX-License-Identifier: MIT
/**
 * One or more transactions, simulated, then printed or signed.
 *
 * A step marked `afterPrevious` depends on the one before it having landed (a `createDrop` needs the
 * `approve` first). In --print mode it cannot be simulated yet and says so; with a keystore it is
 * simulated immediately before it is sent, after its predecessor mined. Nothing is sent that did not
 * simulate, and a confirmation (typed, unless --yes) comes before the first send.
 *
 * `assertMayWrite` is the one gate before a signature: a chain with no deployment is refused, and on a
 * mainnet --yes counts only when the network was named on this command line, so a default in the config
 * can never turn a script into a mainnet write.
 */

import { parseEventLogs, type Abi, type Hex } from "viem";

import { ui } from "./brand.js";
import { requireDeployment, type ChainContext } from "./chain.js";
import { currentCommand } from "./command.js";
import type { Output } from "./output.js";
import { askTypedConfirmation } from "./prompt.js";
import { canSend, receiptJson, renderTx, send, simulate, type PreparedTx, type Signer } from "./tx.js";
import { EXIT, UserError } from "../util/log.js";

export interface FlowTx {
  readonly label: string;
  readonly tx: PreparedTx;
  readonly afterPrevious?: boolean;
}

export interface FlowConfirm {
  readonly prompting: boolean;
  readonly yes: boolean;
  readonly what: string;
  readonly expected: string;
}

export interface FlowSent {
  readonly label: string;
  readonly hash: Hex;
  readonly receipt: Record<string, unknown>;
  readonly events: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
}

export interface FlowResult {
  readonly ok: boolean;
  readonly simulations: readonly { readonly label: string; readonly ok: boolean | null; readonly error?: string }[];
  readonly sent: readonly FlowSent[];
  /** The user declined at the confirmation. */
  readonly cancelled?: true;
}

/** The exit code for a flow's outcome: a revert is 4, a declined confirmation is 130. */
export function flowExit(r: FlowResult): number {
  if (r.ok) return EXIT.OK;
  return r.cancelled === true ? EXIT.CANCELLED : EXIT.SIMULATION;
}

/** The last gate before a key is touched. Throws rather than returns. */
export function assertMayWrite(ctx: ChainContext, yes: boolean): void {
  requireDeployment(ctx);
  if (ctx.isMainnet && yes && currentCommand()?.chainNamed !== true) {
    throw new UserError(`--yes on ${ctx.name} needs the network named on the command line`, `add --network ${ctx.chainId}: a mainnet write is never taken from a default`, EXIT.REFUSED);
  }
}

/** The warning line a mainnet confirmation opens with. */
export function mainnetPrefix(ctx: ChainContext): string {
  return ctx.isMainnet ? `MAINNET: ${ctx.name}, real funds. ` : "";
}

export async function runFlow(out: Output, ctx: ChainContext, signer: Signer, txs: readonly FlowTx[], confirm: FlowConfirm, abis: readonly Abi[]): Promise<FlowResult> {
  const native = ctx.chain.nativeCurrency.symbol;
  const sims: Array<{ label: string; ok: boolean | null; error?: string }> = [];
  const allAbi = abis.flatMap((a) => [...a]) as Abi;

  const printing = !canSend(signer);
  for (const t of txs) {
    if (t.afterPrevious === true && sims.length > 0) {
      sims.push({ label: t.label, ok: null });
      out.line(`${ui.muted("·")} ${t.label}: simulates once the step before it has landed`);
      continue;
    }
    const s = await simulate(ctx, t.tx, abis);
    sims.push({ label: t.label, ...s });
    out.line(s.ok ? `${ui.success("✓")} Simulated ${t.label}` : `${ui.bold("✕")} ${t.label} would revert: ${s.error}`);
    if (!s.ok) return { ok: false, simulations: sims, sent: [] };
  }

  if (printing) {
    txs.forEach((t, i) => {
      out.line("");
      out.line(ui.accent(`${i + 1}. ${t.label}`));
      renderTx(out, ctx, t.tx, native);
    });
    return { ok: true, simulations: sims, sent: [] };
  }

  assertMayWrite(ctx, confirm.yes);
  if (!confirm.yes) {
    if (!confirm.prompting) throw new UserError("sending needs --yes when there is no terminal to confirm in", undefined, EXIT.REFUSED);
    if (!(await askTypedConfirmation(`${mainnetPrefix(ctx)}${confirm.what}`, confirm.expected))) return { ok: false, simulations: sims, sent: [], cancelled: true };
  }
  const sent: FlowSent[] = [];
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i] as FlowTx;
    if (sims[i]?.ok === null) {
      const s = await simulate(ctx, t.tx, abis);
      sims[i] = { label: t.label, ...s };
      out.line(s.ok ? `${ui.success("✓")} Simulated ${t.label}` : `${ui.bold("✕")} ${t.label} would revert: ${s.error}`);
      if (!s.ok) return { ok: false, simulations: sims, sent };
    }
    const r = await send(ctx, signer, t.tx);
    let events: FlowSent["events"] = [];
    try {
      events = parseEventLogs({ abi: allAbi, logs: r.receipt.logs }).map((l) => ({ name: l.eventName, args: (l.args ?? {}) as Record<string, unknown> }));
    } catch {
      /* logs from contracts outside these ABIs are simply not decoded */
    }
    out.line(`${r.receipt.status === "success" ? ui.success("✓") : ui.bold("✕")} ${t.label}: ${r.hash} ${ui.muted(`block ${r.receipt.blockNumber}, gas ${r.receipt.gasUsed}`)}`);
    sent.push({ label: t.label, hash: r.hash, receipt: receiptJson(r.receipt), events });
    if (r.receipt.status !== "success") return { ok: false, simulations: sims, sent };
  }
  return { ok: true, simulations: sims, sent };
}
