// SPDX-License-Identifier: MIT
/**
 * Sending a transaction the way every screen in this app does it:
 *
 *   1. **Simulate the exact bytes** with `eth_call` from the connected account.
 *      A call that would revert is stopped here, with the contract's own error
 *      decoded, and the wallet is never asked.
 *   2. **Send those same bytes** (`to`, `data`, `value`), nothing added.
 *   3. **Wait for the receipt** and report a revert on chain as a failure, not
 *      as "submitted".
 *
 * Error decoding: a revert carries the contract's custom error as raw bytes.
 * `describeError` decodes them against the ABIs the caller names (the utility
 * contracts' own, from `@gullylabs/core-sdk`), so the screen says
 * `InsufficientFee()` rather than "execution reverted", and adds a sentence on
 * what to do where one is known.
 */

import { useCallback, useState } from "react";
import { BaseError, UserRejectedRequestError, decodeErrorResult, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { publicClient } from "./client";

/** One transaction, exactly as it will be sent. Builders from the SDK return this shape. */
export interface TxRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** What a known custom error means for the person who hit it. Keyed by error name. */
export const ERROR_HINTS: Readonly<Record<string, string>> = {
  InsufficientFee: "The fee rose between the read and the send. Reload the page to read the new fee.",
  InsufficientSplitFee: "The creation fee rose between the read and the send. Reload the page to read the new fee.",
  ProtocolShareAboveLimit: "The protocol share rose above the one you were shown. Reload to read it again.",
  NativeValueTooLow: "The value sent does not cover the amounts plus the fee.",
  NativeValueMismatch: "The value sent does not equal the amount plus the fee.",
  ERC20InsufficientAllowance: "Approve the exact amount first.",
  ERC20InsufficientBalance: "This wallet does not hold enough of the token.",
  AlreadyClaimed: "This claim has already been paid.",
  InvalidProof: "The proof does not match the drop's Merkle root: the claims file is not this drop's.",
  Expired: "The drop has expired; nothing can be claimed any more.",
  NotExpired: "The drop has not expired yet; the creator can sweep only after it does.",
  ContractAccountMustClaimItself: "This account is a contract (or a delegated account): it must send its own claim.",
  NotCreator: "Only the drop's creator can do that.",
  NothingToRelease: "Nothing is owed to that payee in that currency right now.",
  NothingToClaim: "Nothing is claimable right now.",
  NotPayee: "Only the payee of a slot can do that.",
  StillLocked: "The lock has not reached its unlock date.",
  NotLockOwner: "Only the lock owner can do that.",
  NotBeneficiary: "Only the beneficiary can do that.",
  NotPositionOwner: "The connected wallet does not own that position.",
  InvalidUnlock: "The unlock date must be in the future and within the contract's maximum.",
  InvalidSchedule: "The schedule must satisfy start <= cliff <= end, end in the future.",
  NotLater: "A lock can only be extended, never shortened.",
  TooManyRecipients: "One call takes at most 1,000 recipients; the list is sent in batches.",
};

function isHexData(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length >= 10;
}

/** The raw revert bytes carried anywhere in an error's cause chain, or `null`. */
export function revertDataOf(err: unknown): Hex | null {
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { data?: unknown; raw?: unknown; cause?: unknown };
    if (isHexData(e.raw)) return e.raw;
    if (isHexData(e.data)) return e.data;
    if (e.data !== null && typeof e.data === "object" && isHexData((e.data as { data?: unknown }).data)) {
      return (e.data as { data: Hex }).data;
    }
    current = e.cause;
  }
  return null;
}

export interface DecodedRevert {
  readonly name: string;
  readonly args: readonly unknown[];
  /** `Name(arg, arg)`. */
  readonly text: string;
  readonly hint: string | null;
}

