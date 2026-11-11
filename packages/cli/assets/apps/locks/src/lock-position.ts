// SPDX-License-Identifier: MIT
/**
 * Time-lock a CL liquidity position with `GullyCorePositionLock`: approve the lock
 * for this one NFT, then `lock(tokenId, unlockAt, owner)` for the flat fee.
 * Until `unlockAt` nobody can remove its liquidity or move the NFT; the lock
 * owner keeps collecting its swap fees and can extend, never shorten.
 */

import {
  GULLYCORE_POSITION_LOCK_ABI,
  buildApprovePositionForLock,
  buildLockPosition,
  readChainNow,
  readFeeGate,
  readPositionApproval,
  readPositionLockContext,
  validatePositionLock,
} from "@gullylabs/core-sdk/lock";
import { CL_POSITION_MANAGER_ABI } from "@gullylabs/core-sdk";
import { erc721Abi } from "viem";

import { address, args, need, str, utc, when } from "./lib/args.js";
import { connect, contract } from "./lib/chain.js";
import { main } from "./lib/main.js";
import { native, runPlan, type Step } from "./lib/tx.js";

const HELP = `npm run lock-position -- --token-id <n> --unlock <date> [--owner <0x...>] [--execute]

  --token-id <n>     the CLPositionManager position NFT to lock (you must own it)
  --unlock <date>    +180d, 2027-01-01 (UTC) or unix seconds; at most 100 years out
  --owner <0x...>    who owns the lock and receives its fees (default: the sender)
  --execute          send; without it this is a dry run that prints and simulates the plan

Environment: RPC_URL (required), PRIVATE_KEY (for --execute), FROM (dry-run sender), GULLYCORE_POSITION_LOCK (devnet override).`;

main(HELP, async () => {
  const { values, execute } = args({ "token-id": { type: "string" }, unlock: { type: "string" }, owner: { type: "string" } });
  const ctx = await connect(execute);
  const lock = contract(ctx, "positionLock");
  const idText = need(values, "token-id");
  if (!/^\d+$/.test(idText)) throw new Error("--token-id must be a whole number");
  const tokenId = BigInt(idText);

  // The lock accepts NFTs from ONE position manager: read which, never assume.
  const context = await readPositionLockContext(ctx.client, lock);
  const now = await readChainNow(ctx.client); // block.timestamp: the clock unlockAt is compared against
  const unlockAt = when(need(values, "unlock"), now);
  const ownerText = str(values, "owner");
  const owner = ownerText === undefined ? ctx.from : address(ownerText, "--owner");
  if (owner === null) throw new Error("pass --owner, or set PRIVATE_KEY / FROM so the sender owns the lock");

  // Only the NFT's owner can lock it: say so plainly rather than as a revert.
  const holder = await ctx.client.readContract({ address: context.positionManager, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] });
  if (ctx.from !== null && holder.toLowerCase() !== ctx.from.toLowerCase()) {
    throw new Error(`position #${tokenId} is held by ${holder}, not the sender ${ctx.from}`);
  }

  const issues = validatePositionLock({ unlockAt, owner, nowSeconds: now, lock });
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(" "));

  const terms = await readFeeGate(ctx.client, lock);
  console.log(`${ctx.chain.name} (chain ${ctx.chainId}), GullyCorePositionLock ${lock}`);
  console.log(`position #${tokenId} of ${context.positionManager}, locked until ${utc(unlockAt)}, lock owner ${owner}`);
  console.log(`fee ${native(ctx, terms.feeWei)}${terms.pendingFee === null ? "" : ` (rising to ${native(ctx, terms.pendingFee.feeWei)}; the value covers it, the surplus is refunded)`}\n`);

  const steps: Step[] = [];
  const approved = ctx.from !== null && (await readPositionApproval(ctx.client, { positionManager: context.positionManager, lock, tokenId, owner: ctx.from }));
  if (!approved) {
    steps.push({ label: `approve the lock for position #${tokenId}`, call: buildApprovePositionForLock({ positionManager: context.positionManager, lock, tokenId }) });
  }
  steps.push({ label: `lock position #${tokenId}`, call: buildLockPosition({ lock, tokenId, unlockAt, owner, terms }), afterPrevious: !approved });
  await runPlan(ctx, steps, [GULLYCORE_POSITION_LOCK_ABI, CL_POSITION_MANAGER_ABI]);
  if (!execute) console.log("\nDry run: nothing was sent. Add --execute to send.");
});
