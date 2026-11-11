// SPDX-License-Identifier: MIT
/* ============================================================================
   Market cap <-> opening price, as the launch wizards hold them.

   The template's own copy of Gully Core's market-cap seam (MIT), with one
   addition: every entry point takes the TENANT'S default cap
   (`launch.defaultOpeningMarketCapUsd`) where the dapp uses the SDK's.

   WHY THIS FILE EXISTS. The SDK (`@gullylabs/core-sdk` `./price`) owns the
   arithmetic and owns it in exact integers: `openingPriceFromMarketCap` and
   its three siblings. What it does NOT own is the shape the wizards keep their
   numbers in — a decimal STRING, because that is what an `<input>` holds and
   what `LegDraftV2.quotePerLaunchToken` takes. This module is the seam: string
   in, string out, with the SDK's bigints in the middle and no floating point
   anywhere on the path.

   `Number` appears in this file exactly twice, both times as a decimals COUNT.
   Never as a value. `Number("0.000000005") * 1e9` is the class of mistake the
   design decision (2026-09-20) exists to remove, and reintroducing it
   here would remove it from the creator and hand it to us.

   WHAT "PRICE" MEANS, restated because every off-by-10^18 starts here:
     - THE SDK's `price` is RAW quote units per ONE WHOLE token.
     - THIS FILE's price strings are WHOLE quote per ONE WHOLE token, e.g.
       "0.000000005" — what the wizard's price field shows and what the kit
       builder parses.
   `rawToDecimal(raw, quoteDecimals)` and `decimalToRaw` are the only crossing.

   ROUND-TRIPPING IS AN INEQUALITY, NOT AN EQUALITY. Both SDK conversions round
   DOWN, so `capFromPrice(priceFromCap(t)) <= t`. On top of that the kit SNAPS
   the price onto a CL range edge or a Bin `activeId`, which moves it by far
   more than the rounding. So a screen shows the target while it is being typed
   and the SNAPPED figure as the answer — never the target as the answer. Every
   caller here gets a `CapUnit` and is expected to feed it the SNAPPED price
   (`BuiltLaunchV2.legs[i].openingPrice`) for the readout.

   NOTHING HERE READS A CHAIN OR A CLOCK, so it is testable to the last unit and
   is tested that way (`marketCap.test.ts`).
   ============================================================================ */

import {
  DEFAULT_OPENING_MARKET_CAP_USD,
  marketCapFromOpeningPrice,
  nativeMarketCapFromOpeningPrice,
  openingPriceFromMarketCap,
  openingPriceFromNativeMarketCap,
  type NativeUsdRate,
  type UsdAmount,
} from '@gullylabs/core-sdk'

/* ------------------------------------------------------------ string <-> raw */

/**
 * A decimal string to raw integer units, truncating anything below `decimals`.
 *
 * Accepts what a user types AND what the SDK prints: `toPrecision(8)` emits
 * exponential notation below 1e-7 ("5.0000000e-9"), which `viem`'s `parseUnits`
 * rejects outright — so the snapped opening price of any 1e9-supply launch would
 * be unreadable without this. Rejects a negative, an empty string and anything
 * that is not a number; returns `null` rather than throwing, because every
 * caller is a keystroke handler.
 */
export function decimalToRaw(value: string, decimals: number): bigint | null {
  const s = value.trim()
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (m === null) return null
  const int = m[1] ?? ''
  const frac = m[2] ?? ''
  if (int === '' && frac === '') return null
  const exp = m[3] === undefined ? 0 : Number(m[3])
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1000) return null
  /* Shift the point by `exp`, then by `decimals`, in one move on the digit string. */
  const digits = `${int}${frac}`
  const shift = exp - frac.length + decimals
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift)
  const drop = -shift
  return drop >= digits.length ? 0n : BigInt(digits.slice(0, digits.length - drop))
}

