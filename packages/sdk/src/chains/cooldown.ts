import { HttpRequestError, TimeoutError, http, type HttpTransportConfig, type Transport } from 'viem'

/**
 * Endpoint COOLDOWN: an HTTP transport that stops asking an endpoint which just failed.
 *
 * WHY. `fallback` with `rank: false` restarts at endpoint 1 on EVERY request. When endpoint 1 is
 * rate-limiting (429), down (5xx) or unreachable, every read in the app pays one failed request to
 * it before reaching a provider that answers — and a page's burst of reads plus a block poller turns
 * one struggling gateway into a request storm against it, which only deepens the rate limit. Measured
 * on gullychain.xyz's /app (2026-09-25): with the first Sepolia endpoint answering 429, every
 * request went to it first, doubling the page's traffic for as long as the tab stayed open; with every
 * endpoint down, the page kept sending ~15 requests per 10 s forever.
 *
 * WHAT IT DOES. A transport failure — an HTTP error the node sent (401/403/408/429/5xx), a request
 * that never got a response, or a timeout — puts that URL in COOLDOWN: for the next `baseMs` (then
 * doubling per consecutive failure, up to `maxMs`) the transport refuses immediately without touching
 * the network, so `fallback` moves straight on to the next endpoint. One success clears it. The state
 * is per URL and module-wide, so every client and transport in the page that names the same endpoint
 * shares what was learned.
 *
 * A LIMIT ANSWERED AS JSON-RPC COOLS TOO. Some public endpoints say "not serving you" inside an
 * HTTP 200: `rpc.ordofi.network` (Robinhood) answers every call with `-32005 "the network is busy,
 * please try again in a moment"`; others say `-32005 "limit exceeded"`, `"rate limited"`, `"too many
 * requests"`. viem's `fallback` already moves on from those, but without a cooldown every later
 * request paid that endpoint first (measured ~2.7 s per call on ordofi). So a JSON-RPC error whose
 * code is a limit code (`-32005`, `-32016`, `-32029`, `-32090`, `429`) or whose message reads as a
 * rate limit / busy / quota cools the endpoint exactly like an HTTP 429 — EXCEPT on `eth_getLogs`,
 * where `-32005` is also how several providers say "too many results / range too wide" for THAT
 * request (BNB's dataseed nodes, Infura): the fallback still moves on, the endpoint stays usable for
 * reads. Mirrors `classifyFailure` in apps/api/src/router/transport.ts.
 *
 * WHAT IT DOES NOT DO. Any other RPC-level answer — a revert, "block range too large", an unknown
 * method — is the node WORKING, and never cools an endpoint. When every endpoint is cooling down the request
 * fails fast with `EndpointCoolingDownError` (an `HttpRequestError`, so callers classify it as a
 * transport failure and show their honest "unreachable" state) instead of queueing retries; the next
 * attempt after the soonest cooldown expires probes again.
 */

export interface CooldownOptions {
  /** First cooldown after a failure. Default 15 s. */
  readonly baseMs?: number
  /** Ceiling for the doubling cooldown. Default 2 min. */
  readonly maxMs?: number
  /**
   * Whether a TIMEOUT cools the endpoint. Default true. Set false for a transport that runs
   * deliberately heavy requests (a whole-history `eth_getLogs`), where a slow answer is the request's
   * size and says nothing about the endpoint's health.
   */
  readonly coolOnTimeout?: boolean
  /**
   * Requests in flight to this URL at once, across every client in the process that names it;
   * the rest queue in order. Default: no cap.
   *
   * WHY (Kinetiq Elysium, rpc.elysium.kinetiq.xyz, measured from a Gully server 2026-11-09): 60
   * simultaneous requests → 10 × HTTP 429 with no Retry-After; a sustained 5, 10 and 20 requests
   * per second → every one 200; a 50-call JSON-RPC batch → 200. The limit is CONCURRENCY, not
   * rate: a page's or the indexer's fan-out of parallel eth_calls trips it, the same calls spread
   * over a few hundred milliseconds do not. A 429 then cools the chain's ONLY endpoint for 15 s, so
   * one burst empties the swap page (5 × 429 on /app → /app/swap) and fails an index pass. A small
   * in-flight cap turns the burst into a short queue the endpoint serves.
   */
  readonly maxInFlight?: number
}

