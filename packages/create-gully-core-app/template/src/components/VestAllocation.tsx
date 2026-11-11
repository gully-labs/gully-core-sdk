// SPDX-License-Identifier: MIT
/**
 * "Vest your allocation": the optional step after a Kit v2 launch confirms.
 *
 * WHAT THE KIT GIVES. `LaunchpadKitV2.createLaunch` seeds `seedSupply` into
 * the locked pools and sends everything else (`totalSupply - seedSupply`, plus
 * a few wei of seeding dust) in ONE transfer to the allocation recipient, as a
 * plain balance. It creates no lock and stores no record of the recipient: the
 * only record is that transfer in the launch receipt, which
 * `readLaunchAllocation` (SDK) reads. When the whole supply was seeded there is
 * nothing to vest, and this says so and offers nothing.
 *
 * Vesting is a SECOND transaction on `GullyCoreTokenLock`; the launch is live
 * either way. Fee read live (`feeWei`, `pendingFee`), exact approval,
 * simulate-then-send, receipt status checked (`useTx`).
 *
 * BENEFICIARY. A token lock pays only when its beneficiary itself calls
 * `claim(lockId, to)`. A Team split cannot make that call, so naming one would
 * strand the lock forever: refused, with the alternative (stay the
 * beneficiary, claim to the split's address).
 */

