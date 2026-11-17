// SPDX-License-Identifier: MIT
/**
 * The buy alert source: where the alerts come from, with no framework.
 *
 *   pools     `GET <api>/chains/<id>/pools?token=<addr>` (every Gully Core pool of
 *             the token on the chain: launch pools, DEX pools, hook pools), or
 *             `GET <api>/chains/<id>/pools/<poolId>` for a `pool` attribute
 *   history   `GET <api>/chains/<id>/pools/<poolId>/swaps?limit=N` per pool: the
 *             last indexed swaps, already timed, so the widget is never empty
 *   live      the pool managers' `Swap` logs after the index's block, read from
 *             the chain through Gully RPC's keyless project with the SDK's
 *             `readPoolTrades` (the same reader the app's token page polls),
 *             every `pollSeconds` while the tab is visible; `withTimestamps`
 *             times the new blocks
 *   dollars   `GET <api>/prices?chain=<id>`: dollars per whole quote token,
 *             refreshed every minute; a quote with no price stays unpriced
 *   words     `GET <api>/tokens/<id>/<addr>`: the token's symbol, name and mark
 *
 * No key: the API's public reads carry `Access-Control-Allow-Origin: *`, and the
 * keyless RPC project is open to every visitor IP at 25 req/s. A failed poll keeps
 * the last good tape and counts (`stalled`), so the chip can stop saying LIVE.
 */

import { createClient, http, type Address, type Hex, type PublicClient } from "viem";
import { getBlock, getBlockNumber, getLogs } from "viem/actions";
import { readPoolTrades, withTimestamps, type Trade } from "@gullylabs/core-sdk";

import {
  followedPoolFromApi,
  keylessRpcFor,
  mergeTape,
  pricesFromApi,
  tradeFromApiSwap,
  type ApiPoolRow,
  type ApiSwapRow,
  type BuysAttributes,
  type FollowedPool,
  type TapeTrade,
} from "./model.js";

export interface TokenWords {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  /** Absolute URL of the token's mark (the API always answers an image), or null. */
  readonly logoUrl: string | null;
}

export interface BuysState {
  readonly status: "loading" | "ready" | "error";
  readonly message: string | null;
  readonly token: TokenWords | null;
  readonly pools: ReadonlyMap<string, FollowedPool>;
  readonly tape: readonly TapeTrade[];
  /** Keys of trades that arrived through a live poll, not the history. */
  readonly fresh: ReadonlySet<string>;
  /** Lowercase quote address -> dollars per whole unit. */
  readonly usdPerQuote: ReadonlyMap<string, number>;
  /** The footnote the API attaches to a reference price (a test network), else "". */
  readonly priceNote: string;
  readonly head: bigint | null;
  readonly polls: number;
  /** Consecutive failed polls; 2 or more is a stall. */
  readonly stalled: number;
}

export type BuysListener = (s: BuysState) => void;

export interface BuysSourceOptions {
  readonly fetchImpl?: typeof fetch;
  /** Whether the page is visible (polls pause when it is not). Default: `document.visibilityState`. */
  readonly visible?: () => boolean;
  readonly now?: () => number;
}

/** History swaps read per pool at start (the API's page), and the deepest chain backfill when the index is behind. */
export const HISTORY_PER_POOL = 25;
export const MAX_BACKFILL_BLOCKS = 5_000n;
export const PRICE_REFRESH_MS = 60_000;
const MAX_POOLS = 10;

const initial = (): BuysState => ({
  status: "loading",
  message: null,
  token: null,
  pools: new Map(),
  tape: [],
  fresh: new Set(),
  usdPerQuote: new Map(),
  priceNote: "",
  head: null,
  polls: 0,
  stalled: 0,
});

/** Only the actions the market reader calls, so the bundle carries no more of viem than it uses. */
function clientFor(rpc: string): PublicClient {
  const base = createClient({ transport: http(rpc, { retryCount: 1, timeout: 12_000 }) });
  return {
    ...base,
    getBlock: (args?: unknown) => getBlock(base, args as never),
    getBlockNumber: (args?: unknown) => getBlockNumber(base, args as never),
    getLogs: (args?: unknown) => getLogs(base, args as never),
  } as unknown as PublicClient;
}