/** Raw integer units back to a plain decimal string — never exponential, trailing zeros trimmed. */
export function rawToDecimal(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = (decimals === 0 ? '' : digits.slice(digits.length - decimals)).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`
}

/* ------------------------------------------------------------------- units */

/**
 * What a market cap on this leg is DENOMINATED in.
 *
 * `usd` requires a resolved native/USD answer AND a natively-quoted leg: the
 * resolver prices the chain's NATIVE currency, and nothing in this repo prices a
 * stock token or an arbitrary ERC-20. A leg quoted in anything else is therefore
 * `quote` — a cap in the quote currency, with NO dollar figure rendered, which is
 * the same honest outcome as a chain with no feed at all.
 */
export type CapUnit =
  | { readonly k: 'usd'; readonly rate: NativeUsdRate; readonly quoteDecimals: number }
  | { readonly k: 'quote'; readonly symbol: string; readonly quoteDecimals: number }

/** Everything a conversion needs about the token being launched. */
export interface CapContext {
  /** Raw token units, i.e. `parseUnits(totalSupply, 18)`. Must be positive. */
  readonly totalSupply: bigint
  readonly tokenDecimals: number
}

export type CapResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string }

const fail = (error: string): CapResult => ({ ok: false, error })

/* ------------------------------------------------------------- conversions */

/**
 * The opening price (whole quote per whole token, as a decimal string) that
 * makes `totalSupply` worth `cap`.
 *
 * A zero from the SDK is a real answer and is surfaced as an error here: a cap
 * that works out below one raw quote unit per token cannot be opened at all, and
 * a pool born at a price of zero is not a thing. Saying so is the whole point of
 * the feature.
 */
export function priceFromCap(cap: string, unit: CapUnit, ctx: CapContext): CapResult {
  if (cap.trim() === '') return fail('Enter an opening market cap.')
  if (ctx.totalSupply <= 0n) return fail('Set a total supply first.')
  let raw: bigint
  try {
    if (unit.k === 'usd') {
      const amount = decimalToRaw(cap, 2)
      if (amount === null) return fail('The market cap must be an amount in dollars.')
      if (amount === 0n) return fail('The market cap must be more than zero.')
      raw = openingPriceFromMarketCap({
        usdTarget: { amount, decimals: 2 },
        totalSupply: ctx.totalSupply,
        tokenDecimals: ctx.tokenDecimals,
        quoteUsd: unit.rate,
        quoteDecimals: unit.quoteDecimals,
      })
    } else {
      const quoteTarget = decimalToRaw(cap, unit.quoteDecimals)
      if (quoteTarget === null) return fail(`The market cap must be an amount in ${unit.symbol}.`)
      if (quoteTarget === 0n) return fail('The market cap must be more than zero.')
      raw = openingPriceFromNativeMarketCap({ quoteTarget, totalSupply: ctx.totalSupply, tokenDecimals: ctx.tokenDecimals })
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  if (raw <= 0n) {
    return fail('That market cap works out below one unit of the quote per token — raise it, or cut the supply.')
  }
  return { ok: true, value: rawToDecimal(raw, unit.quoteDecimals) }
}

/**
 * The market cap a given opening price implies, as a decimal string in the
 * unit's own denomination. Feed it the SNAPPED price for a readout.
 */
export function capFromPrice(price: string, unit: CapUnit, ctx: CapContext): CapResult {
  if (price.trim() === '') return fail('Enter an opening price.')
  if (ctx.totalSupply <= 0n) return fail('Set a total supply first.')
  const raw = decimalToRaw(price, unit.quoteDecimals)
  if (raw === null) return fail('The opening price must be a decimal number.')
  if (raw === 0n) return fail(`An opening price below one raw unit of the quote cannot be represented.`)
  try {
    if (unit.k === 'usd') {
      const usd = marketCapFromOpeningPrice({
        price: raw,
        totalSupply: ctx.totalSupply,
        tokenDecimals: ctx.tokenDecimals,
        quoteUsd: unit.rate,
        quoteDecimals: unit.quoteDecimals,
      })
      return { ok: true, value: rawToDecimal(usd.amount, usd.decimals) }
    }
    const quote = nativeMarketCapFromOpeningPrice({ price: raw, totalSupply: ctx.totalSupply, tokenDecimals: ctx.tokenDecimals })
    return { ok: true, value: rawToDecimal(quote, unit.quoteDecimals) }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/* --------------------------------------------------------- the two-way link */

/**
 * The cap field and the price field hold the same fact twice, so exactly one of
 * them is authoritative at any moment and the other is rewritten from it.
 *
 * `capPrimary` is which. It flips to `true` when the creator edits the cap (or
 * picks a chip) and to `false` when they edit the price — so a creator who types
 * a price keeps their price and watches the cap move, and a creator who chose a
 * cap keeps THAT when they change the supply or the quote. Market-cap-first is
 * the default, not the only mode.
 */
export interface CapLink {
  readonly price: string
  readonly marketCap: string
  readonly capPrimary: boolean
}

/**
 * The single field to rewrite, or `null` when the two already agree.
 *
 * Returning a patch rather than mutating is what makes this safe to run in an
 * effect: the caller writes only when something changed, so the effect cannot
 * feed itself. A conversion that fails clears the derived field instead of
 * leaving a stale number behind it — a price that no longer matches its cap is
 * exactly the silent error this feature exists to remove.
 */
export function syncCapAndPrice(s: CapLink, unit: CapUnit, ctx: CapContext): Partial<CapLink> | null {
  if (s.capPrimary) {
    const next = s.marketCap.trim() === '' ? '' : (() => { const r = priceFromCap(s.marketCap, unit, ctx); return r.ok ? r.value : '' })()
    return next === s.price ? null : { price: next }
  }
  const next = s.price.trim() === '' ? '' : (() => { const r = capFromPrice(s.price, unit, ctx); return r.ok ? r.value : '' })()
  return next === s.marketCap ? null : { marketCap: next }
}

/* ------------------------------------------------ one leg, as a wizard holds it */

/**
 * What a leg's two numbers are denominated in, as a tag the leg carries:
 * `usd:<quote address>:<quote decimals>` or `quote:<quote address>:<quote decimals>`.
 *
 * The ADDRESS, not the symbol: two tokens may share a symbol, and a number typed
 * against one must never be read against the other.
 */
export function capUnitKey(unit: CapUnit, quoteAddress: string): string {
  return `${unit.k}:${quoteAddress.toLowerCase()}:${unit.quoteDecimals}`
}

/** The quote half of a tag (`<address>:<decimals>`); `''` for a leg that was never tagged. */
function quoteOfKey(key: string): string {
  const i = key.indexOf(':')
  return i < 0 ? '' : key.slice(i + 1)
}

/** A leg's cap and price, plus the tag that says what they were written in. */
export interface CapLegState extends CapLink {
  /** `capUnitKey` of the unit these numbers were last reconciled in; `''` before the first time
      (a new leg, or a draft kept by a build that did not tag). */
  readonly capUnitKey: string
}

/**
 * The unit a leg's cap is in RIGHT NOW.
 *
 * `pending` is its own state and is not `quote`: while the native/USD read of a
 * natively quoted pool has not settled, nobody knows yet whether "3500" will
 * mean dollars or 3,500 of the native currency. Nothing is derived, seeded or
 * sent in that window (see `reconcileCapLeg`).
 */
export type LegCapUnit = { readonly pending: true } | { readonly pending: false; readonly unit: CapUnit; readonly key: string }

/**
 * The single patch that brings one leg into agreement with its unit, or `null`.
 *
 * THREE CASES, each one a way a launch used to open at a number nobody chose:
 *
 *   1. PENDING. The rate is still being read. Nothing is touched. Before this,
 *      a restored "3500" was converted as 3,500 of the native currency while the
 *      read was in flight, and the price that produced was then KEPT when the
 *      read landed: a $3,500 draft reopened at a cap a thousand times larger.
 *   2. THE PAIR CHANGED. Both numbers were in the old quote, so both are
 *      dropped: a price of 0.000000001 ETH is not 0.000000001 of anything else.
 *      The first pool falls back to the default cap where there are dollars to
 *      state it in, and is left empty, to be typed, where there are not.
 *   3. THE SAME PAIR, RE-DENOMINATED (the dollar rate arrived or went away, or
 *      the draft predates the tag). The PRICE is the fact the two units share,
 *      so it becomes the authority and the cap is rewritten from it.
 *
 * Otherwise it is `syncCapAndPrice`, and the tag is written whenever it moved.
 */
export function reconcileCapLeg(leg: CapLegState, u: LegCapUnit, ctx: CapContext, opts: { readonly first: boolean; readonly defaultCapText?: string }): Partial<CapLegState> | null {
  if (u.pending || ctx.totalSupply <= 0n) return null
  const defaultCap = opts.defaultCapText ?? DEFAULT_CAP_USD_TEXT
  const tag: Partial<CapLegState> = leg.capUnitKey === u.key ? {} : { capUnitKey: u.key }
  const hasNumber = leg.marketCap.trim() !== '' || leg.price.trim() !== ''
  let patch: Partial<CapLegState>
  if (leg.capUnitKey !== '' && quoteOfKey(leg.capUnitKey) !== quoteOfKey(u.key) && hasNumber) {
    const cleared: Partial<CapLegState> = { marketCap: opts.first && u.unit.k === 'usd' ? defaultCap : '', price: '', capPrimary: true }
    patch = { ...cleared, ...(syncCapAndPrice({ ...leg, ...cleared } as CapLink, u.unit, ctx) ?? {}) }
  } else {
    const reDenominated = leg.capPrimary && leg.capUnitKey !== u.key && leg.price.trim() !== ''
    patch = reDenominated ? { capPrimary: false, ...(syncCapAndPrice({ ...leg, capPrimary: false }, u.unit, ctx) ?? {}) } : (syncCapAndPrice(leg, u.unit, ctx) ?? {})
  }
  const out = { ...patch, ...tag }
  return Object.keys(out).length === 0 ? null : out
}

/**
 * Every leg of a form brought into agreement in ONE pass, or the SAME array when nothing moved.
 *
 * The wizards call this inside the keystroke's own state update, so the cap/price link is settled
 * before the commit and their reconcile effect finds nothing to write. That matters beyond one
 * render: a follow-up render scheduled from an effect after every keystroke is what let a fast
 * typist pile up nested updates until React threw #185 (Maximum update depth). The guarantee the
 * callers rely on, and `marketCap.test.ts` checks: one pass reaches the fixed point, so a second
 * pass returns its input unchanged. `units[i]` null = that leg's quote is still being read.
 */
export function reconcileCapLegs<L extends CapLegState>(legs: readonly L[], units: readonly (LegCapUnit | null | undefined)[], ctx: CapContext, defaultCapText?: string): readonly L[] {
  let changed = false
  const out = legs.map((leg, i) => {
    const u = units[i]
    if (u === undefined || u === null) return leg
    const p = reconcileCapLeg(leg, u, ctx, { first: i === 0, ...(defaultCapText === undefined ? {} : { defaultCapText }) })
    if (p === null) return leg
    changed = true
    return { ...leg, ...p }
  })
  return changed ? out : legs
}

/** Said while the native/USD read is in flight: until it lands nobody knows what unit a cap is in. */
export const CAP_PENDING_TEXT = 'reading the dollar price, so the opening market cap can be set…'

/**
 * The default cap for a first pool that has no number yet: the $3,500,
 * and ONLY where the unit is dollars. With no dollar source there is no
 * "$3,500 equivalent", so the field stays empty and the creator types a cap in
 * the quote currency; a round native number is never offered in its place.
 */
export function defaultCapPatch(leg: CapLegState, u: LegCapUnit, defaultCapText: string = DEFAULT_CAP_USD_TEXT): Partial<CapLegState> | null {
  if (u.pending || u.unit.k !== 'usd') return null
  if (leg.marketCap.trim() !== '' || leg.price.trim() !== '') return null
  return { marketCap: defaultCapText, capPrimary: true }
}

/* -------------------------------------------------------------- formatting */

/**
 * A cap as a screen shows it: `$3,499.97`, `$1,250,000.00`, or `12.5 ETH`.
 *
 * EXACT, deliberately. The one figure this whole feature exists to put in front
 * of a creator is the cap the pool will ACTUALLY open at after the snap, and a
 * compacted "$3.5K" hides precisely the digits that say the snap moved it. The
 * chips carry their own short labels; nothing else here is abbreviated.
 *
 * String arithmetic, not `Number`, so a cap above 2^53 still prints every digit.
 */
export function formatCap(value: string, unit: CapUnit): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(value.trim())
  if (m === null) return value
  const whole = m[1] ?? '0'
  const frac = m[2] ?? ''
  if (unit.k === 'quote') {
    /* SIGNIFICANT digits, not the first N characters: a price like 0.000000005
       is all leading zeros until the one digit that matters, and slicing the
       string would print 0.00000000 — a zero where the number was. */
    const trimmed = frac.replace(/0+$/, '')
    const lead = trimmed.search(/[1-9]/)
    const short = lead < 0 ? '' : trimmed.slice(0, lead + 6).replace(/0+$/, '')
    return `${group(whole)}${short === '' ? '' : `.${short}`} ${unit.symbol}`
  }
  return `$${group(whole)}.${`${frac}00`.slice(0, 2)}`
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/* ------------------------------------------------------------- the default */

/**
 * The $3,500 default, as the wizards' cap field holds it.
 *
 * Read from the SDK constant rather than typed again here, so there is one
 * number in the repo and a change to it reaches both wizards.
 */
export const DEFAULT_CAP_USD_TEXT: string = rawToDecimal(DEFAULT_OPENING_MARKET_CAP_USD.amount, DEFAULT_OPENING_MARKET_CAP_USD.decimals)

/**
 * The chips beside the cap field. Dollars only, because they only appear when a
 * USD source resolved; on a chain without one there is no "$3,500 equivalent" to
 * offer and the wizard offers none rather than inventing a round native number
 * that would read as a recommendation.
 *
 * The default is one of them and is marked, so a creator can see what they are
 * moving away from.
 */
export const CAP_CHIPS_USD: readonly { readonly text: string; readonly label: string }[] = [
  { text: '1000', label: '$1K' },
  { text: DEFAULT_CAP_USD_TEXT, label: '$3.5K' },
  { text: '10000', label: '$10K' },
  { text: '50000', label: '$50K' },
]

export type { NativeUsdRate, UsdAmount }
