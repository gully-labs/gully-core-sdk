import { describe, expect, it } from 'vitest'
import { isLocalRpcUrl, gullycoreTransport, resolveEndpoints, resolveLogEndpoints } from '../src/index.js'

const RH = 4663
const env = (url: string) => ({ [`GULLYCORE_RPC_${RH}`]: url })

describe('a supplied RPC and the public safety net', () => {
  it('a LOCAL supplied RPC is used alone by default — a devnet never falls through to the real chain', () => {
    for (const u of ['http://127.0.0.1:8545', 'http://localhost:8545', 'http://192.168.1.20:8545', 'http://10.0.0.5:8545', 'http://anvil.localhost', 'http://[::1]:8545']) {
      expect(resolveEndpoints(RH, env(u))).toEqual([u])
      expect(resolveLogEndpoints(RH, env(u))).toEqual([u])
    }
  })

  it('a remote keyed RPC keeps the public list behind it by default (unchanged behaviour)', () => {
    const urls = resolveEndpoints(RH, env('https://rh.example-provider.io/v2/key'))
    expect(urls[0]).toBe('https://rh.example-provider.io/v2/key')
    expect(urls.length).toBeGreaterThan(1)
  })

  it('publicFallback: false makes any supplied RPC exclusive; true keeps the net behind a local node on purpose', () => {
    expect(resolveEndpoints(RH, env('https://rh.example-provider.io/v2/key'), { publicFallback: false })).toEqual(['https://rh.example-provider.io/v2/key'])
    expect(resolveEndpoints(RH, env('http://127.0.0.1:8545'), { publicFallback: true }).length).toBeGreaterThan(1)
    /* With nothing supplied the option cannot empty the list. */
    expect(resolveEndpoints(RH, {}, { publicFallback: false }).length).toBeGreaterThan(0)
  })

  it('gullycoreTransport carries the option through', () => {
    const t = gullycoreTransport(RH, { env: env('https://rh.example-provider.io/v2/key'), publicFallback: false })({ chain: undefined })
    expect(t.value?.transports.length).toBe(1)
    const local = gullycoreTransport(RH, { env: env('http://127.0.0.1:8545') })({ chain: undefined })
    expect(local.value?.transports.length).toBe(1)
  })

  it('isLocalRpcUrl knows a public host from a private one', () => {
    expect(isLocalRpcUrl('https://rpc.mainnet.chain.robinhood.com')).toBe(false)
    expect(isLocalRpcUrl('http://172.20.0.3:8545')).toBe(true)
    expect(isLocalRpcUrl('http://172.32.0.3:8545')).toBe(false)
    expect(isLocalRpcUrl('not a url')).toBe(false)
  })
})
