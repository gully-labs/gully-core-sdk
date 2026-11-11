// SPDX-License-Identifier: MIT
/**
 * Team splits: `GullyCoreSplitFactory` and the `GullyCoreSplit` clones it makes.
 *
 * A split is one address that pays a team by fixed shares. Its payee list and
 * weights are frozen at creation, it has no owner, and anything that reaches it
 * (native, any ERC-20, a Gully Core locker's or guard's credit pulled with
 * `collect`) is owed to the payees in proportion to their weights, after a
 * protocol share frozen into the split when it was made. Payouts are pull:
 * anyone may `release` a slot — the money always goes to that slot's payee.
 *
 * Three screens: the directory (every split the factory made, read with
 * `splitCount` / `splits`, no log scan), creation, and one split's books with
 * the calls that move its money. Every figure is a read; the creation fee and
 * the protocol share are read in the same block the page renders and shown
 * before anyone signs.
 */

import {
  GULLYCORE_SPLIT_ABI,
  GULLYCORE_SPLIT_FACTORY_ABI,
  SPLIT_MAX_LABEL_BYTES,
  SPLIT_MAX_NAME_BYTES,
  SPLIT_MAX_PAYEES,
  buildCollectAndReleaseAll,
  buildCreateSplit,
  encodeRelease,
  encodeReleaseProtocol,
  readSplit,
  readSplitBalances,
  readSplitCredits,
  readSplitDirectory,
  readSplitFactoryTerms,
  splitSafeValue,
  validateSplitDraft,
} from "@gullylabs/core-sdk/split";
import { useMemo, useState, type ReactElement } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { parseEventLogs, type Abi, type Address } from "viem";

import { BarList, Kpi, Kpis, ShareBar } from "../components/Charts";
import { Async, Empty, NotDeployed } from "../components/States";
import { AddressLink, TxStatus, native, utc } from "../components/Utility";
import { resolveConfig } from "../config/resolve";
import { count, formatAmount, formatBps } from "../lib/format";
import { addressOrNull, bpsToPercent, splitDraftFromRows, type PayeeRow } from "../lib/forms";
import { useTx } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { currencyMeta, splitCurrencies, splitSources } from "../lib/utilities";
import { publicClient } from "../lib/client";

const SPLIT_ABIS: readonly Abi[] = [GULLYCORE_SPLIT_FACTORY_ABI as Abi, GULLYCORE_SPLIT_ABI as Abi];

function useSplitFactory(): Address | null {
  return resolveConfig().utilities.splitFactory;
}

function SplitsNotDeployed({ title }: { title: string }): ReactElement {
  const cfg = resolveConfig();
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>{title}</h1>
      </header>
      <NotDeployed what="Team splits" contract="GullyCoreSplitFactory" chainName={cfg.core.name} chainId={cfg.core.chainId} />
    </div>
  );
}

/* ----------------------------------------------------------- directory --- */

export function Splits(): ReactElement {
  const factory = useSplitFactory();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState("");
  const directory = useAsync(async () => (factory === null ? null : readSplitDirectory(publicClient(), factory)), [factory]);
  if (factory === null) return <SplitsNotDeployed title="Team splits" />;
  const target = addressOrNull(lookup);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Team splits</h1>
        <p className="page-sub">
          One address that pays a team by fixed shares. Nobody owns a split: its payees and shares are frozen when it
          is made, and anyone can pay a payee what the split owes them.
        </p>
        <Link className="btn btn-primary" to="/splits/new">
          Create a split
        </Link>
      </header>

      <form
        className="form form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (target !== null) navigate(`/splits/${target}`);
        }}
      >
        <label>
          Open a split by address
          <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="0x…" />
        </label>
        <button type="submit" className="btn btn-ghost" disabled={target === null}>
          Open
        </button>
      </form>

      <Async
        state={directory.state}
        onRetry={directory.reload}
        loadingLabel="Loading splits"
        isEmpty={(rows) => rows === null || rows.length === 0}
        empty={<Empty title="No splits yet" detail="The factory has made none." />}
      >
        {(rows) =>
          rows === null ? null : (
            <>
              <Kpis>
                <Kpi label="Splits" value={String(rows.length)} sub="made by this factory" />
                <Kpi label="Payee slots" value={String(rows.reduce((t, r) => t + r.payeeCount, 0))} sub="across every split" />
                <Kpi
                  label="Protocol share"
                  value={rows.length === 0 ? "—" : formatBps(Math.max(...rows.map((r) => r.protocolShareBps)))}
                  sub={rows.length === 0 ? "no split yet" : `highest frozen share · lowest ${formatBps(Math.min(...rows.map((r) => r.protocolShareBps)))}`}
                />
              </Kpis>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Payees</th>
                    <th>Protocol share (frozen)</th>
                    <th>Address</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((row) => (
                    <tr key={row.address}>
                      <td>
                        <Link to={`/splits/${row.address}`}>{row.name}</Link>
                      </td>
                      <td>{row.payeeCount}</td>
                      <td>{formatBps(row.protocolShareBps)}</td>
                      <td>
                        <AddressLink address={row.address} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )
        }
      </Async>
    </div>
  );
}

