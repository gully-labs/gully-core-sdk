// SPDX-License-Identifier: MIT
/* ============================================================================
   The market-cap seam, tested where it is testable: strings in, strings out,
   no chain, no clock, no React.

   Run with `npm run test` in the Gully Core app (`node --test`, no test runner added —
   Node 24 strips the types itself). The SDK's own integer arithmetic is tested
   in packages/sdk; what is tested HERE is the wiring the wizards depend on, and
   in particular the two numbers the launch rules name by hand:

     - a $3,500 cap on a 1e9 supply at $3,500/ETH is 0.000000001 ETH per token;
     - a 5 ETH cap on a 1e9 supply is 0.000000005 — "one zero out is 10x,
       permanent, and the LP is locked forever".

   Plus the no-USD path, which is a NORMAL outcome rather than a failure — every
   testnet (Sepolia's feed prices real ether, which is the most misleading kind
   of true), the four surveyed chains that have a Pyth feed id but no verified
   Pyth contract, any chain outside the survey, and any pool quoted in something
   other than the chain's native currency. It must produce a usable price with
   no dollar figure anywhere in it.
   ============================================================================ */

import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CAP_CHIPS_USD,
  DEFAULT_CAP_USD_TEXT,
  capFromPrice,
  capUnitKey,
  decimalToRaw,
  defaultCapPatch,
  formatCap,
  priceFromCap,
  rawToDecimal,
  reconcileCapLeg,
  syncCapAndPrice,
  type CapContext,
  type CapLegState,
  type CapUnit,
  type LegCapUnit,
} from './marketCap'

/** 1,000,000,000 whole tokens at 18 decimals — the wizards' default supply. */
const SUPPLY_1E9: CapContext = { totalSupply: 10n ** 27n, tokenDecimals: 18 }
/** $3,500.00000000 per native unit, in a Chainlink feed's own shape. */
const AT_3500: CapUnit = { k: 'usd', rate: { answer: 3500n * 10n ** 8n, answerDecimals: 8 }, quoteDecimals: 18 }
const IN_ETH: CapUnit = { k: 'quote', symbol: 'ETH', quoteDecimals: 18 }

const value = (r: ReturnType<typeof priceFromCap>): string => {
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  return r.ok ? r.value : ''
}
const error = (r: ReturnType<typeof priceFromCap>): string => {
  assert.equal(r.ok, false, 'expected a refusal')
  return r.ok ? '' : r.error
}

/* ------------------------------------------------------------ string <-> raw */

test('decimalToRaw reads a plain decimal, truncating below the quote decimals', () => {
  assert.equal(decimalToRaw('1', 18), 10n ** 18n)
  assert.equal(decimalToRaw('0.000000005', 18), 5_000_000_000n)
  assert.equal(decimalToRaw('.5', 6), 500_000n)
  assert.equal(decimalToRaw('1.2345678', 6), 1_234_567n, 'truncates, never rounds up')
  assert.equal(decimalToRaw('0.0000001', 6), 0n, 'below one raw unit is a real zero, not an error')
})

test('decimalToRaw reads the exponential notation the SDK prints', () => {
  /* `toPrecision(8)` emits this for any price under 1e-7, which is every
     1e9-supply launch. viem's parseUnits rejects it outright. */
  assert.equal(decimalToRaw('5.0000000e-9', 18), 5_000_000_000n)
  assert.equal(decimalToRaw('1e-9', 18), 10n ** 9n)
  assert.equal(decimalToRaw('1.5E3', 0), 1500n)
})