interface Health {
  fails: number
  until: number
}

const health = new Map<string, Health>()

/** Refused locally because the endpoint is in cooldown. Nothing was sent. */
export class EndpointCoolingDownError extends HttpRequestError {
  override name = 'EndpointCoolingDownError' as 'HttpRequestError'
  readonly retryAt: number
  constructor(url: string, retryAt: number) {
    super({ url, details: `endpoint cooling down after failures; next attempt after ${new Date(retryAt).toISOString()}` })
    this.retryAt = retryAt
  }
}

/** Statuses that say the ENDPOINT is not serving us, as opposed to the request being wrong. */
function coolsOnStatus(status: number | undefined): boolean {
  return status === undefined || status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

/** JSON-RPC error codes that mean "not serving you right now" rather than "this request is wrong". */
const LIMIT_CODES: ReadonlySet<number> = new Set([-32005, -32016, -32029, -32090, 429])
/** Messages that say the same in words (checked across the error's cause chain). */
const NOT_SERVING = /busy|rate.?limit|too many requests|capacity|limit exceeded|exceeded .*limit|try again (later|in a moment)|over quota|quota/i

function errCode(e: unknown): number | undefined {
  for (let x: unknown = e, i = 0; x && i < 6; i++) {
    const c = (x as { code?: unknown }).code
    if (typeof c === 'number') return c
    x = (x as { cause?: unknown }).cause
  }
  return undefined
}

function errText(e: unknown): string {
  const parts: string[] = []
  for (let x: unknown = e, i = 0; x && i < 6; i++) {
    const m = x as { details?: unknown; shortMessage?: unknown }
    if (typeof m.details === 'string') parts.push(m.details)
    if (typeof m.shortMessage === 'string') parts.push(m.shortMessage)
    x = (x as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

/** A JSON-RPC answer that is a rate limit / "busy" / quota refusal (see the header). */
export function isRpcLimitError(e: unknown): boolean {
  const code = errCode(e)
  if (code === 3) return false // a revert is an answer, whatever its message says
  if (code !== undefined && LIMIT_CODES.has(code)) return true
  return NOT_SERVING.test(errText(e))
}

function isEndpointFailure(e: unknown, coolOnTimeout: boolean, method: string | undefined): boolean {
  if (e instanceof EndpointCoolingDownError) return false
  if (e instanceof TimeoutError) return coolOnTimeout
  if (e instanceof HttpRequestError) return coolsOnStatus(e.status)
  if (method !== 'eth_getLogs' && isRpcLimitError(e)) return true
  return false
}

/** The cooldown for `url` as of now: `null` when it may be asked. */
export function endpointCooldown(url: string, now = Date.now()): { readonly until: number; readonly fails: number } | null {
  const h = health.get(url)
  return h !== undefined && now < h.until ? { until: h.until, fails: h.fails } : null
}

/** Forget every endpoint's history (tests, or a manual "retry now"). */
export function resetEndpointCooldowns(): void {
  health.clear()
}

/** The longest an endpoint's `Retry-After` is honoured for. */
export const RETRY_AFTER_MAX_MS = 30_000

/**
 * `Retry-After` (seconds, or an HTTP date) carried by an HttpRequestError on `err` or one of its causes, in ms; 0 when
 * there is none. Kinetiq Elysium (a Conduit node) answers a per-IP 429 with `Retry-After: 1` (measured from a Gully server
 * 2026-11-10); apps/api chain/budget.ts honours it the same way.
 */
export function retryAfterMs(err: unknown, now: () => number = Date.now): number {
  for (let x: unknown = err, i = 0; x !== null && typeof x === 'object' && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    const h = (x as { headers?: unknown }).headers
    const raw = typeof (h as Headers | undefined)?.get === 'function' ? (h as Headers).get('retry-after') : null
    if (raw === null || raw === undefined) continue
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(RETRY_AFTER_MAX_MS, Math.round(secs * 1000))
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at - now()))
  }
  return 0
}

/**
 * Record a failure against `url` and return the time it may be asked again. `floorMs` (an endpoint's own
 * `Retry-After`) is the least the cooldown lasts: the endpoint said when, and asking sooner is the burst again.
 */
export function noteEndpointFailure(url: string, opts: CooldownOptions = {}, now = Date.now(), floorMs = 0): number {
  const base = opts.baseMs ?? 15_000
  const max = opts.maxMs ?? 120_000
  const h = health.get(url) ?? { fails: 0, until: 0 }
  /* Already cooling: a sibling request from the same burst failed first. One outage is one failure,
     not one per request in flight — escalating per request put a page's first burst of ~20 reads
     straight onto the 2-minute ceiling. The endpoint's own floor still extends it. */
  if (now < h.until) {
    if (floorMs > 0 && now + floorMs > h.until) {
      h.until = now + floorMs
      health.set(url, h)
    }
    return h.until
  }
  h.fails += 1
  h.until = now + Math.max(floorMs, Math.min(max, base * 2 ** (h.fails - 1)))
  health.set(url, h)
  return h.until
}

/* ------------------------------------------------------------- in-flight cap --- */

interface Slot {
  active: number
  readonly queue: (() => void)[]
}

/** Per URL, module-wide: every transport in the process that names the endpoint shares one queue. */
const slots = new Map<string, Slot>()

/** Requests to `url` in flight right now (tests, diagnostics). */
export function endpointInFlight(url: string): number {
  return slots.get(url)?.active ?? 0
}

/** Run `fn` once fewer than `max` requests to `url` are in flight; FIFO otherwise. */
async function withEndpointSlot<T>(url: string, max: number, fn: () => Promise<T>): Promise<T> {
  let s = slots.get(url)
  if (s === undefined) {
    s = { active: 0, queue: [] }
    slots.set(url, s)
  }
  const slot = s
  if (slot.active >= max) await new Promise<void>((resolve) => slot.queue.push(resolve))
  slot.active += 1
  try {
    return await fn()
  } finally {
    slot.active -= 1
    slot.queue.shift()?.()
  }
}

/** viem `http(url)` with endpoint cooldown (and, with `maxInFlight`, an in-flight cap). Drop-in inside a `fallback([...])`. */
export function cooledHttp(url: string, config: HttpTransportConfig = {}, opts: CooldownOptions = {}): Transport {
  const inner = http(url, config)
  const coolOnTimeout = opts.coolOnTimeout ?? true
  const max = opts.maxInFlight !== undefined && opts.maxInFlight > 0 ? Math.floor(opts.maxInFlight) : null
  return ((params: Parameters<typeof inner>[0]) => {
    const t = inner(params)
    const send = async (args: unknown, options: unknown): Promise<unknown> => {
      /* Checked AFTER the queue as well as before it: a request that waited behind a burst must not be
         the one that finds out the endpoint has since started refusing. */
      const cooling = endpointCooldown(url)
      if (cooling !== null) throw new EndpointCoolingDownError(url, cooling.until)
      try {
        const out = await (t.request as (a: unknown, o: unknown) => Promise<unknown>)(args, options)
        health.delete(url)
        return out
      } catch (e) {
        if (isEndpointFailure(e, coolOnTimeout, (args as { method?: string } | undefined)?.method)) noteEndpointFailure(url, opts, Date.now(), retryAfterMs(e))
        throw e
      }
    }
    const request = (async (args: unknown, options: unknown) => {
      const cooling = endpointCooldown(url)
      if (cooling !== null) throw new EndpointCoolingDownError(url, cooling.until)
      return max === null ? send(args, options) : withEndpointSlot(url, max, () => send(args, options))
    }) as typeof t.request
    return { ...t, request }
  }) as Transport
}
