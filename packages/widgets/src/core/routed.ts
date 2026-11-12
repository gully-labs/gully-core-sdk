// SPDX-License-Identifier: MIT
/**
 * Routed quotes: the OPTIONAL capability that lets the swap widget fill a trade on a third-party
 * venue through Gully Core's `GullyCoreFillRouter` when that beats every Gully Core pool for the user.
 *
 * The rules this file exists to keep (owner decisions 2026-09-20 / 2026-09-25 / 2026-09-26):
 *
 *  - The routing fee is the ON-CHAIN value the router API read from `GullyCoreFillRouter` (15 bps today,
 *    inside an immutable 50 bps cap). This file never sets, computes-to-charge or assumes it; it
 *    only checks that what the API reports is internally consistent and within the cap.
 *  - A Gully Core pool pays 0 routing fee: a Gully Core route never goes through the fill router at all, so
 *    when the Gully Core path wins there is no routing line.
 *  - The routing fee is its own line, never merged into price impact. Minimum received is computed
 *    from the output AFTER the fee (the fee is taken from the input, so the venue output already
 *    carries it).
 *  - The venue is named factually ("Best price: Uniswap v3"): the API's own `name`, no marks.
 *  - FAIL CLOSED TO GULLY CORE POOLS. Router not configured, unreachable, answering something that does
 *    not verify, or not strictly better: the Gully Core path is used exactly as before. A routed quote
 *    never silently replaces a Gully Core price with a worse one.
 *  - Calldata the API builds is decoded and checked here against what the user saw BEFORE the
 *    wallet is asked to sign: `to` is the configured fill router, the currencies, amount, recipient
 *    and fee cap are the quoted ones, and the floor is at least the displayed minimum.
 *
 * Pure: no React, no chain access. `fetch` is injected so it is tested without a network.
 */

import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";

/** `address(0)`: native currency, as the router API and `GullyCoreFillRouter` both spell it. */
export const ROUTED_NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** The fill router's immutable ceiling. A reported fee above it is not a fee this contract can charge. */
export const ROUTED_FEE_CAP_BPS = 50;

/** How the widget reaches a router API. */
export interface RouterEndpointConfig {
  /**
   * Base URL of the chain-scoped router routes, WITHOUT the chain id, e.g.
   * `https://gullychain.xyz/core/v1/chains`. The widget calls `<base>/<chainId>/quote` and friends.
   */
  readonly baseUrl: string;
  /** `GullyCoreFillRouter` on this chain, from the SDK address book. A built transaction must be addressed to it. */
  readonly fillRouter: Address;
  /** Optional API key carrying the `router:quote` scope. Anonymous otherwise (rate limited per IP). */
  readonly apiKey?: string;
  /** Test seam and SSR seam. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** A third-party fill the router API quoted, parsed and checked. */
export interface RoutedQuote {
  readonly chainId: number;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  /** What the user receives: the venue's output for the post-fee budget. */
  readonly amountOut: bigint;
  /** Routing fee in force, as the API READ it from `GullyCoreFillRouter`. */
  readonly feeBps: number;
  /** Routing fee in `tokenIn` units if the venue consumes the whole budget. */
  readonly feeAmount: bigint;
  /** The contract the fee was read from (must be the configured fill router). */
  readonly feeReadFrom: Address;
  /** Stable venue id, e.g. `UNISWAP_V3`. */
  readonly venueId: string;
  /** Factual venue name for the "Best price" line, from the API's source list. */
  readonly venueName: string;
  /** `null` when the API could not take a reference quote. Never a guessed number. */
  readonly priceImpactBps: number | null;
  readonly blockNumber: bigint;
  /** Unix seconds (chain time) after which the quote is stale. */
  readonly expiresAt: number;
}

export class RoutedQuoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RoutedQuoteError";
  }
}

/* ----------------------------------------------------------------------------
   HTTP
   ---------------------------------------------------------------------------- */

/**
 * A router failure worth asking again soon: the API timed out or answered 5xx, or could not be reached.
 * A cold quote engine on a slow chain can exceed the API's own budget once and answer in well under a
 * second the next time, so one quick retry is the difference between "no route" and a quote.
 */
export function isTransientRouterError(err: unknown): boolean {
  if (!(err instanceof RoutedQuoteError)) return false;
  if (err.code === "TIMEOUT" || err.code === "UNREACHABLE") return true;
  return err.status !== undefined && err.status >= 500;
}

