// SPDX-License-Identifier: MIT
/**
 * Locks: `GullyCorePositionLock` (time-locked CL liquidity positions) and
 * `GullyCoreTokenLock` (ERC-20 / native time-locks and vesting), plus the
 * protocol's LP locker, which holds every Kit v2 launch's seed liquidity
 * forever and has no withdraw path.
 *
 * Two kinds of lock are never blurred on these screens: "time-locked until
 * <date>" (the lock owner or beneficiary gets it back on schedule) and "locked
 * permanently (LP locker)". Time is the chain's `block.timestamp`, the clock
 * the contracts compare against; dates are shown in UTC.
 *
 * Screens: the list (every pool and token with a lock, and the connected
 * wallet's own locks with the calls that move them), "Lock liquidity or
 * tokens", and one pool's or one token's locks. Each lock pays one flat
 * native fee to the contract, read live and shown before signing.
 */

import { CL_POSITION_MANAGER_ABI, poolKeyToId, type PoolKey } from "@gullylabs/core-sdk";
import {
  GULLYCORE_POSITION_LOCK_ABI,
  GULLYCORE_TOKEN_LOCK_ABI,
  NATIVE,
  buildAcceptLockOwner,
  buildApprovePositionForLock,
  buildClaimTokenLock,
  buildCollectLockedFees,
  buildErc20Approve,
  buildLockPosition,
  buildTokenLock,
  buildWithdrawPosition,
  isNative,
  readBeneficiaryLocks,
  readChainNow,
  readErc20Allowance,
  readPositionApproval,
  readPositionLock,
  readPositionLockContext,
  readPositionLockDirectory,
  readPositionLocksOf,
  readTokenLockDirectory,
  validatePositionLock,
  validateTokenLock,
} from "@gullylabs/core-sdk/lock";
import { LocksPanel, formatLockBps } from "@gullylabs/core-widgets";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { erc20Abi, parseUnits, type Abi, type Address, type Hex } from "viem";

import { BarList, Progress, ViewToggle, type View } from "../components/Charts";
import { sortRows, windowProgress } from "../lib/chart";
import { PoolLockBadge } from "../components/LockBadges";
import { Async, Empty, NotDeployed } from "../components/States";
import { AddressLink, TxStatus, UtilityFee, utc } from "../components/Utility";
import { resolveConfig } from "../config/resolve";
import { publicClient } from "../lib/client";
import { formatAmount, shortAddress } from "../lib/format";
import { addressOrNull, scheduleFromForm, unixToUtcInput, utcInputToUnix, type LockScheduleForm } from "../lib/forms";
import { useTx } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { currencyMeta, readLpLockerIndex, readPoolLockSummary, readUtilityFee, type CurrencyMeta } from "../lib/utilities";

const LOCK_ABIS: readonly Abi[] = [GULLYCORE_POSITION_LOCK_ABI as Abi, GULLYCORE_TOKEN_LOCK_ABI as Abi, erc20Abi as Abi, CL_POSITION_MANAGER_ABI as Abi];

function amountText(value: bigint, meta: CurrencyMeta | undefined): string {
  if (meta === undefined || meta.decimals === null) return `${value.toString()} base units${meta === undefined ? "" : ` ${meta.symbol}`}`;
  return formatAmount(value, meta.decimals, meta.symbol);
}