import { readLaunchAllocation } from "@gullylabs/core-sdk";
import {
  GULLYCORE_TOKEN_LOCK_ABI,
  buildErc20Approve,
  buildTokenLock,
  readChainNow,
  readErc20Allowance,
  validateTokenLock,
} from "@gullylabs/core-sdk/lock";
import { useMemo, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { decodeEventLog, erc20Abi, formatUnits, parseUnits, type Abi, type Address, type Hex } from "viem";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "../lib/client";
import { shortAddress } from "../lib/format";
import { addressOrNull, unixToUtcInput, utcInputToUnix } from "../lib/forms";
import { useTx } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { isFactorySplit, readUtilityFee } from "../lib/utilities";
import { Async, NotDeployed } from "./States";
import { TxStatus, UtilityFee } from "./Utility";

const ABIS: readonly Abi[] = [GULLYCORE_TOKEN_LOCK_ABI as Abi, erc20Abi as Abi];
const DAY = 86_400n;

export function VestAllocation(props: {
  token: Address;
  symbol: string;
  decimals: number;
  kit: Address;
  launchTx: Hex;
  totalSupply: bigint;
  seedSupply: bigint;
}): ReactElement {
  const cfg = resolveConfig();
  const lock = cfg.utilities.tokenLock;
  if (lock === null) {
    return <NotDeployed what="Vesting (the token lock)" contract="GullyCoreTokenLock" chainName={cfg.core.name} chainId={cfg.core.chainId} />;
  }
  return <VestForm {...props} lock={lock} vault={cfg.contracts.vault} />;
}

function VestForm(p: {
  token: Address;
  symbol: string;
  decimals: number;
  kit: Address;
  launchTx: Hex;
  totalSupply: bigint;
  seedSupply: bigint;
  lock: Address;
  vault: Address;
}): ReactElement {
  const tx = useTx(ABIS);
  const account = tx.account;
  const [amountText, setAmountText] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [startText, setStartText] = useState("");
  const [cliffDays, setCliffDays] = useState("90");
  const [durationDays, setDurationDays] = useState("365");
  const [nonce, setNonce] = useState(0);
  const [lockedId, setLockedId] = useState<bigint | null>(null);

  const base = useAsync(async () => {
    const [allocation, terms, now] = await Promise.all([
      readLaunchAllocation(publicClient(), { txHash: p.launchTx, token: p.token, kit: p.kit, vault: p.vault, totalSupply: p.totalSupply, seedSupply: p.seedSupply }),
      readUtilityFee(p.lock),
      readChainNow(publicClient()),
    ]);
    return { allocation, terms, now };
  }, [p.launchTx, p.lock, nonce]);
  const held = useAsync(async () => (account === undefined ? null : publicClient().readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [account] })), [account, p.token, nonce]);
  const allowance = useAsync(async () => (account === undefined ? null : readErc20Allowance(publicClient(), p.token, account, p.lock)), [account, p.token, p.lock, nonce]);
  const who = beneficiary.trim() === "" ? (account ?? "") : beneficiary.trim();
  const benCheck = useAsync(async () => {
    const b = addressOrNull(who);
    if (b === null) return null;
    const code = await publicClient().getCode({ address: b });
    const isContract = code !== undefined && code !== "0x";
    return { isContract, isSplit: isContract ? await isFactorySplit(b) : false };
  }, [who]);

  const built = useMemo(() => {
    if (base.state.status !== "ready") return null;
    const { allocation, terms, now } = base.state.data;
    const issues: string[] = [];
    let amount: bigint | null = null;
    try {
      amount = amountText.trim() === "" ? (allocation?.amount ?? null) : parseUnits(amountText.trim(), p.decimals);
    } catch {
      issues.push(`The amount must be a decimal number of ${p.symbol}.`);
    }
    const start = startText === "" ? (now / 60n) * 60n : utcInputToUnix(startText);
    const cliff = /^\d+$/.test(cliffDays.trim()) ? BigInt(cliffDays.trim()) * DAY : null;
    const duration = /^\d+$/.test(durationDays.trim()) ? BigInt(durationDays.trim()) * DAY : null;
    if (start === null || cliff === null || duration === null || duration === 0n) issues.push("Enter a start (UTC), a cliff and a duration in whole days (duration above zero).");
    const schedule = start !== null && cliff !== null && duration !== null ? { start, cliff: start + cliff, end: start + duration } : null;
    if (benCheck.state.status === "ready" && benCheck.state.data?.isSplit === true) {
      issues.push("A Team split cannot be the beneficiary: a token lock pays only when its beneficiary calls claim itself, and a split cannot, so the lock would be stranded forever. Stay the beneficiary and claim to the split's address.");
    }
    if (benCheck.state.status !== "ready") issues.push("Checking the beneficiary…");
    if (held.state.status === "ready" && held.state.data !== null && amount !== null && amount > held.state.data) {
      issues.push(`You hold ${formatUnits(held.state.data, p.decimals)} ${p.symbol}, less than the amount.`);
    }
    if (amount !== null && schedule !== null) {
      for (const i of validateTokenLock({ currency: p.token, amount, beneficiary: who, schedule, nowSeconds: now, lock: p.lock })) issues.push(i.message);
    }
    const to = addressOrNull(who);
    const unique = [...new Set(issues)];
    if (unique.length > 0 || amount === null || schedule === null || to === null) return { issues: unique, call: null, amount, schedule };
    return { issues: unique, call: buildTokenLock({ lock: p.lock, currency: p.token, amount, beneficiary: to, schedule, terms }), amount, schedule };
  }, [base.state, amountText, startText, cliffDays, durationDays, benCheck.state, held.state, who, p.decimals, p.symbol, p.token, p.lock]);

  const needsApproval = built?.amount != null && allowance.state.status === "ready" && allowance.state.data !== null && allowance.state.data < built.amount;

  return (
    <section className="panel" aria-labelledby="vest-h">
      <h2 id="vest-h">Vest your allocation (optional)</h2>
      <Async state={base.state} onRetry={base.reload} loadingLabel="Loading the allocation">
        {({ allocation, terms }) =>
          allocation === null || allocation.dustOnly ? (
            <p className="state">The whole supply was seeded into the locked pools, so there is no allocation to vest.</p>
          ) : (
            <>
              <p className="state-hint">
                The kit sent {formatUnits(allocation.amount, p.decimals)} {p.symbol} to <code className="mono">{shortAddress(allocation.recipient)}</code> in the launch
                transaction, as a plain balance. It makes no lock: vesting is a second transaction on <code>GullyCoreTokenLock</code>, and the launch is live either way.
                {account !== undefined && account.toLowerCase() !== allocation.recipient.toLowerCase() ? " The connected wallet is not the recipient; connect it to vest the allocation." : ""}
              </p>
              {lockedId !== null ? (
                <p className="state state-ok">
                  Lock #{lockedId.toString()} created. See it on <Link to={`/locks/token/${p.token}`}>the token&rsquo;s locks</Link>.
                </p>
              ) : (
                <form className="form" onSubmit={(e) => e.preventDefault()}>
                  <label>
                    Amount ({p.symbol}); empty = the whole allocation
                    <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" placeholder={formatUnits(allocation.amount, p.decimals)} />
                  </label>
                  <label>
                    Beneficiary; empty = you. Only it can claim (to any address).
                    <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder={account ?? "0x…"} />
                  </label>
                  <label>
                    Vesting starts at (UTC)
                    <input type="datetime-local" value={startText === "" && built?.schedule ? unixToUtcInput(built.schedule.start) : startText} onChange={(e) => setStartText(e.target.value)} />
                  </label>
                  <label>
                    Cliff, days
                    <input value={cliffDays} onChange={(e) => setCliffDays(e.target.value)} inputMode="numeric" />
                  </label>
                  <label>
                    Duration, days
                    <input value={durationDays} onChange={(e) => setDurationDays(e.target.value)} inputMode="numeric" />
                  </label>
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
                    {needsApproval && built?.amount != null ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={tx.busy}
                        onClick={() => void tx.run("Approve", buildErc20Approve({ token: p.token, spender: p.lock, amount: built.amount as bigint })).then(() => setNonce((n) => n + 1))}
                      >
                        1. Approve exactly {formatUnits(built.amount, p.decimals)} {p.symbol}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={built === null || built.call === null || needsApproval || tx.busy || account === undefined}
                      onClick={() => {
                        if (!built?.call) return;
                        void tx.run("Vest", built.call).then((r) => {
                          if (r === null) return;
                          for (const log of r.logs) {
                            if (log.address.toLowerCase() !== p.lock.toLowerCase()) continue;
                            try {
                              const e = decodeEventLog({ abi: GULLYCORE_TOKEN_LOCK_ABI, data: log.data, topics: log.topics });
                              if (e.eventName === "Locked") setLockedId(e.args.lockId);
                            } catch {
                              /* another event */
                            }
                          }
                          setNonce((n) => n + 1);
                        });
                      }}
                    >
                      {account === undefined ? "Connect a wallet" : "Simulate and vest"}
                    </button>
                  </div>
                  <TxStatus phase={tx.phase} />
                </form>
              )}
              <UtilityFee terms={terms} contract="GullyCoreTokenLock" per="lock" />
            </>
          )
        }
      </Async>
    </section>
  );
}
