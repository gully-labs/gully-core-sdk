// SPDX-License-Identifier: MIT
/**
 * Headless controllers for `LockerWidget`: the wallet, the live fees, the
 * connected wallet's locks, and a step runner that simulates every call with
 * its exact bytes before the wallet sees it and checks every receipt.
 *
 * The wallet is the same minimal surface `createViemAdapter` takes
 * (`WidgetWallet`: `getAccount` + `sendTransaction`), or, when none is passed,
 * the mounted `WidgetProvider`'s adapter. Reads, simulations and receipts go
 * through the viem `PublicClient` the host passes, on the lock contracts'
 * chain.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { Address, Hex, PublicClient } from "viem";
import {
  readBeneficiaryLocks,
  readChainNow,
  readFeeGate,
  readPositionLocksOf,
  type FeeGateTerms,
  type PositionLockRecord,
  type TokenLockView,
  type UtilityCall,
} from "@gullylabs/core-sdk/lock";

import type { WidgetWallet } from "../adapters/viem.js";
import { useOptionalWidgetContext } from "../context/WidgetProvider.js";
import { describeError } from "../core/errors.js";
import { useAsyncResource, type AsyncResource } from "./useAsyncResource.js";

/** The two lock contracts, from the host's address book. `null` = the chain has no address for it; surfaces render "coming soon". */
export interface LockerContracts {
  readonly positionLock: Address | null;
  readonly tokenLock: Address | null;
}

/** The wallet a locker signs with: the prop, else the provider's adapter, else none. */
export function useLockerWallet(wallet: WidgetWallet | undefined): WidgetWallet | null {
  const ctx = useOptionalWidgetContext();
  return useMemo(() => {
    if (wallet !== undefined) return wallet;
    const adapter = ctx?.adapter;
    if (adapter === undefined || adapter.isMock) return null;
    return {
      getAccount: () => adapter.getAccount(),
      sendTransaction: (req) => adapter.sendTransaction({ ...req, summary: "Gully Core lock", source: "live" }),
    };
  }, [wallet, ctx?.adapter]);
}

/** The connected account, re-read every few seconds so a wallet switch shows. */
export function useLockerAccount(wallet: WidgetWallet | null): AsyncResource<Address | null> {
  return useAsyncResource(() => (wallet === null ? Promise.resolve(null) : wallet.getAccount()), [wallet], { refetchIntervalMs: 4_000 });
}

export interface LockerFees {
  readonly position: FeeGateTerms | null;
  readonly token: FeeGateTerms | null;
}

/** Each lock contract's fee terms, read live (`feeWei`, `pendingFee`, cap, recipient). */
export function useLockerFees(client: PublicClient, contracts: LockerContracts): AsyncResource<LockerFees> {
  return useAsyncResource(
    async () => {
      const [position, token] = await Promise.all([
        contracts.positionLock === null ? Promise.resolve(null) : readFeeGate(client, contracts.positionLock),
        contracts.tokenLock === null ? Promise.resolve(null) : readFeeGate(client, contracts.tokenLock),
      ]);
      return { position, token };
    },
    [client, contracts.positionLock, contracts.tokenLock],
    { enabled: contracts.positionLock !== null || contracts.tokenLock !== null, refetchIntervalMs: 60_000 },
  );
}

export interface MyLocks {
  readonly positions: readonly PositionLockRecord[];
  readonly tokens: readonly TokenLockView[];
  /** The chain's `block.timestamp` when read. */
  readonly now: bigint;
}

/** Locks `account` owns or has been offered, on both contracts. */
export function useMyLocks(client: PublicClient, contracts: LockerContracts, account: Address | null): AsyncResource<MyLocks> {
  return useAsyncResource(
    async () => {
      const a = account as Address;
      const [now, positions, tokens] = await Promise.all([
        readChainNow(client),
        contracts.positionLock === null ? Promise.resolve([]) : readPositionLocksOf(client, contracts.positionLock, a),
        contracts.tokenLock === null ? Promise.resolve({ locks: [] as TokenLockView[] }) : readBeneficiaryLocks(client, contracts.tokenLock, a),
      ]);
      return { positions, tokens: tokens.locks, now };
    },
    [client, contracts.positionLock, contracts.tokenLock, account],
    { enabled: account !== null && (contracts.positionLock !== null || contracts.tokenLock !== null), refetchIntervalMs: 60_000 },
  );
}

/** Thrown when a mined transaction reverted: the receipt, not the hash, is the proof. */
export class TransactionRevertedError extends Error {
  readonly hash: Hex;
  constructor(hash: Hex) {
    super(`The transaction ${hash.slice(0, 10)}… was mined and reverted.`);
    this.name = "TransactionRevertedError";
    this.hash = hash;
  }
}

/**
 * One call: simulate with the exact bytes and value from `account`, send
 * through the wallet, wait for the receipt, and throw unless it succeeded.
 */
export async function simulateSendConfirm(client: PublicClient, wallet: WidgetWallet, account: Address, call: UtilityCall): Promise<Hex> {
  await client.call({ account, to: call.to, data: call.data, value: call.value });
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new TransactionRevertedError(hash);
  return hash;
}

export interface RunnerStep {
  readonly label: string;
  /** Built when the step starts, so it reads the chain as it is after the previous step. */
  readonly build: () => Promise<UtilityCall>;
}

export type RunnerState =
  | { readonly k: "idle" }
  | { readonly k: "running"; readonly labels: readonly string[]; readonly active: number; readonly phase: "simulating" | "signing" | "confirming" }
  | { readonly k: "done"; readonly labels: readonly string[]; readonly hashes: readonly Hex[] }
  | { readonly k: "failed"; readonly labels: readonly string[]; readonly active: number; readonly message: string };

/** Runs steps in order; the first failure stops the run and is described in one sentence. */
export function useLockerRunner(client: PublicClient, wallet: WidgetWallet | null, account: Address | null, onDone?: () => void): { state: RunnerState; run(steps: readonly RunnerStep[]): Promise<void>; reset(): void } {
  const [state, setState] = useState<RunnerState>({ k: "idle" });
  const busy = useRef(false);
  const run = useCallback(
    async (steps: readonly RunnerStep[]) => {
      if (busy.current) return;
      const labels = steps.map((s) => s.label);
      if (wallet === null || account === null) {
        setState({ k: "failed", labels, active: 0, message: "Connect a wallet first." });
        return;
      }
      busy.current = true;
      const hashes: Hex[] = [];
      let i = 0;
      try {
        for (; i < steps.length; i++) {
          setState({ k: "running", labels, active: i, phase: "simulating" });
          const call = await steps[i]!.build();
          await client.call({ account, to: call.to, data: call.data, value: call.value });
          setState({ k: "running", labels, active: i, phase: "signing" });
          const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
          setState({ k: "running", labels, active: i, phase: "confirming" });
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new TransactionRevertedError(hash);
          hashes.push(hash);
        }
        setState({ k: "done", labels, hashes });
        onDone?.();
      } catch (error) {
        setState({ k: "failed", labels, active: i, message: error instanceof TransactionRevertedError ? error.message : describeError(error, "transaction") });
      } finally {
        busy.current = false;
      }
    },
    [client, wallet, account, onDone],
  );
  const reset = useCallback(() => setState({ k: "idle" }), []);
  return { state, run, reset };
}
