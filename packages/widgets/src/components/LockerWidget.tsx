// SPDX-License-Identifier: MIT
/**
 * `LockerWidget`: lock liquidity and tokens with Gully Core from any React app.
 *
 *   Lock liquidity  time-lock a CL position NFT in `GullyCorePositionLock`
 *   Lock tokens     a time lock or cliff + linear vesting in `GullyCoreTokenLock`
 *   My locks        the connected wallet's locks: collect fees, extend,
 *                   withdraw after the date, claim what has vested, accept an
 *                   offered lock
 *
 * The fee is read live from each contract (`feeWei` and any announced
 * `pendingFee`) and shown before anything is signed; it is the contract's, not
 * this widget's, so every caller pays the same. Approvals are exact (this one
 * NFT; exactly the amount), and only when the chain says one is missing. Every
 * call is simulated with its exact bytes before the wallet sees it, and every
 * receipt is checked: a mined revert is reported as one. Errors read through
 * the widgets' decoder.
 *
 * The wallet is `wallet` (the `WidgetWallet` surface `createViemAdapter`
 * takes), else the mounted `WidgetProvider`'s adapter. Reads go through
 * `client`, on the lock contracts' chain.
 */

import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { erc20Abi, getAddress, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { CL_POSITION_MANAGER_ABI } from "@gullylabs/core-sdk";
import {
  buildAcceptBeneficiary,
  buildAcceptLockOwner,
  buildApprovePositionForLock,
  buildClaimTokenLock,
  buildCollectLockedFees,
  buildErc20Approve,
  buildExtendPositionLock,
  buildLockPosition,
  buildTokenLock,
  buildWithdrawPosition,
  readChainNow,
  readErc20Allowance,
  readFeeGate,
  readPositionApproval,
  readPositionLockContext,
  validatePositionLock,
  validateTokenLock,
} from "@gullylabs/core-sdk/lock";

import type { WidgetWallet } from "../adapters/viem.js";
import { useOptionalWidgetContext, type WidgetTheme } from "../context/WidgetProvider.js";
import { useAsyncResource } from "../hooks/useAsyncResource.js";
import { useLockerAccount, useLockerFees, useLockerRunner, useLockerWallet, useMyLocks, type LockerContracts, type RunnerState, type RunnerStep } from "../hooks/useLocker.js";
import {
  POSITION_ACTION_LABEL,
  TOKEN_ACTION_LABEL,
  lockSchedule,
  lockerFeeView,
  parseDays,
  parseLockAmount,
  parseUtcInput,
  planPositionLock,
  planTokenLock,
  positionLockActions,
  toUtcInput,
  tokenLockActions,
  type VestingMode,
} from "../locker/model.js";
import { formatLockAmount, formatLockBps, formatUtc, releaseSchedule, vestedBps } from "../locks/model.js";
import { ScheduleSpark } from "./lockCharts.js";
import { injectWidgetStyles } from "../styles/css.js";

export interface LockerWidgetProps {
  readonly client: PublicClient;
  readonly contracts: LockerContracts;
  readonly wallet?: WidgetWallet;
  readonly native?: { readonly symbol: string; readonly decimals: number };
  readonly theme?: WidgetTheme;
  readonly title?: string;
  readonly defaultTab?: LockerTab;
  /** Prefill the token tab. */
  readonly defaultToken?: Address;
  /** Opens the host's wallet connect flow; falls back to the provider's. */
  readonly onConnectRequest?: () => void;
  /** Links a transaction hash to an explorer; `null` for no link. */
  readonly explorerTxUrl?: (hash: Hex) => string | null;
  /** The Gully Core icon (kit `02-icon/gully-core-icon-orange.svg`) beside the
   * title, at the kit's 24 px minimum. The intrinsic size is the master's real viewBox so the shape
   * is reserved correctly; CSS decides how big it draws. Omit for none. */
  readonly brandMarkUrl?: string;
  readonly className?: string;
}

export type LockerTab = "position" | "token" | "mine";

const DEFAULT_NATIVE = { symbol: "ETH", decimals: 18 };
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Progress({ state, explorerTxUrl }: { state: RunnerState; explorerTxUrl: LockerWidgetProps["explorerTxUrl"] }): ReactElement | null {
  if (state.k === "idle") return null;
  const labels = state.labels;
  const active = state.k === "done" ? labels.length : state.active;
  return (
    <div role="status" aria-live="polite">
      <ol className="gullycore-locker__steps">
        {labels.map((l, i) => (
          <li key={l} data-state={i < active ? "done" : i === active && state.k === "running" ? "active" : "pending"}>
            {l}
          </li>
        ))}
      </ol>
      {state.k === "running" ? (
        <p className="gullycore-locker__status">
          {state.phase === "simulating" ? "Simulating the exact transaction…" : state.phase === "signing" ? "Confirm in your wallet…" : "Waiting for the receipt…"}
        </p>
      ) : state.k === "failed" ? (
        <p className="gullycore-locker__status" data-kind="error">
          {state.message}
        </p>
      ) : (
        <p className="gullycore-locker__status" data-kind="success">
          Done: every receipt succeeded.{" "}
          {state.hashes.map((h) => {
            const href = explorerTxUrl?.(h) ?? null;
            return href === null ? (
              <code key={h}>{short(h)} </code>
            ) : (
              <a key={h} href={href} target="_blank" rel="noopener noreferrer">
                {short(h)}{" "}
              </a>
            );
          })}
        </p>
      )}
    </div>
  );
}

function FeeBox({ terms, native }: { terms: Parameters<typeof lockerFeeView>[0] | null | undefined; native: { symbol: string; decimals: number } }): ReactElement {
  if (terms === undefined) return <p className="gullycore-locker__fee">Loading the fee…</p>;
  if (terms === null) return <p className="gullycore-locker__fee">Couldn&rsquo;t load the fee. Try again.</p>;
  const v = lockerFeeView(terms, native);
  return (
    <p className="gullycore-locker__fee">
      <span>
        Fee <strong>{v.fee}</strong>, sends <strong>{v.sends}</strong>
      </span>
      {v.pending !== null ? <span>{v.pending}</span> : null}
      <span className="gullycore-note">{v.note}</span>
    </p>
  );
}

/* ------------------------------------------------------------ position tab --- */

function PositionTab(p: { props: LockerWidgetProps; account: Address | null; wallet: WidgetWallet | null; fee: Parameters<typeof lockerFeeView>[0] | null | undefined; onDone: () => void }): ReactElement {
  const { client, contracts } = p.props;
  const lock = contracts.positionLock as Address;
  const [tokenIdText, setTokenId] = useState("");
  const [unlockText, setUnlock] = useState("");
  const [ownerText, setOwner] = useState("");
  const tokenId = /^\d+$/.test(tokenIdText.trim()) ? BigInt(tokenIdText.trim()) : null;
  const unlockAt = parseUtcInput(unlockText);
  const owner = ownerText.trim() === "" ? p.account : isAddress(ownerText.trim(), { strict: false }) ? getAddress(ownerText.trim()) : null;

  const pos = useAsyncResource(
    async () => {
      const ctx = await readPositionLockContext(client, lock);
      const id = tokenId as bigint;
      const [nftOwner, info, approved, now] = await Promise.all([
        client.readContract({ address: ctx.positionManager, abi: CL_POSITION_MANAGER_ABI, functionName: "ownerOf", args: [id] }).catch(() => null),
        client.readContract({ address: ctx.positionManager, abi: CL_POSITION_MANAGER_ABI, functionName: "positions", args: [id] }).catch(() => null),
        p.account === null ? Promise.resolve(false) : readPositionApproval(client, { positionManager: ctx.positionManager, lock, tokenId: id, owner: p.account }).catch(() => false),
        readChainNow(client),
      ]);
      return { ctx, nftOwner, liquidity: info === null ? null : (info[3] as bigint), approved, now };
    },
    [client, lock, tokenId, p.account],
    { enabled: tokenId !== null },
  );
  const d = pos.data;
  useEffect(() => {
    if (unlockText === "" && d !== null) setUnlock(toUtcInput(d.now + 30n * 86_400n));
  }, [d, unlockText]);

  const issues: string[] = [];
  if (tokenIdText.trim() !== "" && tokenId === null) issues.push("The position id is a whole number.");
  if (d !== null && tokenId !== null) {
    if (d.nftOwner === null) issues.push(`Position #${tokenId} does not exist on this position manager.`);
    else if (p.account !== null && d.nftOwner.toLowerCase() !== p.account.toLowerCase()) issues.push(`Position #${tokenId} is owned by ${short(d.nftOwner)}, not the connected wallet.`);
    if (d.liquidity === 0n) issues.push("The position holds no liquidity.");
    if (unlockAt === null) issues.push("Choose an unlock date.");
    else for (const i of validatePositionLock({ unlockAt, owner: owner ?? "", nowSeconds: d.now, lock })) issues.push(i.message);
  }
  const runner = useLockerRunner(client, p.wallet, p.account, p.onDone);
  const ready = d !== null && tokenId !== null && unlockAt !== null && owner !== null && issues.length === 0 && p.account !== null && runner.state.k !== "running";
  const plan = ready ? planPositionLock({ tokenId: tokenId as bigint, approved: d.approved, unlockAt: unlockAt as bigint }) : [];

  const go = (): void => {
    if (!ready) return;
    const id = tokenId as bigint;
    const steps: RunnerStep[] = plan.map((s) => ({
      label: s.label,
      build:
        s.key === "approve"
          ? async () => buildApprovePositionForLock({ positionManager: d.ctx.positionManager, lock, tokenId: id })
          : async () => buildLockPosition({ lock, tokenId: id, unlockAt: unlockAt as bigint, owner: owner as Address, terms: await readFeeGate(client, lock) }),
    }));
    void runner.run(steps);
  };

  return (
    <div className="gullycore-locker__form">
      <label className="gullycore-locker__field">
        <span>Position id (CL position NFT)</span>
        <input className="gullycore-locker__input" inputMode="numeric" value={tokenIdText} onChange={(e) => setTokenId(e.target.value)} placeholder="Position id" />
      </label>
      {d !== null && d.liquidity !== null ? <p className="gullycore-note">Liquidity L {d.liquidity.toLocaleString("en-US")}{d.approved ? " · already approved to the lock" : ""}</p> : null}
      {pos.status === "error" ? <p className="gullycore-locker__status" data-kind="error">Couldn&rsquo;t load the position. Try again.</p> : null}
      <div className="gullycore-locker__row2">
        <label className="gullycore-locker__field">
          <span>Unlock (UTC)</span>
          <input className="gullycore-locker__input" type="datetime-local" value={unlockText} onChange={(e) => setUnlock(e.target.value)} />
        </label>
        <label className="gullycore-locker__field">
          <span>Lock owner</span>
          <input className="gullycore-locker__input" value={ownerText} onChange={(e) => setOwner(e.target.value)} placeholder={p.account === null ? "0x…" : `${short(p.account)} (you)`} />
        </label>
      </div>
      {issues.length > 0 ? (
        <ul className="gullycore-locker__issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      <FeeBox terms={p.fee} native={p.props.native ?? DEFAULT_NATIVE} />
      <p className="gullycore-note">Until the unlock date nobody can remove the liquidity or move the NFT. The lock owner keeps collecting its swap fees and withdraws after the date. A lock can be extended, never shortened.</p>
      <button type="button" className="gullycore-cta" disabled={!ready} onClick={go}>
        {plan.length > 1 ? "Approve and lock" : "Lock position"}
      </button>
      <Progress state={runner.state} explorerTxUrl={p.props.explorerTxUrl} />
    </div>
  );
}

/* --------------------------------------------------------------- token tab --- */

function TokenTab(p: { props: LockerWidgetProps; account: Address | null; wallet: WidgetWallet | null; fee: Parameters<typeof lockerFeeView>[0] | null | undefined; onDone: () => void }): ReactElement {
  const { client, contracts } = p.props;
  const lock = contracts.tokenLock as Address;
  const native = p.props.native ?? DEFAULT_NATIVE;
  const [isNative, setIsNative] = useState(false);
  const [tokenText, setToken] = useState(p.props.defaultToken ?? "");
  const [amountText, setAmount] = useState("");
  const [benText, setBen] = useState("");
  const [mode, setMode] = useState<VestingMode>("timelock");
  const [unlockText, setUnlock] = useState("");
  const [startText, setStart] = useState("");
  const [cliffText, setCliff] = useState("0");
  const [durText, setDur] = useState("365");
  const token: Address | null = isNative ? zeroAddress : isAddress(tokenText.trim(), { strict: false }) ? getAddress(tokenText.trim()) : null;
  const beneficiary = benText.trim() === "" ? p.account : isAddress(benText.trim(), { strict: false }) ? getAddress(benText.trim()) : null;

  const tok = useAsyncResource(
    async () => {
      const t = token as Address;
      const [symbol, decimals, balance, allowance, now] = await Promise.all([
        isNative ? Promise.resolve(native.symbol) : client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }),
        isNative ? Promise.resolve(native.decimals) : client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }),
        p.account === null ? Promise.resolve(null) : isNative ? client.getBalance({ address: p.account }) : client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [p.account] }),
        p.account === null || isNative ? Promise.resolve(0n) : readErc20Allowance(client, t, p.account, lock),
        readChainNow(client),
      ]);
      return { symbol, decimals: Number(decimals), balance, allowance, now };
    },
    [client, token, isNative, p.account, lock],
    { enabled: token !== null },
  );
  const d = tok.data;
  useEffect(() => {
    if (d === null) return;
    if (unlockText === "") setUnlock(toUtcInput(d.now + 30n * 86_400n));
    if (startText === "") setStart(toUtcInput(d.now + 3600n));
  }, [d, unlockText, startText]);

  const amount = d === null ? null : parseLockAmount(amountText, d.decimals);
  const schedule = lockSchedule(mode, { unlockAt: parseUtcInput(unlockText), start: parseUtcInput(startText), cliffDays: parseDays(cliffText), durationDays: parseDays(durText) });
  const issues: string[] = [];
  if (!isNative && tokenText.trim() !== "" && token === null) issues.push("The token is not an address.");
  if (tok.status === "error" && d === null) issues.push("The token could not be read: is it an ERC-20 on this chain?");
  if (d !== null) {
    if (amountText.trim() !== "" && amount === null) issues.push(`Enter an amount with at most ${d.decimals} decimals.`);
    if (amount !== null && d.balance !== null && amount > d.balance) issues.push(`The connected wallet holds ${formatLockAmount(d.balance, { symbol: d.symbol, decimals: d.decimals })}.`);
    if (schedule === null) issues.push(mode === "timelock" ? "Choose an unlock date." : "Set a start date, a cliff and a duration in whole days.");
    else if (amount !== null) for (const i of validateTokenLock({ currency: token as string, amount, beneficiary: beneficiary ?? "", schedule, nowSeconds: d.now, lock })) issues.push(i.message);
  }
  const runner = useLockerRunner(client, p.wallet, p.account, p.onDone);
  const ready = d !== null && amount !== null && amount > 0n && schedule !== null && beneficiary !== null && issues.length === 0 && p.account !== null && runner.state.k !== "running";
  const plan = ready ? planTokenLock({ native: isNative, allowance: d.allowance, amount: amount as bigint, amountText: amountText.trim(), symbol: d.symbol }) : [];

  const go = (): void => {
    if (!ready) return;
    const steps: RunnerStep[] = plan.map((s) => ({
      label: s.label,
      build:
        s.key === "approve"
          ? async () => buildErc20Approve({ token: token as Address, spender: lock, amount: amount as bigint })
          : async () => buildTokenLock({ lock, currency: token as Address, amount: amount as bigint, beneficiary: beneficiary as Address, schedule, terms: await readFeeGate(client, lock) }),
    }));
    void runner.run(steps);
  };

  return (
    <div className="gullycore-locker__form">
      <div className="gullycore-locker__choice" role="radiogroup" aria-label="Currency">
        <label>
          <input type="radio" checked={!isNative} onChange={() => setIsNative(false)} /> ERC-20 token
        </label>
        <label>
          <input type="radio" checked={isNative} onChange={() => setIsNative(true)} /> Native {native.symbol}
        </label>
      </div>
      {!isNative ? (
        <label className="gullycore-locker__field">
          <span>Token address</span>
          <input className="gullycore-locker__input" value={tokenText} onChange={(e) => setToken(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
      ) : null}
      <div className="gullycore-locker__row2">
        <label className="gullycore-locker__field">
          <span>Amount{d !== null ? ` (${d.symbol})` : ""}</span>
          <input className="gullycore-locker__input" inputMode="decimal" value={amountText} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </label>
        <label className="gullycore-locker__field">
          <span>Beneficiary</span>
          <input className="gullycore-locker__input" value={benText} onChange={(e) => setBen(e.target.value)} placeholder={p.account === null ? "0x…" : `${short(p.account)} (you)`} spellCheck={false} />
        </label>
      </div>
      {d !== null && d.balance !== null ? <p className="gullycore-note">Balance {formatLockAmount(d.balance, { symbol: d.symbol, decimals: d.decimals })}</p> : null}
      <div className="gullycore-locker__choice" role="radiogroup" aria-label="Schedule">
        <label>
          <input type="radio" checked={mode === "timelock"} onChange={() => setMode("timelock")} /> Time lock (all at one date)
        </label>
        <label>
          <input type="radio" checked={mode === "vesting"} onChange={() => setMode("vesting")} /> Vesting (cliff, then linear)
        </label>
      </div>
      {mode === "timelock" ? (
        <label className="gullycore-locker__field">
          <span>Unlock (UTC)</span>
          <input className="gullycore-locker__input" type="datetime-local" value={unlockText} onChange={(e) => setUnlock(e.target.value)} />
        </label>
      ) : (
        <>
          <label className="gullycore-locker__field">
            <span>Vesting starts (UTC)</span>
            <input className="gullycore-locker__input" type="datetime-local" value={startText} onChange={(e) => setStart(e.target.value)} />
          </label>
          <div className="gullycore-locker__row2">
            <label className="gullycore-locker__field">
              <span>Cliff (days after start)</span>
              <input className="gullycore-locker__input" inputMode="numeric" value={cliffText} onChange={(e) => setCliff(e.target.value)} />
            </label>
            <label className="gullycore-locker__field">
              <span>Fully vested (days after start)</span>
              <input className="gullycore-locker__input" inputMode="numeric" value={durText} onChange={(e) => setDur(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {schedule !== null && mode === "vesting" ? <p className="gullycore-note">Nothing claimable before {formatUtc(schedule.cliff)}; everything vested at {formatUtc(schedule.end)}.</p> : null}
      {schedule !== null && mode === "vesting" && d !== null && amount !== null && amount > 0n
        ? (() => {
            const sched = releaseSchedule([{ ...schedule, amount }], d.now);
            return sched === null ? null : <ScheduleSpark points={sched.points} total={sched.total} now={d.now} token={{ symbol: d.symbol, decimals: d.decimals }} />;
          })()
        : null}
      {issues.length > 0 ? (
        <ul className="gullycore-locker__issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      <FeeBox terms={p.fee} native={native} />
      <p className="gullycore-note">The schedule is fixed at creation: no key can shorten, revoke or redirect it. The beneficiary claims what has vested, to any address.</p>
      <button type="button" className="gullycore-cta" disabled={!ready} onClick={go}>
        {plan.length > 1 ? "Approve and lock" : "Lock tokens"}
      </button>
      <Progress state={runner.state} explorerTxUrl={p.props.explorerTxUrl} />
    </div>
  );
}

/* ---------------------------------------------------------------- my locks --- */

function MineTab(p: { props: LockerWidgetProps; account: Address | null; wallet: WidgetWallet | null }): ReactElement {
  const { client, contracts } = p.props;
  const mine = useMyLocks(client, contracts, p.account);
  const runner = useLockerRunner(client, p.wallet, p.account, mine.refetch);
  const [extend, setExtend] = useState<Record<string, string>>({});
  const native = p.props.native ?? DEFAULT_NATIVE;
  const metas = useAsyncResource(
    async () => {
      const cur = [...new Set((mine.data?.tokens ?? []).map((t) => t.currency.toLowerCase()))] as Address[];
      const out: Record<string, { symbol: string; decimals: number | null }> = {};
      await Promise.all(
        cur.map(async (c) => {
          if (c === zeroAddress) out[c] = native;
          else {
            const [s, dd] = await Promise.all([
              client.readContract({ address: c, abi: erc20Abi, functionName: "symbol" }).catch(() => short(c)),
              client.readContract({ address: c, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
            ]);
            out[c] = { symbol: s, decimals: dd === null ? null : Number(dd) };
          }
        }),
      );
      return out;
    },
    [client, (mine.data?.tokens ?? []).map((t) => t.currency).join(",")],
    { enabled: (mine.data?.tokens.length ?? 0) > 0 },
  );
  if (p.account === null) return <p className="gullycore-trust__state">Connect a wallet to see its locks.</p>;
  if (mine.data === null) {
    return mine.status === "error" ? (
      <p className="gullycore-locker__status" data-kind="error">
        Couldn&rsquo;t load the locks.{" "}
        <button type="button" className="gullycore-trust__retry" onClick={mine.refetch}>
          Retry
        </button>
      </p>
    ) : (
      <p className="gullycore-trust__state">Loading your locks…</p>
    );
  }
  const { positions, tokens, now } = mine.data;
  const busy = runner.state.k === "running";
  const act = (label: string, build: RunnerStep["build"]): void => void runner.run([{ label, build }]);
  const posLock = contracts.positionLock;
  const tokLock = contracts.tokenLock;
  return (
    <div className="gullycore-locker__form">
      {positions.length === 0 && tokens.length === 0 ? <p className="gullycore-trust__state">This wallet owns no lock and has been offered none.</p> : null}
      {posLock !== null && positions.length > 0 ? (
        <ul className="gullycore-locks__list">
          {positions.map((r) => {
            const actions = positionLockActions(r, p.account, now);
            const k = r.tokenId.toString();
            const newUnlock = parseUtcInput(extend[k] ?? "");
            return (
              <li key={k} className="gullycore-locks__item" data-status={r.withdrawn ? "withdrawn" : now < r.unlockAt ? "locked" : "unlockable"}>
                <div className="gullycore-locks__row">
                  <strong>Position #{k}</strong>
                  <span className="gullycore-locks__status">{r.withdrawn ? "Withdrawn" : now < r.unlockAt ? "Locked" : "Unlockable"}</span>
                </div>
                <p className="gullycore-note">
                  Unlocks {formatUtc(r.unlockAt)} · pool {r.poolId.slice(0, 10)}…{r.pendingOwner !== null ? ` · offered to ${short(r.pendingOwner)}` : ""}
                </p>
                {actions.includes("extend") ? (
                  <label className="gullycore-locker__field">
                    <span>New unlock (UTC), later than the current one</span>
                    <input className="gullycore-locker__input" type="datetime-local" value={extend[k] ?? toUtcInput(r.unlockAt)} onChange={(e) => setExtend({ ...extend, [k]: e.target.value })} />
                  </label>
                ) : null}
                <div className="gullycore-locker__actions">
                  {actions.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className="gullycore-locker__btn"
                      disabled={busy || (a === "extend" && (newUnlock === null || newUnlock <= r.unlockAt))}
                      onClick={() =>
                        act(
                          `${POSITION_ACTION_LABEL[a]}: position #${k}`,
                          async () =>
                            a === "collect"
                              ? buildCollectLockedFees({ lock: posLock, tokenId: r.tokenId })
                              : a === "extend"
                                ? buildExtendPositionLock({ lock: posLock, tokenId: r.tokenId, newUnlockAt: newUnlock as bigint })
                                : a === "withdraw"
                                  ? buildWithdrawPosition({ lock: posLock, tokenId: r.tokenId, to: p.account as Address })
                                  : buildAcceptLockOwner({ lock: posLock, tokenId: r.tokenId }),
                        )
                      }
                    >
                      {POSITION_ACTION_LABEL[a]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {tokLock !== null && tokens.length > 0 ? (
        <ul className="gullycore-locks__list">
          {tokens.map((l) => {
            const m = metas.data?.[l.currency.toLowerCase()] ?? { symbol: short(l.currency), decimals: null };
            const actions = tokenLockActions(l, p.account);
            return (
              <li key={l.lockId.toString()} className="gullycore-locks__item" data-status={l.status}>
                <div className="gullycore-locks__row">
                  <strong>Lock #{l.lockId.toString()}</strong>
                  <span className="gullycore-locks__status">{l.status === "cliff" ? "Before cliff" : l.status === "vesting" ? "Vesting" : l.status === "vested" ? "Fully vested" : "Claimed"}</span>
                </div>
                <div className="gullycore-progress" role="img" aria-label={`${formatLockBps(vestedBps(l))} vested`}>
                  <div className="gullycore-progress-fill" style={{ width: `${vestedBps(l) / 100}%` }} />
                </div>
                <p className="gullycore-note">
                  {formatLockAmount(l.amount, m)} · claimable {formatLockAmount(l.claimable, m)} · {l.start === l.end ? `unlocks ${formatUtc(l.end)}` : `vests ${formatUtc(l.start)} → ${formatUtc(l.end)}`}
                </p>
                <div className="gullycore-locker__actions">
                  {actions.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className="gullycore-locker__btn"
                      disabled={busy}
                      onClick={() =>
                        act(`${TOKEN_ACTION_LABEL[a]}: lock #${l.lockId}`, async () =>
                          a === "claim" ? buildClaimTokenLock({ lock: tokLock, lockId: l.lockId, to: p.account as Address }) : buildAcceptBeneficiary({ lock: tokLock, lockId: l.lockId }),
                        )
                      }
                    >
                      {TOKEN_ACTION_LABEL[a]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Progress state={runner.state} explorerTxUrl={p.props.explorerTxUrl} />
    </div>
  );
}

/* ------------------------------------------------------------------ widget --- */

export function LockerWidget(props: LockerWidgetProps): ReactElement {
  const ctx = useOptionalWidgetContext();
  const theme = props.theme ?? ctx?.theme ?? "dark";
  const headingId = useId();
  useEffect(() => {
    injectWidgetStyles();
  }, []);
  const wallet = useLockerWallet(props.wallet);
  const accountRes = useLockerAccount(wallet);
  const account = accountRes.data ?? null;
  const fees = useLockerFees(props.client, props.contracts);
  const hasPos = props.contracts.positionLock !== null;
  const hasTok = props.contracts.tokenLock !== null;
  const [tab, setTab] = useState<LockerTab>(props.defaultTab ?? (hasPos ? "position" : "token"));
  /* After a lock mines, the fee (and so the form) is re-read; "My locks" reads on every visit. */
  const onDone = useCallback(() => fees.refetch(), [fees.refetch]);
  const connect = props.onConnectRequest ?? ctx?.onConnectRequest;
  const tabs = useMemo(() => {
    const t: { key: LockerTab; label: string }[] = [];
    if (hasPos) t.push({ key: "position", label: "Lock liquidity" });
    if (hasTok) t.push({ key: "token", label: "Lock tokens" });
    t.push({ key: "mine", label: "My locks" });
    return t;
  }, [hasPos, hasTok]);
  const feeFor = (which: "position" | "token") => (fees.data === null ? (fees.status === "error" ? null : undefined) : fees.data[which]);

  return (
    <section className={`gullycore-widget gullycore-locker${props.className ? ` ${props.className}` : ""}`} data-gullycore-theme={theme} aria-labelledby={headingId}>
      <header className="gullycore-header gullycore-brand">
        {props.brandMarkUrl !== undefined ? <img className="gullycore-brand__mark" src={props.brandMarkUrl} width={220} height={220} alt="" /> : null}
        <h2 id={headingId} className="gullycore-title">
          {props.title ?? "Lock with Gully Core"}
        </h2>
      </header>
      {!hasPos && !hasTok ? (
        <p className="gullycore-trust__state" role="status">
          Gully Core locks are coming soon on this chain.
        </p>
      ) : (
        <>
          <div className="gullycore-locker__tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" className="gullycore-locker__tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {account === null ? (
            <button type="button" className="gullycore-cta" disabled={connect === undefined} onClick={connect}>
              Connect wallet
            </button>
          ) : (
            <p className="gullycore-note">Connected {short(account)}</p>
          )}
          {tab === "position" && hasPos ? <PositionTab props={props} account={account} wallet={wallet} fee={feeFor("position")} onDone={onDone} /> : null}
          {tab === "token" && hasTok ? <TokenTab props={props} account={account} wallet={wallet} fee={feeFor("token")} onDone={onDone} /> : null}
          {tab === "mine" ? <MineTab props={props} account={account} wallet={wallet} /> : null}
        </>
      )}
      <p className="gullycore-footer gullycore-footer--brand">Fees read live from the lock contracts · every call simulated first</p>
    </section>
  );
}
