// SPDX-License-Identifier: MIT
/* ============================================================================
   The chart kit's default formatters: a count, a number, a UTC time and a
   PRICE. The kit is the template's own copy of Gully Core's shared chart kit
   (MIT), and this file is the one thing it needed from the dapp beyond the
   kit folder itself, restated here so the kit imports nothing outside it.

   Prices must pass `fmtPrice` (`formatY={fmtPrice}` / `format={fmtPrice}`):
   a launch token's price is often below 1e-6, and `fmtNumber` would print
   it as "<0.0001" — a zero where the number was. `fmtPrice` writes the zero
   run as a subscript count (0.0₈14), the way every Gully Core surface does.
   ============================================================================ */

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** Digits of a non-negative bigint with thousands separators. */
function groupBigint(v: bigint): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** A JS number (a ratio, a volume in whole units): 2 decimals from 1,000, 4 under it, 4 significant under 1. */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const a = Math.abs(n)
  if (a < 0.0001) return n < 0 ? '>-0.0001' : '<0.0001'
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (a >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

/** A count or a block number, with separators. */
export function fmtInt(n: number | bigint): string {
  return typeof n === 'bigint' ? (n < 0n ? '-' + groupBigint(-n) : groupBigint(n)) : INT.format(n)
}

/** Unix seconds as `2026-09-26 14:05 UTC`. */
export function fmtUtc(seconds: number | bigint): string {
  const ms = Number(seconds) * 1000
  if (!Number.isFinite(ms)) return '—'
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉']

/** A price: up to 6 decimals from 1, 6 significant from 1e-4, a subscript zero run below (0.0₈14). */
export function fmtPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—'
  if (p === 0) return '0'
  if (p < 0) return `-${fmtPrice(-p)}`
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: 6 })
  if (p >= 1e-4) return p.toPrecision(6).replace(/\.?0+$/, '')
  /* Four significant digits after the zero run, from the exponent form so any magnitude works. */
  const [mantissa = '0', exp = '0'] = p.toExponential(3).split('e')
  const zeros = -Number(exp) - 1
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0'
  const sub = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)] ?? d)
    .join('')
  return `0.0${sub}${digits}`
}
