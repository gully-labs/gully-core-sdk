// Whether one Chainlink round may be SHIPPED, judged against the chain's own head.
//
// Shared by `generate-native-feeds.mjs` and `generate-stock-feeds.mjs` and unit-tested
// on its own (`test/feedFreshness.test.ts`), because the rule was wrong once in a way no
// test could see: the generator compared every chain's `updatedAt` against ONE wall-clock
// instant captured at process start. Monad is the ninth chain in the loop, so by the
// time it was read that instant was ~2 minutes old and a round published 131 s into
// the run read as "131 s in the future". Two consecutive runs on 2026-10-15 rejected
// a different MON/USD aggregator each. The stock generator had the same stale instant
// (it under-reported every equity feed's age by the run's elapsed time, and would have
// rejected a round published during the run as "in the future") until it was moved onto
// this module later the same day.
//
// The two generators apply the verdict differently, and that is policy, not drift: a
// crypto feed past its heartbeat is a fault (native rejects on `stale`), an equity feed
// past its heartbeat is usually a closed market (stock RECORDS it). Both reject `future`
// and `noHeartbeat`. The verdict carries the three flags separately so a caller never
// has to parse a reason string to tell them apart.
//
// MEASURED, 2026-10-15 (three reads a minute apart, `rpc.monad.xyz` and
// `mainnet.base.org`, head block and `latestRoundData()` read in the same instant):
//
//   chain       feed                   updatedAt − head.timestamp   head.timestamp − wall
//   Monad 143   mon-usd (canonical)    −8 s, −39 s, −9 s            +1 s, +1 s, 0 s
//   Monad 143   mon-usd-shared-svr     −61 s, −122 s, −2 s          (same reads)
//   Base 8453   eth-usd-shared-svr-2   −46 s, −106 s, −168 s        0 s, −1 s, +1 s
//
// So the aggregators were AHEAD OF NOTHING — not of the chain's head, not of the wall
// clock — and Monad's block timestamps track wall time to the second. The whole
// "~130 s ahead" was the generator's own elapsed run time.
//
// THE RULE, with the reference fixed:
//   reference  = the timestamp of the chain's latest block, read in the same breath as
//                the round (same endpoint, right after `latestRoundData()`).
//   ahead      = updatedAt − reference. Legitimately ≤ 0; a few seconds > 0 is possible
//                when a load-balanced endpoint serves the `eth_call` from a node one or
//                two blocks past the one that served the head.
//   ok         = ahead <= FUTURE_SKEW_SECONDS
//                AND age (= −ahead) <= heartbeat + STALE_GRACE_SECONDS
//                AND the directory gave a heartbeat at all.
//
// The tolerance is NOT widened from the 120 s the generator always had, because the
// measurement gives no reason to: the correct reference makes the measured skew ≤ 1 s.
// A round that is more than two minutes ahead of the head it was read against is a
// feed lying about time, and stays a rejection.

/**
 * Seconds a round's `updatedAt` may sit PAST the chain head it was read against before
 * it is called a future timestamp. Measured skew on 2026-10-15 was ≤ 0 s (table above);
 * the allowance exists for load-balanced endpoints and sequencer timestamp latitude.
 */
export const FUTURE_SKEW_SECONDS = 120;

/**
 * Grace added to a feed's own heartbeat before its answer is called stale, in seconds.
 *
 * `updatedAt` is the timestamp of the block that INCLUDED the update, not of the
 * observation, so a feed that publishes exactly on its heartbeat can still read a little
 * over it through ordinary block-time jitter and sequencer timestamp latitude. Five minutes
 * absorbs that on every chain here and is negligible against the 3,600 s and 86,400 s
 * heartbeats; on BNB's 27 s heartbeat the grace dominates, which is correct — one missed
 * 27-second beat is noise, not a fault.
 */
export const STALE_GRACE_SECONDS = 300;

