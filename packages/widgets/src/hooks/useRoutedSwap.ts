// SPDX-License-Identifier: MIT
/**
 * Headless routed quotes and routed execution (see `core/routed.ts` for the rules).
 *
 * `useRoutedQuote` asks the router API for its best third-party fill while the Gully Core path quotes as it
 * always has; `chooseRoute` then keeps the Gully Core pool unless the routed fill is strictly better for
 * the user. Any failure along the way — no router configured, the API unreachable or disabled on the
 * server, a response that does not verify — leaves the choice on the Gully Core path. It never produces a
 * price of its own.
 *
 * `useRoutedExecute` runs the routed fill in ONE click: when the API says the fill router needs an
 * exact-amount approval, that approval is sent, mined, and the fill is built again and sent without a
 * second click (the API builds a fill only for a sender it can simulate, so the two cannot be one
 * batch); then the API-built calldata (decoded and checked against the quote the user
 * saw), a fresh simulation of those exact bytes, and only then the wallet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { TokenInfo } from "../adapters/protocol.js";
import { WalletNotConnectedError } from "../adapters/protocol.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import {
  buildRoutedSwap,
  chooseRoute,
  fetchRoutedQuote,
  fetchRouterSources,
  routedMinReceived,
  isTransientRouterError,
  RoutedQuoteError,
  ROUTED_NATIVE,
  simulateRoutedSwap,
  type RouteChoice,
  type RoutedQuote,
  type RouterEndpointConfig,
} from "../core/routed.js";

/** How long a router that answered "not here" (404, disabled, wrong fill router) is left alone. */
const ROUTER_BACKOFF_MS = 5 * 60_000;
/** A timed-out or 5xx answer is asked again this soon, once per request, rather than at the next refresh. */
const TRANSIENT_RETRY_MS = 1_500;

export type RoutedStatus = "off" | "idle" | "loading" | "ready" | "none" | "unavailable";

export interface UseRoutedQuoteParams {
  readonly router: RouterEndpointConfig | undefined;
  readonly tokenIn: TokenInfo | null;
  readonly tokenOut: TokenInfo | null;
  readonly amountIn: bigint | null;
  readonly slippageBps: number;
  /**
   * The Gully Core path's net output for THIS request, `null` when it has none (no pool, error). Pass
   * `undefined` while the Gully Core quote is still loading: no choice is made on a half-read state.
   */
  readonly gullycoreNetOut: bigint | null | undefined;
  /** Routing is not offered at all while this is false (e.g. an integrator fee is active). */
  readonly enabled: boolean;
  readonly refetchIntervalMs?: number;
}

export interface UseRoutedQuoteResult {
  readonly status: RoutedStatus;
  readonly quote: RoutedQuote | null;
  readonly choice: RouteChoice;
  /** Floor for the routed fill, from the fee-net output. `null` on the Gully Core path. */
  readonly minReceived: bigint | null;
  refetch(): void;
}

function tokenAddress(t: TokenInfo): Address {
  return t.isNative === true ? ROUTED_NATIVE : t.address;
}