/* ------------------------------------------------------------ creation --- */

const EMPTY_ROW: PayeeRow = { address: "", percent: "", label: "" };

export function SplitNew(): ReactElement {
  const cfg = resolveConfig();
  const factory = useSplitFactory();
  const tx = useTx(SPLIT_ABIS);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<PayeeRow[]>([{ ...EMPTY_ROW, percent: "50" }, { ...EMPTY_ROW, percent: "50" }]);
  const [created, setCreated] = useState<Address | null>(null);
  const terms = useAsync(async () => (factory === null ? null : readSplitFactoryTerms(publicClient(), factory)), [factory]);

  const form = useMemo(() => splitDraftFromRows(name, rows), [name, rows]);
  const sdkIssues = useMemo(() => (form.draft === null ? [] : validateSplitDraft(form.draft)), [form.draft]);

  if (factory === null) return <SplitsNotDeployed title="Create a split" />;

  function setRow(i: number, patch: Partial<PayeeRow>): void {
    setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    tx.reset();
  }

  async function onCreate(): Promise<void> {
    if (terms.state.status !== "ready" || terms.state.data === null || form.draft === null || factory === null) return;
    const call = buildCreateSplit({ factory, draft: form.draft, terms: terms.state.data });
    const receipt = await tx.run("Create split", call);
    if (receipt === null) return;
    const logs = parseEventLogs({ abi: GULLYCORE_SPLIT_FACTORY_ABI, logs: receipt.logs, eventName: "SplitCreated" });
    const first = logs[0] as { args: Record<string, unknown> } | undefined;
    const split = first?.args["split"];
    if (typeof split === "string") setCreated(split as Address);
  }

  const blocking = form.problems.length > 0 || sdkIssues.length > 0 || form.draft === null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Create a split</h1>
        <p className="page-sub">
          The payees and their shares are fixed forever once the split exists. A payee can hand its own slot to
          another address (two-step); nobody can change the shares.
        </p>
        <Link className="btn btn-ghost" to="/splits">
          All splits
        </Link>
      </header>

      <Async state={terms.state} onRetry={terms.reload} loadingLabel="Loading the fee">
        {(t) =>
          t === null ? null : (
            <div className="wizard">
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onCreate();
                }}
              >
                <fieldset>
                  <legend>Split</legend>
                  <label>
                    Name (up to {SPLIT_MAX_NAME_BYTES} bytes, stored on chain)
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your team name" required />
                  </label>
                </fieldset>
                <fieldset>
                  <legend>
                    Payees ({rows.length} of at most {SPLIT_MAX_PAYEES}; shares must add up to 100%)
                  </legend>
                  {rows.map((row, i) => (
                    <div className="row-fields" key={i}>
                      <label>
                        Address
                        <input value={row.address} onChange={(e) => setRow(i, { address: e.target.value })} placeholder="0x…" />
                      </label>
                      <label className="narrow">
                        Share, %
                        <input value={row.percent} onChange={(e) => setRow(i, { percent: e.target.value })} inputMode="decimal" />
                      </label>
                      <label>
                        Label (optional, {SPLIT_MAX_LABEL_BYTES} bytes, emitted not stored)
                        <input value={row.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                      </label>
                      {rows.length > 1 ? (
                        <button type="button" className="btn btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      ) : null}
                      {form.problems
                        .filter((p) => p.row === i)
                        .concat(
                          sdkIssues
                            /* An untouched empty row is not an error yet; Create stays disabled either way. */
                            .filter((s) => s.index === i && !(s.field === "address" && row.address.trim() === ""))
                            .map((s) => ({ row: i, message: s.message })),
                        )
                        .map((p) => (
                          <p className="warn-inline" key={p.message}>
                            {p.message}
                          </p>
                        ))}
                    </div>
                  ))}
                  {rows.length < SPLIT_MAX_PAYEES ? (
                    <button type="button" className="btn btn-ghost" onClick={() => setRows([...rows, { ...EMPTY_ROW }])}>
                      Add a payee
                    </button>
                  ) : null}
                  <p className="muted">Shares add up to {bpsToPercent(form.totalBps)}.</p>
                  {form.problems
                    .filter((p) => p.row === null)
                    .concat(sdkIssues.filter((s) => s.index === undefined).map((s) => ({ row: null, message: s.message })))
                    .map((p) => (
                      <p className="warn-inline" key={p.message}>
                        {p.message}
                      </p>
                    ))}
                </fieldset>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={blocking || tx.busy || tx.account === undefined}>
                    {tx.account === undefined ? "Connect a wallet to create" : "Simulate and create"}
                  </button>
                </div>
                <TxStatus phase={tx.phase} />
                {created !== null ? (
                  <p className="state state-ok">
                    Your split is <Link to={`/splits/${created}`} className="mono">{created}</Link>. Pay it like any
                    address, or name it as a launch&rsquo;s creator.
                  </p>
                ) : null}
              </form>

              <aside className="panel">
                <h2>What this costs</h2>
                <dl className="kv">
                  <dt>Creation fee now</dt>
                  <dd>{native(t.feeWei)}</dd>
                  {t.pendingFee !== null ? (
                    <>
                      <dt>Announced fee</dt>
                      <dd>
                        {native(t.pendingFee.value)} from {utc(t.pendingFee.effectiveAt)}
                      </dd>
                    </>
                  ) : null}
                  <dt>Sent as msg.value</dt>
                  <dd>
                    {native(splitSafeValue(t))}
                    {splitSafeValue(t) > t.feeWei ? " (covers the announced fee; the surplus is refunded in the same call)" : ""}
                  </dd>
                  <dt>Protocol share</dt>
                  <dd>
                    {formatBps(t.protocolShareBps)} of everything the split ever receives, frozen into this split
                    {t.pendingProtocolShare !== null
                      ? ` (new splits get ${formatBps(t.pendingProtocolShare.value)} from ${utc(t.pendingProtocolShare.effectiveAt)})`
                      : ""}
                  </dd>
                  <dt>Ceilings</dt>
                  <dd>
                    {native(t.capFeeWei)} fee · {formatBps(t.capProtocolShareBps)} share, immutable
                  </dd>
                  <dt>Paid to</dt>
                  <dd>
                    <AddressLink address={t.recipient} /> <span className="muted">(the protocol, immutable)</span>
                  </dd>
                </dl>
                <p className="state-hint">
                  Read from <code>GullyCoreSplitFactory</code> at <AddressLink address={factory} /> in this block. The call
                  names the share you were shown as the most you accept, so an increase that lands first makes it
                  revert instead of being frozen in. <strong>{cfg.brand.name} adds no fee of its own.</strong>
                </p>
              </aside>
            </div>
          )
        }
      </Async>
    </div>
  );
}

