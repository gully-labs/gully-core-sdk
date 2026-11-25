// SPDX-License-Identifier: MIT
/**
 * The airdrop PRODUCT rules, kept apart from the contract.
 *
 * `GullyCoreMerkleDrop` stores one 32-byte root and a claimed-bitmap, so it has no recipient cap of its own.
 * The cap people meet is a product choice, enforced here (and by any UI that calls these helpers):
 * `AIRDROP_MAX_RECIPIENTS`. Raising it later needs no new contract; the claims-file host
 * (`DROP_CLAIMS_MAX_CLAIMS` on the Core API, 5,000) is the next limit above it.
 *
 * The one thing that DOES bound a list on chain is putting the claims INSIDE the drop's `metadataURI`
 * (2,048 bytes, about 25 wallets as a data: URI). Never do that: publish the claims file (`buildAirdrop` ->
 * `claimsFile`) to IPFS and put its `ipfs://` URI in `metadataURI`.
 */

import { getAddress, type Address, type Hex } from "viem";

import { mergeDuplicateRecipients, parseRecipientsCsv, type ParsedRecipients, type Recipient } from "./amounts.js";
import { buildDropClaimsFile, claimsOf, type DropClaim, type DropClaimsFile } from "./merkle.js";
import type { HolderAirdropPlan } from "./holders.js";

/** Product limit on recipients per airdrop. Not a contract limit. */
export const AIRDROP_MAX_RECIPIENTS = 500;

/** The CSV a creator can download, fill in and upload. Comments (`#`) and the header are skipped by the parser. */
export const AIRDROP_CSV_TEMPLATE =
  "address,amount\n# one wallet per line; amount in whole tokens, e.g. 12.5\n0x0000000000000000000000000000000000000001,10\n0x0000000000000000000000000000000000000002,2.5\n";

export interface AirdropListIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface AirdropListCheck {
  readonly ok: boolean;
  readonly count: number;
  readonly total: bigint;
  readonly issues: readonly AirdropListIssue[];
}

/**
 * Check a parsed list against the product rules: at least one recipient, at most `max` (default 500),
 * and, when the creator approved an amount, a total that does not exceed it. Parser issues are carried over
 * (line-numbered); duplicate addresses are an error here because one wallet gets one leaf.
 */
export function checkAirdropList(
  parsed: Pick<ParsedRecipients, "rows" | "issues" | "total">,
  opts: { readonly max?: number; readonly approvedTotal?: bigint } = {},
): AirdropListCheck {
  const max = opts.max ?? AIRDROP_MAX_RECIPIENTS;
  const issues: AirdropListIssue[] = parsed.issues
    .filter((i) => !(i.severity === "warning" && /^Same address as line/.test(i.message)))
    .map((i) => ({ severity: i.severity, message: i.line > 0 ? `Line ${i.line}: ${i.message}` : i.message }));
  const seen = new Set<string>();
  let dup = 0;
  for (const r of parsed.rows) {
    const k = r.account.toLowerCase();
    if (seen.has(k)) dup++;
    seen.add(k);
  }
  if (dup > 0) issues.push({ severity: "error", message: `${dup} address${dup === 1 ? " is" : "es are"} listed more than once. Merge them first.` });
  if (parsed.rows.length === 0) issues.push({ severity: "error", message: "The list has no recipients." });
  if (parsed.rows.length > max) issues.push({ severity: "error", message: `${parsed.rows.length} recipients; an airdrop takes at most ${max}. Split it in two.` });
  if (parsed.rows.some((r) => r.amount === 0n)) issues.push({ severity: "error", message: "A recipient with amount 0 cannot claim anything. Remove it." });
  if (opts.approvedTotal !== undefined && parsed.total > opts.approvedTotal) issues.push({ severity: "error", message: "The list adds up to more than the amount you approved." });
  return { ok: !issues.some((i) => i.severity === "error"), count: parsed.rows.length, total: parsed.total, issues };
}

export interface BuiltAirdrop {
  /** The root to pass to `createDrop`. */
  readonly merkleRoot: Hex;
  /** Sum of the amounts: the `amount` to fund. */
  readonly total: bigint;
  readonly recipients: readonly Recipient[];
  /** Publish this (IPFS) and put its URI in `metadataURI`. */
  readonly claimsFile: DropClaimsFile;
  /** The leaf, index and proof for a wallet; `[]` when it is not on the list. */
  getProof(account: string): DropClaim[];
}

