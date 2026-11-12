// SPDX-License-Identifier: MIT
/**
 * "You receive" typed: the amount to PAY for it, solved from quotes.
 *
 * Every path the widget fills through is exact-input (the Gully Core quoters as the widget calls them, the
 * router API, the launch guards that refuse a partial fill with `SwapNotFilled`). So a typed output is
 * never sent as an exact-output trade: it is turned into the smallest input whose QUOTED output reaches
 * the target, and that input is then quoted, shown and executed as an ordinary exact-input swap, with its
 * own minimum received. The solver only ever asks for quotes; it never prices anything itself.
 *
 * Method: a proportional first guess from a seed quote, then a bracket (an input whose output is short
 * of the target and one whose output reaches it), then bisection on the bracket until the reaching
 * input's output is within `toleranceBps` above the target or the bracket is one unit wide. Bounded:
 * `maxQuotes` quotes in all. An output that no input reaches (the pool or venue runs out: the quote
 * fails) is `null`, never an approximation.
 */

export interface BackSolveOptions {
  /** A first input to quote, in the input token's smallest unit (> 0). */
  readonly seed: bigint;
  /** How far above the target the solved output may land, in bps (default 10 = 0.1%). */
  readonly toleranceBps?: number;
  /** Most quotes the solve may ask for (default 24). */
  readonly maxQuotes?: number;
}

export interface BackSolveResult {
  /** The input to pay, exact-input. */
  readonly amountIn: bigint;
  /** What the quote said that input delivers (>= the target). */
  readonly amountOut: bigint;
  readonly quotes: number;
}

/**
 * The smallest input (within tolerance) whose quoted output is at least `target`.
 * `quote(amountIn)` returns the output the user would receive, or `null` when it cannot be filled.
 */
export async function solveAmountIn(target: bigint, quote: (amountIn: bigint) => Promise<bigint | null>, options: BackSolveOptions): Promise<BackSolveResult | null> {
  if (target <= 0n || options.seed <= 0n) return null;
  const tol = BigInt(options.toleranceBps ?? 10);
  const max = options.maxQuotes ?? 24;
  let used = 0;
  const ask = async (x: bigint): Promise<bigint | null> => {
    used++;
    try {
      return await quote(x);
    } catch {
      return null;
    }
  };
  const close = (out: bigint) => out * 10_000n <= target * (10_000n + tol);

  // A seed the venue cannot fill at all: try smaller seeds before giving up (a thin pool).
  let seed = options.seed;
  let seedOut = await ask(seed);
  // Unfillable: shrink it. Rounds to nothing (dust): grow it.
  while ((seedOut === null || seedOut === 0n) && used < 8) {
    if (seedOut === null) {
      if (seed <= 1n) break;
      seed = seed / 1000n > 0n ? seed / 1000n : 1n;
    } else seed = seed * 1000n;
    seedOut = await ask(seed);
  }
  if (seedOut === null || seedOut === 0n) return null;

  // Bracket: lo is short of the target, hi reaches it.
  let lo = 0n;
  let hi: bigint | null = null;
  let hiOut = 0n;
  if (seedOut >= target) {
    hi = seed;
    hiOut = seedOut;
  } else {
    lo = seed;
  }
  let guessFrom = { x: seed, out: seedOut };
  let ceil: bigint | null = null; // the smallest input known to be unfillable
  while (hi === null && used < max) {
    if (ceil !== null && ceil - lo <= 1n) return null;
    // Proportional guess, padded 1% so a concave curve (price impact) still tends to overshoot; kept
    // below an input already known to be unfillable.
    let x = (guessFrom.x * target * 101n) / (guessFrom.out * 100n) + 1n;
    if (x <= lo) x = lo * 2n;
    if (ceil !== null && x >= ceil) x = lo + (ceil - lo) / 2n;
    const out = await ask(x);
    if (out === null) ceil = x;
    else if (out >= target) {
      hi = x;
      hiOut = out;
    } else {
      lo = x;
      guessFrom = { x, out };
    }
  }
  if (hi === null) return null;

  // Bisect down to the smallest reaching input within tolerance.
  let reach: bigint = hi;
  while (!close(hiOut) && reach - lo > 1n && used < max) {
    const mid: bigint = lo + (reach - lo) / 2n;
    const out = await ask(mid);
    if (out !== null && out >= target) {
      reach = mid;
      hiOut = out;
    } else {
      lo = mid;
    }
  }
  return { amountIn: reach, amountOut: hiOut, quotes: used };
}
