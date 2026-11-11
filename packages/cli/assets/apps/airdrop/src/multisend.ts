// SPDX-License-Identifier: MIT
/**
 * CSV -> validate -> plan -> simulate -> (with --execute) send, through
 * `GullyCoreMultisend`: native or one ERC-20 to up to 1,000 addresses per call.
 * Each call is atomic and pays the contract's flat fee once.
 */

import { readFile } from "node:fs/promises";

import { GULLYCORE_MULTISEND_ABI, buildErc20Approve, parseRecipientsCsv, planMultisend, readFeeGate } from "@gullylabs/core-sdk/drop";
import { erc20Abi } from "viem";

import { args, currency, need, str } from "./lib/args.js";
import { connect, contract } from "./lib/chain.js";
import { main } from "./lib/main.js";
import { allowance, amount, balanceOf, tokenFacts } from "./lib/token.js";
import { native, runPlan, type Step } from "./lib/tx.js";

const HELP = `npm run multisend -- --csv <file> --token <0x...|native> [options]

  --csv <file>         one "address,amount" per line (a header, blank lines and # comments are fine)
  --token <0x|native>  the ERC-20 to send, or native
  --unit base          amounts are base units (default: decimal amounts in whole tokens)
  --batch-size <n>     recipients per call, 1..1000 (default 1000)
  --allow-duplicates   keep an address listed twice (default: refuse)
  --execute            send; without it this is a dry run that prints and simulates the plan

Environment: RPC_URL (required), PRIVATE_KEY (for --execute), FROM (dry-run sender), GULLYCORE_MULTISEND (devnet override).`;

main(HELP, async () => {
  const { values, execute } = args({
    csv: { type: "string" },
    token: { type: "string" },
    unit: { type: "string" },
    "batch-size": { type: "string" },
    "allow-duplicates": { type: "boolean" },
  });
  const ctx = await connect(execute);
  const multisend = contract(ctx, "multisend");
  const token = await tokenFacts(ctx, currency(need(values, "token")));

  // 1. Parse and validate. Every problem is reported with its line; nothing is dropped silently.
  const unit = str(values, "unit") === "base" ? "base" : "decimal";
  const parsed = parseRecipientsCsv(await readFile(need(values, "csv"), "utf8"), {
    decimals: token.decimals,
    unit,
    duplicates: values["allow-duplicates"] === true ? "warn" : "error",
  });
  for (const i of parsed.issues) console.log(`line ${i.line}: ${i.severity}: ${i.message}`);
  if (!parsed.ok) throw new Error("the CSV has errors; fix them and run again");

  // 2. The plan, priced by the fee read from the contract now.
  const terms = await readFeeGate(ctx.client, multisend);
  const batchSize = str(values, "batch-size");
  const plan = planMultisend({
    multisend,
    currency: token.address,
    recipients: parsed.rows,
    terms,
    ...(batchSize === undefined ? {} : { batchSize: Number(batchSize) }),
  });
  console.log(`\n${ctx.chain.name} (chain ${ctx.chainId}), GullyCoreMultisend ${multisend}`);
  console.log(`${parsed.rows.length} recipients, ${amount(token, plan.totalAmount)} in ${plan.batches.length} call(s)`);
  console.log(`fee: ${native(ctx, terms.feeWei)} per call${terms.pendingFee === null ? "" : `, rising to ${native(ctx, terms.pendingFee.feeWei)} (the value covers it; the surplus is refunded)`}`);
  console.log(`native to send in total: ${native(ctx, plan.totalValue)}\n`);

  // 3. Can the sender pay? Read, not assumed.
  if (ctx.from !== null) {
    const have = await balanceOf(ctx, token, ctx.from);
    if (have < plan.totalAmount) throw new Error(`${ctx.from} holds ${amount(token, have)}; the plan sends ${amount(token, plan.totalAmount)}`);
  }

  // 4. Steps: an EXACT approval for the sum (ERC-20 only, skipped when already enough), then each batch.
  const steps: Step[] = [];
  const approvalNeeded = plan.approval !== null && (ctx.from === null || (await allowance(ctx, token, ctx.from, multisend)) < plan.approval.amount);
  if (plan.approval !== null && approvalNeeded) {
    steps.push({ label: `approve ${amount(token, plan.approval.amount)} to GullyCoreMultisend`, call: buildErc20Approve(plan.approval) });
  }
  plan.batches.forEach((b, i) => {
    steps.push({ label: `batch ${i + 1}: ${b.recipients} recipients, ${amount(token, b.amount)}`, call: b.call, afterPrevious: approvalNeeded });
  });
  await runPlan(ctx, steps, [GULLYCORE_MULTISEND_ABI, erc20Abi]);
  if (!execute) console.log("\nDry run: nothing was sent. Add --execute to send.");
});
