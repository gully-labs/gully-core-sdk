// SPDX-License-Identifier: MIT
/**
 * Headless liquidity provision, for both pool types.
 *
 * The pool-type difference lives entirely in the {@link LiquidityRange} union
 * and in {@link ../callpath/liquidity.js}. Everything a UI touches here - the
 * range editor state, the quote, the execution state machine - is identical for
 * concentrated liquidity and for the liquidity book.
 */

import { useCallback, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import type {
  AddLiquidityQuote,
  ApprovalRequirement,
  LiquidityRange,
  PoolInfo,
  PositionInfo,
  RemoveLiquidityQuote,
  TokenInfo,
} from "../adapters/protocol.js";
import { WalletNotConnectedError } from "../adapters/protocol.js";
import { chainDeadline } from "../config/chain.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import { describeError } from "../core/errors.js";
import { InsufficientBalanceError, depositRequirements, findShortfall } from "../core/liquidityGuards.js";
import { ceilTickToSpacing, floorTickToSpacing, maximumSpent, minimumReceived } from "../core/math.js";
import { tickSpacingOf } from "../core/pool.js";
import { useAsyncResource, type AsyncResource, type AsyncStatus } from "./useAsyncResource.js";

/** Lifecycle of a liquidity transaction. */
export type LiquidityExecutionStep =
  | "idle"
  | "needs-approval"
  | "approving"
  | "building"
  | "awaiting-signature"
  | "pending"
  | "success"
  | "error";

/** Builds a default range around the pool's current position. */
export function defaultRangeFor(
  pool: PoolInfo,
  currentTick: number | null,
  activeId: number | null,
  widthFactor = 10,
): LiquidityRange | null {
  if (pool.poolType === "CL") {
    const spacing = tickSpacingOf(pool);
    if (currentTick === null) return null;
    const halfWidth = spacing * widthFactor;
    return {
      type: "CL",
      tickLower: floorTickToSpacing(currentTick - halfWidth, spacing),
      tickUpper: ceilTickToSpacing(currentTick + halfWidth, spacing),
    };
  }
  if (activeId === null) return null;
  return {
    type: "BIN",
    activeIdDesired: activeId,
    binIdLower: activeId - widthFactor,
    binIdUpper: activeId + widthFactor,
    idSlippage: 5,
  };
}

/** Widens or narrows a range symmetrically, respecting the pool's granularity. */
export function adjustRange(
  range: LiquidityRange,
  pool: PoolInfo,
  deltaSteps: number,
): LiquidityRange {
  if (range.type === "CL") {
    const spacing = tickSpacingOf(pool);
    const lower = range.tickLower - deltaSteps * spacing;
    const upper = range.tickUpper + deltaSteps * spacing;
    if (lower >= upper) return range;
    return { type: "CL", tickLower: lower, tickUpper: upper };
  }
  const lower = range.binIdLower - deltaSteps;
  const upper = range.binIdUpper + deltaSteps;
  if (lower > upper) return range;
  return { ...range, binIdLower: lower, binIdUpper: upper };
}

/** Human-readable description of a range, for labels and summaries. */
export function describeRange(range: LiquidityRange): string {
  if (range.type === "CL") {
    return `Ticks ${range.tickLower} to ${range.tickUpper}`;
  }
  const count = range.binIdUpper - range.binIdLower + 1;
  return `Bins ${range.binIdLower} to ${range.binIdUpper} (${count} bins, active ${range.activeIdDesired})`;
}

/** Parameters for {@link useAddLiquidityQuote}. */
export interface UseAddLiquidityQuoteParams {
  readonly pool: PoolInfo | null;
  readonly range: LiquidityRange | null;
  readonly amount0Desired: bigint | null;
  readonly amount1Desired: bigint | null;
  readonly enabled?: boolean;
}

/** Quotes an add-liquidity operation. */
export function useAddLiquidityQuote(
  params: UseAddLiquidityQuoteParams,
): AsyncResource<AddLiquidityQuote | null> & { readonly isMock: boolean } {
  const { adapter } = useWidgetContext();
  const { pool, range, amount0Desired, amount1Desired } = params;

  const enabled =
    (params.enabled ?? true) &&
    pool !== null &&
    range !== null &&
    (amount0Desired ?? 0n) + (amount1Desired ?? 0n) > 0n;

  const loader = useCallback(async (): Promise<AddLiquidityQuote | null> => {
    if (pool === null || range === null) return null;
    return adapter.quoteAddLiquidity({
      pool,
      range,
      amount0Desired: amount0Desired ?? 0n,
      amount1Desired: amount1Desired ?? 0n,
    });
  }, [adapter, pool, range, amount0Desired, amount1Desired]);

  const resource = useAsyncResource<AddLiquidityQuote | null>(
    loader,
    [
      adapter,
      pool?.id ?? null,
      range === null ? null : JSON.stringify(range),
      amount0Desired?.toString() ?? null,
      amount1Desired?.toString() ?? null,
    ],
    { enabled },
  );

  return { ...resource, isMock: adapter.isMock };
}

/** Result of {@link useAddLiquidityExecute}. */
export interface UseLiquidityExecuteResult {
  readonly step: LiquidityExecutionStep;
  readonly error: Error | null;
  readonly txHash: Hex | null;
  readonly approvals: readonly ApprovalRequirement[];
  readonly needsApproval: boolean;
  /**
   * The token the wallet holds too little of for this deposit, or `null` when
   * every balance covers it (or has not been read yet). While set, neither an
   * approval nor the deposit is offered: `approve` and `execute` re-read the
   * balances and refuse with `InsufficientBalanceError` before anything is signed.
   */
  readonly insufficient: TokenInfo | null;
  readonly statusMessage: string;
  approve(): Promise<void>;
  execute(): Promise<void>;
  reset(): void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Parameters for {@link useAddLiquidityExecute}. */
export interface UseAddLiquidityExecuteParams {
  readonly quote: AddLiquidityQuote | null;
  /** Slippage applied to the deposited amounts, in bps. */
  readonly slippageBps?: number;
  readonly recipient?: Address;
  readonly hookData?: Hex;
  readonly onSuccess?: (hash: Hex) => void;
}

/** Drives approve-then-add-liquidity for either pool type. */
export function useAddLiquidityExecute(
  params: UseAddLiquidityExecuteParams,
): UseLiquidityExecuteResult {
  const { adapter, chain, integrator, defaultSlippageBps } = useWidgetContext();
  const { quote } = params;
  const slippageBps = params.slippageBps ?? defaultSlippageBps;

  const [step, setStep] = useState<LiquidityExecutionStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [approvalToken, setApprovalToken] = useState(0);

  const accountResource = useAsyncResource(
    useCallback(() => adapter.getAccount(), [adapter]),
    [adapter],
  );
  const account = accountResource.data;

  const amounts = useMemo(() => {
    if (quote === null) return null;
    return {
      amount0Max: maximumSpent(quote.amount0, slippageBps),
      amount1Max: maximumSpent(quote.amount1, slippageBps),
    };
  }, [quote, slippageBps]);

  /* What the deposit takes from the wallet, and whether the wallet holds it.
     Read BEFORE an approval or a deposit is offered, so a wallet that cannot
     pay sees "Insufficient <SYMBOL>" instead of an approval it does not need
     and a gas estimate failing with TRANSFER_FROM_FAILED. See core/liquidityGuards. */
  const requirements = useMemo(
    () => (quote === null || amounts === null ? [] : depositRequirements(quote, amounts.amount0Max, amounts.amount1Max)),
    [quote, amounts],
  );
  const requirementsKey = requirements.map((r) => `${r.token.address}:${r.required.toString()}`).join(",");
  const readShortfall = useCallback(async (): Promise<TokenInfo | null> => {
    if (account === null || requirements.length === 0) return null;
    const balances = await Promise.all(requirements.map((r) => adapter.getBalance(r.token, account)));
    return findShortfall(requirements, balances);
  }, [adapter, account, requirements]);
  const shortfallResource = useAsyncResource<TokenInfo | null>(
    readShortfall,
    [adapter, account, requirementsKey, approvalToken],
    { enabled: account !== null && requirements.length > 0, refetchIntervalMs: 30_000 },
  );
  const insufficient = requirements.length === 0 || account === null ? null : (shortfallResource.data ?? null);
  const refetchShortfall = shortfallResource.refetch;

  /* The deposit is pulled by the POSITION MANAGER, not the router, so that is
     the Permit2 spender the allowance has to name. */
  const approvalLoader = useCallback(async (): Promise<readonly ApprovalRequirement[]> => {
    if (quote === null || account === null || amounts === null) return [];
    const spender = quote.pool.poolType === "CL" ? chain.contracts.clPositionManager : chain.contracts.binPositionManager;
    const [first, second] = await Promise.all([
      adapter.getApprovalRequirements(quote.pool.token0, account, amounts.amount0Max, spender),
      adapter.getApprovalRequirements(quote.pool.token1, account, amounts.amount1Max, spender),
    ]);
    return [...first, ...second];
  }, [adapter, chain, quote, account, amounts]);

  const approvalResource = useAsyncResource<readonly ApprovalRequirement[]>(
    approvalLoader,
    [adapter, quote?.pool.id ?? null, account, amounts?.amount0Max.toString() ?? null, approvalToken],
    { enabled: quote !== null && account !== null },
  );
  const approvals = approvalResource.data ?? [];

  const approve = useCallback(async (): Promise<void> => {
    const next = approvals[0];
    if (next === undefined) return;
    setError(null);
    setStep("approving");
    try {
      /* Re-read at the moment of signing: never approve for a deposit the wallet cannot pay. */
      const short = await readShortfall();
      if (short !== null) {
        refetchShortfall();
        throw new InsufficientBalanceError(short);
      }
      const transaction = await adapter.buildApproval(next);
      const hash = await adapter.sendTransaction(transaction);
      await adapter.waitForTransaction(hash);
      setApprovalToken((token) => token + 1);
      setStep("idle");
    } catch (cause: unknown) {
      setError(toError(cause));
      setStep("error");
    }
  }, [adapter, approvals, readShortfall, refetchShortfall]);

  const execute = useCallback(async (): Promise<void> => {
    if (quote === null || amounts === null) return;
    if (account === null) {
      setError(new WalletNotConnectedError("add liquidity"));
      setStep("error");
      return;
    }
    setError(null);
    setStep("building");
    try {
      const short = await readShortfall();
      if (short !== null) {
        refetchShortfall();
        throw new InsufficientBalanceError(short);
      }
      const transaction = await adapter.buildAddLiquidity({
        quote,
        amount0Max: amounts.amount0Max,
        amount1Max: amounts.amount1Max,
        recipient: params.recipient ?? account,
        deadline: await chainDeadline(chain, adapter),
        integrator,
        ...(params.hookData ? { hookData: params.hookData } : {}),
      });
      setStep("awaiting-signature");
      const hash = await adapter.sendTransaction(transaction);
      setTxHash(hash);
      setStep("pending");
      const outcome = await adapter.waitForTransaction(hash);
      if (outcome.status === "reverted") throw new Error(`The transaction was mined but reverted (${hash}).`);
      setStep("success");
      /* The deposit spent balance and allowance: re-read both. */
      setApprovalToken((token) => token + 1);
      params.onSuccess?.(hash);
    } catch (cause: unknown) {
      setError(toError(cause));
      setStep("error");
    }
  }, [adapter, account, amounts, chain, integrator, params, quote, readShortfall, refetchShortfall]);

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setTxHash(null);
  }, []);

  const effectiveStep: LiquidityExecutionStep =
    step === "idle" && approvals.length > 0 && insufficient === null ? "needs-approval" : step;

  return {
    step: effectiveStep,
    error,
    txHash,
    approvals,
    needsApproval: approvals.length > 0,
    insufficient,
    statusMessage: describeLiquidityStep(effectiveStep, approvals[0], error, adapter.isMock),
    approve,
    execute,
    reset,
  };
}