function base(cfg: RouterEndpointConfig, chainId: number): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}/${chainId}`;
}

function headers(cfg: RouterEndpointConfig, json: boolean): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (json) h["content-type"] = "application/json";
  if (cfg.apiKey) h["x-api-key"] = cfg.apiKey;
  return h;
}

async function call(cfg: RouterEndpointConfig, url: string, init: RequestInit): Promise<unknown> {
  const f = cfg.fetch ?? globalThis.fetch;
  if (typeof f !== "function") throw new RoutedQuoteError("NO_FETCH", "no fetch available");
  let res: Response;
  try {
    res = await f(url, init);
  } catch (err) {
    throw new RoutedQuoteError("UNREACHABLE", `router API unreachable: ${(err as Error).message}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new RoutedQuoteError("BAD_RESPONSE", `router API answered ${res.status} with no JSON`, res.status);
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new RoutedQuoteError(e?.code ?? `HTTP_${res.status}`, e?.message ?? `router API answered ${res.status}`, res.status, e?.details);
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (data === undefined) throw new RoutedQuoteError("BAD_RESPONSE", "router API answered without data");
  return data;
}

function big(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !/^[0-9]{1,78}$/.test(v)) throw new RoutedQuoteError("BAD_RESPONSE", `${what} is not a decimal integer string`);
  return BigInt(v);
}

function addr(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new RoutedQuoteError("BAD_RESPONSE", `${what} is not an address`);
  return getAddress(v);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `id -> name` for the chain's sources (`GET /:chainId/sources`). */
export async function fetchRouterSources(cfg: RouterEndpointConfig, chainId: number, signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  const data = (await call(cfg, `${base(cfg, chainId)}/sources`, { headers: headers(cfg, false), ...(signal ? { signal } : {}) })) as { sources?: { id?: unknown; name?: unknown; enabled?: unknown }[]; routers?: { fillRouter?: unknown } };
  const fr = data.routers?.fillRouter;
  if (typeof fr !== "string" || !same(fr, cfg.fillRouter)) {
    throw new RoutedQuoteError("FILL_ROUTER_MISMATCH", "the router API names a different fill router than this site's address book");
  }
  const out = new Map<string, string>();
  for (const s of data.sources ?? []) if (typeof s.id === "string" && typeof s.name === "string" && s.enabled === true) out.set(s.id, s.name);
  return out;
}

export interface RoutedQuoteRequest {
  readonly chainId: number;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly slippageBps: number;
}

/**
 * Asks the router API for its best route. Returns `null` when that route is a GULLY CORE pool (the widget's
 * own Gully Core path already covers it, with 0 routing fee) or when nothing third-party can fill. Throws
 * `RoutedQuoteError` when the answer cannot be trusted; callers treat every throw as "use Gully Core pools".
 */
export async function fetchRoutedQuote(
  cfg: RouterEndpointConfig,
  req: RoutedQuoteRequest,
  venueNames: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<RoutedQuote | null> {
  const q = new URLSearchParams({ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amount: req.amountIn.toString(), slippageBps: String(req.slippageBps) });
  let data: Record<string, unknown>;
  try {
    data = (await call(cfg, `${base(cfg, req.chainId)}/quote?${q}`, { headers: headers(cfg, false), ...(signal ? { signal } : {}) })) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof RoutedQuoteError && err.code === "NO_ROUTE") return null;
    throw err;
  }
  return parseRoutedQuote(cfg, req, data, venueNames);
}

/** Parses and verifies a `/quote` response body's `data`. Exported for tests. */
export function parseRoutedQuote(cfg: RouterEndpointConfig, req: RoutedQuoteRequest, data: Record<string, unknown>, venueNames: ReadonlyMap<string, string>): RoutedQuote | null {
  const route = data["route"] as Record<string, unknown> | undefined;
  const fee = data["protocolFee"] as Record<string, unknown> | undefined;
  if (!route || !fee) throw new RoutedQuoteError("BAD_RESPONSE", "quote without route or fee");
  if (data["chainId"] !== req.chainId) throw new RoutedQuoteError("BAD_RESPONSE", "quote for another chain");
  if (!same(addr(data["tokenIn"], "tokenIn"), req.tokenIn) || !same(addr(data["tokenOut"], "tokenOut"), req.tokenOut)) {
    throw new RoutedQuoteError("BAD_RESPONSE", "quote for another pair");
  }
  const amountIn = big(data["amountIn"], "amountIn");
  if (amountIn !== req.amountIn) throw new RoutedQuoteError("BAD_RESPONSE", "quote for another amount");

  // The Gully Core path is the widget's own; a Gully Core route here adds nothing and pays nothing.
  if (route["execution"] === "gullycore-universal-router") return null;
  if (route["execution"] !== "gullycore-fill-router") throw new RoutedQuoteError("BAD_RESPONSE", "unknown execution");
  if (!same(addr(route["to"], "route.to"), cfg.fillRouter)) throw new RoutedQuoteError("FILL_ROUTER_MISMATCH", "routed fill not addressed to this site's fill router");

  const feeBps = fee["bps"];
  if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > ROUTED_FEE_CAP_BPS) {
    throw new RoutedQuoteError("BAD_RESPONSE", "routing fee outside the contract's cap");
  }
  const feeReadFrom = addr(fee["readFrom"], "protocolFee.readFrom");
  if (!same(feeReadFrom, cfg.fillRouter)) throw new RoutedQuoteError("FILL_ROUTER_MISMATCH", "routing fee not read from this site's fill router");
  const budget = big(fee["budget"], "protocolFee.budget");
  const feeAmount = big(fee["amount"], "protocolFee.amount");
  const refund = big(fee["refund"], "protocolFee.refund");
  // The contract's own split, re-checked: fee = floor(budget * bps / 10_000); budget + fee + refund = amountIn.
  if (feeAmount !== (budget * BigInt(feeBps)) / 10_000n || budget + feeAmount + refund !== amountIn) {
    throw new RoutedQuoteError("BAD_RESPONSE", "routing fee does not add up");
  }
  const amountOut = big(data["amountOut"], "amountOut");
  if (amountOut === 0n) return null;
  const venueId = typeof route["source"] === "string" ? route["source"] : "";
  const legs = route["legs"] as unknown[] | undefined;
  if (!Array.isArray(legs) || legs.length !== 1) {
    // Split routing is behind a server flag that is OFF; a split answer is not something this widget renders.
    throw new RoutedQuoteError("UNSUPPORTED", "split routes are not rendered by this widget");
  }
  const venueName = venueNames.get(venueId);
  if (venueName === undefined) throw new RoutedQuoteError("BAD_RESPONSE", "quote names a venue the source list does not");
  const impact = data["priceImpactBps"];
  const expiresAt = data["expiresAt"];
  if (typeof expiresAt !== "number") throw new RoutedQuoteError("BAD_RESPONSE", "quote without expiry");
  return {
    chainId: req.chainId,
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    amountIn,
    amountOut,
    feeBps,
    feeAmount,
    feeReadFrom,
    venueId,
    venueName,
    priceImpactBps: typeof impact === "number" && Number.isFinite(impact) ? impact : null,
    blockNumber: big(data["blockNumber"], "blockNumber"),
    expiresAt,
  };
}