function argText(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/** Decodes revert bytes against each ABI in turn (plus `Error(string)` / `Panic`). */
export function decodeRevert(data: Hex, abis: readonly Abi[]): DecodedRevert | null {
  for (const abi of [...abis, [] as Abi]) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      const args = (decoded.args ?? []) as readonly unknown[];
      const name = decoded.errorName;
      const text = name === "Error" && typeof args[0] === "string" ? args[0] : `${name}(${args.map(argText).join(", ")})`;
      return { name, args, text, hint: ERROR_HINTS[name] ?? null };
    } catch {
      /* not in this ABI */
    }
  }
  return null;
}

/** One sentence for any failure: a rejection, a decoded revert, or viem's short message. */
export function describeError(err: unknown, abis: readonly Abi[] = []): string {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError) !== null) {
    return "You rejected the request in your wallet. Nothing was sent.";
  }
  const data = revertDataOf(err);
  if (data !== null) {
    const decoded = decodeRevert(data, abis);
    if (decoded !== null) return decoded.hint === null ? `The contract refused: ${decoded.text}.` : `The contract refused: ${decoded.text}. ${decoded.hint}`;
    return `The contract refused with an error this app cannot decode (${data.slice(0, 10)}).`;
  }
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

export type TxPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "simulating"; readonly label: string }
  | { readonly kind: "signing"; readonly label: string }
  | { readonly kind: "confirming"; readonly label: string; readonly hash: Hex }
  | { readonly kind: "done"; readonly label: string; readonly hash: Hex; readonly receipt: TransactionReceipt }
  | { readonly kind: "failed"; readonly label: string; readonly message: string };

export interface TxRunner {
  readonly phase: TxPhase;
  readonly busy: boolean;
  readonly account: Address | undefined;
  /** Simulate, send, wait. Resolves the receipt, or `null` when anything failed (the phase says why). */
  readonly run: (label: string, request: TxRequest) => Promise<TransactionReceipt | null>;
  /** Simulate only: `null` when the call would succeed, else the reason. */
  readonly simulate: (request: TxRequest) => Promise<string | null>;
  readonly reset: () => void;
}

/** The simulate → send → confirm runner, with errors decoded against `abis`. */
export function useTx(abis: readonly Abi[]): TxRunner {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });

  const simulate = useCallback(
    async (request: TxRequest): Promise<string | null> => {
      if (address === undefined) return "Connect a wallet first.";
      try {
        await publicClient().call({ account: address, to: request.to, data: request.data, value: request.value });
        return null;
      } catch (err) {
        return describeError(err, abis);
      }
    },
    [address, abis],
  );

  const run = useCallback(
    async (label: string, request: TxRequest): Promise<TransactionReceipt | null> => {
      if (address === undefined || walletClient === undefined) {
        setPhase({ kind: "failed", label, message: "Connect a wallet first." });
        return null;
      }
      setPhase({ kind: "simulating", label });
      const refusal = await simulate(request);
      if (refusal !== null) {
        setPhase({ kind: "failed", label, message: `Not sent — the simulation failed. ${refusal}` });
        return null;
      }
      setPhase({ kind: "signing", label });
      let hash: Hex;
      try {
        hash = await walletClient.sendTransaction({ to: request.to, data: request.data, value: request.value });
      } catch (err) {
        setPhase({ kind: "failed", label, message: describeError(err, abis) });
        return null;
      }
      setPhase({ kind: "confirming", label, hash });
      try {
        const receipt = await publicClient().waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setPhase({ kind: "failed", label, message: `The transaction was mined and reverted (${hash}).` });
          return null;
        }
        setPhase({ kind: "done", label, hash, receipt });
        return receipt;
      } catch (err) {
        setPhase({ kind: "failed", label, message: `Sent (${hash}), but the receipt could not be read: ${describeError(err, abis)}` });
        return null;
      }
    },
    [address, walletClient, abis, simulate],
  );

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);
  const busy = phase.kind === "simulating" || phase.kind === "signing" || phase.kind === "confirming";
  return { phase, busy, account: address, run, simulate, reset };
}
