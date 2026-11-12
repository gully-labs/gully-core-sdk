// SPDX-License-Identifier: MIT
/**
 * Headless swap execution: approvals, signature, confirmation.
 *
 * The integrator fee is threaded in here, not chosen here. The hook reads the
 * validated config from context and passes it to `adapter.buildSwap`, which
 * hands it to `buildSwapCall`, which encodes the `TAKE_PORTION` (or
 * `PAY_PORTION`) step. There is no code path that executes a swap while
 * dropping the fee, and none that executes one with an unvalidated fee.
 *
 * ONE BUTTON, AS FEW CONFIRMATIONS AS THE WALLET ALLOWS (owner, 2026-10-11: "I had to do 2 transactions
 * just to sell the token how can we cut it to 1?"). `execute` runs the whole plan:
 *   - the Permit2 grant to the router is a SIGNATURE carried in the swap (`PERMIT2_PERMIT`) wherever the
 *     wallet signs typed data; a `Permit2.approve` transaction only where it cannot;
 *   - the one-time `token.approve(Permit2)` (at the maximum, so it is asked once per token per wallet)
 *     goes in ONE EIP-5792 atomic batch with the swap where the wallet supports it, else it is sent and
 *     mined first and the swap follows in the same click;
 *   - every transaction is still built, verified and simulated before the wallet sees it (a batch is
 *     simulated as a batch by the host, or not sent as one).
 * `plan` names the stages ahead (`allow`, `grant`, `sign`, `swap`) and `batched` whether the
 * transactions among them go as one confirmation, so the UI can say "Approve and swap" or show
 * "1 · Allow DTC once  2 · Swap".
 */

import { useCallback, useMemo, useState } from "react";
import type { Hex } from "viem";
import type {
  ApprovalRequirement,
  ProtocolAdapter,
  SwapQuoteResult,
  TokenInfo,
  WidgetTransactionRequest,
} from "../adapters/protocol.js";
import { BatchUnavailableError, WalletNotConnectedError } from "../adapters/protocol.js";
import type { SignedPermit } from "../callpath/permit2.js";
import { chainDeadline } from "../config/chain.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import { describeError } from "../core/errors.js";
import type { QuoteBreakdown } from "../core/math.js";
import { useAsyncResource } from "./useAsyncResource.js";

/** Where a swap is in its lifecycle. */
export type SwapExecutionStep =
  | "idle"
  | "needs-approval"
  | "approving"
  | "signing"
  | "building"
  | "awaiting-signature"
  | "pending"
  | "success"
  | "error";

/**
 * One stage of a swap's plan: `allow` the one-time ERC-20 approval of Permit2 (a transaction), `grant`
 * Permit2's allowance to the router as a TRANSACTION (only where the wallet cannot sign it), `sign` the
 * same grant as a signature carried in the swap, `swap` the swap itself.
 */
export type SwapStage = "allow" | "grant" | "sign" | "swap";

/** The stages ahead, from the approvals still outstanding and what the wallet can do. Pure; tested. */
export function planSwapStages(approvals: readonly ApprovalRequirement[], canSign: boolean): readonly SwapStage[] {
  const stages: SwapStage[] = [];
  if (approvals.some((a) => a.kind === "erc20-to-permit2")) stages.push("allow");
  if (approvals.some((a) => a.kind === "permit2-to-router")) stages.push(canSign ? "sign" : "grant");
  stages.push("swap");
  return stages;
}

/**
 * Runs a swap's plan up to the SENT swap and returns its hash (the caller waits for it): approvals read
 * afresh, the Permit2 grant signed where the wallet can (else a transaction), the swap built with the
 * permit, then the approvals and the swap as ONE atomic batch where the wallet takes one, else one by
 * one with each approval mined before the swap is sent. Exported so the flow is tested without a DOM.
 */
