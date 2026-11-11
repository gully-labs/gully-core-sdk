// SPDX-License-Identifier: MIT
/**
 * "Build the list from holders of a token": fills the airdrop's recipient list
 * from the chain instead of a CSV.
 *
 * `readHolderSnapshot` (SDK) reduces the token's Transfer logs from a start
 * block to the snapshot block and CHECKS the sum against `totalSupply()` read at
 * that block; a scan that cannot finish or does not add up is an error, never a
 * partial list. `planHolderAirdrop` computes the amounts with exact integer
 * math (pro-rata floors, equal split floors; the dust is not sent and is
 * shown). Default exclusions (Vault, pool managers, LP lockers, lock contracts,
 * drop factory, multisend, zero/dead, the token itself) come from the address
 * book. The result is written into the CSV box as exact `address,amount` lines,
 * so it goes through the same parse, batching and Merkle code as a CSV.
 */

import {
  defaultHolderExclusions,
  formatAmountExact,
  parseAmountExact,
  planHolderAirdrop,
  readContractAccounts,
  readHolderSnapshot,
  type HolderAirdropMode,
  type HolderAirdropPlan,
  type HolderSnapshot,
} from "@gullylabs/core-sdk/drop";
import { useState, type ReactElement } from "react";
import { isAddress, getAddress, type Address } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "../lib/client";
import { shortAddress } from "../lib/format";
import { utc } from "./Utility";

type Mode = HolderAirdropMode["kind"];

export function HoldersInput({
  decimals,
  symbol,
  kind,
  onText,
}: {
  /** The AIRDROP token's decimals (`null`: it cannot be used). */
  decimals: number | null;
  symbol: string;
  kind: "multisend" | "drop";
  onText: (csv: string) => void;
}): ReactElement {
  const cfg = resolveConfig();
  const [open, setOpen] = useState(false);
  const [tokenText, setTokenText] = useState("");
  const [fromText, setFromText] = useState(cfg.core.deployedAtBlock.toString());
  const [snapText, setSnapText] = useState("");
  const [mode, setMode] = useState<Mode>("pro-rata");
  const [amountText, setAmountText] = useState("");
  const [minText, setMinText] = useState("");
  const [topText, setTopText] = useState("");
  const [excludeContracts, setExcludeContracts] = useState(kind === "drop");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ snap: HolderSnapshot; plan: HolderAirdropPlan } | null>(null);

  async function build(): Promise<void> {
    setError(null);
    setResult(null);
    if (decimals === null) return setError("The airdrop token does not answer decimals(); amounts cannot be computed exactly.");
    if (!isAddress(tokenText.trim())) return setError("Enter the address of the token whose holders receive the airdrop.");
    const from = /^\d+$/.test(fromText.trim()) ? BigInt(fromText.trim()) : null;
    const at = snapText.trim() === "" ? undefined : /^\d+$/.test(snapText.trim()) ? BigInt(snapText.trim()) : null;
    if (from === null || at === null) return setError("Blocks are whole numbers; leave the snapshot empty for the latest block.");
    let modeArg: HolderAirdropMode;
    let minBalance = 0n;
    try {
      const v = parseAmountExact(amountText, decimals);
      modeArg = mode === "fixed" ? { kind: "fixed", amountEach: v } : { kind: mode, budget: v };
    } catch (e) {
      return setError(`${mode === "fixed" ? "Amount each" : "Budget"}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const token = getAddress(tokenText.trim());
    try {
      setBusy("Loading holders…");
      const snap = await readHolderSnapshot(publicClient(), token, {
        fromBlock: from,
        ...(at === undefined ? {} : { snapshotBlock: at }),
        window: 10_000_000n,
        minWindow: 1_000n,
      });
      if (minText.trim() !== "") {
        const d = await publicClient()
          .readContract({ address: token, abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" })
          .catch(() => null);
        if (d === null && !/^\d+$/.test(minText.trim())) return setError("The holders' token does not answer decimals(): give the minimum balance in whole base units.");
        minBalance = d === null ? BigInt(minText.trim()) : parseAmountExact(minText, Number(d));
      }
      let contracts: Set<string> | undefined;
      if (excludeContracts) {
        setBusy(`Checking which of ${snap.holders.length} holders are contracts…`);
        contracts = await readContractAccounts(publicClient(), snap.holders.map((h) => h.address), { blockNumber: snap.snapshotBlock });
      }
      const topN = topText.trim() === "" ? undefined : Number(topText.trim());
      const plan = planHolderAirdrop(snap.holders, modeArg, {
        minBalance,
        exclude: defaultHolderExclusions(cfg.contracts, token),
        excludeContracts,
        ...(contracts === undefined ? {} : { contracts }),
        ...(topN === undefined ? {} : { topN }),
      });
      setResult({ snap, plan });
    } catch (e) {
      setError(`No list: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <p>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          …or build the list from holders of a token
        </button>
      </p>
    );
  }
  const fmt = (v: bigint) => (decimals === null ? v.toString() : formatAmountExact(v, decimals));

  return (
    <fieldset>
      <legend>Build the list from holders of a token</legend>
      <label>
        Holders of (token address)
        <input value={tokenText} onChange={(e) => setTokenText(e.target.value)} placeholder="0x…" spellCheck={false} />
      </label>
      <label>
        Scan from block
        <input value={fromText} onChange={(e) => setFromText(e.target.value)} inputMode="numeric" />
        <small>At or before the token&rsquo;s creation: a later start fails the totalSupply check and says so.</small>
      </label>
      <label>
        Snapshot block (empty = latest)
        <input value={snapText} onChange={(e) => setSnapText(e.target.value)} inputMode="numeric" placeholder="latest" />
      </label>
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="pro-rata">Pro-rata to balance (a budget)</option>
          <option value="equal">Equal split (a budget)</option>
          <option value="fixed">A fixed amount each</option>
        </select>
      </label>
      <label>
        {mode === "fixed" ? `Amount each (${symbol})` : `Budget (${symbol})`}
        <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Minimum balance (holders&rsquo; token, optional)
        <input value={minText} onChange={(e) => setMinText(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Top N holders only (optional)
        <input value={topText} onChange={(e) => setTopText(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        <input type="checkbox" checked={excludeContracts} onChange={(e) => setExcludeContracts(e.target.checked)} /> Exclude contract accounts
        <small>
          {kind === "drop"
            ? " A claimable drop pays a contract only when it calls claim itself; a pool or locker never will."
            : " A multisend pays contracts too; one that refuses the transfer reverts its whole batch."}
        </small>
      </label>
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void build()}>
          {busy ?? "Read holders and compute"}
        </button>
      </div>
      {error !== null ? (
        <p className="state state-error" role="alert">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <div className="parse-report">
          <p>
            Holders as of {utc(result.snap.snapshotTimestamp)}; balances add up to the total supply.
          </p>
          <p>
            {result.plan.recipients.length} recipients · total {fmt(result.plan.total)} {symbol}
            {result.plan.budget === null ? "" : ` · dust not sent ${fmt(result.plan.dust)} ${symbol}`} · {result.plan.excluded.length} excluded
          </p>
          {result.plan.excluded.length > 0 ? (
            <ul className="problem-list">
              {result.plan.excluded.slice(0, 30).map((e) => (
                <li key={`${e.address}:${e.kind}`}>
                  <code>{shortAddress(e.address as Address)}</code>
                  <span>{e.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={result.plan.recipients.length === 0}
              onClick={() => onText(result.plan.recipients.map((r) => `${r.account},${fmt(r.amount)}`).join("\n") + "\n")}
            >
              Put these {result.plan.recipients.length} recipients in the list
            </button>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