function LocksNotDeployed({ title }: { title: string }): ReactElement {
  const cfg = resolveConfig();
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>{title}</h1>
      </header>
      <NotDeployed
        what="Gully Core locks"
        contract="GullyCorePositionLock or GullyCoreTokenLock"
        chainName={cfg.core.name}
        chainId={cfg.core.chainId}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- list --- */

export function Locks(): ReactElement {
  const cfg = resolveConfig();
  const { positionLock, tokenLock } = cfg.utilities;
  const tx = useTx(LOCK_ABIS);
  const account = tx.account;

  const directory = useAsync(async () => {
    const client = publicClient();
    const [tokens, index] = await Promise.all([
      tokenLock === null ? Promise.resolve(null) : readTokenLockDirectory(client, tokenLock),
      readLpLockerIndex(),
    ]);
    const pools =
      positionLock === null ? null : await readPositionLockDirectory(client, positionLock, { lpLocker: index.locker, lpLockerTokenIds: index.allTokenIds });
    const currencies = new Set<string>();
    for (const c of tokens?.currencies ?? []) currencies.add(c.currency);
    for (const p of pools?.pools ?? []) {
      currencies.add(p.currency0);
      currencies.add(p.currency1);
    }
    const metas = await Promise.all([...currencies].map((c) => currencyMeta(c as Address)));
    return { tokens, pools, metas, index };
  }, [positionLock, tokenLock]);

  const mine = useAsync(async () => {
    if (account === undefined) return null;
    const client = publicClient();
    const [tokenLocks, positionLocks, now] = await Promise.all([
      tokenLock === null ? Promise.resolve(null) : readBeneficiaryLocks(client, tokenLock, account),
      positionLock === null ? Promise.resolve([]) : readPositionLocksOf(client, positionLock, account),
      readChainNow(client),
    ]);
    const metas = await Promise.all([...new Set((tokenLocks?.locks ?? []).map((l) => l.currency))].map((c) => currencyMeta(c)));
    return { tokenLocks: tokenLocks?.locks ?? [], positionLocks, now, metas };
  }, [account, positionLock, tokenLock]);
  const [poolView, setPoolView] = useState<View>("chart");
  const [tokenView, setTokenView] = useState<View>("chart");

  if (positionLock === null && tokenLock === null) return <LocksNotDeployed title="Locks" />;

  const metaOf = (metas: readonly CurrencyMeta[], c: string) => metas.find((m) => m.address.toLowerCase() === c.toLowerCase());

  return (
    <div className="page">
      <header className="page-head">
        <h1>Locks</h1>
        <p className="page-sub">
          Liquidity positions and tokens locked until a date or vesting on a schedule, and the launch liquidity the
          protocol&rsquo;s LP locker holds forever. Read live from {cfg.core.name}.
        </p>
        <Link className="btn btn-primary" to="/locks/new">
          Lock liquidity or tokens
        </Link>
      </header>

      {account === undefined ? null : (
        <section className="panel">
          <h2>Your locks</h2>
          <Async state={mine.state} onRetry={mine.reload} loadingLabel="Loading your locks">
            {(m) => {
              if (m === null) return null;
              if (m.tokenLocks.length === 0 && m.positionLocks.length === 0) {
                return <p className="muted">{shortAddress(account)} is neither the beneficiary of a token lock nor the owner of a liquidity lock.</p>;
              }
              return (
                <>
                  {m.tokenLocks.map((l) => (
                    <div key={`t${l.lockId}`} className="row-card">
                      <strong>Token lock #{l.lockId.toString()}</strong> · {amountText(l.amount, metaOf(m.metas, l.currency))} ·{" "}
                      {l.start === l.end ? `unlocks ${utc(l.end)}` : `vests ${utc(l.start)} → ${utc(l.end)}`} · claimable{" "}
                      {amountText(l.claimable, metaOf(m.metas, l.currency))}{" "}
                      <Progress
                        fraction={windowProgress(Number(l.start), Number(l.end), Number(m.now))}
                        label={`Token lock #${l.lockId.toString()}`}
                        caption={
                          m.now >= l.end
                            ? "fully released by the schedule"
                            : m.now < l.start
                              ? `schedule starts ${utc(l.start)}`
                              : `${Math.round(windowProgress(Number(l.start), Number(l.end), Number(m.now)) * 100)}% of the schedule elapsed`
                        }
                      />
                      {l.claimable > 0n ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          disabled={tx.busy || tokenLock === null}
                          onClick={() =>
                            tokenLock !== null &&
                            void tx.run(`Claim lock #${l.lockId}`, buildClaimTokenLock({ lock: tokenLock, lockId: l.lockId, to: account })).then(() => mine.reload())
                          }
                        >
                          Claim to this wallet
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {m.positionLocks.map((p) => {
                    const pending = p.pendingOwner !== null && p.pendingOwner.toLowerCase() === account.toLowerCase() && p.owner.toLowerCase() !== account.toLowerCase();
                    const unlockable = !p.withdrawn && m.now >= p.unlockAt;
                    return (
                      <div key={`p${p.tokenId}`} className="row-card">
                        <strong>Position #{p.tokenId.toString()}</strong> · {p.withdrawn ? "withdrawn" : unlockable ? `unlockable since ${utc(p.unlockAt)}` : `locked until ${utc(p.unlockAt)}`} ·{" "}
                        <Link to={`/locks/pool/${p.poolId}`}>pool</Link>{" "}
                        {positionLock !== null && pending ? (
                          <button type="button" className="btn btn-ghost btn-small" disabled={tx.busy} onClick={() => void tx.run(`Accept lock #${p.tokenId}`, buildAcceptLockOwner({ lock: positionLock, tokenId: p.tokenId })).then(() => mine.reload())}>
                            Accept the offered lock
                          </button>
                        ) : null}
                        {positionLock !== null && !pending && !p.withdrawn ? (
                          <button type="button" className="btn btn-ghost btn-small" disabled={tx.busy} onClick={() => void tx.run(`Collect fees of #${p.tokenId}`, buildCollectLockedFees({ lock: positionLock, tokenId: p.tokenId })).then(() => mine.reload())}>
                            Collect fees
                          </button>
                        ) : null}
                        {positionLock !== null && !pending && unlockable ? (
                          <button type="button" className="btn btn-ghost btn-small" disabled={tx.busy} onClick={() => void tx.run(`Withdraw #${p.tokenId}`, buildWithdrawPosition({ lock: positionLock, tokenId: p.tokenId, to: account })).then(() => mine.reload())}>
                            Withdraw the position
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                  <TxStatus phase={tx.phase} />
                </>
              );
            }}
          </Async>
        </section>
      )}

      <Async state={directory.state} onRetry={directory.reload} loadingLabel="Loading every lock">
        {(d) => (
          <>
            <section className="panel">
              <div className="chart-head">
                <h2>Liquidity</h2>
                {d.pools !== null && d.pools.pools.length > 0 ? <ViewToggle view={poolView} onChange={setPoolView} label="Liquidity locks" /> : null}
              </div>
              {d.pools === null ? (
                <NotDeployed what="The liquidity lock" contract="GullyCorePositionLock" chainName={cfg.core.name} chainId={cfg.core.chainId} />
              ) : d.pools.pools.length === 0 ? (
                <Empty title="No liquidity locks yet" detail="No position is time-locked and the LP locker holds none." />
              ) : poolView === "chart" ? (
                <BarList
                  caption="Locked share of each pool's active liquidity"
                  empty=""
                  rows={sortRows(d.pools.pools, (p) => p.lockedActiveBps, "desc").map((p) => {
                    const name = `${metaOf(d.metas, p.currency0)?.symbol ?? shortAddress(p.currency0)} / ${metaOf(d.metas, p.currency1)?.symbol ?? shortAddress(p.currency1)}`;
                    return {
                      key: p.poolId,
                      label: <Link to={`/locks/pool/${p.poolId}`}>{name}</Link>,
                      text: name,
                      value: p.lockedActiveBps ?? 0,
                      display: p.lockedActiveBps === null ? "not measurable" : `${formatLockBps(p.lockedActiveBps)} locked`,
                    };
                  })}
                />
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th>Locked share of active liquidity</th>
                      <th>Time locks live</th>
                      <th>Permanent (LP locker)</th>
                      <th>Next unlock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.pools.pools.map((p) => (
                      <tr key={p.poolId}>
                        <td>
                          <Link to={`/locks/pool/${p.poolId}`}>
                            {metaOf(d.metas, p.currency0)?.symbol ?? shortAddress(p.currency0)} / {metaOf(d.metas, p.currency1)?.symbol ?? shortAddress(p.currency1)}
                          </Link>
                        </td>
                        <td>{p.lockedActiveBps === null ? <span className="muted">not measurable</span> : formatLockBps(p.lockedActiveBps)}</td>
                        <td>{p.lockedCount}</td>
                        <td>{p.permanent.length}</td>
                        <td>{p.nextUnlockAt === null ? <span className="muted">—</span> : utc(p.nextUnlockAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>

            <section className="panel">
              <div className="chart-head">
                <h2>Tokens</h2>
                {d.tokens !== null && d.tokens.currencies.length > 0 ? <ViewToggle view={tokenView} onChange={setTokenView} label="Token locks" /> : null}
              </div>
              {d.tokens === null ? (
                <NotDeployed what="The token lock" contract="GullyCoreTokenLock" chainName={cfg.core.name} chainId={cfg.core.chainId} />
              ) : d.tokens.currencies.length === 0 ? (
                <Empty title="No token locks yet" detail="Nothing is locked yet." />
              ) : tokenView === "chart" ? (
                <>
                  <BarList
                    caption="Share of each token's supply the token lock still holds"
                    empty=""
                    rows={sortRows(d.tokens.currencies, (c) => c.heldBps, "desc").map((c) => {
                      const name = metaOf(d.metas, c.currency)?.symbol ?? shortAddress(c.currency);
                      return {
                        key: c.currency,
                        label: <Link to={`/locks/token/${c.currency}`}>{name}</Link>,
                        text: name,
                        value: c.heldBps ?? 0,
                        display: c.heldBps === null ? "no supply to measure" : `${formatLockBps(c.heldBps)} of supply`,
                      };
                    })}
                  />
                </>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Locks</th>
                      <th>Still held</th>
                      <th>Share of supply held</th>
                      <th>Next release</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.tokens.currencies.map((c) => (
                      <tr key={c.currency}>
                        <td>
                          <Link to={`/locks/token/${c.currency}`}>{metaOf(d.metas, c.currency)?.symbol ?? shortAddress(c.currency)}</Link>
                        </td>
                        <td>{c.locks.length}</td>
                        <td>{amountText(c.totalHeld, metaOf(d.metas, c.currency))}</td>
                        <td>{c.heldBps === null ? <span className="muted">no supply to measure</span> : formatLockBps(c.heldBps)}</td>
                        <td>{c.nextCliffOrEnd === null ? <span className="muted">—</span> : utc(c.nextCliffOrEnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>
          </>
        )}
      </Async>
    </div>
  );
}

/* ---------------------------------------------------------- lock (new) --- */

type Kind = "token" | "liquidity";

export function LockNew(): ReactElement {
  const cfg = resolveConfig();
  const [params, setParams] = useSearchParams();
  const kind: Kind = params.get("kind") === "liquidity" ? "liquidity" : "token";
  const { positionLock, tokenLock } = cfg.utilities;
  if (positionLock === null && tokenLock === null) return <LocksNotDeployed title="Lock liquidity or tokens" />;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Lock liquidity or tokens</h1>
        <p className="page-sub">
          A lock cannot be shortened, revoked or redirected by anyone. The dates are UTC and the contract compares them
          with <code>block.timestamp</code>.
        </p>
        <Link className="btn btn-ghost" to="/locks">
          All locks
        </Link>
      </header>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={kind === "token"} className={kind === "token" ? "tab tab-active" : "tab"} onClick={() => setParams({ kind: "token" })}>
          Tokens
        </button>
        <button type="button" role="tab" aria-selected={kind === "liquidity"} className={kind === "liquidity" ? "tab tab-active" : "tab"} onClick={() => setParams({ kind: "liquidity" })}>
          A liquidity position
        </button>
      </div>
      {kind === "token" ? (
        tokenLock === null ? (
          <NotDeployed what="The token lock" contract="GullyCoreTokenLock" chainName={cfg.core.name} chainId={cfg.core.chainId} />
        ) : (
          <TokenLockForm lock={tokenLock} />
        )
      ) : positionLock === null ? (
        <NotDeployed what="The liquidity lock" contract="GullyCorePositionLock" chainName={cfg.core.name} chainId={cfg.core.chainId} />
      ) : (
        <PositionLockForm lock={positionLock} />
      )}
    </div>
  );
}

const CUSTOM = "custom";

function TokenLockForm({ lock }: { lock: Address }): ReactElement {
  const cfg = resolveConfig();
  const tx = useTx(LOCK_ABIS);
  const account = tx.account;
  const [choice, setChoice] = useState<string>(NATIVE);
  const [custom, setCustom] = useState("");
  const [amount, setAmount] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [schedule, setSchedule] = useState<LockScheduleForm>({ mode: "timelock", at: "", cliffDays: "0", durationDays: "365" });
  const [allowanceNonce, setAllowanceNonce] = useState(0);

  const base = useAsync(async () => {
    const [terms, now] = await Promise.all([readUtilityFee(lock), readChainNow(publicClient())]);
    return { terms, now };
  }, [lock]);

  useEffect(() => {
    if (base.state.status === "ready" && schedule.at === "") {
      setSchedule((s) => ({ ...s, at: unixToUtcInput(base.state.status === "ready" ? base.state.data.now + 30n * 86_400n : 0n) }));
    }
  }, [base.state, schedule.at]);
  useEffect(() => {
    if (beneficiary === "" && account !== undefined) setBeneficiary(account);
  }, [account, beneficiary]);

  const currency: Address | null = choice === CUSTOM ? addressOrNull(custom) : (choice as Address);
  const meta = useAsync(async () => (currency === null ? null : currencyMeta(currency)), [currency]);
  const decimals = meta.state.status === "ready" && meta.state.data !== null ? meta.state.data.decimals : null;

  let raw: bigint | null = null;
  let amountError: string | null = null;
  if (amount.trim() !== "") {
    if (decimals === null) amountError = "The token's decimals could not be read, so an amount cannot be converted exactly.";
    else {
      try {
        raw = parseUnits(amount.trim(), decimals);
      } catch {
        amountError = "Not a decimal amount.";
      }
    }
  }
  const allowance = useAsync(async () => {
    if (currency === null || isNative(currency) || account === undefined) return null;
    return readErc20Allowance(publicClient(), currency, account, lock);
  }, [currency, account, lock, allowanceNonce]);

  const built = useMemo(() => {
    if (base.state.status !== "ready") return null;
    const sched = scheduleFromForm(schedule);
    if ("error" in sched) return { issues: [sched.error], call: null };
    const issues = validateTokenLock({
      currency: currency ?? "",
      amount: raw ?? 0n,
      beneficiary,
      schedule: sched,
      nowSeconds: base.state.data.now,
      lock,
    }).map((i) => i.message);
    if (amountError !== null) issues.unshift(amountError);
    if (issues.length > 0 || currency === null || raw === null) return { issues, call: null };
    const to = addressOrNull(beneficiary);
    if (to === null) return { issues: ["The beneficiary is not an address."], call: null };
    return { issues: [], call: buildTokenLock({ lock, currency, amount: raw, beneficiary: to, schedule: sched, terms: base.state.data.terms }), schedule: sched };
  }, [base.state, schedule, currency, raw, beneficiary, amountError, lock]);

  const needsApproval =
    currency !== null && !isNative(currency) && raw !== null && allowance.state.status === "ready" && allowance.state.data !== null && allowance.state.data < raw;

  return (
    <Async state={base.state} onRetry={base.reload} loadingLabel="Loading the fee">
      {({ terms }) => (
        <div className="wizard">
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <fieldset>
              <legend>What to lock</legend>
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
                    {meta.state.status === "ready" && meta.state.data !== null
                      ? meta.state.data.decimals === null
                        ? "Does not answer decimals(); not lockable from this screen."
                        : `${meta.state.data.symbol}, ${meta.state.data.decimals} decimals (read from the contract).`
                      : "Decimals are read from the contract, never typed."}
                  </small>
                </label>
              ) : null}
              <label>
                Amount{meta.state.status === "ready" && meta.state.data !== null ? ` (${meta.state.data.symbol})` : ""}
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0" />
                <small>A fee-on-transfer token locks what actually arrives; the lock records the net amount.</small>
              </label>
              <label>
                Beneficiary (receives it; can claim to any address and hand the lock on, two-step)
                <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="0x…" />
              </label>
            </fieldset>
            <fieldset>
              <legend>Schedule (UTC)</legend>
              <label>
                <input type="radio" checked={schedule.mode === "timelock"} onChange={() => setSchedule({ ...schedule, mode: "timelock" })} /> Everything at one date
              </label>
              <label>
                <input type="radio" checked={schedule.mode === "vesting"} onChange={() => setSchedule({ ...schedule, mode: "vesting" })} /> Vest linearly, with an optional cliff
              </label>
              <label>
                {schedule.mode === "timelock" ? "Unlocks at" : "Vesting starts at"}
                <input type="datetime-local" value={schedule.at} onChange={(e) => setSchedule({ ...schedule, at: e.target.value })} />
                <small>
                  {utcInputToUnix(schedule.at) === null ? "" : `${utc(utcInputToUnix(schedule.at) ?? 0n)} · the contract's clock, not your time zone.`}
                </small>
              </label>
              {schedule.mode === "vesting" ? (
                <>
                  <label>
                    Cliff, days (nothing is claimable before it)
                    <input value={schedule.cliffDays} onChange={(e) => setSchedule({ ...schedule, cliffDays: e.target.value })} inputMode="numeric" />
                  </label>
                  <label>
                    Duration, days (everything vested at the end)
                    <input value={schedule.durationDays} onChange={(e) => setSchedule({ ...schedule, durationDays: e.target.value })} inputMode="numeric" />
                  </label>
                </>
              ) : null}
            </fieldset>
            {built !== null && built.issues.length > 0 ? (
              <ul className="problem-list">
                {built.issues.map((m) => (
                  <li key={m}>
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="form-actions">
              {needsApproval && currency !== null && raw !== null ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={tx.busy}
                  onClick={() => void tx.run("Approve", buildErc20Approve({ token: currency, spender: lock, amount: raw })).then(() => setAllowanceNonce((n) => n + 1))}
                >
                  1. Approve exactly {amount} {meta.state.status === "ready" ? meta.state.data?.symbol : ""}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary"
                disabled={built === null || built.call === null || needsApproval || tx.busy || account === undefined}
                onClick={() => {
                  if (built?.call) void tx.run("Lock", built.call).then((r) => r !== null && setAllowanceNonce((n) => n + 1));
                }}
              >
                {account === undefined ? "Connect a wallet" : needsApproval ? "2. Simulate and lock" : "Simulate and lock"}
              </button>
            </div>
            <TxStatus phase={tx.phase} />
            {tx.phase.kind === "done" && tx.phase.label === "Lock" && currency !== null ? (
              <p className="state state-ok">
                Locked. See it on <Link to={`/locks/token/${currency}`}>the token&rsquo;s locks</Link>.
              </p>
            ) : null}
          </form>
          <UtilityFee terms={terms} contract="GullyCoreTokenLock" per="lock">
            {currency !== null && isNative(currency) && raw !== null ? (
              <p className="state-hint">For a native lock the value sent is the amount plus the fee.</p>
            ) : null}
          </UtilityFee>
        </div>
      )}
    </Async>
  );
}

function PositionLockForm({ lock }: { lock: Address }): ReactElement {
  const tx = useTx(LOCK_ABIS);
  const account = tx.account;
  const [tokenIdText, setTokenIdText] = useState("");
  const [unlock, setUnlock] = useState("");
  const [owner, setOwner] = useState("");
  const [nonce, setNonce] = useState(0);

  const base = useAsync(async () => {
    const client = publicClient();
    const [terms, now, ctx] = await Promise.all([readUtilityFee(lock), readChainNow(client), readPositionLockContext(client, lock)]);
    return { terms, now, ctx };
  }, [lock]);
  useEffect(() => {
    if (base.state.status === "ready" && unlock === "") setUnlock(unixToUtcInput(base.state.data.now + 180n * 86_400n));
  }, [base.state, unlock]);
  useEffect(() => {
    if (owner === "" && account !== undefined) setOwner(account);
  }, [account, owner]);

  const tokenId = /^\d{1,78}$/.test(tokenIdText.trim()) ? BigInt(tokenIdText.trim()) : null;
  const position = useAsync(async () => {
    if (tokenId === null || base.state.status !== "ready") return null;
    const client = publicClient();
    const pm = base.state.data.ctx.positionManager;
    const [nftOwner, p, existing] = await Promise.all([
      client.readContract({ address: pm, abi: CL_POSITION_MANAGER_ABI, functionName: "ownerOf", args: [tokenId] }).catch(() => null),
      client.readContract({ address: pm, abi: CL_POSITION_MANAGER_ABI, functionName: "positions", args: [tokenId] }).catch(() => null),
      readPositionLock(client, lock, tokenId).catch(() => null),
    ]);
    if (nftOwner === null || p === null) return { exists: false as const };
    const key = p[0] as unknown as PoolKey;
    const poolId = poolKeyToId(key);
    const approved = account === undefined ? false : await readPositionApproval(client, { positionManager: pm, lock, tokenId, owner: account });
    const [m0, m1] = await Promise.all([currencyMeta(key.currency0), currencyMeta(key.currency1)]);
    return { exists: true as const, nftOwner, poolId: poolId as Hex, tickLower: Number(p[1]), tickUpper: Number(p[2]), liquidity: p[3], existing, approved, m0, m1 };
  }, [tokenId, base.state.status, account, nonce]);

  return (
    <Async state={base.state} onRetry={base.reload} loadingLabel="Loading the fee">
      {({ terms, now, ctx }) => {
        const pos = position.state.status === "ready" ? position.state.data : null;
        const unlockAt = utcInputToUnix(unlock);
        const issues: string[] = [];
        if (unlockAt === null) issues.push("Pick the unlock date and time (UTC).");
        else issues.push(...validatePositionLock({ unlockAt, owner, nowSeconds: now, lock }).map((i) => i.message));
        if (pos !== null && pos.exists) {
          if (account !== undefined && pos.nftOwner.toLowerCase() !== account.toLowerCase()) issues.push(`Position #${tokenIdText} is owned by ${pos.nftOwner}, not the connected wallet.`);
          if (pos.liquidity === 0n) issues.push("The position holds no liquidity; the contract refuses an empty position.");
          if (pos.existing !== null && !pos.existing.withdrawn) issues.push("That position is already locked here.");
        }
        const ownerAddress = addressOrNull(owner);
        const found = pos !== null && pos.exists ? pos : null;
        const approved = found?.approved === true;
        const ready = found !== null && issues.length === 0 && unlockAt !== null && ownerAddress !== null && tokenId !== null;
        return (
          <div className="wizard">
            <form className="form" onSubmit={(e) => e.preventDefault()}>
              <fieldset>
                <legend>Position</legend>
                <label>
                  Position NFT id (from <AddressLink address={ctx.positionManager} />, the one position manager this lock accepts)
                  <input value={tokenIdText} onChange={(e) => setTokenIdText(e.target.value)} inputMode="numeric" placeholder="token id" />
                </label>
                {tokenId !== null && position.state.status === "loading" ? <p className="muted">Reading position #{tokenIdText}…</p> : null}
                {pos !== null && !pos.exists ? <p className="warn-inline">No position #{tokenIdText} exists on that position manager.</p> : null}
                {pos !== null && pos.exists ? (
                  <dl className="kv">
                    <dt>Pool</dt>
                    <dd>
                      {pos.m0.symbol} / {pos.m1.symbol} · <span className="mono">{shortAddress(pos.poolId, 10, 6)}</span>
                    </dd>
                    <dt>Range</dt>
                    <dd>
                      ticks {pos.tickLower} to {pos.tickUpper}, liquidity {pos.liquidity.toString()}
                    </dd>
                    <dt>Owner</dt>
                    <dd>
                      <AddressLink address={pos.nftOwner} />
                    </dd>
                  </dl>
                ) : null}
              </fieldset>
              <fieldset>
                <legend>Lock</legend>
                <label>
                  Unlocks at (UTC)
                  <input type="datetime-local" value={unlock} onChange={(e) => setUnlock(e.target.value)} />
                  <small>{unlockAt === null ? "" : `${utc(unlockAt)}. Can be extended later, never shortened.`}</small>
                </label>
                <label>
                  Lock owner (collects the position&rsquo;s swap fees meanwhile, withdraws it after the date)
                  <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="0x…" />
                </label>
              </fieldset>
              {tokenId !== null && issues.length > 0 ? (
                <ul className="problem-list">
                  {issues.map((m) => (
                    <li key={m}>
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="form-actions">
                {ready && !approved && tokenId !== null ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={tx.busy}
                    onClick={() => void tx.run("Approve the position", buildApprovePositionForLock({ positionManager: ctx.positionManager, lock, tokenId })).then(() => setNonce((n) => n + 1))}
                  >
                    1. Approve position #{tokenIdText} for the lock
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!ready || !approved || tx.busy}
                  onClick={() => {
                    if (ready && unlockAt !== null && ownerAddress !== null && tokenId !== null) {
                      void tx.run("Lock", buildLockPosition({ lock, tokenId, unlockAt, owner: ownerAddress, terms })).then(() => setNonce((n) => n + 1));
                    }
                  }}
                >
                  {account === undefined ? "Connect a wallet" : ready && !approved ? "2. Simulate and lock" : "Simulate and lock"}
                </button>
              </div>
              <TxStatus phase={tx.phase} />
              {tx.phase.kind === "done" && tx.phase.label === "Lock" && pos !== null && pos.exists ? (
                <p className="state state-ok">
                  Locked. See it on <Link to={`/locks/pool/${pos.poolId}`}>the pool&rsquo;s locks</Link>.
                </p>
              ) : null}
            </form>
            <UtilityFee terms={terms} contract="GullyCorePositionLock" per="lock" />
          </div>
        );
      }}
    </Async>
  );
}

/* -------------------------------------------------------------- detail --- */

export function PoolLocks(): ReactElement {
  const cfg = resolveConfig();
  const params = useParams();
  const poolId = (params["poolId"] ?? "") as Hex;
  const valid = /^0x[0-9a-fA-F]{64}$/.test(poolId);
  const tx = useTx(LOCK_ABIS);
  const resource = useAsync(async () => {
    if (!valid) return null;
    const summary = await readPoolLockSummary(poolId);
    if (summary === null) return null;
    const [m0, m1] = await Promise.all([currencyMeta(summary.currency0), currencyMeta(summary.currency1)]);
    return { summary, m0, m1 };
  }, [poolId]);
  const positionLock = cfg.utilities.positionLock;

  if (!valid) {
    return (
      <div className="page page-narrow">
        <Empty title="Not a pool id" detail="A pool id is 32 bytes of hex." />
      </div>
    );
  }
  return (
    <div className="page">
      <header className="page-head">
        <h1>Pool locks</h1>
        <p className="page-sub mono">{poolId}</p>
        <Link className="btn btn-ghost" to="/locks">
          All locks
        </Link>{" "}
        {positionLock === null ? null : (
          <Link className="btn btn-ghost" to="/locks/new?kind=liquidity">
            Lock a position
          </Link>
        )}
      </header>
      <PoolLockBadge poolId={poolId} detail />
      <Async state={resource.state} onRetry={resource.reload} loadingLabel="Loading the pool's locks">
        {(d) =>
          d === null ? (
            <NotDeployed what="Gully Core locks" contract="GullyCorePositionLock or an LP locker" chainName={cfg.core.name} chainId={cfg.core.chainId} />
          ) : (
            <>
              <section className="panel">
                <h2>Time-locked positions</h2>
                {d.summary.locks.length === 0 ? (
                  <p className="muted">None in this pool.</p>
                ) : (
                  <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th>Status</th>
                        <th>Lock owner</th>
                        <th>Holds now</th>
                        <th>Unlocks</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {d.summary.locks.map((l) => (
                        <tr key={l.tokenId.toString()}>
                          <td>#{l.tokenId.toString()}</td>
                          <td>
                            {l.status}
                            {l.inRange === false ? " · out of range" : ""}
                          </td>
                          <td>
                            <AddressLink address={l.owner} />
                          </td>
                          <td>
                            {l.amount0 === null || l.amount1 === null ? "—" : `${amountText(l.amount0, d.m0)} + ${amountText(l.amount1, d.m1)}`}
                          </td>
                          <td>{utc(l.unlockAt)}</td>
                          <td>
                            {positionLock !== null && l.status !== "withdrawn" ? (
                              <button type="button" className="btn btn-ghost btn-small" disabled={tx.busy || tx.account === undefined} onClick={() => void tx.run(`Collect fees of #${l.tokenId}`, buildCollectLockedFees({ lock: positionLock, tokenId: l.tokenId })).then(() => resource.reload())}>
                                Collect fees (paid to the lock owner)
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
                <TxStatus phase={tx.phase} />
              </section>
              <section className="panel">
                <h2>Locked permanently (LP locker)</h2>
                {d.summary.permanent.length === 0 ? (
                  <p className="muted">The protocol&rsquo;s LP locker holds no position in this pool.</p>
                ) : (
                  <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th>Range</th>
                        <th>Holds now</th>
                        <th>Fee receiver (creator)</th>
                        <th>Locked at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.summary.permanent.map((p) => (
                        <tr key={p.tokenId.toString()}>
                          <td>#{p.tokenId.toString()}</td>
                          <td>
                            {p.tickLower} to {p.tickUpper}
                            {p.inRange === false ? " · out of range" : ""}
                          </td>
                          <td>{p.amount0 === null || p.amount1 === null ? "—" : `${amountText(p.amount0, d.m0)} + ${amountText(p.amount1, d.m1)}`}</td>
                          <td>
                            <AddressLink address={p.creator} />
                          </td>
                          <td>{utc(p.lockedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
                <p className="state-hint">
                  The LP locker has no withdraw path: these positions are never removed. Only their fees are harvested and
                  split between creator, integrator and protocol.
                </p>
              </section>
            </>
          )
        }
      </Async>
    </div>
  );
}

export function TokenLocks(): ReactElement {
  const cfg = resolveConfig();
  const params = useParams();
  const token = addressOrNull(params["token"] ?? "");
  const tokenLock = cfg.utilities.tokenLock;
  if (token === null) {
    return (
      <div className="page page-narrow">
        <Empty title="Not an address" detail="The link does not name a token address." />
      </div>
    );
  }
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>Token locks</h1>
        <p className="page-sub mono">{token}</p>
        <Link className="btn btn-ghost" to="/locks">
          All locks
        </Link>{" "}
        {tokenLock === null ? null : (
          <Link className="btn btn-ghost" to="/locks/new">
            Lock tokens
          </Link>
        )}
      </header>
      {tokenLock === null ? (
        <NotDeployed what="The token lock" contract="GullyCoreTokenLock" chainName={cfg.core.name} chainId={cfg.core.chainId} />
      ) : (
        <LocksPanel
          client={publicClient()}
          target={{ kind: "token", token, tokenLock }}
          native={{ symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals }}
          title="Locks of this token"
        />
      )}
      <p className="state-hint">
        A beneficiary claims from <Link to="/locks">Locks → Your locks</Link>. The share of supply is{" "}
        <code>totalHeld</code> over <code>totalSupply()</code>, read live.
      </p>
    </div>
  );
}
