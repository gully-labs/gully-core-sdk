// SPDX-License-Identifier: MIT
/**
 * Verify a claims file the way a claimer does: rebuild the root from every
 * claim, check every proof and the total, and (with --drop) compare with the
 * root, chain and currency the DROP stores. Reads only.
 */

import { readFile } from "node:fs/promises";

import { claimsOf, parseDropClaimsFile, readDrop, readDropClaimed, verifyDropClaimsFile } from "@gullylabs/core-sdk/drop";

import { address, args, need, str, utc } from "./lib/args.js";
import { connect } from "./lib/chain.js";
import { main } from "./lib/main.js";

const HELP = `npm run check-claims -- --file <claims.json> [--drop <0x...>] [--account <0x...>]

  --file <file>      the claims file (as written by npm run drop)
  --drop <0x...>     a deployed drop: compare the file with its stored root, and show progress
  --account <0x...>  list this account's leaves and whether each is claimed (needs --drop)

Environment: RPC_URL (required with --drop).`;

main(HELP, async () => {
  const { values } = args({ file: { type: "string" }, drop: { type: "string" }, account: { type: "string" } });
  const file = parseDropClaimsFile(await readFile(need(values, "file"), "utf8"));
  const dropText = str(values, "drop");

  if (dropText === undefined) {
    const check = verifyDropClaimsFile(file);
    console.log(check.ok ? `OK: ${file.claims.length} claims, total ${file.total}, root ${file.merkleRoot}` : check.issues.join("\n"));
    if (!check.ok) process.exitCode = 1;
    return;
  }

  const ctx = await connect(false);
  const drop = address(dropText, "--drop");
  const info = await readDrop(ctx.client, drop);
  const check = verifyDropClaimsFile(file, { root: info.merkleRoot, chainId: ctx.chainId, currency: info.currency });
  console.log(check.ok ? `OK: the file matches drop ${drop}` : `MISMATCH:\n  ${check.issues.join("\n  ")}`);
  console.log(`claimed ${info.claimedAmount} of ${info.totalAmount} base units (${info.claimedBps / 100}%), open until ${utc(info.expiresAt)}`);
  console.log(`metadataURI: ${info.metadataURI === "" ? "(empty)" : info.metadataURI}`);
  if (!check.ok) process.exitCode = 1;

  const accountText = str(values, "account");
  if (accountText !== undefined) {
    const leaves = claimsOf(file, address(accountText, "--account"));
    const claimed = await readDropClaimed(ctx.client, drop, leaves.map((c) => c.index));
    if (leaves.length === 0) console.log("that account has no leaf in this file");
    leaves.forEach((c, i) => console.log(`leaf ${c.index}: ${c.amount} base units, ${claimed[i] === true ? "claimed" : "not claimed"}`));
  }
});
