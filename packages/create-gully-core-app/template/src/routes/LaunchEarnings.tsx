// SPDX-License-Identifier: MIT
/**
 * What the connected wallet has earned from locked launches, and the calls
 * that move it.
 *
 * Three contracts owe money, and none pushes it:
 *
 *   * The KIT credits the integrator launch fee to the integrator wallet at
 *     launch time; `claimFees(to)` pays the caller's balance in native.
 *   * The LOCKERS hold every launch position. Where the POOL charges the
 *     trading fee, or a part of what a buy pays, the position earns it: `collectFees(lockId)` is
 *     permissionless and credits the creator, the integrator and the protocol
 *     their frozen shares, and `claim(currency, to)` pays the caller's own.
 *   * The launch GUARDS take the creator tax (when a launch carries one) into a
 *     per-pool pot. Where the LAUNCH CONTRACT takes the trading fee itself, in
 *     the pool's quote currency, that fee has a pot beside it. Settling splits
 *     a pot by its frozen shares; `claimFrom(pools, currency, to)` settles both
 *     pots of a pool and pays the caller in one transaction.
 *
 * A guard keeps ONE balance per account and currency, whatever it was credited
 * for, so a guard's credit is listed once and never added to itself.
 *
 * The plan of what is owed and which call moves it is the SDK's
 * (`planKitV2Earnings`): this screen draws it and sends the calls it carries.
 *
 * Nothing on this screen can touch anyone else's balance: every call pays
 * `msg.sender`'s own credit, and collecting or settling only moves fees into
 * the credits a launch already defines. Every figure is a live read.
 */

