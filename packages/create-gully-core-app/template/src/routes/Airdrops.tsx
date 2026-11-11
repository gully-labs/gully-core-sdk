// SPDX-License-Identifier: MIT
/**
 * Airdrops: `GullyCoreMultisend` (push native or one ERC-20 to a list, up to 1,000
 * recipients per transaction) and `GullyCoreDropFactory` / `GullyCoreMerkleDrop`
 * (a claimable drop: the tokens sit in a drop contract and each recipient
 * claims with a Merkle proof until it expires; then the creator sweeps the
 * rest).
 *
 * Amounts from a CSV are parsed EXACTLY (`parseRecipientsCsv`): "0.1" is
 * 10^17 base units of an 18-decimal token, never a float, and a value with
 * more decimals than the token has is an error on its line, not a rounding.
 *
 * A drop stores only its Merkle root. Claimers need their index, amount and
 * proof, which live in a claims file the creator publishes. The claim page
 * rebuilds the root from that file and compares it with the root read from
 * the drop before offering a claim, so the file cannot lie about who gets
 * what, wherever it is hosted.
 */

import {
  DROP_MAX_METADATA_BYTES,
  GULLYCORE_DROP_FACTORY_ABI,
  GULLYCORE_MERKLE_DROP_ABI,
  GULLYCORE_MULTISEND_ABI,
  NATIVE,
  buildClaimDrop,
  buildCreateDrop,
  buildDropClaimsFile,
  buildErc20Approve,
  buildSweepDrop,
  claimsOf,
  isNative,
  parseDropClaimsFile,
  parseRecipientsCsv,
  planMultisend,
  readDrop,
  readDropClaimed,
  readDropDirectory,
  readErc20Allowance,
  readIsDrop,
  validateDropDraft,
  verifyDropClaimsFile,
  type DropClaimsFile,
  type ParsedRecipients,
} from "@gullylabs/core-sdk/drop";
import { readChainNow } from "@gullylabs/core-sdk/lock";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { erc20Abi, parseEventLogs, type Abi, type Address } from "viem";

import { BarList, Kpi, Kpis, ViewToggle, type View } from "../components/Charts";
import { sortRows } from "../lib/chart";
import { Async, Empty, NotDeployed } from "../components/States";
import { AddressLink, TxStatus, UtilityFee, utc } from "../components/Utility";
import { resolveConfig } from "../config/resolve";
import { publicClient } from "../lib/client";
import { count, formatAmount, formatBps, shortAddress } from "../lib/format";
import { addressOrNull, claimsFileName, claimsFileUrls, unixToUtcInput, utcInputToUnix } from "../lib/forms";
import { useTx } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { currencyMeta, readUtilityFee, type CurrencyMeta } from "../lib/utilities";
import { HoldersInput } from "../components/HoldersInput";

const DROP_ABIS: readonly Abi[] = [GULLYCORE_MULTISEND_ABI as Abi, GULLYCORE_DROP_FACTORY_ABI as Abi, GULLYCORE_MERKLE_DROP_ABI as Abi, erc20Abi as Abi];

function amountText(value: bigint, meta: CurrencyMeta | null | undefined): string {
  if (meta === null || meta === undefined || meta.decimals === null) return `${value.toString()} base units`;
  return formatAmount(value, meta.decimals, meta.symbol);
}

function AirdropsNotDeployed({ title, contract }: { title: string; contract: string }): ReactElement {
  const cfg = resolveConfig();
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>{title}</h1>
        <Link className="btn btn-ghost" to="/airdrops">
          Airdrops
        </Link>
      </header>
      <NotDeployed what={title} contract={contract} chainName={cfg.core.name} chainId={cfg.core.chainId} />
    </div>
  );
}

/** Download `data` as a JSON file. */
function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------ shared: currency + CSV --- */

const CUSTOM = "custom";