export class BuysSource {
  #attrs: BuysAttributes;
  #state: BuysState = initial();
  #listeners = new Set<BuysListener>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #priceTimer: ReturnType<typeof setInterval> | null = null;
  #run = 0;
  #client: PublicClient | null = null;
  #fetch: typeof fetch;
  #visible: () => boolean;
  #now: () => number;
  #polling = false;

  constructor(attrs: BuysAttributes, opts: BuysSourceOptions = {}) {
    this.#attrs = attrs;
    this.#fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#visible = opts.visible ?? (() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));
    this.#now = opts.now ?? (() => Date.now());
  }

  get state(): BuysState {
    return this.#state;
  }

  subscribe(l: BuysListener): () => void {
    this.#listeners.add(l);
    l(this.#state);
    return () => this.#listeners.delete(l);
  }

  #set(patch: Partial<BuysState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }

  start(): void {
    this.stop();
    const run = ++this.#run;
    this.#state = initial();
    this.#set({});
    void this.#load(run);
  }

  stop(): void {
    this.#run += 1;
    if (this.#timer !== null) clearInterval(this.#timer);
    if (this.#priceTimer !== null) clearInterval(this.#priceTimer);
    this.#timer = null;
    this.#priceTimer = null;
  }

  /** The same source, new attributes: a full reload. */
  reset(attrs: BuysAttributes): void {
    this.#attrs = attrs;
    this.#client = null;
    this.start();
  }

  async #json(path: string): Promise<unknown> {
    const r = await this.#fetch(`${this.#attrs.api}${path}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Gully Core API answered ${r.status} for ${path}`);
    return r.json();
  }

  async #load(run: number): Promise<void> {
    const a = this.#attrs;
    try {
      const prices = await this.#readPrices();
      if (run !== this.#run) return;
      const rows = await this.#readPoolRows();
      if (run !== this.#run) return;
      const base: Address | null = a.target.kind === "token" ? a.target.token : null;
      const pools = new Map<string, FollowedPool>();
      for (const row of rows.slice(0, MAX_POOLS)) {
        const fp = followedPoolFromApi(row, a.chainId, base, new Set(prices.keys()));
        if (fp !== null) pools.set(fp.pool.poolId.toLowerCase(), fp);
      }
      if (pools.size === 0) {
        this.#set({ status: "error", message: a.target.kind === "token" ? "No Gully Core pool holds this token on this chain yet." : "This pool is not in the Gully Core index.", pools, usdPerQuote: prices });
        return;
      }
      const first = [...pools.values()][0]!;
      const token = await this.#readToken(base ?? first.base.address).catch(() => ({ address: first.base.address, symbol: first.base.symbol, name: first.base.symbol, logoUrl: null }));
      if (run !== this.#run) return;
      const { tape, indexedTo } = await this.#readHistory(pools);
      if (run !== this.#run) return;
      this.#set({ status: "ready", message: null, token, pools, tape, usdPerQuote: prices, head: indexedTo });
      /* First poll at once: the trades between the index's block and the head. */
      await this.#poll(run);
      if (run !== this.#run) return;
      this.#timer = setInterval(() => void this.#poll(run), Math.max(5, a.pollSeconds) * 1000);
      this.#priceTimer = setInterval(() => void this.#readPrices().then((p) => run === this.#run && this.#set({ usdPerQuote: p })).catch(() => undefined), PRICE_REFRESH_MS);
    } catch (e) {
      if (run !== this.#run) return;
      this.#set({ status: "error", message: e instanceof Error && /API answered|fetch/i.test(e.message) ? "Couldn't reach the Gully Core API." : "Couldn't read this token's pools." });
    }
  }

  async #readPrices(): Promise<Map<string, number>> {
    try {
      const answer = await this.#json(`/prices?chain=${this.#attrs.chainId}`);
      const note = typeof answer === "object" && answer !== null && typeof (answer as { footnote?: unknown }).footnote === "string" ? ((answer as { footnote: string }).footnote ?? "") : "";
      if (note !== this.#state.priceNote) this.#state = { ...this.#state, priceNote: note };
      return pricesFromApi(answer);
    } catch {
      return new Map(this.#state.usdPerQuote);
    }
  }

  async #readPoolRows(): Promise<readonly ApiPoolRow[]> {
    const a = this.#attrs;
    if (a.target.kind === "pool") {
      const one = (await this.#json(`/chains/${a.chainId}/pools/${a.target.poolId}`)) as { data?: ApiPoolRow };
      return one.data === undefined ? [] : [one.data];
    }
    const list = (await this.#json(`/chains/${a.chainId}/pools?token=${a.target.token}&limit=50`)) as { data?: { items?: ApiPoolRow[] } };
    return list.data?.items ?? [];
  }

  async #readToken(address: Address): Promise<TokenWords> {
    const r = (await this.#json(`/tokens/${this.#attrs.chainId}/${address}`)) as { data?: { address?: string; symbol?: string | null; name?: string | null; logoUrl?: string | null } };
    const d = r.data ?? {};
    const origin = this.#attrs.api.replace(/\/v1$/, "");
    const logo = typeof d.logoUrl === "string" && d.logoUrl !== "" ? (d.logoUrl.startsWith("http") ? d.logoUrl : `${origin}${d.logoUrl}`) : null;
    return { address, symbol: d.symbol ?? address.slice(0, 8), name: d.name ?? d.symbol ?? address, logoUrl: logo };
  }

  /** The last indexed swaps of every followed pool, and the block the index had reached. */
  async #readHistory(pools: ReadonlyMap<string, FollowedPool>): Promise<{ tape: readonly TapeTrade[]; indexedTo: bigint | null }> {
    const a = this.#attrs;
    let indexedTo: bigint | null = null;
    const all: TapeTrade[] = [];
    await Promise.all(
      [...pools.values()].map(async (fp) => {
        try {
          const r = (await this.#json(`/chains/${a.chainId}/pools/${fp.pool.poolId}/swaps?limit=${HISTORY_PER_POOL}`)) as { data?: ApiSwapRow[]; provenance?: { toBlock?: string | number } };
          const to = r.provenance?.toBlock;
          if (to !== undefined && to !== null) {
            const b = BigInt(to);
            indexedTo = indexedTo === null || b < indexedTo ? b : indexedTo;
          }
          for (const s of r.data ?? []) {
            const t = tradeFromApiSwap(s, fp.pool);
            if (t !== null) all.push({ trade: t, poolId: fp.pool.poolId });
          }
        } catch {
          /* a pool the index does not hold yet: the chain poll covers it */
        }
      }),
    );
    const cap = Math.max(a.limit, HISTORY_PER_POOL) * Math.max(1, pools.size);
    return { tape: mergeTape([], all, cap).tape, indexedTo };
  }

  #rpcClient(): PublicClient {
    if (this.#client === null) this.#client = clientFor(this.#attrs.rpc ?? keylessRpcFor(this.#attrs.chainId));
    return this.#client;
  }

  async #poll(run: number): Promise<void> {
    if (run !== this.#run || this.#polling || !this.#visible()) return;
    this.#polling = true;
    try {
      const client = this.#rpcClient();
      const head = await client.getBlockNumber();
      const prev = this.#state.head;
      let from = prev === null ? head - 50n : prev + 1n;
      if (head - from > MAX_BACKFILL_BLOCKS) from = head - MAX_BACKFILL_BLOCKS;
      if (from < 0n) from = 0n;
      const incoming: TapeTrade[] = [];
      if (from <= head) {
        for (const fp of this.#state.pools.values()) {
          const raw = await readPoolTrades(client, fp.pool, { fromBlock: from, toBlock: head });
          const timed: readonly Trade[] = raw.length === 0 ? raw : await withTimestamps(client, raw, 4);
          for (const t of timed) incoming.push({ trade: t, poolId: fp.pool.poolId });
        }
      }
      if (run !== this.#run) return;
      const cap = Math.max(this.#attrs.limit, HISTORY_PER_POOL) * Math.max(1, this.#state.pools.size);
      const merged = mergeTape(this.#state.tape, incoming, cap);
      const fresh = new Set(this.#state.fresh);
      for (const k of merged.fresh) fresh.add(k);
      this.#set({ tape: merged.tape, fresh, head: head, polls: this.#state.polls + 1, stalled: 0 });
    } catch {
      if (run !== this.#run) return;
      this.#set({ stalled: this.#state.stalled + 1 });
    } finally {
      this.#polling = false;
    }
  }

  /** The poll, on demand (a "refresh" control). */
  refresh(): void {
    void this.#poll(this.#run);
  }

  /** Test seam: the hash of a pool id as the tape keys it. */
  static poolKey(poolId: Hex): string {
    return poolId.toLowerCase();
  }

  get now(): number {
    return Math.floor(this.#now() / 1000);
  }
}