/** Quotes a third-party fill beside the Gully Core path and chooses the better one for the user. */
export function useRoutedQuote(p: UseRoutedQuoteParams): UseRoutedQuoteResult {
  const { chain } = useWidgetContext();
  const chainId = chain.chainId;
  const [state, setState] = useState<{ key: string; status: RoutedStatus; quote: RoutedQuote | null }>({ key: "", status: "idle", quote: null });
  const [tick, setTick] = useState(0);
  const names = useRef<{ key: string; map: ReadonlyMap<string, string> } | null>(null);
  const blockedUntil = useRef(0);
  /* The request already retried after a transient failure: one quick retry per request, then the interval. */
  const retried = useRef("");

  const active = p.enabled && p.router !== undefined;
  const key =
    active && p.tokenIn !== null && p.tokenOut !== null && p.amountIn !== null && p.amountIn > 0n
      ? `${chainId}:${tokenAddress(p.tokenIn)}:${tokenAddress(p.tokenOut)}:${p.amountIn}:${p.slippageBps}`
      : "";

  useEffect(() => {
    if (key === "" || p.router === undefined || p.tokenIn === null || p.tokenOut === null || p.amountIn === null) return;
    if (Date.now() < blockedUntil.current) {
      setState({ key, status: "unavailable", quote: null });
      return;
    }
    const router = p.router;
    const ctl = new AbortController();
    const req = { chainId, tokenIn: tokenAddress(p.tokenIn), tokenOut: tokenAddress(p.tokenOut), amountIn: p.amountIn, slippageBps: p.slippageBps };
    setState((s) => (s.key === key ? s : { key, status: "loading", quote: null }));
    (async () => {
      const nk = `${router.baseUrl}|${chainId}|${router.fillRouter}`;
      if (names.current === null || names.current.key !== nk) names.current = { key: nk, map: await fetchRouterSources(router, chainId, ctl.signal) };
      return fetchRoutedQuote(router, req, names.current.map, ctl.signal);
    })()
      .then((q) => {
        if (!ctl.signal.aborted) setState({ key, status: q === null ? "none" : "ready", quote: q });
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        // Not served here (router tier off, chain not routed, a different fill router): stop asking for a while.
        if (err instanceof RoutedQuoteError && (err.status === 404 || err.code === "FILL_ROUTER_MISMATCH" || err.code === "NOT_FOUND")) {
          blockedUntil.current = Date.now() + ROUTER_BACKOFF_MS;
        }
        /* A cold engine timing out once: still loading, asked again shortly (once), not "unavailable" yet. */
        if (isTransientRouterError(err) && retried.current !== key) {
          retried.current = key;
          setTimeout(() => {
            if (!ctl.signal.aborted) setTick((t) => t + 1);
          }, TRANSIENT_RETRY_MS);
          return;
        }
        setState({ key, status: "unavailable", quote: null });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request, not the objects
  }, [key, tick]);

  useEffect(() => {
    if (key === "") return;
    const id = setInterval(() => setTick((t) => t + 1), p.refetchIntervalMs ?? 15_000);
    return () => clearInterval(id);
  }, [key, p.refetchIntervalMs]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return useMemo(() => {
    if (!active) return { status: "off" as const, quote: null, choice: { kind: "gullycore" as const }, minReceived: null, refetch };
    if (key === "" || state.key !== key) return { status: key === "" ? ("idle" as const) : ("loading" as const), quote: null, choice: { kind: "gullycore" as const }, minReceived: null, refetch };
    // Only a quote for THIS request, and only once the Gully Core side has settled, is ever compared.
    const choice: RouteChoice = p.gullycoreNetOut === undefined ? { kind: "gullycore" } : chooseRoute(p.gullycoreNetOut, state.quote);
    const minReceived = choice.kind === "routed" ? routedMinReceived(choice.quote, p.slippageBps) : null;
    return { status: state.status, quote: state.quote, choice, minReceived, refetch };
  }, [active, key, state, p.gullycoreNetOut, p.slippageBps, refetch]);
}

export type RoutedStep = "idle" | "building" | "needs-approval" | "approving" | "simulating" | "awaiting-signature" | "pending" | "success" | "error";

export interface UseRoutedExecuteResult {
  readonly step: RoutedStep;
  readonly error: Error | null;
  readonly txHash: Hex | null;
  /** Set once the API reported that the fill router needs an exact-amount approval. */
  readonly approval: { readonly to: Address; readonly data: Hex; readonly amount: bigint } | null;
  approve(): Promise<void>;
  execute(): Promise<void>;
  reset(): void;
}

/** Executes the chosen routed fill through `GullyCoreFillRouter`. */
export function useRoutedExecute(p: {
  readonly router: RouterEndpointConfig | undefined;
  readonly choice: RouteChoice;
  readonly minReceived: bigint | null;
  readonly slippageBps: number;
  readonly recipient?: Address;
  readonly onSuccess?: (hash: Hex) => void;
}): UseRoutedExecuteResult {
  const { adapter, chain } = useWidgetContext();
  const [step, setStep] = useState<RoutedStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [approval, setApproval] = useState<UseRoutedExecuteResult["approval"]>(null);

  const q = p.choice.kind === "routed" ? p.choice.quote : null;
  // A new quote (another pair, amount or fee) invalidates a pending approval prompt.
  const qKey = q === null ? "" : `${q.tokenIn}:${q.tokenOut}:${q.amountIn}`;
  useEffect(() => {
    setApproval(null);
    setStep((s) => (s === "needs-approval" ? "idle" : s));
  }, [qKey]);

  const fail = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause : new Error(String(cause)));
    setStep("error");
  }, []);

  const approve = useCallback(async () => {
    if (approval === null) return;
    setError(null);
    setStep("approving");
    try {
      const hash = await adapter.sendTransaction({ to: approval.to, data: approval.data, value: 0n, summary: "Approve the exact amount for this routed swap", source: "live" });
      const outcome = await adapter.waitForTransaction(hash);
      if (outcome.status === "reverted") throw new Error(`The approval was mined but reverted (${hash}).`);
      setApproval(null);
      setStep("idle");
    } catch (cause) {
      fail(cause);
    }
  }, [adapter, approval, fail]);

  const execute = useCallback(async () => {
    if (p.router === undefined || q === null || p.minReceived === null) return;
    const account = await adapter.getAccount();
    if (account === null) return fail(new WalletNotConnectedError("swap"));
    setError(null);
    setTxHash(null);
    setStep("building");
    try {
      const req = {
        chainId: chain.chainId,
        tokenIn: q.tokenIn,
        tokenOut: q.tokenOut,
        amountIn: q.amountIn,
        slippageBps: p.slippageBps,
        sender: account,
        recipient: p.recipient ?? account,
        amountOutMinimum: p.minReceived,
      };
      let built = await buildRoutedSwap(p.router, req, q.feeBps);
      if (built.kind === "approval") {
        /* The exact-amount approval the API asked for (checked in buildRoutedSwap), then the fill, in this same click. */
        setApproval({ to: built.to, data: built.data, amount: built.amount });
        setStep("approving");
        const approvalHash = await adapter.sendTransaction({ to: built.to, data: built.data, value: 0n, summary: "Approve the exact amount for this routed swap", source: "live" });
        const mined = await adapter.waitForTransaction(approvalHash);
        if (mined.status === "reverted") throw new Error(`The approval was mined but reverted (${approvalHash}).`);
        setApproval(null);
        setStep("building");
        built = await buildRoutedSwap(p.router, req, q.feeBps);
        if (built.kind === "approval") throw new Error("The router still reports a missing approval after it was mined.");
      }
      setStep("simulating");
      await simulateRoutedSwap(p.router, chain.chainId, account, built.swap);
      setStep("awaiting-signature");
      const hash = await adapter.sendTransaction({
        to: built.swap.tx.to,
        data: built.swap.tx.data,
        value: built.swap.tx.value,
        summary: `Routed swap via ${q.venueName} (routing fee ${q.feeBps / 100}%)`,
        source: "live",
      });
      setTxHash(hash);
      setStep("pending");
      const outcome = await adapter.waitForTransaction(hash);
      if (outcome.status === "reverted") throw new Error(`The swap was mined but reverted (${hash}).`);
      setStep("success");
      p.onSuccess?.(hash);
    } catch (cause) {
      fail(cause);
    }
  }, [adapter, chain.chainId, fail, p, q]);

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setTxHash(null);
  }, []);

  return { step, error, txHash, approval, approve, execute, reset };
}
