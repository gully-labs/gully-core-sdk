// SPDX-License-Identifier: MIT
/**
 * Lock an ERC-20 or native in `GullyCoreTokenLock`: a plain time-lock (--unlock) or
 * a vesting schedule (--start, --cliff-days, --duration-days). The schedule is
 * fixed at creation; no key can shorten, revoke or redirect it.
 *
 *   vested(t) = 0 before the cliff, all of it at the end, linear from start to end in between.
 */

import {
  GULLYCORE_TOKEN_LOCK_ABI,
  buildErc20Approve,
  buildTokenLock,
  cliffLinearSchedule,
  readChainNow,
  readFeeGate,
  timeLockSchedule,
  validateTokenLock,
  vestedAt,
  type VestingSchedule,
} from "@gullylabs/core-sdk/lock";
import { parseAmountExact } from "@gullylabs/core-sdk/drop";
import { erc20Abi } from "viem";

import { address, args, currency, days, need, str, utc, when } from "./lib/args.js";
import { connect, contract } from "./lib/chain.js";
import { main } from "./lib/main.js";
import { allowance, amount as fmt, balanceOf, tokenFacts } from "./lib/token.js";
import { native, runPlan, type Step } from "./lib/tx.js";

const HELP = `npm run vest -- --token <0x...|native> --amount <n> --beneficiary <0x...> (--unlock <date> | --duration-days <n> [--start <date>] [--cliff-days <n>]) [--execute]

  --token <0x|native>    what to lock
  --amount <n>           exact decimal amount in whole tokens (e.g. 250000.5)
  --beneficiary <0x...>  who can claim; rotates two-step later
  --unlock <date>        a plain time-lock: everything at this moment (+365d, 2027-01-01, unix seconds)
  --start <date>         vesting start (default now)
  --cliff-days <n>       nothing claimable before start + n days (default 0)
  --duration-days <n>    everything vested at start + n days
  --execute              send; without it this is a dry run that prints and simulates the plan

Environment: RPC_URL (required), PRIVATE_KEY (for --execute), FROM (dry-run sender), GULLYCORE_TOKEN_LOCK (devnet override).`;

main(HELP, async () => {
  const { values, execute } = args({
    token: { type: "string" },
    amount: { type: "string" },
    beneficiary: { type: "string" },
    unlock: { type: "string" },
    start: { type: "string" },
    "cliff-days": { type: "string" },
    "duration-days": { type: "string" },
  });
  const ctx = await connect(execute);
  const lock = contract(ctx, "tokenLock");
  const token = await tokenFacts(ctx, currency(need(values, "token")));
  const amount = parseAmountExact(need(values, "amount"), token.decimals); // exact, never a float
  const beneficiary = address(need(values, "beneficiary"), "--beneficiary");
  const now = await readChainNow(ctx.client);

  const unlock = str(values, "unlock");
  const duration = str(values, "duration-days");
  if ((unlock === undefined) === (duration === undefined)) throw new Error("pass exactly one of --unlock (a time-lock) or --duration-days (vesting)");
  const schedule: VestingSchedule =
    unlock !== undefined
      ? timeLockSchedule(when(unlock, now))
      : cliffLinearSchedule({
          start: when(str(values, "start") ?? "now", now),
          cliffSeconds: days(str(values, "cliff-days") ?? "0", "--cliff-days"),
          durationSeconds: days(duration ?? "0", "--duration-days"),
        });

  const issues = validateTokenLock({ currency: token.address, amount, beneficiary, schedule, nowSeconds: now, lock });
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(" "));

  const terms = await readFeeGate(ctx.client, lock);
  console.log(`${ctx.chain.name} (chain ${ctx.chainId}), GullyCoreTokenLock ${lock}`);
  console.log(`${fmt(token, amount)} for ${beneficiary}`);
  console.log(`start ${utc(schedule.start)} · cliff ${utc(schedule.cliff)} · end ${utc(schedule.end)}`);
  console.log(`vested at the cliff: ${fmt(token, vestedAt({ amount, ...schedule }, schedule.cliff))}`);
  console.log(`fee ${native(ctx, terms.feeWei)}${token.native ? " (sent with the amount)" : ""}\n`);

  if (ctx.from !== null) {
    const have = await balanceOf(ctx, token, ctx.from);
    if (have < amount) throw new Error(`${ctx.from} holds ${fmt(token, have)}; the lock needs ${fmt(token, amount)}`);
  }

  // ERC-20: an EXACT approval for the amount (skipped when already enough). Native: the value carries it.
  const steps: Step[] = [];
  const approvalNeeded = !token.native && (ctx.from === null || (await allowance(ctx, token, ctx.from, lock)) < amount);
  if (approvalNeeded) steps.push({ label: `approve ${fmt(token, amount)} to GullyCoreTokenLock`, call: buildErc20Approve({ token: token.address, spender: lock, amount }) });
  steps.push({
    label: `lock ${fmt(token, amount)}`,
    call: buildTokenLock({ lock, currency: token.address, amount, beneficiary, schedule, terms }),
    afterPrevious: approvalNeeded,
  });
  await runPlan(ctx, steps, [GULLYCORE_TOKEN_LOCK_ABI, erc20Abi]);
  if (!execute) console.log("\nDry run: nothing was sent. Add --execute to send.");
});