function useCurrencyPicker(): {
  element: ReactElement;
  currency: Address | null;
  meta: CurrencyMeta | null;
} {
  const cfg = resolveConfig();
  const [choice, setChoice] = useState<string>(NATIVE);
  const [custom, setCustom] = useState("");
  const currency: Address | null = choice === CUSTOM ? addressOrNull(custom) : (choice as Address);
  const meta = useAsync(async () => (currency === null ? null : currencyMeta(currency)), [currency]);
  const m = meta.state.status === "ready" ? meta.state.data : null;
  const element = (
    <>
      <label>
        Currency
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value={NATIVE}>{cfg.nativeCurrency.symbol} (native)</option>
          {cfg.tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol} · {shortAddress(t.address)}
            </option>
          ))}
          <option value={CUSTOM}>Another ERC-20 by address…</option>
        </select>
      </label>
      {choice === CUSTOM ? (
        <label>
          Token address
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0x…" />
          <small>
            {m === null ? "Symbol and decimals are read from the contract, never typed." : m.decimals === null ? "Does not answer decimals(); amounts cannot be parsed exactly." : `${m.symbol}, ${m.decimals} decimals (read from the contract).`}
          </small>
        </label>
      ) : null}
    </>
  );
  return { element, currency, meta: m };
}

function CsvInput({ text, onText }: { text: string; onText: (t: string) => void }): ReactElement {
  return (
    <>
      <label>
        Recipients, one per line: <code>address,amount</code> in whole tokens (a header line is skipped)
        <textarea value={text} onChange={(e) => onText(e.target.value)} rows={8} spellCheck={false} placeholder={"address,amount"} />
      </label>
      <label>
        …or upload a CSV file
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f !== undefined) void f.text().then(onText);
          }}
        />
      </label>
    </>
  );
}

