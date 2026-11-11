// SPDX-License-Identifier: MIT
/**
 * A token's holders -> a recipients CSV for `npm run multisend` or `npm run drop`.
 * Reads only; sends nothing.
 *
 * The holder set is reduced from the token's Transfer logs, from --from-block to
 * the snapshot block, and CHECKED: the balances must add up to `totalSupply()`
 * read at the snapshot block. A scan that cannot finish, or does not add up (it
 * started after the token's first mint, or the token rebases), is an error: no
 * partial list is ever written.
 *
 * Amounts are exact integers: pro-rata is floor(budget * balance / eligible),
 * equal is floor(budget / n); the remainder (dust) is printed and not sent.
 * Default exclusions come from the SDK address book (Vault, pool managers, LP
 * lockers, lock contracts, multisend, drop factory, zero/dead, the token).
 */

import { writeFile } from "node:fs/promises";

import {
  defaultHolderExclusions,
  formatAmountExact,
  parseAmountExact,
  planHolderAirdrop,
  readContractAccounts,
  readHolderSnapshot,
  type HolderAirdropMode,
  type HolderExclusionRule,
} from "@gullylabs/core-sdk/drop";

import { address, args, currency, need, str, utc } from "./lib/args.js";
import { connect } from "./lib/chain.js";
import { main } from "./lib/main.js";
import { tokenFacts } from "./lib/token.js";

const HELP = `npm run holders -- --holders-of <0x...> --token <0x...|native> --mode <pro-rata|equal|fixed> --amount <n> [options]

  --holders-of <0x...>   the token whose holders receive the airdrop
  --token <0x|native>    the token you will SEND (its decimals size the amounts)
  --mode <m>             pro-rata (a budget shared by balance), equal (a budget shared equally), fixed (the same to each)
  --amount <n>           the budget (pro-rata, equal) or the amount each (fixed), in whole --token units
  --from-block <n>       where the Transfer scan starts (default: the chain's Gully Core deployment block);
                         must be at or before the holders' token's first mint, or the check fails
  --snapshot <n>         the snapshot block (default: latest)
  --min-balance <n>      skip holders below this balance, in whole --holders-of units
  --top <n>              keep only the largest N holders
  --exclude-contracts    skip addresses with code (a Merkle drop pays a contract only if it claims itself)
  --exclude <a,b,...>    more addresses to skip
  --out <file>           where to write the CSV (default holders.csv)

Environment: RPC_URL (required).`;

main(HELP, async () => {
  const { values } = args({
    "holders-of": { type: "string" },
    token: { type: "string" },
    mode: { type: "string" },
    amount: { type: "string" },
    "from-block": { type: "string" },
    snapshot: { type: "string" },
    "min-balance": { type: "string" },
    top: { type: "string" },
    "exclude-contracts": { type: "boolean" },
    exclude: { type: "string" },
    out: { type: "string" },
  });
  const ctx = await connect(false);
  const holdersOf = address(need(values, "holders-of"), "--holders-of");
  const sendToken = await tokenFacts(ctx, currency(need(values, "token")));
  const held = await tokenFacts(ctx, holdersOf);

  const modeText = need(values, "mode");
  if (modeText !== "pro-rata" && modeText !== "equal" && modeText !== "fixed") throw new Error("--mode is pro-rata, equal or fixed");
  const v = parseAmountExact(need(values, "amount"), sendToken.decimals);
  const mode: HolderAirdropMode = modeText === "fixed" ? { kind: "fixed", amountEach: v } : { kind: modeText, budget: v };

  const block = (name: string): bigint | undefined => {
    const t = str(values, name);
    if (t === undefined) return undefined;
    if (!/^\d+$/.test(t)) throw new Error(`--${name} is a whole block number`);
    return BigInt(t);
  };
  const fromBlock = block("from-block") ?? ctx.book?.deployedAtBlock;
  if (fromBlock === undefined) throw new Error("No Gully Core address book for this chain: pass --from-block (the holders' token's creation block or earlier).");
  const snapshotBlock = block("snapshot");

  console.log(`reading Transfer logs of ${held.symbol} (${holdersOf}) from block ${fromBlock}…`);
  const snap = await readHolderSnapshot(ctx.client, holdersOf, {
    fromBlock,
    ...(snapshotBlock === undefined ? {} : { snapshotBlock }),
    window: 10_000_000n,
    minWindow: 1_000n,
  });

  const extra: HolderExclusionRule[] = (str(values, "exclude") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => ({ address: address(s, "--exclude"), reason: "excluded by --exclude" }));
  const exclude = [...(ctx.book === null ? [] : defaultHolderExclusions(ctx.book, holdersOf)), ...extra];
  if (ctx.book === null) console.log("warning: no Gully Core address book for this chain, so only --exclude addresses are skipped");
  const excludeContracts = values["exclude-contracts"] === true;
  const contracts = excludeContracts ? await readContractAccounts(ctx.client, snap.holders.map((h) => h.address), { blockNumber: snap.snapshotBlock }) : undefined;
  const minText = str(values, "min-balance");
  const topText = str(values, "top");

  const plan = planHolderAirdrop(snap.holders, mode, {
    minBalance: minText === undefined ? 0n : parseAmountExact(minText, held.decimals),
    exclude,
    excludeContracts,
    ...(contracts === undefined ? {} : { contracts }),
    ...(topText === undefined ? {} : { topN: Number(topText) }),
  });

  const fmt = (x: bigint): string => formatAmountExact(x, sendToken.decimals);
  console.log(`\nHolders read from Transfer logs from block ${snap.fromBlock} to snapshot block ${snap.snapshotBlock} (${utc(snap.snapshotTimestamp)});`);
  console.log(`balances add up to totalSupply() at that block. ${snap.holders.length} holders, ${snap.transfers} transfers.`);
  console.log(`${plan.recipients.length} recipients, total ${fmt(plan.total)} ${sendToken.symbol}${plan.budget === null ? "" : `, dust not sent ${fmt(plan.dust)} ${sendToken.symbol}`}`);
  for (const e of plan.excluded) console.log(`  excluded ${e.address}: ${e.reason}`);
  if (plan.recipients.length === 0) throw new Error("nobody is left to pay; nothing written");

  const out = str(values, "out") ?? "holders.csv";
  const lines = [
    `# holders of ${holdersOf} at block ${snap.snapshotBlock} (${utc(snap.snapshotTimestamp)}), Transfer logs from block ${snap.fromBlock}; mode ${plan.mode}`,
    "address,amount",
    ...plan.recipients.map((r) => `${r.account},${fmt(r.amount)}`),
  ];
  await writeFile(out, `${lines.join("\n")}\n`, "utf8");
  console.log(`\nwrote ${out}: npm run multisend -- --csv ${out} --token ${sendToken.native ? "native" : sendToken.address}`);
});