/**
 * Positions held by `owner`, optionally filtered to one pool. `refreshKey`
 * re-reads the list whenever it changes: pass a counter the host advances on
 * every confirmed add or removal (the LiquidityWidget does), so an emptied
 * position disappears and amounts update without a reload.
 */
export function usePositions(
  owner: Address | null,
  pool?: PoolInfo | null,
  refreshKey: unknown = 0,
): AsyncResource<readonly PositionInfo[]> {
  const { adapter } = useWidgetContext();
  const loader = useCallback(async (): Promise<readonly PositionInfo[]> => {
    if (owner === null) return [];
    return pool === null || pool === undefined
      ? adapter.listPositions(owner)
      : adapter.listPositions(owner, pool);
  }, [adapter, owner, pool]);
  return useAsyncResource(loader, [adapter, owner, pool?.id ?? null, refreshKey], {
    enabled: owner !== null,
  });
}

/** Parameters for {@link useRemoveLiquidity}. */
export interface UseRemoveLiquidityParams {
  readonly position: PositionInfo | null;
  /** Fraction to withdraw, in bps. */
  readonly percentBps: number;
  readonly slippageBps?: number;
  readonly recipient?: Address;
  readonly onSuccess?: (hash: Hex) => void;
}

/** Result of {@link useRemoveLiquidity}. */
export interface UseRemoveLiquidityResult {
  readonly quote: RemoveLiquidityQuote | null;
  readonly quoteStatus: AsyncStatus;
  readonly step: LiquidityExecutionStep;
  readonly error: Error | null;
  readonly txHash: Hex | null;
  readonly statusMessage: string;
  execute(): Promise<void>;
  reset(): void;
}

