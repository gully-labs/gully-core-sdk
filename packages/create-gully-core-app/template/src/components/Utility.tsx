// SPDX-License-Identifier: MIT
/**
 * Pieces every Gully Core-utility screen (splits, locks, airdrops) shares: the live
 * fee panel, the transaction status line and an explorer link.
 *
 * THE FEE PANEL is the rule "fees are the contracts', read live, shown before
 * signing" made into one component. Every utility contract charges one flat
 * native fee (`GullyCoreFeeGate`): the panel reads `feeWei`, an announced
 * increase, the immutable cap and the immutable recipient in the same block,
 * says what `msg.value` will carry, and says that this app adds nothing. It is
 * never a USD number: native units with the chain's symbol.
 */

import type { FeeGateTerms } from "@gullylabs/core-sdk/lock";
import type { ReactElement, ReactNode } from "react";
import { formatEther, type Address } from "viem";

import { resolveConfig } from "../config/resolve";
import { explorerAddressUrl, explorerTxUrl } from "../lib/client";
import { ExplorerLink } from "./ExplorerLink";
import { shortAddress } from "../lib/format";
import type { TxPhase } from "../lib/tx";

export function AddressLink({ address, full = false }: { address: Address; full?: boolean }): ReactElement {
  return (
    <ExplorerLink href={explorerAddressUrl(address)} className="mono" title={address}>
      {full ? address : shortAddress(address)}
    </ExplorerLink>
  );
}

/** `when` in unix seconds as `2026-10-01 14:05 UTC`. The chain's clock, never the browser's zone. */
export function utc(when: bigint): string {
  return `${new Date(Number(when) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Native wei with the chain's symbol. */
export function native(wei: bigint): string {
  return `${formatEther(wei)} ${resolveConfig().nativeCurrency.symbol}`;
}

/**
 * The fee a utility contract charges, read live. `per` names what one fee
 * buys ("lock", "batch", "drop"); `count` multiplies it for a multi-call plan.
 */
export function UtilityFee({
  terms,
  contract,
  per,
  count = 1,
  children,
}: {
  terms: FeeGateTerms;
  contract: string;
  per: string;
  count?: number;
  children?: ReactNode;
}): ReactElement {
  const cfg = resolveConfig();
  const pending = terms.pendingFee;
  const rises = pending !== null && pending.feeWei > terms.feeWei;
  const safe = rises ? pending.feeWei : terms.feeWei;
  return (
    <section className="panel fee-panel" aria-label="Fee">
      <h2>What this costs</h2>
      <dl className="kv">
        <dt>Fee now</dt>
        <dd>
          {native(terms.feeWei)} per {per}
          {count > 1 ? ` · × ${count} = ${native(terms.feeWei * BigInt(count))}` : ""}
        </dd>
        {pending !== null ? (
          <>
            <dt>{rises ? "Announced increase" : "Announced change"}</dt>
            <dd>
              {native(pending.feeWei)} from {utc(pending.effectiveAt)}
            </dd>
          </>
        ) : null}
        <dt>Sent as fee</dt>
        <dd>
          {native(safe * BigInt(count))}
          {rises ? " (covers the announced increase; the contract refunds the surplus in the same call)" : ""}
        </dd>
        <dt>Ceiling</dt>
        <dd>{native(terms.capWei)} per {per}, immutable</dd>
        <dt>Paid to</dt>
        <dd>
          <AddressLink address={terms.recipient} /> <span className="muted">(the protocol, immutable)</span>
        </dd>
      </dl>
      <p className="state-hint">
        Charged and enforced by <code>{contract}</code> at <AddressLink address={terms.address} />, read in this block.
        Gully Core governance sets it inside the ceiling; an increase waits {Math.round(terms.noticeSeconds / 3600)} h
        after it is announced, a decrease applies at once. <strong>{cfg.brand.name} adds no fee of its own.</strong>
      </p>
      {children}
    </section>
  );
}

/** One line for where a transaction is. */
export function TxStatus({ phase }: { phase: TxPhase }): ReactElement | null {
  switch (phase.kind) {
    case "idle":
      return null;
    case "simulating":
      return <p className="state state-loading">{phase.label}: simulating the exact call…</p>;
    case "signing":
      return <p className="state state-loading">{phase.label}: the simulation passed; confirm in your wallet…</p>;
    case "confirming":
      return (
        <p className="state state-loading">
          {phase.label}: sent,{" "}
          <ExplorerLink href={explorerTxUrl(phase.hash)}>
            waiting for the receipt
          </ExplorerLink>
          …
        </p>
      );
    case "done":
      return (
        <p className="state state-ok">
          {phase.label}: confirmed.{" "}
          <ExplorerLink href={explorerTxUrl(phase.hash)}>
            View transaction
          </ExplorerLink>
        </p>
      );
    case "failed":
      return (
        <p className="state state-error" role="alert">
          {phase.label}: {phase.message}
        </p>
      );
  }
}