import { collectableLocks, planKitV2Earnings, type EarningsCall, type EarningsPlanV2, type TokenMeta } from "@gullylabs/core-sdk";
import { useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { useAccount, useWalletClient } from "wagmi";

import { Async, Empty, NotConfigured } from "../components/States";
import { resolveConfig } from "../config/resolve";
import { explorerTxUrl } from "../lib/client";
import { ExplorerLink } from "../components/ExplorerLink";
import { formatAmount, formatUnits, shortAddress } from "../lib/format";
import { BarList } from "../components/Charts";
import { NATIVE_ADDRESS, readEarningsV2, readKitV2Env } from "../lib/launchesV2";
import { creditLabel, feeIsInQuote, potLabel, potShare } from "../lib/launchWords";
import { useAsync } from "../lib/useAsync";

type TxPhase = { kind: "idle" } | { kind: "sending"; label: string } | { kind: "sent"; hash: string } | { kind: "failed"; message: string };

/** An amount in its own unit, or raw units where the token's metadata could not be read. */
function amountFormatter(): (amount: bigint, currency: string, meta: TokenMeta | null) => string {
  const cfg = resolveConfig();
  return (amount, currency, meta) =>
    currency === NATIVE_ADDRESS
      ? formatAmount(amount, cfg.nativeCurrency.decimals, cfg.nativeCurrency.symbol)
      : meta === null
        ? `${amount.toString()} raw units of ${shortAddress(currency)}`
        : formatAmount(amount, meta.decimals, meta.symbol);
}

/**
 * What the wallet is owed, one bar list PER CURRENCY (rows = where the credit
 * sits). Two currencies never share a scale: a unit of one is not a unit of
 * the other.
 */
function CreditBars({ plan }: { plan: EarningsPlanV2 }): ReactElement | null {
  const cfg = resolveConfig();
  const unit = (currency: string, meta: TokenMeta | null): { symbol: string; decimals: number | null } =>
    currency === NATIVE_ADDRESS
      ? { symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals }
      : meta === null
        ? { symbol: `raw ${shortAddress(currency)}`, decimals: null }
        : { symbol: meta.symbol, decimals: meta.decimals };
  const lines = plan.credits.filter((c) => c.amount > 0n).map((c) => ({ source: creditLabel(c), currency: c.currency, ...unit(c.currency, c.meta), amount: c.amount }));
  if (lines.length === 0) return null;
  const groups = new Map<string, typeof lines>();
  for (const l of lines) groups.set(l.currency.toLowerCase(), [...(groups.get(l.currency.toLowerCase()) ?? []), l]);
  return (
    <>
      {[...groups.values()].map((g) => {
        const head = g[0]!;
        const text = (v: bigint): string => (head.decimals === null ? v.toString() : formatUnits(v, head.decimals));
        return (
          <div key={head.currency}>
            <h3 className="muted">
              {head.symbol} · {text(g.reduce((t, l) => t + l.amount, 0n))} in total
            </h3>
            <BarList
              caption={`Credit owed in ${head.symbol}, by source`}
              empty=""
              rows={g.map((l) => ({ key: l.source, label: l.source, text: l.source, value: Number(text(l.amount)), display: `${text(l.amount)} ${head.symbol}` }))}
            />
          </div>
        );
      })}
    </>
  );
}

export function LaunchEarnings(): ReactElement {
  const cfg = resolveConfig();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [tx, setTx] = useState<TxPhase>({ kind: "idle" });
  const amountText = amountFormatter();

  const resource = useAsync(async () => {
    if (address === undefined) return null;
    const [earnings, env] = await Promise.all([readEarningsV2(address), readKitV2Env()]);
    return planKitV2Earnings(earnings, env);
  }, [cfg.launchpadKitV2, address]);

  if (cfg.launchpadKitV2 === null) {
    return (
      <div className="page page-narrow">
        <header className="page-head">
          <h1>Launch earnings</h1>
        </header>
        <NotConfigured what="The locked launchpad" field="chain.launchpadKitV2" />
      </div>
    );
  }

  async function send(label: string, call: EarningsCall): Promise<void> {
    if (walletClient === undefined) return;
    setTx({ kind: "sending", label });
    try {
      const hash = await walletClient.sendTransaction({ to: call.to, data: call.data });
      setTx({ kind: "sent", hash });
      resource.reload();
    } catch (err) {
      setTx({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>Launch earnings</h1>
        <p className="page-sub">
          Trading fees, creator tax and launch fees credited to the connected wallet, live from the chain.
        </p>
        <Link className="btn btn-ghost" to="/launch">
          Back to launches
        </Link>
      </header>

      {address === undefined ? (
        <Empty title="Connect a wallet" detail="Earnings are per account. Nothing is shown until one is connected." />
      ) : (
        <Async
          state={resource.state}
          onRetry={resource.reload}
          loadingLabel="Loading earnings"
          isEmpty={(plan) => plan === null || (plan.locks.length === 0 && plan.pots.length === 0 && plan.credits.every((c) => c.amount === 0n))}
          empty={
            <Empty
              title="Nothing owed to this wallet"
              detail={`${shortAddress(address)} is neither creator nor integrator on any launch here, and is owed no launch fees.`}
            />
          }
        >
          {(plan) => {
            if (plan === null) return null;
            const busy = tx.kind === "sending";
            /* A position earns where the pool charges the fee, or a part of a buy's fee. The SDK leaves
               out only those whose launch contract was read to leave the pool nothing. */
            const locks = collectableLocks(plan);
            const anyInQuote = plan.pots.some((p) => feeIsInQuote(p.generation));
            return (
              <>
                <section className="panel">
                  <h2>Credited, claimable now</h2>
                  <CreditBars plan={plan} />
                  <dl className="kv">
                    {plan.credits.map((c) => (
                      <div key={c.key} style={{ display: "contents" }}>
                        <dt>{creditLabel(c)}</dt>
                        <dd>
                          {amountText(c.amount, c.currency, c.meta)}{" "}
                          {c.amount > 0n ? (
                            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send("claim", c.claim)}>
                              Claim
                            </button>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {plan.pots.length > 0 ? (
                  <section className="panel">
                    <h2>{anyInQuote ? "To settle: trading fees and creator tax" : "Your creator-tax pools"}</h2>
                    <p className="state-hint">
                      {anyInQuote
                        ? "Each pool keeps what it took in a pot until it is settled. Settling splits the pot by the shares fixed at launch; anyone may call it. “Settle & claim” does both for you."
                        : "The guard takes each pool’s tax into a pot on every swap. Settling splits the pot by the shares frozen before trading opened; anyone may call it. “Settle & claim” does both for you."}
                    </p>
                    <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                      <thead>
                        <tr>
                          <th>Launch</th>
                          <th>Pool</th>
                          <th>What</th>
                          <th>Your share</th>
                          <th>Yours when settled</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.pots.map((p) => (
                          <tr key={p.key}>
                            <td>{p.tokenMeta?.symbol ?? shortAddress(p.token)}</td>
                            <td className="mono">
                              {p.pools} {p.poolId.slice(0, 10)}…{p.tax !== null && !p.tax.live ? " · tax ended" : ""}
                            </td>
                            <td>{potLabel(p)}</td>
                            <td>{potShare(p)}</td>
                            <td>{p.share === 0n ? "0" : amountText(p.share, p.currency, p.meta)}</td>
                            <td>
                              {p.share > 0n ? (
                                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send("settle and claim", p.settleAndClaim)}>
                                  Settle &amp; claim
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  </section>
                ) : null}

                {locks.length > 0 ? (
                  <section className="panel">
                    <h2>Your locks</h2>
                    <p className="state-hint">
                      Collecting moves a position&rsquo;s accrued LP fees into the credited balances above — yours,
                      the other parties&rsquo;, and the protocol&rsquo;s, in the frozen split. Anyone may call it, so
                      someone may already have.
                    </p>
                    <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                      <thead>
                        <tr>
                          <th>Launch</th>
                          <th>Lock</th>
                          <th>Your role</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {locks.map((lock) => (
                          <tr key={lock.key}>
                            <td>{lock.tokenMeta?.symbol ?? shortAddress(lock.token)}</td>
                            <td className="mono">
                              {lock.pools} #{lock.lockId.toString()}
                            </td>
                            <td>{lock.role}</td>
                            <td>
                              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send("collectFees", lock.collect)}>
                                Collect fees
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  </section>
                ) : null}

                {tx.kind === "sending" ? <p className="state state-loading">Sending {tx.label}…</p> : null}
                {tx.kind === "sent" ? (
                  <p className="state state-ok">
                    Submitted.{" "}
                    <ExplorerLink href={explorerTxUrl(tx.hash)}>
                      View transaction
                    </ExplorerLink>
                  </p>
                ) : null}
                {tx.kind === "failed" ? (
                  <p className="state state-error" role="alert">
                    {tx.message}
                  </p>
                ) : null}

              </>
            );
          }}
        </Async>
      )}
    </div>
  );
}