/**
 * How far the chain head used as the reference may sit from the wall clock before the
 * head itself is refused as a clock and the next endpoint is tried.
 *
 * FOUND ON THE SECOND RUN OF 2026-10-15: `rpc.purroofgroup.com` (HyperEVM) answered
 * `eth_getBlockByNumber("latest")` with block 48,617,869 at timestamp 1792077528 — an
 * HOUR behind the wall clock, and 4,300 blocks behind the head it served seconds later —
 * while the `eth_call` in the same breath was answered from a current node. Judged
 * against that head, a fresh HYPE/USD round read "3582 s in the future" and was
 * rejected. That is the load-balanced-RPC hazard `ContractClock.sol` refuses endpoints
 * for (`EvmTimestampDisagreesWithHeader`), reaching the generator through a different
 * door. A head that is this far from real time is a stale backend, not the chain:
 * refuse it as a clock, do not judge anything against it.
 *
 * Legitimate head-to-wall offsets measured on 2026-10-15: 0 to −1 s on every chain with
 * sub-second to 2 s blocks, −4 to −10 s on Ethereum and Sepolia (12 s slots).
 */
export const HEAD_WALL_TOLERANCE_SECONDS = 120;

/**
 * Null when `headTimestamp` is a usable reference clock, else the reason it is not.
 *
 * @param {number} headTimestamp  the latest block's timestamp, unix seconds
 * @param {number} wallSeconds    the wall clock at that read, unix seconds
 * @param {number} [tolerance]    defaults to {@link HEAD_WALL_TOLERANCE_SECONDS}
 * @returns {string | null}
 */
export function headClockFault(headTimestamp, wallSeconds, tolerance = HEAD_WALL_TOLERANCE_SECONDS) {
  const head = Number(headTimestamp);
  const wall = Number(wallSeconds);
  if (!Number.isFinite(head) || !Number.isFinite(wall)) {
    throw new TypeError("headClockFault: headTimestamp and wallSeconds must be finite numbers");
  }
  const offset = head - wall;
  if (Math.abs(offset) <= Number(tolerance)) return null;
  return (
    `endpoint served a head ${Math.abs(offset)}s ${offset < 0 ? "behind" : "ahead of"} the wall clock ` +
    `(head timestamp ${head}, wall ${wall}; tolerance ${tolerance}s) — a stale or skewed backend, not a reference`
  );
}

/**
 * Judge one round against the head it was read beside.
 *
 * Pure: no clock, no chain. Every number is an argument so the test can be exact.
 *
 * @param {object} round
 * @param {number} round.updatedAt            `latestRoundData().updatedAt`, unix seconds
 * @param {number} round.referenceTimestamp   the chain head's timestamp, unix seconds
 * @param {number} round.heartbeatSeconds     the directory's heartbeat; 0 / NaN = none given
 * @param {number} [round.futureSkewSeconds]  defaults to {@link FUTURE_SKEW_SECONDS}
 * @param {number} [round.staleGraceSeconds]  defaults to {@link STALE_GRACE_SECONDS}
 * @returns {{ ok: boolean, ageSeconds: number, aheadSeconds: number, reasons: string[],
 *            future: boolean, noHeartbeat: boolean, stale: boolean }}
 *   `ageSeconds` is `reference − updatedAt` (negative when the round is ahead of the
 *   head); `aheadSeconds` is its negation, kept so a reader never has to flip a sign.
 *   `future`, `noHeartbeat` and `stale` are the three faults as flags, one per reason,
 *   for a caller that treats them differently (the stock generator records `stale` and
 *   rejects the other two). `ok` is `!future && !noHeartbeat && !stale`.
 */