/** Quotes and executes a withdrawal from either pool type. */
export function useRemoveLiquidity(
  params: UseRemoveLiquidityParams,
): UseRemoveLiquidityResult {
  const { adapter, chain, integrator, defaultSlippageBps } = useWidgetContext();
  const { position, percentBps } = params;
  const slippageBps = params.slippageBps ?? defaultSlippageBps;

  const [step, setStep] = useState<LiquidityExecutionStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);

  const loader = useCallback(async (): Promise<RemoveLiquidityQuote | null> => {
    if (position === null) return null;
    return adapter.quoteRemoveLiquidity(position, percentBps);
  }, [adapter, position, percentBps]);

  const resource = useAsyncResource<RemoveLiquidityQuote | null>(
    loader,
    /* Keyed on the position RECORD, not its id: after a partial removal the
       re-read list hands over a new record with less liquidity, and the quote
       must follow it rather than keep pricing the old one. */
    [adapter, position, percentBps],
    { enabled: position !== null && percentBps > 0 },
  );

  const execute = useCallback(async (): Promise<void> => {
    const quote = resource.data;
    if (position === null || quote === null) return;
    const account = await adapter.getAccount();
    if (account === null) {
      setError(new WalletNotConnectedError("remove liquidity"));
      setStep("error");
      return;
    }
    setError(null);
    setStep("building");
    try {
      const transaction = await adapter.buildRemoveLiquidity({
        position,
        percentBps,
        amount0Min: minimumReceived(quote.amount0, slippageBps),
        amount1Min: minimumReceived(quote.amount1, slippageBps),
        recipient: params.recipient ?? account,
        deadline: await chainDeadline(chain, adapter),
        integrator,
      });
      setStep("awaiting-signature");
      const hash = await adapter.sendTransaction(transaction);
      setTxHash(hash);
      setStep("pending");
      const outcome = await adapter.waitForTransaction(hash);
      if (outcome.status === "reverted") throw new Error(`The transaction was mined but reverted (${hash}).`);
      setStep("success");
      params.onSuccess?.(hash);
    } catch (cause: unknown) {
      setError(toError(cause));
      setStep("error");
    }
  }, [adapter, chain, integrator, params, percentBps, position, resource.data, slippageBps]);

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setTxHash(null);
  }, []);

  return {
    quote: resource.data,
    quoteStatus: resource.status,
    step,
    error,
    txHash,
    statusMessage: describeLiquidityStep(step, undefined, error, adapter.isMock),
    execute,
    reset,
  };
}

function describeLiquidityStep(
  step: LiquidityExecutionStep,
  pending: ApprovalRequirement | undefined,
  error: Error | null,
  isMock: boolean,
): string {
  const mockPrefix = isMock ? "Simulated (mock adapter): " : "";
  switch (step) {
    case "idle":
      return "";
    case "needs-approval":
      return pending === undefined
        ? "Approval required"
        : `Approve ${pending.token.symbol} before continuing`;
    case "approving":
      return `${mockPrefix}Waiting for the approval to confirm`;
    case "building":
      return `${mockPrefix}Preparing the transaction`;
    case "awaiting-signature":
      return `${mockPrefix}Confirm the transaction in your wallet`;
    case "pending":
      return `${mockPrefix}Submitted, waiting for confirmation`;
    case "success":
      return `${mockPrefix}Confirmed`;
    case "error":
      return error === null ? "Something went wrong" : describeError(error, "liquidity");
    default:
      return "";
  }
}