/* ----------------------------------------------------------------------------
   Choosing
   ---------------------------------------------------------------------------- */

export type RouteChoice =
  | { readonly kind: "gullycore" }
  | { readonly kind: "routed"; readonly quote: RoutedQuote };

/**
 * Picks the better NET output for the user. `gullycoreNetOut` is what the Gully Core path pays the user
 * (after any integrator fee), or `null` when no Gully Core pool can fill. The routed quote's output is
 * already net of the routing fee. A routed fill wins only when STRICTLY better; a tie stays on the
 * Gully Core pool (0 routing fee, the venue Gully Core exists to fill).
 */
export function chooseRoute(gullycoreNetOut: bigint | null, routed: RoutedQuote | null): RouteChoice {
  if (routed === null || routed.amountOut === 0n) return { kind: "gullycore" };
  if (gullycoreNetOut === null) return { kind: "routed", quote: routed };
  return routed.amountOut > gullycoreNetOut ? { kind: "routed", quote: routed } : { kind: "gullycore" };
}

/** `floor(amountOut * (10_000 - slippage) / 10_000)`: the floor on the fee-net output. */
export function routedMinReceived(q: RoutedQuote, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) throw new RangeError("slippageBps out of range");
  return (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** The routing-fee line: `null` (no line) on a Gully Core route or an exempt venue. */
export function routingFeeLine(choice: RouteChoice): { readonly label: string; readonly bps: number; readonly amount: bigint } | null {
  if (choice.kind !== "routed" || choice.quote.feeBps === 0) return null;
  const bps = choice.quote.feeBps;
  const pct = (bps / 100).toFixed(2).replace(/0$/, "");
  return { label: `Routing fee ${pct}%`, bps, amount: choice.quote.feeAmount };
}

/** "Best price: <venue>". Factual, no marks. */
export function bestPriceLabel(choice: RouteChoice): string | null {
  return choice.kind === "routed" ? choice.quote.venueName : null;
}

/* ----------------------------------------------------------------------------
   Building and verifying the fill
   ---------------------------------------------------------------------------- */

const FILL_ABI = [
  {
    type: "function",
    name: "fill",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "target", type: "address" },
          { name: "currencyIn", type: "address" },
          { name: "currencyOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "wrapInput", type: "bool" },
          { name: "unwrapOutput", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "spent", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "refund", type: "uint256" },
    ],
  },
] as const;

const APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** Exact-amount ERC-20 approval of the fill router: never unlimited. */
export function encodeExactApproval(token: Address, fillRouter: Address, amount: bigint): { to: Address; data: Hex } {
  return { to: token, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [fillRouter, amount] }) };
}

export interface RoutedSwapRequest extends RoutedQuoteRequest {
  readonly sender: Address;
  readonly recipient: Address;
  /** The floor the user was shown. The API refuses to build below the fresh quote, never silently lower. */
  readonly amountOutMinimum: bigint;
}

export interface BuiltRoutedSwap {
  readonly tx: { readonly to: Address; readonly data: Hex; readonly value: bigint; readonly gas: bigint };
  readonly minAmountOut: bigint;
  readonly simulated: { readonly amountOut: bigint; readonly spent: bigint; readonly feeAmount: bigint; readonly refund: bigint };
  readonly feeBps: number;
}

export type BuildOutcome =
  | { readonly kind: "built"; readonly swap: BuiltRoutedSwap }
  | { readonly kind: "approval"; readonly to: Address; readonly data: Hex; readonly amount: bigint };

/**
 * `POST /:chainId/swap`. The API returns calldata only after the exact bytes simulated from the
 * sender. When the sender has not approved the fill router it answers 409 APPROVAL_REQUIRED with the
 * step; that step is checked to be an EXACT-amount `approve(fillRouter, amountIn)` on `tokenIn`.
 */
export async function buildRoutedSwap(cfg: RouterEndpointConfig, req: RoutedSwapRequest, expectedFeeBps: number): Promise<BuildOutcome> {
  let data: Record<string, unknown>;
  try {
    data = (await call(cfg, `${base(cfg, req.chainId)}/swap`, {
      method: "POST",
      headers: headers(cfg, true),
      body: JSON.stringify({
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn.toString(),
        sender: req.sender,
        recipient: req.recipient,
        slippageBps: req.slippageBps,
        amountOutMinimum: req.amountOutMinimum.toString(),
      }),
    })) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof RoutedQuoteError && err.code === "APPROVAL_REQUIRED") {
      const steps = ((err.details as { approvals?: unknown[] } | undefined)?.approvals ?? []) as Record<string, unknown>[];
      if (steps.length !== 1) throw new RoutedQuoteError("BAD_RESPONSE", "a routed fill needs exactly one approval step");
      const s = steps[0]!;
      const to = addr(s["to"], "approval.to");
      const stepData = s["data"];
      if (s["kind"] !== "erc20-approve" || !same(to, req.tokenIn) || typeof stepData !== "string") throw new RoutedQuoteError("BAD_RESPONSE", "unexpected approval step");
      const d = decodeFunctionData({ abi: APPROVE_ABI, data: stepData as Hex });
      if (!same(d.args[0], cfg.fillRouter) || d.args[1] !== req.amountIn) throw new RoutedQuoteError("BAD_RESPONSE", "approval is not an exact-amount approval of the fill router");
      return { kind: "approval", to, data: stepData as Hex, amount: d.args[1] };
    }
    throw err;
  }
  return { kind: "built", swap: verifyBuiltRoutedSwap(cfg, req, data, expectedFeeBps) };
}

