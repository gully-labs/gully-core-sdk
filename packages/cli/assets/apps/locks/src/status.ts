// SPDX-License-Identifier: MIT
/**
 * What is locked, read from the chain. Reads only; never sends.
 *
 *   --pool <poolId>   every time-lock in a CL pool, and the locked share of its ACTIVE liquidity
 *   --token <0x...>   every lock of a token, and the share of its supply held / not yet vested
 */

import { readCurrencyLocks, readPoolLocks } from "@gullylabs/core-sdk/lock";
import { isHex } from "viem";

import { args, currency, str, utc } from "./lib/args.js";
import { connect, contract } from "./lib/chain.js";
import { main } from "./lib/main.js";
import { amount, tokenFacts } from "./lib/token.js";

const HELP = `npm run status -- (--pool <poolId> | --token <0x...|native>)

  --pool <poolId>   a CL pool id (bytes32)
  --token <0x...>   a token, or native

Environment: RPC_URL (required), GULLYCORE_POSITION_LOCK / GULLYCORE_TOKEN_LOCK (devnet overrides).`;

const bps = (v: number | null): string => (v === null ? "n/a" : `${v / 100}%`);

main(HELP, async () => {
  const { values } = args({ pool: { type: "string" }, token: { type: "string" } });
  const ctx = await connect(false);
  const pool = str(values, "pool");
  const tokenText = str(values, "token");
  if ((pool === undefined) === (tokenText === undefined)) throw new Error("pass exactly one of --pool or --token");

  if (pool !== undefined) {
    if (!isHex(pool) || pool.length !== 66) throw new Error("--pool must be a 32-byte pool id");
    const s = await readPoolLocks(ctx.client, contract(ctx, "positionLock"), pool);
    // Share of ACTIVE liquidity: in-range locked liquidity over the pool's liquidity at the current tick,
    // exact at this block. It says nothing about liquidity outside the current price and moves with it.
    console.log(`pool ${pool}`);
    console.log(`time-locked share of active liquidity: ${bps(s.timeLockedActiveBps)} (${s.lockedCount} lock(s) before their date)`);
    console.log(`locked positions out of range: ${s.outOfRangeLocked}`);
    console.log(`next unlock: ${s.nextUnlockAt === null ? "none" : utc(s.nextUnlockAt)}`);
    console.log("(time-locks only: a launch pool's permanent LP-locker positions need a log scan; see readPoolLocks' lpLocker option)");
    for (const l of s.locks) console.log(`  #${l.tokenId} ${l.status} until ${utc(l.unlockAt)} owner ${l.owner}${l.inRange === false ? " (out of range)" : ""}`);
    return;
  }

  const token = await tokenFacts(ctx, currency(tokenText ?? ""));
  const s = await readCurrencyLocks(ctx.client, contract(ctx, "tokenLock"), token.address);
  console.log(`${token.symbol} ${token.address}`);
  console.log(`held by the lock: ${amount(token, s.totalHeld)} (${bps(s.heldBps)} of supply, vested-but-unclaimed included)`);
  console.log(`not yet vested: ${amount(token, s.unvested)} (${bps(s.unvestedBps)} of supply)`);
  console.log(`next cliff or end: ${s.nextCliffOrEnd === null ? "none" : utc(s.nextCliffOrEnd)}`);
  for (const l of s.locks) console.log(`  lock ${l.lockId}: ${l.status}, ${amount(token, l.claimable)} claimable, beneficiary ${l.beneficiary}`);
});