test('decimalToRaw refuses what is not a non-negative number', () => {
  for (const bad of ['', ' ', 'abc', '-1', '1.2.3', '0x10', '1e', 'Infinity', 'NaN']) {
    assert.equal(decimalToRaw(bad, 18), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('rawToDecimal never prints exponential notation and trims trailing zeros', () => {
  assert.equal(rawToDecimal(5_000_000_000n, 18), '0.000000005')
  assert.equal(rawToDecimal(10n ** 18n, 18), '1')
  assert.equal(rawToDecimal(0n, 18), '0')
  assert.equal(rawToDecimal(350_000n, 2), '3500')
  assert.equal(rawToDecimal(349_997n, 2), '3499.97')
})

/* ------------------------------------------------------------- the USD path */

test('a $3,500 cap on a 1e9 supply at $3,500/ETH is 0.000000001 ETH per token', () => {
  assert.equal(value(priceFromCap('3500', AT_3500, SUPPLY_1E9)), '0.000000001')
})

test('the default is the decided value, and it is the SDK constant', () => {
  assert.equal(DEFAULT_CAP_USD_TEXT, '3500')
  assert.ok(
    CAP_CHIPS_USD.some((c) => c.text === DEFAULT_CAP_USD_TEXT),
    'the default must be one of the chips a creator can see themselves moving away from',
  )
})

test('typing a price gives back the cap it implies', () => {
  assert.equal(value(capFromPrice('0.000000001', AT_3500, SUPPLY_1E9)), '3500')
  assert.equal(value(capFromPrice('0.00000001', AT_3500, SUPPLY_1E9)), '35000', 'one zero out is 10x')
})

test('round-tripping is an inequality, never an equality', () => {
  /* A rate that does not divide cleanly, so the "down" rounding actually bites. */
  const odd: CapUnit = { k: 'usd', rate: { answer: 3333_33333333n, answerDecimals: 8 }, quoteDecimals: 18 }
  for (const target of ['3500', '1000', '10000', '50000', '7777.77']) {
    const price = value(priceFromCap(target, odd, SUPPLY_1E9))
    const back = value(capFromPrice(price, odd, SUPPLY_1E9))
    assert.ok(decimalToRaw(back, 2)! <= decimalToRaw(target, 2)!, `${back} must not exceed ${target}`)
  }
})

test('a six-decimal quote quantises HARD, and the round-tripped cap is the one that is true', () => {
  /* USDC-style: $1.00 per unit, 6 decimals. $3,500 over 1e9 tokens works out at
     3.5 RAW units per token, and a raw unit is indivisible — so the pool opens at
     3, i.e. $3,000, a 14% miss that has nothing to do with the tick snap. This is
     the single strongest argument for showing the round-tripped figure rather
     than the target: on this quote the target is simply not attainable. */
  const usdc: CapUnit = { k: 'usd', rate: { answer: 1_0000_0000n, answerDecimals: 8 }, quoteDecimals: 6 }
  const price = value(priceFromCap('3500', usdc, SUPPLY_1E9))
  assert.equal(price, '0.000003')
  assert.equal(value(capFromPrice(price, usdc, SUPPLY_1E9)), '3000')
})

/* -------------------------------------------- the no-feed path (tier 4) */

test('with no USD source the cap is denominated in the quote and the maths is the same', () => {
  /* The exact figure creators are warned they mistype. */
  assert.equal(value(priceFromCap('5', IN_ETH, SUPPLY_1E9)), '0.000000005')
  assert.equal(value(capFromPrice('0.000000005', IN_ETH, SUPPLY_1E9)), '5')
})

test('the no-feed path never needs a rate, so it cannot smuggle one in', () => {
  /* `IN_ETH` carries no `rate` field at all — the type makes a dollar figure
     unconstructible on this path rather than merely discouraged. */
  assert.equal('rate' in IN_ETH, false)
})

test('a quote-denominated cap formats with its symbol and no dollar sign', () => {
  assert.equal(formatCap('5', IN_ETH), '5 ETH')
  assert.equal(formatCap('0.000000005', IN_ETH), '0.000000005 ETH')
  assert.equal(formatCap('1234.5', IN_ETH), '1,234.5 ETH')
  assert.ok(!formatCap('5', IN_ETH).includes('$'))
})

/* ------------------------------------------------------------- refusals */

test('an empty, zero or unparseable cap is refused with a sentence, not a zero price', () => {
  assert.match(error(priceFromCap('', AT_3500, SUPPLY_1E9)), /market cap/i)
  assert.match(error(priceFromCap('0', AT_3500, SUPPLY_1E9)), /more than zero/i)
  assert.match(error(priceFromCap('abc', AT_3500, SUPPLY_1E9)), /dollars/i)
  assert.match(error(priceFromCap('abc', IN_ETH, SUPPLY_1E9)), /ETH/)
})

test('a cap that works out below one raw quote unit per token is refused, not opened at zero', () => {
  const usdg: CapUnit = { k: 'usd', rate: { answer: 1_0000_0000n, answerDecimals: 8 }, quoteDecimals: 6 }
  const huge: CapContext = { totalSupply: 10n ** 48n, tokenDecimals: 18 }
  assert.match(error(priceFromCap('3500', usdg, huge)), /below one unit/i)
})

test('a missing supply is refused before any arithmetic', () => {
  const none: CapContext = { totalSupply: 0n, tokenDecimals: 18 }
  assert.match(error(priceFromCap('3500', AT_3500, none)), /total supply/i)
  assert.match(error(capFromPrice('0.000000001', AT_3500, none)), /total supply/i)
})

/* --------------------------------------------------------- the two-way link */

test('the cap drives the price while the cap is primary, and the reverse after a price edit', () => {
  assert.deepEqual(syncCapAndPrice({ price: '', marketCap: '3500', capPrimary: true }, AT_3500, SUPPLY_1E9), { price: '0.000000001' })
  assert.deepEqual(syncCapAndPrice({ price: '0.00000001', marketCap: '', capPrimary: false }, AT_3500, SUPPLY_1E9), { marketCap: '35000' })
})

test('the link settles: once the two agree it returns null, so an effect cannot feed itself', () => {
  assert.equal(syncCapAndPrice({ price: '0.000000001', marketCap: '3500', capPrimary: true }, AT_3500, SUPPLY_1E9), null)
  assert.equal(syncCapAndPrice({ price: '0.000000001', marketCap: '3500', capPrimary: false }, AT_3500, SUPPLY_1E9), null)
})

test('changing the supply moves the PRICE while the cap is primary', () => {
  /* Ten times the supply at the same $3,500 cap is a tenth of the price. The
     alternative — holding the price and silently decupling the cap — is the
     creator trap this feature exists to close. */
  const tenfold: CapContext = { totalSupply: 10n ** 28n, tokenDecimals: 18 }
  assert.deepEqual(syncCapAndPrice({ price: '0.000000001', marketCap: '3500', capPrimary: true }, AT_3500, tenfold), { price: '0.0000000001' })
})

test('a failed conversion clears the derived field instead of leaving a stale number', () => {
  assert.deepEqual(syncCapAndPrice({ price: '0.000000001', marketCap: '', capPrimary: true }, AT_3500, SUPPLY_1E9), { price: '' })
  assert.deepEqual(syncCapAndPrice({ price: 'not a number', marketCap: '3500', capPrimary: false }, AT_3500, SUPPLY_1E9), { marketCap: '' })
})

test('switching a leg from dollars to its quote currency re-expresses the same price', () => {
  /* The unit changes when a creator picks a stock quote, or when the feed read
     settles as unavailable. With the PRICE primary the number they chose
     survives and only its denomination changes. */
  const link = { price: '0.000000005', marketCap: '17.5', capPrimary: false }
  assert.deepEqual(syncCapAndPrice(link, IN_ETH, SUPPLY_1E9), { marketCap: '5' })
})

/* ------------------------------------------------------------ formatting */

test('a dollar cap prints exactly, because the snapped cents are the point', () => {
  assert.equal(formatCap('3500', AT_3500), '$3,500.00')
  assert.equal(formatCap('3499.97', AT_3500), '$3,499.97')
  assert.equal(formatCap('1250000', AT_3500), '$1,250,000.00')
  assert.equal(formatCap('0.42', AT_3500), '$0.42')
})

/* ------------------------------------------- one leg, as a wizard holds it */

const NATIVE = '0x0000000000000000000000000000000000000000'
const STOCK = '0x1111111111111111111111111111111111111111'
const IN_STOCK: CapUnit = { k: 'quote', symbol: 'NVDA', quoteDecimals: 18 }
const PENDING: LegCapUnit = { pending: true }
const ready = (unit: CapUnit, quote: string): LegCapUnit => ({ pending: false, unit, key: capUnitKey(unit, quote) })
const USD_NATIVE = ready(AT_3500, NATIVE)
const ETH_NATIVE = ready(IN_ETH, NATIVE)
const FRESH: CapLegState = { marketCap: '', price: '', capPrimary: true, capUnitKey: '' }
/** Apply patches until the leg settles, the way the wizard's effect does; fails if it never does. */
function settle(leg: CapLegState, u: LegCapUnit, first = true): CapLegState {
  let cur = leg
  for (let i = 0; i < 6; i++) {
    const patch = reconcileCapLeg(cur, u, SUPPLY_1E9, { first })
    if (patch === null) return cur
    cur = { ...cur, ...patch }
  }
  assert.fail('the leg never settled: the effect would feed itself')
}

test('the tag names the quote by ADDRESS, so two tokens sharing a symbol are two units', () => {
  assert.equal(capUnitKey(AT_3500, NATIVE), `usd:${NATIVE}:18`)
  assert.equal(capUnitKey(IN_ETH, NATIVE.toUpperCase().replace('0X', '0x')), `quote:${NATIVE}:18`)
  assert.notEqual(capUnitKey(IN_STOCK, STOCK), capUnitKey(IN_STOCK, NATIVE))
})

test('a new launch defaults to $3,500, and the price sent is derived from that cap', () => {
  const seed = defaultCapPatch(FRESH, USD_NATIVE)
  assert.deepEqual(seed, { marketCap: '3500', capPrimary: true })
  const leg = settle({ ...FRESH, ...seed }, USD_NATIVE)
  assert.equal(leg.marketCap, DEFAULT_CAP_USD_TEXT)
  assert.equal(leg.capPrimary, true)
  assert.equal(leg.price, '0.000000001', '$3,500 over 1e9 tokens at $3,500/ETH')
  assert.equal(leg.capUnitKey, `usd:${NATIVE}:18`)
})

test('while the dollar rate is still being read nothing is seeded and nothing is derived', () => {
  assert.equal(defaultCapPatch(FRESH, PENDING), null)
  assert.equal(reconcileCapLeg(FRESH, PENDING, SUPPLY_1E9, { first: true }), null)
  /* The case that used to go wrong: a kept "$3,500" read as 3,500 ETH while the read was in flight. */
  const kept: CapLegState = { marketCap: '3500', price: '0.000000001', capPrimary: true, capUnitKey: `usd:${NATIVE}:18` }
  assert.equal(reconcileCapLeg(kept, PENDING, SUPPLY_1E9, { first: true }), null)
})

test('with no dollar source there is no default at all: never a round native number', () => {
  assert.equal(defaultCapPatch(FRESH, ETH_NATIVE), null)
  const leg = settle(FRESH, ETH_NATIVE)
  assert.equal(leg.marketCap, '')
  assert.equal(leg.price, '', 'an empty price is what stops the launch until a cap is typed')
})

test('the default is not laid over a number the creator already has', () => {
  assert.equal(defaultCapPatch({ ...FRESH, marketCap: '10000' }, USD_NATIVE), null)
  assert.equal(defaultCapPatch({ ...FRESH, price: '0.000000002', capPrimary: false }, USD_NATIVE), null)
})

test('a kept $3,500 draft reopens at $3,500 at the CURRENT rate, not at the rate it was typed at', () => {
  const kept: CapLegState = { marketCap: '3500', price: '0.000000001', capPrimary: true, capUnitKey: `usd:${NATIVE}:18` }
  const at1750: CapUnit = { k: 'usd', rate: { answer: 1750n * 10n ** 8n, answerDecimals: 8 }, quoteDecimals: 18 }
  const leg = settle(kept, ready(at1750, NATIVE))
  assert.equal(leg.marketCap, '3500')
  assert.equal(leg.capPrimary, true)
  assert.equal(leg.price, '0.000000002', 'half the rate, twice the native price, the same dollars')
})

test('a draft kept in dollars and reopened with NO dollar source keeps its price, never its number', () => {
  const kept: CapLegState = { marketCap: '3500', price: '0.000000001', capPrimary: true, capUnitKey: `usd:${NATIVE}:18` }
  const leg = settle(kept, ETH_NATIVE)
  assert.equal(leg.price, '0.000000001')
  assert.equal(leg.marketCap, '1', 'one ETH, which is what that price is worth; "3500 ETH" is the error')
  assert.equal(leg.capPrimary, false)
  assert.equal(leg.capUnitKey, `quote:${NATIVE}:18`)
})

test('a draft from before the tag existed is held to its price', () => {
  const old: CapLegState = { marketCap: '3500', price: '0.000000001', capPrimary: true, capUnitKey: '' }
  const leg = settle(old, ETH_NATIVE)
  assert.equal(leg.price, '0.000000001')
  assert.equal(leg.marketCap, '1')
})

test('the rate arriving later re-expresses a typed native cap in dollars at the same price', () => {
  const typed = settle({ ...FRESH, marketCap: '2' }, ETH_NATIVE)
  assert.equal(typed.price, '0.000000002')
  const leg = settle(typed, USD_NATIVE)
  assert.equal(leg.price, '0.000000002', 'the pool the creator chose is unchanged')
  assert.equal(leg.marketCap, '7000')
  assert.equal(leg.capPrimary, false)
})

test('changing the PAIR drops both numbers: a price in one token is not a price in another', () => {
  const inEth = settle({ ...FRESH, marketCap: '3500' }, USD_NATIVE)
  const toStock = settle({ ...inEth }, ready(IN_STOCK, STOCK))
  assert.equal(toStock.marketCap, '')
  assert.equal(toStock.price, '', 'nothing carries over, so nothing opens at a number nobody chose')
  assert.equal(toStock.capUnitKey, `quote:${STOCK}:18`)
  /* Back to the native pair with dollars available: the first pool returns to the default. */
  const typedStock = settle({ ...toStock, marketCap: '40' }, ready(IN_STOCK, STOCK))
  assert.equal(typedStock.price, '0.00000004')
  const back = settle(typedStock, USD_NATIVE)
  assert.equal(back.marketCap, DEFAULT_CAP_USD_TEXT)
  assert.equal(back.price, '0.000000001')
  assert.equal(back.capPrimary, true)
})

test('a later pool whose pair changed is left empty, not given the first pool\'s default', () => {
  const second = settle({ ...FRESH, marketCap: '40' }, ready(IN_STOCK, STOCK), false)
  const leg = settle(second, USD_NATIVE, false)
  assert.equal(leg.marketCap, '')
  assert.equal(leg.price, '')
})

test('nothing is reconciled against a supply that is not set', () => {
  const none: CapContext = { totalSupply: 0n, tokenDecimals: 18 }
  assert.equal(reconcileCapLeg({ ...FRESH, marketCap: '3500' }, USD_NATIVE, none, { first: true }), null)
})