export function judgeRoundFreshness(round) {
  const updatedAt = Number(round.updatedAt);
  const reference = Number(round.referenceTimestamp);
  const heartbeat = Number(round.heartbeatSeconds ?? 0);
  const futureSkew = Number(round.futureSkewSeconds ?? FUTURE_SKEW_SECONDS);
  const staleGrace = Number(round.staleGraceSeconds ?? STALE_GRACE_SECONDS);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(reference)) {
    throw new TypeError(`judgeRoundFreshness: updatedAt and referenceTimestamp must be finite numbers`);
  }
  const ageSeconds = reference - updatedAt;
  const aheadSeconds = -ageSeconds;
  const reasons = [];
  let future = false;
  let noHeartbeat = false;
  let stale = false;

  if (aheadSeconds > futureSkew) {
    future = true;
    reasons.push(
      `updatedAt ${updatedAt} is ${aheadSeconds}s past the chain head it was read against ` +
        `(head timestamp ${reference}; tolerance ${futureSkew}s)`,
    );
  }
  if (!(heartbeat > 0)) {
    noHeartbeat = true;
    reasons.push("directory gives no heartbeat");
  } else if (ageSeconds > heartbeat + staleGrace) {
    stale = true;
    reasons.push(
      `stale: last round ${ageSeconds}s before the chain head, heartbeat ${heartbeat}s (+${staleGrace}s grace). ` +
        `This is a 24/7 crypto feed, so age past the heartbeat is a fault, not a closed market.`,
    );
  }
  return { ok: reasons.length === 0, ageSeconds, aheadSeconds, reasons, future, noHeartbeat, stale };
}

/**
 * Read `latestRoundData()` and the chain head from ONE client, round first, head second,
 * and refuse the head as a reference when it disagrees with the wall clock.
 *
 * This is the paired read both generators judge a round by. Order matters: with the
 * head read AFTER the `eth_call`, the head can only be at or past the block the call
 * was served at, so a legitimate round reads "ahead" by at most node-to-node skew on a
 * load-balanced endpoint — never by the generator's own elapsed time.
 *
 * It THROWS when the head fails {@link headClockFault}, on purpose: a caller running it
 * inside an endpoint-fallback loop then tries the next endpoint instead of judging the
 * round against a clock that is not one (the HyperEVM hour-behind case above). The
 * thrown message names the head block so the log says which backend lied.
 *
 * Duck-typed on the two viem methods it uses, so a test can hand it a fake client.
 *
 * @param {{ readContract: Function, getBlock: Function }} client  a viem public client
 * @param {object} args
 * @param {string} args.address                 the aggregator proxy
 * @param {readonly unknown[]} args.abi         an ABI carrying `functionName`
 * @param {string} [args.functionName]          defaults to `latestRoundData`
 * @param {number} [args.tolerance]             defaults to {@link HEAD_WALL_TOLERANCE_SECONDS}
 * @param {() => number} [args.now]             the wall clock in ms; defaults to `Date.now`
 * @returns {Promise<{ data: unknown, headBlock: number, headTimestamp: number,
 *                     wallSeconds: number, headWallOffsetSeconds: number }>}
 */
export async function readRoundBesideHead(client, args) {
  const functionName = args.functionName ?? "latestRoundData";
  const tolerance = args.tolerance ?? HEAD_WALL_TOLERANCE_SECONDS;
  const now = args.now ?? Date.now;
  const data = await client.readContract({ address: args.address, abi: args.abi, functionName });
  const head = await client.getBlock({ blockTag: "latest" });
  const wallSeconds = Math.floor(now() / 1000);
  const headBlock = Number(head.number);
  const headTimestamp = Number(head.timestamp);
  const fault = headClockFault(headTimestamp, wallSeconds, tolerance);
  if (fault) throw new Error(`${fault} [head block ${headBlock}]`);
  // Chain head minus wall clock at the same read: how far this chain's block clock sits
  // from real time. Recorded because "block timestamps lag wall time" is a claim made
  // about several of these chains, and this is where it would show.
  return { data, headBlock, headTimestamp, wallSeconds, headWallOffsetSeconds: headTimestamp - wallSeconds };
}