/* -------------------------------------------------------------- detail --- */

export function SplitDetail(): ReactElement {
  const factory = useSplitFactory();
  const params = useParams();
  const split = addressOrNull(params["address"] ?? "");
  const tx = useTx(SPLIT_ABIS);

  const resource = useAsync(async () => {
    if (split === null || factory === null) return null;
    const client = publicClient();
    const info = await readSplit(client, split);
    const [currencies, sources] = await Promise.all([splitCurrencies(split), splitSources()]);
    const [balances, credits, metas] = await Promise.all([
      readSplitBalances(client, split, info.slots.length, currencies),
      readSplitCredits(client, split, sources, currencies),
      Promise.all(currencies.map((c) => currencyMeta(c))),
    ]);
    const isOurs = info.factory.toLowerCase() === factory.toLowerCase();
    return { info, balances, credits, metas, sources, isOurs };
  }, [split, factory]);

  if (factory === null) return <SplitsNotDeployed title="Split" />;
  if (split === null) {
    return (
      <div className="page page-narrow">
        <Empty title="Not an address" detail="The link does not name a valid address." />
      </div>
    );
  }

  return (
    <div className="page">
      <Async state={resource.state} onRetry={resource.reload} loadingLabel="Loading the split">
        {(data) => {
          if (data === null) return null;
          const { info, balances, credits, metas, isOurs } = data;
          const metaOf = (c: Address) => metas.find((m) => m.address.toLowerCase() === c.toLowerCase());
          const amount = (value: bigint, c: Address): string => {
            const m = metaOf(c);
            return m === undefined || m.decimals === null ? `${value.toString()} base units` : formatAmount(value, m.decimals, m.symbol);
          };
          const touched = balances.filter((b) => b.totalReceived > 0n);
          const pendingCredits = credits.filter((c) => c.amount !== null && c.amount > 0n);
          const unreadable = credits.filter((c) => c.amount === null);
          return (
            <>
              <header className="page-head">
                <h1>{info.name}</h1>
                <p className="page-sub">
                  Split <AddressLink address={info.address} full /> · protocol share {formatBps(info.protocolShareBps)},
                  frozen.
                </p>
                <Link className="btn btn-ghost" to="/splits">
                  All splits
                </Link>
              </header>
              {!isOurs ? (
                <p className="warn-inline">
                  This split was made by factory {info.factory}, not the one this app is configured with. Its books read the
                  same way; check the address you were given.
                </p>
              ) : null}

              <section className="panel">
                <h2>Payees</h2>
                <ShareBar
                  caption="Each payee's share of what is left after the protocol's cut"
                  shares={info.slots.map((s) => ({ label: `slot ${s.slot}`, part: s.shareBps, display: bpsToPercent(s.shareBps) }))}
                />
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th>Payee</th>
                      <th>Share of the rest</th>
                      <th>Offered to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.slots.map((s) => (
                      <tr key={s.slot}>
                        <td>{s.slot}</td>
                        <td>
                          <AddressLink address={s.payee} />
                          {tx.account !== undefined && tx.account.toLowerCase() === s.payee.toLowerCase() ? " (you)" : ""}
                        </td>
                        <td>{bpsToPercent(s.shareBps)}</td>
                        <td>{s.pendingPayee === null ? <span className="muted">—</span> : <AddressLink address={s.pendingPayee} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
                <p className="state-hint">
                  Shares apply to what is left after the protocol&rsquo;s {formatBps(info.protocolShareBps)}. Paid to{" "}
                  <AddressLink address={info.protocolRecipient} /> only.
                </p>
              </section>

              <section className="panel">
                <h2>Owed to the split by Gully Core contracts</h2>
                {data.sources.length === 0 ? (
                  <p className="state-hint">
                    No launch kit is configured in <code>gullycore.config.ts</code>, so no locker, guard or kit credit is read.
                    The split still holds whatever is sent to it directly (below).
                  </p>
                ) : pendingCredits.length === 0 ? (
                  <p className="muted">Nothing is owed to this split right now.</p>
                ) : (
                  <ul className="plain-list">
                    {pendingCredits.map((c) => (
                      <li key={`${c.source.address}:${c.currency}`}>
                        {amount(c.amount ?? 0n, c.currency)} at {c.source.label} <AddressLink address={c.source.address} />
                      </li>
                    ))}
                  </ul>
                )}
                {unreadable.length > 0 ? (
                  <p className="warn-inline">{count(unreadable.length, "credit")} could not be read and is not counted.</p>
                ) : null}
                <p className="state-hint">
                  A creator tax must be settled into the guard&rsquo;s credits (<code>settleTax</code>, permissionless) before
                  it shows here, and so must a trading fee the launch takes itself (<code>settleFee</code>); LP fees must be
                  collected into the locker (<code>collectFees</code>). All three are on the launch earnings screen.
                </p>
              </section>

              <section className="panel">
                <h2>Books, per currency</h2>
                {touched.length === 0 ? (
                  <Empty title="Nothing received yet" detail="The split has held nothing in any currency this app reads." />
                ) : (
                  touched.map((b) => (
                    <div key={b.currency} className="subpanel">
                      <h3>{metaOf(b.currency)?.symbol ?? b.currency}</h3>
                      <BarList
                        caption={`Where ${metaOf(b.currency)?.symbol ?? "this currency"} has gone`}
                        empty=""
                        rows={[
                          { key: "in", label: "Received", text: "Received, all time", value: Number(b.totalReceived), display: amount(b.totalReceived, b.currency) },
                          { key: "out", label: "Paid out", text: "Paid out", value: Number(b.totalReleased), display: amount(b.totalReleased, b.currency) },
                          {
                            key: "owed",
                            label: "Owed to payees",
                            text: "Owed to payees now",
                            value: Number(info.slots.reduce((t, s) => t + (b.releasable[s.slot] ?? 0n), 0n)),
                            display: amount(info.slots.reduce((t, s) => t + (b.releasable[s.slot] ?? 0n), 0n), b.currency),
                          },
                          { key: "proto", label: "Protocol, owed", text: "Protocol, owed", value: Number(b.protocolReleasable), display: amount(b.protocolReleasable, b.currency) },
                        ]}
                      />
                      <dl className="kv">
                        <dt>Received, all time</dt>
                        <dd>{amount(b.totalReceived, b.currency)}</dd>
                        <dt>Paid out</dt>
                        <dd>{amount(b.totalReleased, b.currency)}</dd>
                        <dt>Protocol, owed</dt>
                        <dd>
                          {amount(b.protocolReleasable, b.currency)}
                          {b.protocolReleasable > 0n ? (
                            <>
                              {" "}
                              <button
                                type="button"
                                className="btn btn-ghost btn-small"
                                disabled={tx.busy}
                                onClick={() => void tx.run("Release protocol share", { to: info.address, data: encodeReleaseProtocol(b.currency), value: 0n }).then(() => resource.reload())}
                              >
                                Release
                              </button>
                            </>
                          ) : null}
                        </dd>
                      </dl>
                      <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                        <thead>
                          <tr>
                            <th>Slot</th>
                            <th>Payee</th>
                            <th>Owed now</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {info.slots.map((s) => {
                            const owed = b.releasable[s.slot] ?? 0n;
                            return (
                              <tr key={s.slot}>
                                <td>{s.slot}</td>
                                <td>
                                  <AddressLink address={s.payee} />
                                </td>
                                <td>{amount(owed, b.currency)}</td>
                                <td>
                                  {owed > 0n ? (
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-small"
                                      disabled={tx.busy || tx.account === undefined}
                                      onClick={() =>
                                        void tx
                                          .run(`Release slot ${s.slot}`, { to: info.address, data: encodeRelease(s.slot, b.currency), value: 0n })
                                          .then(() => resource.reload())
                                      }
                                    >
                                      Pay this payee
                                    </button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table></div>
                    </div>
                  ))
                )}
              </section>

              <section className="panel">
                <h2>Collect and pay everyone</h2>
                <p>
                  One transaction: pull every credit listed above into the split, then pay every payee and the protocol
                  their share in each currency touched. Anyone may send it; the money only ever goes to the payees.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={tx.busy || tx.account === undefined || (pendingCredits.length === 0 && touched.every((b) => b.releasable.every((r) => r === 0n) && b.protocolReleasable === 0n))}
                  onClick={() => {
                    let call;
                    try {
                      call = buildCollectAndReleaseAll({
                        split: info.address,
                        credits,
                        alsoRelease: touched.filter((b) => b.releasable.some((r) => r > 0n) || b.protocolReleasable > 0n).map((b) => b.currency),
                      });
                    } catch {
                      return; /* nothing to collect or release; the button is disabled in that state */
                    }
                    void tx.run("Collect and release all", call).then(() => resource.reload());
                  }}
                >
                  {tx.account === undefined ? "Connect a wallet" : "Simulate and send"}
                </button>
                <TxStatus phase={tx.phase} />
              </section>

            </>
          );
        }}
      </Async>
    </div>
  );
}
