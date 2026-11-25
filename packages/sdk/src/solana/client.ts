// SPDX-License-Identifier: MIT
/**
 * A minimal READ client for Gully Core on Solana: pool state, launches, the fee settings and swap quotes through the
 * Gully Router. Plain JSON-RPC over fetch, no @solana/web3.js, no signing, no transactions. Function names follow the
 * EVM SDK where the same idea exists (`readChainFeeTerms`, `GullyCore...RouterClient.quote({ tokenIn, tokenOut, amountIn })`).
 *
 * The public devnet RPC rate-limits per IP: the RPC wrapper keeps one request in flight by default and waits out a
 * 429's Retry-After. Pass your own RPC URL (e.g. a Gully RPC or dRPC endpoint) for real traffic.
 */
import { base64Decode, type SolanaAddress } from "./codec.js";
import { ACCOUNT_SIZES, decodeFeeSettings, decodeLaunch, decodePoolState, type SolanaFeeSettings, type SolanaLaunch, type SolanaPoolState } from "./accounts.js";
import type { GullyCoreSolanaDeployment } from "./deployments.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface SolanaRpcOptions {
  readonly url: string;
  readonly fetch?: FetchLike;
  /** Requests in flight at once (default 1, the public devnet RPC rejects bursts). */
  readonly maxInFlight?: number;
  readonly timeoutMs?: number;
  /** How many times a 429 is retried (default 3). */
  readonly retries?: number;
}

export interface SolanaRpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

export class SolanaRpcError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: number | null) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

export function createSolanaRpc(o: SolanaRpcOptions): SolanaRpc {
  const f: FetchLike = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const max = Math.max(1, o.maxInFlight ?? 1);
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const acquire = async () => {
    while (inFlight >= max) await new Promise<void>((r) => waiters.push(r));
    inFlight++;
  };
  const release = () => {
    inFlight--;
    waiters.shift()?.();
  };
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        await acquire();
        let res;
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
          try {
            res = await f(o.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: ctl.signal });
          } finally {
            clearTimeout(t);
          }
        } finally {
          release();
        }
        if (res.status === 429 && attempt < (o.retries ?? 3)) {
          const ra = Number(res.headers.get("retry-after"));
          await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new SolanaRpcError(`${method}: HTTP ${res.status}`, res.status, null);
        const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (j.error) throw new SolanaRpcError(`${method}: ${j.error.message}`, res.status, j.error.code);
        return j.result as T;
      }
    },
  };
}

interface AccountInfo { data: [string, string]; owner: string; executable: boolean; lamports: number }

async function accountData(rpc: SolanaRpc, address: SolanaAddress, owner?: SolanaAddress): Promise<Uint8Array | null> {
  const r = await rpc.call<{ value: AccountInfo | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  if (!r.value) return null;
  if (owner && r.value.owner !== owner) throw new Error(`${address} is not owned by ${owner}`);
  return base64Decode(r.value.data[0]);
}

/** One Gully CP-Swap pool, or null when the account does not exist. */
export async function readPoolState(rpc: SolanaRpc, d: GullyCoreSolanaDeployment, pool: SolanaAddress): Promise<(SolanaPoolState & { address: SolanaAddress }) | null> {
  const data = await accountData(rpc, pool, d.programs.cpSwap);
  return data ? { address: pool, ...decodePoolState(data) } : null;
}

export interface SolanaPoolReserves {
  /** Vault balance minus the protocol, fund and creator fees the pool owes (what the curve trades against). */
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

/** The pool's tradable reserves: its two vault balances minus the fees held for collection. */
export async function readPoolReserves(rpc: SolanaRpc, p: SolanaPoolState): Promise<SolanaPoolReserves> {
  const bal = async (vault: SolanaAddress) => BigInt((await rpc.call<{ value: { amount: string } }>("getTokenAccountBalance", [vault, { commitment: "confirmed" }])).value.amount);
  const v0 = await bal(p.token0Vault);
  const v1 = await bal(p.token1Vault);
  const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
  return { reserve0: sub(v0, p.protocolFeesToken0 + p.fundFeesToken0 + p.creatorFeesToken0), reserve1: sub(v1, p.protocolFeesToken1 + p.fundFeesToken1 + p.creatorFeesToken1) };
}

/** Every Gully CP-Swap pool (getProgramAccounts by account size). */
export async function listPools(rpc: SolanaRpc, d: GullyCoreSolanaDeployment): Promise<Array<SolanaPoolState & { address: SolanaAddress }>> {
  const rows = await rpc.call<Array<{ pubkey: string; account: AccountInfo }>>("getProgramAccounts", [d.programs.cpSwap, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: ACCOUNT_SIZES.PoolState }] }]);
  const out: Array<SolanaPoolState & { address: SolanaAddress }> = [];
  for (const r of rows) {
    try { out.push({ address: r.pubkey, ...decodePoolState(base64Decode(r.account.data[0])) }); } catch { /* another account of the same size */ }
  }
  return out;
}

/** One Gully Launch account (its address, not the mint), or null. */
export async function readLaunch(rpc: SolanaRpc, d: GullyCoreSolanaDeployment, launch: SolanaAddress): Promise<(SolanaLaunch & { address: SolanaAddress }) | null> {
  const data = await accountData(rpc, launch, d.programs.launch);
  return data ? { address: launch, ...decodeLaunch(data) } : null;
}