/**
 * CSV rows or a holder snapshot plan -> the tree, the claims file and per-wallet proofs.
 * Duplicates are summed, zero amounts dropped; a list over `max` throws.
 */
export function buildAirdrop(args: {
  readonly chainId: number;
  readonly currency: Address;
  readonly recipients: readonly Recipient[] | HolderAirdropPlan;
  readonly symbol?: string | null;
  readonly decimals?: number | null;
  readonly max?: number;
}): BuiltAirdrop {
  const rows: readonly Recipient[] = "recipients" in args.recipients ? args.recipients.recipients : args.recipients;
  const merged = mergeDuplicateRecipients(rows).filter((r) => r.amount > 0n);
  const max = args.max ?? AIRDROP_MAX_RECIPIENTS;
  if (merged.length === 0) throw new RangeError("An airdrop needs at least one recipient with an amount above zero.");
  if (merged.length > max) throw new RangeError(`${merged.length} recipients; an airdrop takes at most ${max}.`);
  const claimsFile = buildDropClaimsFile({ chainId: args.chainId, currency: args.currency, recipients: merged, symbol: args.symbol ?? null, decimals: args.decimals ?? null });
  return {
    merkleRoot: claimsFile.merkleRoot,
    total: BigInt(claimsFile.total),
    recipients: merged.map((r) => ({ account: getAddress(r.account), amount: r.amount })),
    claimsFile,
    getProof: (account) => claimsOf(claimsFile, account),
  };
}

/** The shape of the Core indexer's `GET /tokens/:addr/holders` and `/tokens/:addr/airdrop-snapshot` rows. */
export interface IndexerHolderRow {
  readonly address: string;
  readonly balance: string | number | bigint;
}

/** Indexer rows -> `HolderBalance[]` for `planHolderAirdrop` (non-positive and malformed rows are dropped). */
export function holdersFromIndexer(rows: readonly IndexerHolderRow[]): { address: Address; balance: bigint }[] {
  const out: { address: Address; balance: bigint }[] = [];
  for (const r of rows) {
    let b: bigint;
    try {
      b = BigInt(r.balance);
    } catch {
      continue;
    }
    if (b <= 0n || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) continue;
    out.push({ address: getAddress(r.address), balance: b });
  }
  return out;
}

/** The row-error shape the kre8 Airdrops UI uses: `line` is 1-based, 0 = about the whole list. */
export interface AirdropCsvError {
  readonly line: number;
  readonly message: string;
}

export interface AirdropCsvResult {
  readonly entries: readonly Recipient[];
  readonly errors: readonly AirdropCsvError[];
  readonly total: bigint;
}

/**
 * ONE CSV parser for every airdrop UI: `parseRecipientsCsv` (exact decimals, checksum, header, comments) with
 * duplicates as errors, plus the product rules of `checkAirdropList`. Returns `{ entries, errors, total }`,
 * which is what `parseRecipientCsv` in kre8's `airdropsV2.ts` returned, so that file can delegate to this.
 * `decimals` are the token's; amounts are whole tokens.
 */
export function parseAirdropCsv(text: string, decimals: number, opts: { max?: number; approvedTotal?: bigint | null } = {}): AirdropCsvResult {
  const parsed = parseRecipientsCsv(text.replace(/^﻿/, ""), { decimals, duplicates: "error" });
  const check = checkAirdropList(parsed, { ...(opts.max !== undefined ? { max: opts.max } : {}), ...(opts.approvedTotal != null ? { approvedTotal: opts.approvedTotal } : {}) });
  const errors: AirdropCsvError[] = [];
  for (const i of parsed.issues) if (i.severity === "error" && !(i.line === 0 && i.message === "No recipients found.")) errors.push({ line: i.line, message: i.message });
  for (const i of parsed.rows) if (i.amount === 0n) errors.push({ line: i.line, message: "The amount must be more than 0" });
  const wholeList = check.issues.filter((i) => i.severity === "error" && !/^Line \d+:/.test(i.message) && !/listed more than once|amount 0|^No recipients found/.test(i.message));
  for (const w of wholeList) errors.push({ line: 0, message: w.message });
  const entries = parsed.rows.filter((r) => r.amount > 0n).map((r) => ({ account: r.account, amount: r.amount }));
  return { entries, errors, total: entries.reduce((s, r) => s + r.amount, 0n) };
}