export async function runSwapPlan(o: {
  readonly adapter: ProtocolAdapter;
  readonly tokenIn: TokenInfo;
  readonly owner: `0x${string}`;
  readonly amountIn: bigint;
  readonly buildSwap: (permit: SignedPermit | undefined) => Promise<WidgetTransactionRequest>;
  readonly onStage?: (stage: SwapStage, step: SwapExecutionStep) => void;
}): Promise<Hex> {
  const { adapter } = o;
  const fresh = await adapter.getApprovalRequirements(o.tokenIn, o.owner, o.amountIn);
  const canSign = adapter.canSignPermit2?.() === true && adapter.signPermit2 !== undefined;
  const allowReq = fresh.find((a) => a.kind === "erc20-to-permit2");
  const grantReq = fresh.find((a) => a.kind === "permit2-to-router");

  let permit: SignedPermit | undefined;
  if (grantReq !== undefined && canSign) {
    o.onStage?.("sign", "signing");
    permit = await adapter.signPermit2!(grantReq);
  }
  const approvalTxs: WidgetTransactionRequest[] = [];
  if (allowReq !== undefined) approvalTxs.push(await adapter.buildApproval(allowReq));
  if (grantReq !== undefined && permit === undefined) approvalTxs.push(await adapter.buildApproval(grantReq));

  o.onStage?.("swap", "building");
  const transaction = await o.buildSwap(permit);

  /* One confirmation where the wallet batches atomically: the approvals and the swap together. */
  if (approvalTxs.length > 0 && adapter.sendBatch !== undefined && (await adapter.supportsAtomicBatch?.()) === true) {
    o.onStage?.("swap", "awaiting-signature");
    try {
      return await adapter.sendBatch([...approvalTxs, transaction]);
    } catch (cause: unknown) {
      if (!(cause instanceof BatchUnavailableError)) throw cause;
      // Not as a batch: one by one below.
    }
  }
  for (let i = 0; i < approvalTxs.length; i++) {
    o.onStage?.(i === 0 && allowReq !== undefined ? "allow" : "grant", "approving");
    const approvalHash = await adapter.sendTransaction(approvalTxs[i]!);
    const mined = await adapter.waitForTransaction(approvalHash);
    if (mined.status === "reverted") throw new Error(`The approval was mined but reverted (${approvalHash}).`);
  }
  o.onStage?.("swap", "awaiting-signature");
  return adapter.sendTransaction(transaction);
}

/** Parameters for {@link useSwapExecute}. */
export interface UseSwapExecuteParams {
  readonly tokenIn: TokenInfo | null;
  readonly tokenOut: TokenInfo | null;
  readonly amountIn: bigint | null;
  readonly quote: SwapQuoteResult | null;
  readonly breakdown: QuoteBreakdown | null;
  /** Defaults to the connected account. */
  readonly recipient?: `0x${string}`;
  /** Called once the swap transaction confirms. */
  readonly onSuccess?: (hash: Hex) => void;
  readonly onError?: (error: Error) => void;
}