/** Every launch, newest first. */
export async function listLaunches(rpc: SolanaRpc, d: GullyCoreSolanaDeployment): Promise<Array<SolanaLaunch & { address: SolanaAddress }>> {
  const rows = await rpc.call<Array<{ pubkey: string; account: AccountInfo }>>("getProgramAccounts", [d.programs.launch, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: ACCOUNT_SIZES.Launch }] }]);
  const out: Array<SolanaLaunch & { address: SolanaAddress }> = [];
  for (const r of rows) {
    try { out.push({ address: r.pubkey, ...decodeLaunch(base64Decode(r.account.data[0])) }); } catch { /* not a Launch */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** The fee settings account (Gully Core's fee controller on Solana). */
export async function readFeeSettings(rpc: SolanaRpc, d: GullyCoreSolanaDeployment): Promise<SolanaFeeSettings> {
  const data = await accountData(rpc, d.feeSettings, d.programs.cpSwap);
  if (!data) throw new Error(`fee settings account ${d.feeSettings} not found`);
  return decodeFeeSettings(data);
}

export interface SolanaChainFeeTerms {
  /** The flat builder fee, pips (millionths), as `ChainFeeTerms.builderFeePips` on EVM. */
  readonly builderFeePips: number;
  /** Gully's own surfaces (kre8 tier): total trade fee and the creator's part, pips. */
  readonly gullyTradeFeePips: number;
  readonly gullyCreatorFeePips: number;
  /** Gully's share of a launch's creator tax, pips. */
  readonly creatorTaxSharePips: number;
  readonly launchFeeLamports: bigint;
  /** Solana tells builder pools from Gully pools by their config (tier), so terms are per pool from day one. */
  readonly perTenantTerms: true;
  readonly pending: SolanaFeeSettings["pending"];
}

/** Same idea as the EVM `readChainFeeTerms`: what the chain charges today, read from the fee settings account. */
export async function readChainFeeTerms(rpc: SolanaRpc, d: GullyCoreSolanaDeployment): Promise<SolanaChainFeeTerms> {
  const f = await readFeeSettings(rpc, d);
  return {
    builderFeePips: f.builderFeeRate,
    gullyTradeFeePips: f.kre8TradeFeeRate,
    gullyCreatorFeePips: f.kre8CreatorFeeRate,
    creatorTaxSharePips: f.creatorTaxShareRate,
    launchFeeLamports: f.launchFeeLamports,
    perTenantTerms: true,
    pending: f.pending,
  };
}

export interface SolanaRouterQuote {
  readonly tokenIn: SolanaAddress;
  readonly tokenOut: SolanaAddress;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
  readonly priceImpactPct: number;
  readonly venues: readonly string[];
  /** Gully's router fee: 0 on Gully Core pools, 0.15% on fills at another venue. */
  readonly gullyFeeBps: number;
  readonly contextSlot: number;
  readonly requestId: string | null;
}

export class GullyCoreSolanaRouterError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "GullyCoreSolanaRouterError";
  }
}

/** Quotes through the Gully Router (Solana). Quotes only: this client builds and signs nothing. */
export class GullyCoreSolanaRouterClient {
  private readonly base: string;
  private readonly f: FetchLike;
  constructor(o: { readonly url: string; readonly fetch?: FetchLike; readonly apiKey?: string }) {
    this.base = o.url.replace(/\/$/, "");
    this.f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiKey = o.apiKey ?? null;
  }
  private readonly apiKey: string | null;

  async quote(p: { tokenIn: SolanaAddress; tokenOut: SolanaAddress; amountIn: bigint; slippageBps?: number }): Promise<SolanaRouterQuote> {
    const q = new URLSearchParams({ inputMint: p.tokenIn, outputMint: p.tokenOut, amount: p.amountIn.toString(), slippageBps: String(p.slippageBps ?? 50) });
    const res = await this.f(`${this.base}/quote?${q}`, { method: "GET", headers: this.apiKey ? { "x-api-key": this.apiKey } : {} });
    const j = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new GullyCoreSolanaRouterError(String(j["msg"] ?? `HTTP ${res.status}`), res.status, typeof j["code"] === "string" ? (j["code"] as string) : null);
    const plan = Array.isArray(j["routePlan"]) ? (j["routePlan"] as Array<{ venue?: string }>) : [];
    const fee = (j["gullyFee"] ?? {}) as { feeBps?: number };
    return {
      tokenIn: String(j["inputMint"]),
      tokenOut: String(j["outputMint"]),
      amountIn: BigInt(String(j["inAmount"])),
      amountOut: BigInt(String(j["outAmount"])),
      minAmountOut: BigInt(String(j["minOutAmount"] ?? j["otherAmountThreshold"])),
      slippageBps: Number(j["slippageBps"]),
      priceImpactPct: Number(j["priceImpactPct"]),
      venues: [...new Set(plan.map((x) => String(x.venue ?? "")))].filter(Boolean),
      gullyFeeBps: Number(fee.feeBps ?? 0),
      contextSlot: Number(j["contextSlot"] ?? 0),
      requestId: typeof j["requestId"] === "string" ? (j["requestId"] as string) : null,
    };
  }

  async health(): Promise<{ status: string; cluster: string; venues: readonly string[] }> {
    const res = await this.f(`${this.base}/health`, { method: "GET", headers: {} });
    const j = (await res.json()) as { status?: string; cluster?: string; venues?: string[] };
    return { status: String(j.status ?? "unknown"), cluster: String(j.cluster ?? ""), venues: j.venues ?? [] };
  }
}

/** Constant-product output for an exact input, before Gully's fee (rate in millionths). For previews only. */
export function cpOutForExactIn(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const fee = (amountIn * BigInt(tradeFeeRate) + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
}
