// SPDX-License-Identifier: MIT
/**
 * CSV -> Merkle tree -> claims file -> (with --execute) a funded
 * `GullyCoreMerkleDrop`, created through `GullyCoreDropFactory` for its flat fee.
 *
 * The drop stores only the root. Claimers need the claims file, so host it
 * (IPFS or https) BEFORE creating the drop and pass its URI with --uri: it is
 * stored as the drop's metadataURI and the claim page fetches it from there.
 */

import { readFile, writeFile } from "node:fs/promises";

import {
  DROP_MAX_DURATION_SECONDS,
  GULLYCORE_DROP_FACTORY_ABI,
  buildCreateDrop,
  buildDropClaimsFile,
  buildErc20Approve,
  mergeDuplicateRecipients,
  parseRecipientsCsv,
  readFeeGate,
  validateDropDraft,
} from "@gullylabs/core-sdk/drop";
import { readChainNow } from "@gullylabs/core-sdk/lock";
import { erc20Abi, parseEventLogs } from "viem";

import { args, currency, days, need, str, utc } from "./lib/args.js";
import { connect, contract } from "./lib/chain.js";
import { main } from "./lib/main.js";
import { allowance, amount, balanceOf, tokenFacts } from "./lib/token.js";
import { native, runPlan, type Step } from "./lib/tx.js";

const HELP = `npm run drop -- --csv <file> --token <0x...|native> [options]

  --csv <file>         one "address,amount" per line; repeated addresses are merged into one leaf
  --token <0x|native>  the ERC-20 to drop, or native
  --unit base          amounts are base units (default: decimal amounts in whole tokens)
  --days <n>           claimable for n days, 1..${DROP_MAX_DURATION_SECONDS / 86_400n} (default 90); then the creator may sweep the rest
  --out <file>         where to write the claims file (default claims.json)
  --uri <uri>          where the claims file is hosted (ipfs://... or https://...); stored as metadataURI
  --no-uri             create the drop with an empty metadataURI (claimers must be handed the file)
  --execute            send; without it this is a dry run that writes the file and simulates

Environment: RPC_URL (required), PRIVATE_KEY (for --execute), FROM (dry-run sender), GULLYCORE_DROP_FACTORY (devnet override).`;

main(HELP, async () => {
  const { values, execute } = args({
    csv: { type: "string" },
    token: { type: "string" },
    unit: { type: "string" },
    days: { type: "string" },
    out: { type: "string" },
    uri: { type: "string" },
    "no-uri": { type: "boolean" },
  });
  const ctx = await connect(execute);
  const factory = contract(ctx, "dropFactory");
  const token = await tokenFacts(ctx, currency(need(values, "token")));

  // 1. Parse, then one leaf per address.
  const parsed = parseRecipientsCsv(await readFile(need(values, "csv"), "utf8"), {
    decimals: token.decimals,
    unit: str(values, "unit") === "base" ? "base" : "decimal",
  });
  for (const i of parsed.issues) console.log(`line ${i.line}: ${i.severity}: ${i.message}`);
  if (!parsed.ok) throw new Error("the CSV has errors; fix them and run again");
  const recipients = mergeDuplicateRecipients(parsed.rows);

  // 2. The claims file, written now: the root, the total and every account's proof.
  const file = buildDropClaimsFile({ chainId: ctx.chainId, currency: token.address, recipients, symbol: token.symbol, decimals: token.decimals });
  const out = str(values, "out") ?? "claims.json";
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(`${recipients.length} leaves, ${amount(token, BigInt(file.total))}, root ${file.merkleRoot}`);
  console.log(`claims file written to ${out}: host it, then pass its URI with --uri\n`);

  // 3. The drop's terms, checked against the contract's rules before any wallet is asked.
  const uri = str(values, "uri");
  if (uri === undefined && values["no-uri"] !== true) {
    if (execute) throw new Error("pass --uri <where claims.json is hosted>, or --no-uri to create a drop that names no file");
    console.log("note: no --uri given; the drop would name no claims file\n");
  }
  const metadataURI = uri ?? "";
  const now = await readChainNow(ctx.client);
  const expiresAt = now + days(str(values, "days") ?? "90", "--days");
  const totalAmount = BigInt(file.total);
  const issues = validateDropDraft({ amount: totalAmount, merkleRoot: file.merkleRoot, expiresAt, metadataURI, nowSeconds: now });
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(" "));

  const terms = await readFeeGate(ctx.client, factory);
  console.log(`${ctx.chain.name} (chain ${ctx.chainId}), GullyCoreDropFactory ${factory}`);
  console.log(`claimable until ${utc(expiresAt)}; fee ${native(ctx, terms.feeWei)} per drop\n`);
  if (ctx.from !== null) {
    const have = await balanceOf(ctx, token, ctx.from);
    if (have < totalAmount) throw new Error(`${ctx.from} holds ${amount(token, have)}; the drop needs ${amount(token, totalAmount)}`);
  }

  // 4. ERC-20: approve the FACTORY for exactly the total (it moves the tokens straight into the drop).
  const steps: Step[] = [];
  const approvalNeeded = !token.native && (ctx.from === null || (await allowance(ctx, token, ctx.from, factory)) < totalAmount);
  if (approvalNeeded) {
    steps.push({ label: `approve ${amount(token, totalAmount)} to GullyCoreDropFactory`, call: buildErc20Approve({ token: token.address, spender: factory, amount: totalAmount }) });
  }
  steps.push({
    label: `createDrop: ${amount(token, totalAmount)} for ${recipients.length} accounts`,
    call: buildCreateDrop({ factory, currency: token.address, amount: totalAmount, merkleRoot: file.merkleRoot, expiresAt, metadataURI, terms }),
    afterPrevious: approvalNeeded,
  });
  const receipts = await runPlan(ctx, steps, [GULLYCORE_DROP_FACTORY_ABI, erc20Abi]);

  const last = receipts[receipts.length - 1];
  if (last !== undefined) {
    const drop = parseEventLogs({ abi: GULLYCORE_DROP_FACTORY_ABI, logs: last.logs, eventName: "DropCreated" })[0]?.args.drop;
    if (drop === undefined) throw new Error("the transaction succeeded but carried no DropCreated log");
    console.log(`\ndrop ${drop}`);
    console.log(`claim page on a Gully Core site: /app/airdrop/${drop}`);
    console.log(`check the hosted file: npm run check-claims -- --file ${out} --drop ${drop}`);
  } else if (!execute) {
    console.log("\nDry run: nothing was sent. Add --execute to send.");
  }
});
