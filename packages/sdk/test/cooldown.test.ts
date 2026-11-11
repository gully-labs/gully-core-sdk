import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, fallback, HttpRequestError } from 'viem'
import { cooledHttp, endpointCooldown, EndpointCoolingDownError, noteEndpointFailure, resetEndpointCooldowns, retryAfterMs, RETRY_AFTER_MAX_MS } from '../src/chains/cooldown.js'

const A = 'https://a.rpc.example/'
const B = 'https://b.rpc.example/'

type Mode = 'ok' | 429 | 503 | 'revert' | 'network' | 'busy' | 'limitText' | 'reverted' | 'retryAfter'
let modes: Record<string, Mode>
let hits: Record<string, number>

beforeEach(() => {
  resetEndpointCooldowns()
  hits = {}
  modes = { [A]: 'ok', [B]: 'ok' }
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    hits[url] = (hits[url] ?? 0) + 1
    const m = modes[url]
    const { id } = JSON.parse(init.body) as { id: number }
    if (m === 'network') throw new TypeError('Failed to fetch')
    if (m === 429 || m === 503) return new Response('nope', { status: m })
    /* Kinetiq Elysium (a Conduit node), 2026-11-10: a per-IP 429 that says when. */
    if (m === 'retryAfter') return new Response('slow down', { status: 429, headers: { 'retry-after': '25' } })
    if (m === 'revert') return Response.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'block range too large' } })
    /* rpc.ordofi.network (Robinhood), 2026-10-11: every call, HTTP 200. */
    if (m === 'busy') return Response.json({ jsonrpc: '2.0', id, error: { code: -32005, message: 'the network is busy, please try again in a moment' } })
    if (m === 'limitText') return Response.json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'rate limited' } })
    if (m === 'reverted') return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted: limit exceeded', data: '0x' } })
    return Response.json({ jsonrpc: '2.0', id, result: '0x10' })
  })
})
afterEach(() => vi.unstubAllGlobals())

const client = () =>
  createPublicClient({ transport: fallback([cooledHttp(A, { retryCount: 0 }), cooledHttp(B, { retryCount: 0 })], { rank: false, retryCount: 0 }) })

describe('endpoint cooldown', () => {
  it('stops asking a 429ing endpoint after one failure, and the fallback answers from the next', async () => {
    modes[A] = 429
    const c = client()
    for (let i = 0; i < 5; i++) expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n)
    expect(hits[A]).toBe(1)
    expect(hits[B]).toBe(5)
    expect(endpointCooldown(A)).not.toBeNull()
  })

  it('a network failure and a 5xx cool the endpoint too', async () => {
    modes[A] = 'network'
    modes[B] = 503
    const c = client()
    await expect(c.getBlockNumber({ cacheTime: 0 })).rejects.toBeInstanceOf(HttpRequestError)
    await expect(c.getBlockNumber({ cacheTime: 0 })).rejects.toBeInstanceOf(EndpointCoolingDownError)
    /* Everything cooling: the second call sent NOTHING. */
    expect(hits).toEqual({ [A]: 1, [B]: 1 })
  })

  it('an RPC-level refusal is the node working and never cools it', async () => {
    modes[A] = 'revert'
    modes[B] = 'revert'
    const c = client()
    await expect(c.request({ method: 'eth_getLogs', params: [{}] } as never)).rejects.toThrow()
    expect(endpointCooldown(A)).toBeNull()
    expect(endpointCooldown(B)).toBeNull()
  })

  it('backs off exponentially and a success clears the history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      modes[A] = 429
      const c = client()
      await c.getBlockNumber({ cacheTime: 0 })
      const first = endpointCooldown(A)!.until - Date.now()
      vi.setSystemTime(Date.now() + first + 1)
      await c.getBlockNumber({ cacheTime: 0 })
      const second = endpointCooldown(A)!.until - Date.now()
      expect(second).toBe(first * 2)
      modes[A] = 'ok'
      vi.setSystemTime(Date.now() + second + 1)
      await c.getBlockNumber({ cacheTime: 0 })
      expect(endpointCooldown(A)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('one outage is one failure', () => {
  it('a burst of concurrent failures does not escalate the cooldown', async () => {
    modes[A] = 503
    modes[B] = 503
    const c = client()
    await Promise.allSettled(Array.from({ length: 10 }, () => c.request({ method: 'eth_chainId' })))
    const cd = endpointCooldown(A)!
    expect(cd.fails).toBe(1)
    expect(cd.until - Date.now()).toBeLessThanOrEqual(15_000)
  })

  it('a -32005 "busy" answered as HTTP 200 cools the endpoint (rpc.ordofi.network)', async () => {
    modes[A] = 'busy'
    const c = client()
    for (let i = 0; i < 5; i++) expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n)
    expect(hits[A]).toBe(1)
    expect(hits[B]).toBe(5)
    expect(endpointCooldown(A)).not.toBeNull()
  })

  it('a rate limit worded in the message, under another code, cools it too', async () => {
    modes[A] = 'limitText'
    const c = client()
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n)
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n)
    expect(hits[A]).toBe(1)
  })

  it('a -32005 on eth_getLogs is about THAT request (range / result count) and does not cool reads', async () => {
    modes[A] = 'busy'
    const c = client()
    expect(await c.request({ method: 'eth_getLogs', params: [{}] } as never)).toBe('0x10')
    expect(endpointCooldown(A)).toBeNull()
  })

  it('a revert whose reason mentions a limit is an answer, never a cooldown', async () => {
    modes[A] = 'reverted'
    const c = client()
    await expect(c.request({ method: 'eth_call', params: [{}, 'latest'] } as never)).rejects.toThrow()
    expect(endpointCooldown(A)).toBeNull()
  })
})