/** Decodes the API's calldata and checks it is the trade the user saw. Exported for tests. */
export function verifyBuiltRoutedSwap(cfg: RouterEndpointConfig, req: RoutedSwapRequest, data: Record<string, unknown>, expectedFeeBps: number): BuiltRoutedSwap {
  const tx = data["tx"] as Record<string, unknown> | undefined;
  const sim = (data["simulation"] as Record<string, unknown> | undefined)?.["fill"] as Record<string, unknown> | null | undefined;
  if (!tx || !sim) throw new RoutedQuoteError("NOT_ROUTED", "the router built a non-routed transaction; re-quote");
  const to = addr(tx["to"], "tx.to");
  if (!same(to, cfg.fillRouter)) throw new RoutedQuoteError("FILL_ROUTER_MISMATCH", "transaction not addressed to this site's fill router");
  if (!same(addr(tx["from"], "tx.from"), req.sender)) throw new RoutedQuoteError("BAD_RESPONSE", "transaction built for another sender");
  const txData = tx["data"];
  if (typeof txData !== "string") throw new RoutedQuoteError("BAD_RESPONSE", "no calldata");
  let p;
  try {
    p = decodeFunctionData({ abi: FILL_ABI, data: txData as Hex }).args[0];
  } catch {
    throw new RoutedQuoteError("BAD_RESPONSE", "calldata is not GullyCoreFillRouter.fill");
  }
  const nativeIn = same(req.tokenIn, ROUTED_NATIVE);
  const nativeOut = same(req.tokenOut, ROUTED_NATIVE);
  if (!same(p.currencyIn, req.tokenIn) || !same(p.currencyOut, req.tokenOut) || p.wrapInput !== nativeIn || p.unwrapOutput !== nativeOut) {
    throw new RoutedQuoteError("BAD_RESPONSE", "calldata trades another pair");
  }
  if (p.amountIn !== req.amountIn) throw new RoutedQuoteError("BAD_RESPONSE", "calldata spends another amount");
  if (!same(p.recipient, req.recipient)) throw new RoutedQuoteError("BAD_RESPONSE", "calldata pays another recipient");
  if (p.minAmountOut < req.amountOutMinimum) throw new RoutedQuoteError("BAD_RESPONSE", "calldata floor is below the minimum you were shown");
  if (p.maxFeeBps !== expectedFeeBps || p.maxFeeBps > ROUTED_FEE_CAP_BPS) throw new RoutedQuoteError("FEE_CHANGED", "the routing fee changed since the quote; re-quote");
  const value = big(tx["value"], "tx.value");
  if (value !== (nativeIn ? req.amountIn : 0n)) throw new RoutedQuoteError("BAD_RESPONSE", "transaction value does not match");
  const simulated = {
    amountOut: big(sim["amountOut"], "simulation.amountOut"),
    spent: big(sim["spent"], "simulation.spent"),
    feeAmount: big(sim["feeAmount"], "simulation.feeAmount"),
    refund: big(sim["refund"], "simulation.refund"),
  };
  if (simulated.amountOut < p.minAmountOut) throw new RoutedQuoteError("SIMULATION_FAILED", "simulated output is below the floor");
  if (simulated.feeAmount !== (simulated.spent * BigInt(expectedFeeBps)) / 10_000n) throw new RoutedQuoteError("SIMULATION_FAILED", "simulated fee does not match the quoted rate");
  return { tx: { to, data: txData as Hex, value, gas: big(tx["gas"], "tx.gas") }, minAmountOut: p.minAmountOut, simulated, feeBps: expectedFeeBps };
}

/**
 * `POST /:chainId/simulate` on the exact bytes, immediately before the wallet is asked to sign: the
 * chain may have moved since `/swap` simulated. Returns the fill as the chain would execute it now.
 */
export async function simulateRoutedSwap(cfg: RouterEndpointConfig, chainId: number, from: Address, built: BuiltRoutedSwap): Promise<void> {
  const data = (await call(cfg, `${base(cfg, chainId)}/simulate`, {
    method: "POST",
    headers: headers(cfg, true),
    body: JSON.stringify({ from, to: built.tx.to, data: built.tx.data, value: built.tx.value.toString() }),
  })) as { ok?: unknown; fill?: { amountOut?: unknown } | null };
  if (data.ok !== true || !data.fill) throw new RoutedQuoteError("SIMULATION_FAILED", "the fill did not simulate");
  const out = big(data.fill.amountOut, "simulate.amountOut");
  if (out < built.minAmountOut) throw new RoutedQuoteError("SIMULATION_FAILED", "the fill would now pay less than the minimum");
}