/** Result of {@link useSwapExecute}. */
export interface UseSwapExecuteResult {
  readonly step: SwapExecutionStep;
  readonly error: Error | null;
  readonly txHash: Hex | null;
  readonly approvals: readonly ApprovalRequirement[];
  /** An approval TRANSACTION is still needed before (or batched with) the swap. */
  readonly needsApproval: boolean;
  /** The stages `execute` will run, in order. */
  readonly plan: readonly SwapStage[];
  /** `true` when the plan's transactions go to the wallet as ONE atomic batch (one confirmation). */
  readonly batched: boolean;
  /** The stage running now, while `execute` is busy; `null` otherwise. */
  readonly stage: SwapStage | null;
  readonly canExecute: boolean;
  /** One-line description of the current state, suitable for `aria-live`. */
  readonly statusMessage: string;
  /** The built transaction, exposed so a host can inspect or simulate it. */
  readonly preparedTransaction: WidgetTransactionRequest | null;
  approve(): Promise<void>;
  execute(): Promise<void>;
  reset(): void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Drives the approve-then-swap flow. */
export function useSwapExecute(params: UseSwapExecuteParams): UseSwapExecuteResult {
  const { adapter, chain, integrator } = useWidgetContext();
  const { tokenIn, tokenOut, amountIn, quote, breakdown } = params;

  const [step, setStep] = useState<SwapExecutionStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [prepared, setPrepared] = useState<WidgetTransactionRequest | null>(null);
  const [approvalToken, setApprovalToken] = useState(0);

  const accountResource = useAsyncResource(
    useCallback(() => adapter.getAccount(), [adapter]),
    [adapter],
  );
  const account = accountResource.data;

  const approvalLoader = useCallback(async (): Promise<readonly ApprovalRequirement[]> => {
    if (tokenIn === null || amountIn === null || account === null) return [];
    return adapter.getApprovalRequirements(tokenIn, account, amountIn);
  }, [adapter, tokenIn, amountIn, account]);

  const approvalResource = useAsyncResource<readonly ApprovalRequirement[]>(
    approvalLoader,
    [
      adapter,
      tokenIn?.address ?? null,
      amountIn === null ? null : amountIn.toString(),
      account,
      approvalToken,
    ],
    { enabled: tokenIn !== null && amountIn !== null && amountIn > 0n && account !== null },
  );

  const approvals = approvalResource.data ?? [];
  const canSign = adapter.canSignPermit2?.() === true && adapter.signPermit2 !== undefined;
  const plan = useMemo(() => planSwapStages(approvals, canSign), [approvals, canSign]);
  const needsApproval = plan.includes("allow") || plan.includes("grant");
  const batchResource = useAsyncResource(
    useCallback(async () => (adapter.supportsAtomicBatch === undefined ? false : adapter.supportsAtomicBatch()), [adapter]),
    [adapter, account],
    { enabled: account !== null && account !== undefined },
  );
  const batched = needsApproval && batchResource.data === true && adapter.sendBatch !== undefined;
  const [stage, setStage] = useState<SwapStage | null>(null);

  const canExecute =
    tokenIn !== null &&
    tokenOut !== null &&
    amountIn !== null &&
    amountIn > 0n &&
    quote !== null &&
    breakdown !== null &&
    account !== null &&
    approvalResource.status !== "loading" &&
    (step === "idle" || step === "error" || step === "success");

  const approve = useCallback(async (): Promise<void> => {
    const next = approvals[0];
    if (next === undefined) return;
    setError(null);
    setStep("approving");
    try {
      const transaction = await adapter.buildApproval(next);
      const hash = await adapter.sendTransaction(transaction);
      await adapter.waitForTransaction(hash);
      setApprovalToken((token) => token + 1);
      setStep("idle");
    } catch (cause: unknown) {
      const wrapped = toError(cause);
      setError(wrapped);
      setStep("error");
      params.onError?.(wrapped);
    }
  }, [adapter, approvals, params]);

  const execute = useCallback(async (): Promise<void> => {
    if (tokenIn === null || tokenOut === null || amountIn === null) return;
    if (quote === null || breakdown === null) return;
    if (account === null) {
      const wrapped = new WalletNotConnectedError("swap");
      setError(wrapped);
      setStep("error");
      params.onError?.(wrapped);
      return;
    }

    setError(null);
    setTxHash(null);
    try {
      const hash = await runSwapPlan({
        adapter,
        tokenIn,
        owner: account,
        amountIn,
        buildSwap: async (permit) => {
          const transaction = await adapter.buildSwap({
            quote,
            tokenIn,
            tokenOut,
            amountIn,
            minAmountOutGross: breakdown.minAmountOutGross,
            minAmountOutNet: breakdown.minAmountOutNet,
            // The validated config from context. Never a raw prop.
            integrator,
            recipient: params.recipient ?? account,
            deadline: await chainDeadline(chain, adapter),
            ...(permit === undefined ? {} : { permit }),
          });
          setPrepared(transaction);
          return transaction;
        },
        onStage: (st, sp) => {
          setStage(st);
          setStep(sp);
        },
      });
      setTxHash(hash);

      setStep("pending");
      const outcome = await adapter.waitForTransaction(hash);
      if (outcome.status === "reverted") {
        throw new Error(`The swap was mined but reverted (${hash}).`);
      }
      setApprovalToken((token) => token + 1);
      setStage(null);
      setStep("success");
      params.onSuccess?.(hash);
    } catch (cause: unknown) {
      const wrapped = toError(cause);
      setStage(null);
      setApprovalToken((token) => token + 1);
      setError(wrapped);
      setStep("error");
      params.onError?.(wrapped);
    }
  }, [
    adapter,
    account,
    amountIn,
    breakdown,
    chain,
    integrator,
    params,
    quote,
    tokenIn,
    tokenOut,
  ]);

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setTxHash(null);
    setPrepared(null);
  }, []);

  const effectiveStep: SwapExecutionStep =
    step === "idle" && needsApproval ? "needs-approval" : step;

  const statusMessage = useMemo(
    () => describeStep(effectiveStep, approvals[0], error, adapter.isMock, tokenIn?.symbol ?? ""),
    [effectiveStep, approvals, error, adapter.isMock, tokenIn],
  );

  return {
    step: effectiveStep,
    error,
    txHash,
    approvals,
    needsApproval,
    plan,
    batched,
    stage,
    canExecute,
    statusMessage,
    preparedTransaction: prepared,
    approve,
    execute,
    reset,
  };
}

function describeStep(
  step: SwapExecutionStep,
  pending: ApprovalRequirement | undefined,
  error: Error | null,
  isMock: boolean,
  symbol: string,
): string {
  const mockPrefix = isMock ? "Simulated (mock adapter): " : "";
  switch (step) {
    case "idle":
      return "";
    case "needs-approval":
      return pending === undefined ? "Approval required" : `${pending.token.symbol} is allowed once per wallet; after that every swap is one transaction`;
    case "approving":
      return `${mockPrefix}Allowing ${symbol} once: waiting for the approval to confirm`;
    case "signing":
      return `${mockPrefix}Sign the ${symbol} allowance in your wallet (a signature, no gas)`;
    case "building":
      return `${mockPrefix}Preparing the swap transaction`;
    case "awaiting-signature":
      return `${mockPrefix}Confirm the transaction in your wallet`;
    case "pending":
      return `${mockPrefix}Swap submitted, waiting for confirmation`;
    case "success":
      return `${mockPrefix}Swap confirmed`;
    case "error":
      return error === null ? "Something went wrong" : describeError(error, "swap");
    default:
      return "";
  }
}