describe('in-flight cap (maxInFlight)', () => {
  it('never has more than `maxInFlight` requests to one URL open at once, and serves the rest in order', async () => {
    const { cooledHttp: capped, endpointInFlight } = await import('../src/chains/cooldown.js')
    let open = 0
    let peak = 0
    let sent = 0
    const release: (() => void)[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent += 1
      open += 1
      peak = Math.max(peak, open)
      const { id } = JSON.parse(init.body) as { id: number }
      await new Promise<void>((r) => release.push(r))
      open -= 1
      return Response.json({ jsonrpc: '2.0', id, result: '0x10' })
    })
    const c = createPublicClient({ transport: capped(A, { retryCount: 0 }, { maxInFlight: 3 }) })
    /* Ten DISTINCT requests: viem de-duplicates identical ones in flight, which would hide the cap. */
    const all = Promise.all(Array.from({ length: 10 }, (_, i) => c.getBalance({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` })))
    /* Let the first wave start: exactly three are on the wire, seven wait in the queue. */
    for (let i = 0; i < 5 && release.length < 3; i++) await new Promise((r) => setTimeout(r, 5))
    expect(release.length).toBe(3)
    expect(endpointInFlight(A)).toBe(3)
    while (release.length > 0 || endpointInFlight(A) > 0) {
      release.shift()?.()
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(await all).toHaveLength(10)
    expect(peak).toBe(3)
    expect(sent).toBe(10)
  })

  it('a request that queued behind a burst is refused locally once the endpoint has started cooling', async () => {
    const { cooledHttp: capped } = await import('../src/chains/cooldown.js')
    let release: (() => void) | null = null
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: number }
      if (release === null) {
        await new Promise<void>((r) => (release = r))
        return new Response('nope', { status: 429 })
      }
      return Response.json({ jsonrpc: '2.0', id, result: '0x10' })
    })
    const c = createPublicClient({ transport: capped(A, { retryCount: 0 }, { maxInFlight: 1 }) })
    const first = c.getBalance({ address: `0x${'1'.padStart(40, '0')}` })
    const second = c.getBalance({ address: `0x${'2'.padStart(40, '0')}` })
    for (let i = 0; i < 5 && release === null; i++) await new Promise((r) => setTimeout(r, 5))
    ;(release as unknown as () => void)()
    await expect(first).rejects.toBeInstanceOf(HttpRequestError)
    await expect(second).rejects.toBeInstanceOf(EndpointCoolingDownError)
  })
})

describe('an endpoint that says when (Retry-After)', () => {
  it('its Retry-After is the floor of the cooldown, above the 15 s base; capped at 30 s', async () => {
    modes[A] = 'retryAfter'
    const c = client()
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n)
    const cd = endpointCooldown(A)!
    expect(cd.until - Date.now()).toBeGreaterThan(20_000)
    expect(cd.until - Date.now()).toBeLessThanOrEqual(25_000)
  })

  it('retryAfterMs reads seconds and an HTTP date off the error or its causes, 0 when absent', () => {
    const now = () => Date.UTC(2026, 10, 10, 12, 0, 0)
    expect(retryAfterMs(new HttpRequestError({ url: A, status: 429, headers: new Headers({ 'retry-after': '2' }) }))).toBe(2_000)
    expect(retryAfterMs(new HttpRequestError({ url: A, status: 429, headers: new Headers({ 'retry-after': '120' }) }))).toBe(RETRY_AFTER_MAX_MS)
    expect(retryAfterMs(new HttpRequestError({ url: A, status: 429, headers: new Headers({ 'retry-after': new Date(now() + 5_000).toUTCString() }) }), now)).toBe(5_000)
    expect(retryAfterMs(new Error('x'))).toBe(0)
    expect(retryAfterMs({ cause: new HttpRequestError({ url: A, status: 429, headers: new Headers({ 'retry-after': '3' }) }) })).toBe(3_000)
  })

  it('a floor extends a cooldown already running when the endpoint asks for longer', () => {
    resetEndpointCooldowns()
    const t = 1_000_000
    expect(noteEndpointFailure(A, { baseMs: 1_000 }, t)).toBe(t + 1_000)
    expect(noteEndpointFailure(A, { baseMs: 1_000 }, t + 100, 5_000)).toBe(t + 5_100)
    expect(noteEndpointFailure(A, { baseMs: 1_000 }, t + 200, 500)).toBe(t + 5_100)
  })
})