function ParseReport({ parsed, meta }: { parsed: ParsedRecipients; meta: CurrencyMeta | null }): ReactElement {
  const errors = parsed.issues.filter((i) => i.severity === "error");
  const warnings = parsed.issues.filter((i) => i.severity === "warning");
  return (
    <div className="parse-report">
      <p>
        {count(parsed.rows.length, "recipient")} · total {amountText(parsed.total, meta)}
        {parsed.header === null ? "" : " · header line skipped"}
      </p>
      {errors.length + warnings.length > 0 ? (
        <ul className="problem-list">
          {[...errors, ...warnings].slice(0, 50).map((i) => (
            <li key={`${i.line}:${i.message}`}>
              <code>{i.line === 0 ? "file" : `line ${i.line}`}</code>
              <span>
                {i.severity === "warning" ? "warning: " : ""}
                {i.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {errors.length + warnings.length > 50 ? <p className="muted">…and {errors.length + warnings.length - 50} more.</p> : null}
    </div>
  );
}

/* --------------------------------------------------------------- index --- */

export function Airdrops(): ReactElement {
  const cfg = resolveConfig();
  const { multisend, dropFactory } = cfg.utilities;
  const drops = useAsync(async () => {
    if (dropFactory === null) return null;
    const dir = await readDropDirectory(publicClient(), dropFactory, { max: 100 });
    const metas = await Promise.all([...new Set(dir.drops.map((d) => d.currency))].map((c) => currencyMeta(c)));
    return { ...dir, metas };
  }, [dropFactory]);
  const [view, setView] = useState<View>("chart");
  if (multisend === null && dropFactory === null) return <AirdropsNotDeployed title="Airdrops" contract="GullyCoreMultisend or GullyCoreDropFactory" />;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Airdrops</h1>
        <p className="page-sub">Send a token to a list in one transaction, or create a drop recipients claim themselves.</p>
        {multisend === null ? null : (
          <Link className="btn btn-primary" to="/airdrops/send">
            Send to a list
          </Link>
        )}{" "}
        {dropFactory === null ? null : (
          <>
            <Link className="btn btn-primary" to="/airdrops/new">
              Create a claimable drop
            </Link>{" "}
            <Link className="btn btn-ghost" to="/airdrops/claim">
              Claim
            </Link>
          </>
        )}
      </header>
      {multisend === null ? (
        <NotDeployed what="Multisend" contract="GullyCoreMultisend" chainName={cfg.core.name} chainId={cfg.core.chainId} />
      ) : null}
      {dropFactory === null ? (
        <NotDeployed what="Claimable drops" contract="GullyCoreDropFactory" chainName={cfg.core.name} chainId={cfg.core.chainId} />
      ) : (
        <Async
          state={drops.state}
          onRetry={drops.reload}
          loadingLabel="Loading drops"
          isEmpty={(d) => d === null || d.drops.length === 0}
          empty={<Empty title="No drops yet" detail="The drop factory has made none." />}
        >
          {(d) =>
            d === null ? null : (
              <>
                <Kpis>
                  <Kpi label="Drops" value={String(d.total)} sub={d.truncated ? `newest ${d.drops.length} read` : "made by this factory"} />
                  <Kpi label="Fully claimed" value={String(d.drops.filter((x) => x.claimedBps >= 10_000).length)} sub={`of ${d.drops.length} read`} />
                  <Kpi label="Untouched" value={String(d.drops.filter((x) => x.claimedBps === 0).length)} sub="no claim yet" />
                </Kpis>
                <div className="chart-head">
                  <h2>Claimed so far</h2>
                  <ViewToggle view={view} onChange={setView} label="Drops" />
                </div>
                {view === "chart" ? (
                  <BarList
                    caption="Share of each drop claimed so far"
                    empty=""
                    rows={sortRows(d.drops, (x) => x.claimedBps, "desc").map((drop) => {
                      const meta = d.metas.find((m) => m.address.toLowerCase() === drop.currency.toLowerCase());
                      const name = `${shortAddress(drop.address)} · ${meta?.symbol ?? shortAddress(drop.currency)}`;
                      return {
                        key: drop.address,
                        label: (
                          <Link to={`/airdrops/claim?drop=${drop.address}`} className="mono">
                            {name}
                          </Link>
                        ),
                        text: name,
                        value: drop.claimedBps,
                        display: `${formatBps(drop.claimedBps)} of ${amountText(drop.totalAmount, meta)}`,
                      };
                    })}
                  />
                ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                  <thead>
                    <tr>
                      <th>Drop</th>
                      <th>Amount</th>
                      <th>Claimed</th>
                      <th>Claimable until</th>
                      <th>Creator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.drops.map((drop) => {
                      const meta = d.metas.find((m) => m.address.toLowerCase() === drop.currency.toLowerCase());
                      return (
                        <tr key={drop.address}>
                          <td>
                            <Link to={`/airdrops/claim?drop=${drop.address}`} className="mono">
                              {shortAddress(drop.address)}
                            </Link>
                          </td>
                          <td>{amountText(drop.totalAmount, meta)}</td>
                          <td>{formatBps(drop.claimedBps)}</td>
                          <td>{utc(drop.expiresAt)}</td>
                          <td>
                            <AddressLink address={drop.creator} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
                )}
              </>
            )
          }
        </Async>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- multisend --- */

export function AirdropSend(): ReactElement {
  const cfg = resolveConfig();
  const multisend = cfg.utilities.multisend;
  const tx = useTx(DROP_ABIS);
  const picker = useCurrencyPicker();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(0);
  const [nonce, setNonce] = useState(0);
  const terms = useAsync(async () => (multisend === null ? null : readUtilityFee(multisend)), [multisend]);

  const parsed = useMemo(() => {
    if (text.trim() === "" || picker.meta === null || picker.meta.decimals === null) return null;
    return parseRecipientsCsv(text, { decimals: picker.meta.decimals });
  }, [text, picker.meta]);

  const plan = useMemo(() => {
    if (multisend === null || parsed === null || !parsed.ok || picker.currency === null || terms.state.status !== "ready" || terms.state.data === null) return null;
    return planMultisend({ multisend, currency: picker.currency, recipients: parsed.rows, terms: terms.state.data });
  }, [multisend, parsed, picker.currency, terms.state]);

  useEffect(() => setSent(0), [plan]);

  const allowance = useAsync(async () => {
    if (plan === null || plan.approval === null || tx.account === undefined) return null;
    return readErc20Allowance(publicClient(), plan.approval.token, tx.account, plan.approval.spender);
  }, [plan, tx.account, nonce]);

  if (multisend === null) return <AirdropsNotDeployed title="Multisend" contract="GullyCoreMultisend" />;
  const needsApproval = plan !== null && plan.approval !== null && allowance.state.status === "ready" && allowance.state.data !== null && allowance.state.data < plan.approval.amount;

  async function sendAll(): Promise<void> {
    if (plan === null) return;
    for (let i = sent; i < plan.batches.length; i += 1) {
      const batch = plan.batches[i];
      if (batch === undefined) return;
      const receipt = await tx.run(`Batch ${i + 1} of ${plan.batches.length} (${batch.recipients} recipients)`, batch.call);
      if (receipt === null) return;
      setSent(i + 1);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Send to a list</h1>
        <p className="page-sub">
          Each transaction pays up to 1,000 recipients exactly, or reverts whole. A longer list is sent in batches, one
          transaction and one fee each.
        </p>
        <Link className="btn btn-ghost" to="/airdrops">
          Airdrops
        </Link>
      </header>
      <Async state={terms.state} onRetry={terms.reload} loadingLabel="Loading the multisend fee">
        {(t) =>
          t === null ? null : (
            <div className="wizard">
              <form className="form" onSubmit={(e) => e.preventDefault()}>
                <fieldset>
                  <legend>What and to whom</legend>
                  {picker.element}
                  <CsvInput text={text} onText={setText} />
                  <HoldersInput key={picker.currency ?? "none"} decimals={picker.meta?.decimals ?? null} symbol={picker.meta?.symbol ?? ""} kind="multisend" onText={setText} />
                  {parsed === null ? null : <ParseReport parsed={parsed} meta={picker.meta} />}
                </fieldset>
                {plan !== null ? (
                  <dl className="kv">
                    <dt>Batches</dt>
                    <dd>
                      {plan.batches.length} ({sent} sent)
                    </dd>
                    <dt>Total to recipients</dt>
                    <dd>{amountText(plan.totalAmount, picker.meta)}</dd>
                    {picker.currency !== null && isNative(picker.currency) ? (
                      <>
                        <dt>Native needed in all</dt>
                        <dd>{amountText(plan.totalValue, picker.meta)} (amounts plus fees)</dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
                <div className="form-actions">
                  {needsApproval && plan?.approval ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={tx.busy}
                      onClick={() => {
                        const a = plan.approval;
                        if (a !== null) void tx.run("Approve", buildErc20Approve(a)).then(() => setNonce((n) => n + 1));
                      }}
                    >
                      1. Approve exactly {amountText(plan.approval.amount, picker.meta)}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-primary" disabled={plan === null || needsApproval || tx.busy || tx.account === undefined || sent >= (plan?.batches.length ?? 0)} onClick={() => void sendAll()}>
                    {tx.account === undefined ? "Connect a wallet" : sent > 0 ? `Send the remaining ${plan === null ? 0 : plan.batches.length - sent}` : "Simulate and send"}
                  </button>
                </div>
                <TxStatus phase={tx.phase} />
                {plan !== null && sent === plan.batches.length && sent > 0 ? <p className="state state-ok">All {plan.batches.length} batches confirmed.</p> : null}
              </form>
              <UtilityFee terms={t} contract="GullyCoreMultisend" per="batch" count={Math.max(1, plan?.batches.length ?? 1)} />
            </div>
          )
        }
      </Async>
    </div>
  );
}

/* ------------------------------------------------------ claimable drop --- */

export function AirdropNew(): ReactElement {
  const cfg = resolveConfig();
  const factory = cfg.utilities.dropFactory;
  const tx = useTx(DROP_ABIS);
  const picker = useCurrencyPicker();
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState("");
  const [metadataURI, setMetadataURI] = useState("");
  const [nonce, setNonce] = useState(0);
  const [created, setCreated] = useState<Address | null>(null);

  const base = useAsync(async () => {
    if (factory === null) return null;
    const [terms, now] = await Promise.all([readUtilityFee(factory), readChainNow(publicClient())]);
    return { terms, now };
  }, [factory]);
  useEffect(() => {
    if (base.state.status === "ready" && base.state.data !== null && expiry === "") setExpiry(unixToUtcInput(base.state.data.now + 30n * 86_400n));
  }, [base.state, expiry]);

  const parsed = useMemo(() => {
    if (text.trim() === "" || picker.meta === null || picker.meta.decimals === null) return null;
    return parseRecipientsCsv(text, { decimals: picker.meta.decimals });
  }, [text, picker.meta]);

  const file: DropClaimsFile | null = useMemo(() => {
    if (parsed === null || !parsed.ok || picker.currency === null) return null;
    return buildDropClaimsFile({
      chainId: cfg.core.chainId,
      currency: picker.currency,
      recipients: parsed.rows,
      symbol: picker.meta?.symbol ?? null,
      decimals: picker.meta?.decimals ?? null,
      drop: created,
    });
  }, [parsed, picker.currency, picker.meta, cfg.core.chainId, created]);

  const expiresAt = utcInputToUnix(expiry);
  const issues = useMemo(() => {
    if (file === null || base.state.status !== "ready" || base.state.data === null) return [];
    return validateDropDraft({
      amount: BigInt(file.total),
      merkleRoot: file.merkleRoot,
      expiresAt: expiresAt ?? 0n,
      metadataURI: metadataURI.trim(),
      nowSeconds: base.state.data.now,
    }).map((i) => i.message);
  }, [file, base.state, expiresAt, metadataURI]);

  const allowance = useAsync(async () => {
    if (factory === null || picker.currency === null || isNative(picker.currency) || tx.account === undefined) return null;
    return readErc20Allowance(publicClient(), picker.currency, tx.account, factory);
  }, [factory, picker.currency, tx.account, nonce]);

  if (factory === null) return <AirdropsNotDeployed title="Claimable drops" contract="GullyCoreDropFactory" />;

  const total = file === null ? 0n : BigInt(file.total);
  const needsApproval = file !== null && allowance.state.status === "ready" && allowance.state.data !== null && allowance.state.data < total;
  const uriLooksFetchable = metadataURI.trim() === "" || claimsFileUrls(metadataURI) !== null;

  async function onCreate(): Promise<void> {
    if (factory === null || file === null || picker.currency === null || expiresAt === null || base.state.status !== "ready" || base.state.data === null) return;
    const call = buildCreateDrop({
      factory,
      currency: picker.currency,
      amount: total,
      merkleRoot: file.merkleRoot,
      expiresAt,
      metadataURI: metadataURI.trim(),
      terms: base.state.data.terms,
    });
    const receipt = await tx.run("Create drop", call);
    if (receipt === null) return;
    const logs = parseEventLogs({ abi: GULLYCORE_DROP_FACTORY_ABI, logs: receipt.logs, eventName: "DropCreated" });
    const drop = (logs[0] as { args: Record<string, unknown> } | undefined)?.args["drop"];
    if (typeof drop === "string") setCreated(drop as Address);
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Create a claimable drop</h1>
        <p className="page-sub">
          The whole amount moves into a new drop contract in one transaction. Each recipient claims their own amount with
          a proof until the drop expires; after that only the creator can sweep what is left.
        </p>
        <Link className="btn btn-ghost" to="/airdrops">
          Airdrops
        </Link>
      </header>
      <Async state={base.state} onRetry={base.reload} loadingLabel="Loading the fee">
        {(b) =>
          b === null ? null : (
            <div className="wizard">
              <form className="form" onSubmit={(e) => e.preventDefault()}>
                <fieldset>
                  <legend>What and to whom</legend>
                  {picker.element}
                  <CsvInput text={text} onText={setText} />
                  <HoldersInput key={picker.currency ?? "none"} decimals={picker.meta?.decimals ?? null} symbol={picker.meta?.symbol ?? ""} kind="drop" onText={setText} />
                  {parsed === null ? null : <ParseReport parsed={parsed} meta={picker.meta} />}
                </fieldset>
                <fieldset>
                  <legend>Terms</legend>
                  <label>
                    Claimable until (UTC; at least a day, at most five years)
                    <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                    <small>{expiresAt === null ? "" : utc(expiresAt)}</small>
                  </label>
                  <label>
                    Where you will publish the claims file (https:// or ipfs://; up to {DROP_MAX_METADATA_BYTES} bytes, stored in the drop)
                    <input value={metadataURI} onChange={(e) => setMetadataURI(e.target.value)} placeholder="ipfs://… or https://…/claims.json" />
                    <small>
                      {uriLooksFetchable
                        ? "The claim page fetches the file from here and checks it against the drop's root. Leave it empty and claimers must upload the file."
                        : "The claim page cannot fetch from this URI (only https:// and ipfs://); claimers would have to upload the file."}
                    </small>
                  </label>
                </fieldset>
                {file !== null ? (
                  <dl className="kv">
                    <dt>Merkle root</dt>
                    <dd className="mono">{file.merkleRoot}</dd>
                    <dt>Total</dt>
                    <dd>{amountText(total, picker.meta)}</dd>
                  </dl>
                ) : null}
                {issues.length > 0 ? (
                  <ul className="problem-list">
                    {issues.map((m) => (
                      <li key={m}>
                        <span>{m}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="form-actions">
                  <button type="button" className="btn btn-ghost" disabled={file === null} onClick={() => file !== null && downloadJson(claimsFileName(cfg.core.chainId, created, file.merkleRoot), file)}>
                    Download the claims file{created === null ? "" : " (with the drop address)"}
                  </button>
                  {needsApproval && picker.currency !== null ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={tx.busy}
                      onClick={() => picker.currency !== null && factory !== null && void tx.run("Approve", buildErc20Approve({ token: picker.currency, spender: factory, amount: total })).then(() => setNonce((n) => n + 1))}
                    >
                      Approve exactly {amountText(total, picker.meta)}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={file === null || issues.length > 0 || needsApproval || tx.busy || tx.account === undefined || created !== null}
                    onClick={() => void onCreate()}
                  >
                    {tx.account === undefined ? "Connect a wallet" : "Simulate and create"}
                  </button>
                </div>
                <p className="state-hint">
                  Publish the claims file before you share the drop: it holds every recipient&rsquo;s proof, and without it
                  nobody can claim. Its contents cannot be forged — the claim page rebuilds the root from it and refuses a
                  file that does not match the drop.
                </p>
                <TxStatus phase={tx.phase} />
                {created !== null ? (
                  <p className="state state-ok">
                    Drop created at <AddressLink address={created} full />. Download the claims file again (it now names the
                    drop), publish it at the URI you gave, and share{" "}
                    <Link to={`/airdrops/claim?drop=${created}`}>the claim page</Link>.
                  </p>
                ) : null}
              </form>
              <UtilityFee terms={b.terms} contract="GullyCoreDropFactory" per="drop">
                {picker.currency !== null && isNative(picker.currency) ? <p className="state-hint">For a native drop the value sent is the total plus the fee.</p> : null}
              </UtilityFee>
            </div>
          )
        }
      </Async>
    </div>
  );
}

/* --------------------------------------------------------------- claim --- */

async function fetchClaimsFile(uri: string): Promise<unknown> {
  const urls = claimsFileUrls(uri);
  if (urls === null) throw new Error("That is not an https:// or ipfs:// address; upload the file instead.");
  let last: unknown = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 50_000_000) throw new Error("The file is larger than 50 MB.");
      return JSON.parse(text) as unknown;
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("The claims file could not be fetched.");
}

export function AirdropClaim(): ReactElement {
  const cfg = resolveConfig();
  const factory = cfg.utilities.dropFactory;
  const tx = useTx(DROP_ABIS);
  const [params, setParams] = useSearchParams();
  const [dropText, setDropText] = useState(params.get("drop") ?? "");
  const drop = addressOrNull(params.get("drop") ?? "");
  const [who, setWho] = useState("");
  const [fileState, setFileState] = useState<{ status: "none" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; file: DropClaimsFile; source: string }>({ status: "none" });
  const [uri, setUri] = useState("");
  const [nonce, setNonce] = useState(0);

  const info = useAsync(async () => {
    if (drop === null || factory === null) return null;
    const client = publicClient();
    const [d, listed, now] = await Promise.all([readDrop(client, drop), readIsDrop(client, factory, drop), readChainNow(client)]);
    const meta = await currencyMeta(d.currency);
    return { d, listed, now, meta };
  }, [drop, factory, nonce]);

  useEffect(() => {
    if (info.state.status === "ready" && info.state.data !== null && uri === "") setUri(info.state.data.d.metadataURI);
  }, [info.state, uri]);
  useEffect(() => {
    if (who === "" && tx.account !== undefined) setWho(tx.account);
  }, [tx.account, who]);

  const check = useMemo(() => {
    if (fileState.status !== "ready" || info.state.status !== "ready" || info.state.data === null) return null;
    const d = info.state.data.d;
    return verifyDropClaimsFile(fileState.file, { root: d.merkleRoot, chainId: cfg.core.chainId, currency: d.currency });
  }, [fileState, info.state, cfg.core.chainId]);

  const target = addressOrNull(who);
  const mine = useMemo(() => (fileState.status === "ready" && target !== null && check?.ok === true ? claimsOf(fileState.file, target) : []), [fileState, target, check]);
  const claimed = useAsync(async () => (drop === null || mine.length === 0 ? [] : readDropClaimed(publicClient(), drop, mine.map((c) => c.index))), [drop, mine, nonce]);

  if (factory === null) return <AirdropsNotDeployed title="Claimable drops" contract="GullyCoreDropFactory" />;

  function load(raw: unknown, source: string): void {
    try {
      setFileState({ status: "ready", file: parseDropClaimsFile(raw), source });
    } catch (err) {
      setFileState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>Claim a drop</h1>
        <Link className="btn btn-ghost" to="/airdrops">
          Airdrops
        </Link>
      </header>
      <form
        className="form form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const a = addressOrNull(dropText);
          if (a !== null) {
            setParams({ drop: a });
            setFileState({ status: "none" });
            setUri("");
          }
        }}
      >
        <label>
          Drop address
          <input value={dropText} onChange={(e) => setDropText(e.target.value)} placeholder="0x…" />
        </label>
        <button type="submit" className="btn btn-ghost" disabled={addressOrNull(dropText) === null}>
          Open
        </button>
      </form>

      {drop === null ? (
        <Empty title="Open a drop" detail="Paste the drop's address, or follow the link its creator shared." />
      ) : (
        <Async state={info.state} onRetry={info.reload} loadingLabel="Loading the drop">
          {(i) => {
            if (i === null) return null;
            const expired = i.now >= i.d.expiresAt;
            const isCreator = tx.account !== undefined && tx.account.toLowerCase() === i.d.creator.toLowerCase();
            return (
              <>
                {!i.listed ? (
                  <p className="state state-error">
                    {drop} is not a drop made by the configured factory (<code>isDrop</code> is false). Do not trust it as a
                    Gully Core drop.
                  </p>
                ) : null}
                <section className="panel">
                  <dl className="kv">
                    <dt>Amount</dt>
                    <dd>{amountText(i.d.totalAmount, i.meta)}</dd>
                    <dt>Claimed</dt>
                    <dd>
                      {amountText(i.d.claimedAmount, i.meta)} ({formatBps(i.d.claimedBps)})
                    </dd>
                    <dt>Claimable until</dt>
                    <dd>
                      {utc(i.d.expiresAt)}
                      {expired ? " · expired" : ""}
                    </dd>
                    <dt>Creator</dt>
                    <dd>
                      <AddressLink address={i.d.creator} />
                    </dd>
                    <dt>Merkle root</dt>
                    <dd className="mono">{i.d.merkleRoot}</dd>
                  </dl>
                  {expired && isCreator && i.d.balance > 0n ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={tx.busy}
                      onClick={() => tx.account !== undefined && void tx.run("Sweep", buildSweepDrop({ drop, to: tx.account })).then(() => setNonce((n) => n + 1))}
                    >
                      Sweep the remaining {amountText(i.d.balance, i.meta)} to this wallet
                    </button>
                  ) : null}
                </section>

                <section className="panel">
                  <h2>Claims file</h2>
                  <form
                    className="form form-inline"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setFileState({ status: "loading" });
                      void fetchClaimsFile(uri).then(
                        (raw) => load(raw, uri),
                        (err: unknown) => setFileState({ status: "error", message: err instanceof Error ? err.message : String(err) }),
                      );
                    }}
                  >
                    <label>
                      Load from a URL (the drop names: {i.d.metadataURI === "" ? <em>none</em> : <code>{i.d.metadataURI}</code>})
                      <input value={uri} onChange={(e) => setUri(e.target.value)} placeholder="ipfs://… or https://…" />
                    </label>
                    <button type="submit" className="btn btn-ghost" disabled={claimsFileUrls(uri) === null || fileState.status === "loading"}>
                      Load
                    </button>
                  </form>
                  <label>
                    …or upload it
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f !== undefined) void f.text().then((t) => load(t, f.name), (err: unknown) => setFileState({ status: "error", message: String(err) }));
                      }}
                    />
                  </label>
                  {fileState.status === "loading" ? <p className="state state-loading">Fetching the claims file…</p> : null}
                  {fileState.status === "error" ? <p className="state state-error">{fileState.message}</p> : null}
                  {check !== null && fileState.status === "ready" ? (
                    check.ok ? (
                      <p className="state state-ok">
                        Verified: the {count(fileState.file.claims.length, "claim")} in {fileState.source} rebuild exactly the root
                        stored in this drop, every proof checks, and the chain and currency match.
                      </p>
                    ) : (
                      <div className="state state-error">
                        <strong>This file is not this drop&rsquo;s. Nothing from it is offered.</strong>
                        <ul>
                          {check.issues.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      </div>
                    )
                  ) : null}
                </section>

                {check?.ok === true ? (
                  <section className="panel">
                    <h2>Claims for an address</h2>
                    <label>
                      Address (a claim always pays the address in the file; anyone may submit it for an ordinary wallet, a
                      contract must claim for itself)
                      <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="0x…" />
                    </label>
                    {target === null ? null : mine.length === 0 ? (
                      <p className="muted">{shortAddress(target)} has no claim in this drop.</p>
                    ) : (
                      <Async state={claimed.state} onRetry={claimed.reload} loadingLabel="Loading which claims are paid">
                        {(paid) => (
                          <ul className="plain-list">
                            {mine.map((c, k) => (
                              <li key={c.index}>
                                Claim #{c.index}: {amountText(BigInt(c.amount), i.meta)}{" "}
                                {paid[k] === true ? (
                                  <span className="tag">claimed</span>
                                ) : expired ? (
                                  <span className="tag">expired</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-small"
                                    disabled={tx.busy || tx.account === undefined}
                                    onClick={() => void tx.run(`Claim #${c.index}`, buildClaimDrop({ drop, claim: c })).then(() => setNonce((n) => n + 1))}
                                  >
                                    {tx.account === undefined ? "Connect a wallet" : "Simulate and claim"}
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </Async>
                    )}
                  </section>
                ) : null}
                <TxStatus phase={tx.phase} />
                <p className="muted">A claim costs gas only; the drop charges no fee to claim.</p>
              </>
            );
          }}
        </Async>
      )}
    </div>
  );
}
