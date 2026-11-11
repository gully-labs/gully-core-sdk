// SPDX-License-Identifier: MIT
/**
 * `gullycore multisend`, `gullycore split`, `gullycore lock`.
 *
 * Each builds its calls with the SDK (`planMultisend`, `buildCreateSplit`, `buildTokenLock`), reads the
 * live fee from the contract (`readFeeGate`, `readSplitFactoryTerms`), shows every fee on its own line,
 * simulates, and prints or signs through the shared flow.
 */

import { readFileSync } from "node:fs";

import {
  GULLYCORE_MULTISEND_ABI,
  parseRecipientsCsv,
  planMultisend,
  readFeeGate,
  buildErc20Approve,
  readErc20Allowance,
} from "@gullylabs/core-sdk/drop";
import { GULLYCORE_POSITION_LOCK_ABI, GULLYCORE_SPLIT_FACTORY_ABI, GULLYCORE_TOKEN_LOCK_ABI, readTokenMeta } from "@gullylabs/core-sdk/launchpad";
import { buildCreateSplit, readSplitFactoryTerms, validateSplitDraft, type SplitDraftPayee } from "@gullylabs/core-sdk/split";
import {
  buildApprovePositionForLock,
  buildClaimTokenLock,
  buildLockPosition,
  buildTokenLock,
  cliffLinearSchedule,
  readPositionApproval,
  readTokenLock,
  timeLockSchedule,
  validatePositionLock,
  validateTokenLock,
  viewTokenLock,
} from "@gullylabs/core-sdk/lock";
import { CL_POSITION_MANAGER_ABI } from "@gullylabs/core-sdk/trading";
import { erc20Abi, formatUnits, getAddress, isAddress, zeroAddress, type Abi, type Address } from "viem";

import { bpsPercent, formatUnitsTrim, parseIntStrict, parseUnitsExact } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, assertLiveChain, assertNativeValue, requireDeployment, requireFeature, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, requireFlag, type CommandSpec } from "../lib/command.js";
import { flowExit, runFlow, type FlowTx } from "../lib/flow.js";
import { canPrompt } from "../lib/prompt.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf } from "../lib/tx.js";
import { UsageError, UserError } from "../util/log.js";

async function currencyOf(ctx: ChainContext, token: string): Promise<{ address: Address; symbol: string; decimals: number; native: boolean }> {
  if (token.trim().toLowerCase() === "native") assertNativeValue(ctx);
  if (token.trim().toLowerCase() === "native") return { address: zeroAddress, symbol: ctx.chain.nativeCurrency.symbol, decimals: ctx.chain.nativeCurrency.decimals, native: true };
  if (!isAddress(token)) throw new UserError(`--token must be native or an address, received ${token}`);
  const meta = await readTokenMeta(ctx.client, getAddress(token));
  if (meta === null) throw new UserError(`${token} does not answer as an ERC-20 on ${ctx.name}`);
  return { address: meta.address, symbol: meta.symbol, decimals: meta.decimals, native: false };
}

/* ----------------------------------------------------------- multisend */

export const MULTISEND_SPEC: CommandSpec = {
  name: "multisend",
  summary: "send a token or native to many addresses from a CSV",
  usage: "gullycore multisend --csv <file> --token <native|address> --chain <chain> [signing]",
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    csv: { kind: "string", describe: "address,amount per line (whole tokens)", placeholder: "<file>" },
    token: { kind: "string", describe: "native, or the token address", placeholder: "<native|address>" },
  },
};

export async function runMultisend(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, MULTISEND_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(MULTISEND_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const multisend = requireFeature(ctx, "Multisend", ctx.deployment?.multisend);
  await assertLiveChain(ctx);
  const cur = await currencyOf(ctx, requireFlag(cmd, "token"));
  const parsed = parseRecipientsCsv(readFileSync(requireFlag(cmd, "csv"), "utf8"), { decimals: cur.decimals });
  for (const i of parsed.issues) out.warn(`line ${i.line}: ${i.message}`);
  if (!parsed.ok) throw new UserError("the CSV has errors; nothing was sent");
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const terms = await readFeeGate(ctx.client, multisend);
  const plan = planMultisend({ multisend, currency: cur.address, recipients: parsed.rows, terms });
  const txs: FlowTx[] = [];
  if (plan.approval !== null) {
    const allowance = await readErc20Allowance(ctx.client, cur.address, signer.address, multisend);
    if (allowance < plan.approval.amount) txs.push({ label: "approve (exact amount)", tx: { chainId: ctx.chainId, from: signer.address, ...buildErc20Approve(plan.approval) } });
  }
  plan.batches.forEach((b, i) => txs.push({ label: `batch ${i + 1} (${b.recipients} recipients)`, tx: { chainId: ctx.chainId, from: signer.address, ...b.call }, afterPrevious: txs.length > 0 }));
  const native = ctx.chain.nativeCurrency.symbol;
  out.line(ui.bold("Review"));
  out.rows([
    ["Recipients", String(parsed.rows.length)],
    ["Total", `${formatUnitsTrim(plan.totalAmount, cur.decimals)} ${cur.symbol}`],
    ["Fee", `${formatUnits(terms.feeWei, 18)} ${native} per batch × ${plan.batches.length}, to the protocol`],
  ]);
  const yes = cmd.bool("yes");
  const r = await runFlow(out, ctx, signer, txs, { prompting: !yes && !out.json && canPrompt(), yes, what: `This sends ${formatUnitsTrim(plan.totalAmount, cur.decimals)} ${cur.symbol}.`, expected: "send" }, [GULLYCORE_MULTISEND_ABI as unknown as Abi, erc20Abi as unknown as Abi]);
  out.result("multisend", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: { ...r, total: plan.totalAmount, batches: plan.batches.length } });
  return flowExit(r);
}

/* --------------------------------------------------------------- split */

export const SPLIT_SPEC: CommandSpec = {
  name: "split",
  summary: "create a Team split that pays several wallets by fixed shares",
  usage: "gullycore split --name <text> --payees 0xA:60,0xB:40 --chain <chain> [signing]",
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    name: { kind: "string", describe: "split name", placeholder: "<text>" },
    payees: { kind: "string", describe: "comma list of address:percent (percent may have 2 decimals)", placeholder: "<a:p,…>" },
  },
};

/** "0xA:60,0xB:40" -> payees with weights in basis points. Exported for tests. */
export function parsePayees(text: string): SplitDraftPayee[] {
  const rows = text.split(",").map((s) => s.trim()).filter(Boolean);
  const payees = rows.map((row) => {
    const [addr, pct, label] = row.split(":");
    if (addr === undefined || pct === undefined || !isAddress(addr)) throw new UserError(`payee "${row}" must be address:percent`);
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(pct.trim());
    if (m === null) throw new UserError(`payee "${row}": percent must be like 60 or 12.5`);
    return { address: getAddress(addr), weight: Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0"), ...(label !== undefined ? { label } : {}) };
  });
  const total = payees.reduce((s, p) => s + p.weight, 0);
  if (total !== 10_000) throw new UserError(`payee shares add up to ${bpsPercent(total)}, not 100%`);
  return payees;
}

export async function runSplit(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, SPLIT_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(SPLIT_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const factory = requireFeature(ctx, "Team splits", ctx.deployment?.splitFactory);
  await assertLiveChain(ctx);
  const draft = { name: requireFlag(cmd, "name"), payees: parsePayees(requireFlag(cmd, "payees", "e.g. --payees 0xA:60,0xB:40")) };
  const issues = validateSplitDraft(draft);
  if (issues.length > 0) throw new UserError(issues.map((i) => i.message).join(" "));
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const terms = await readSplitFactoryTerms(ctx.client, factory);
  const call = buildCreateSplit({ factory, draft, terms });
  const native = ctx.chain.nativeCurrency.symbol;
  out.line(ui.bold("Review"));
  out.rows([
    ["Name", draft.name],
    ...draft.payees.map((p, i) => [`Payee ${i + 1}`, `${p.address}  ${bpsPercent(Number(p.weight))}`] as const),
    ["Creation fee", `${formatUnits(terms.feeWei, 18)} ${native}, to the protocol`],
    ["Protocol share", `${bpsPercent(terms.protocolShareBps)} of everything paid through the split, frozen forever`],
    ["Permanent", "payees and shares can never change; a payee can only hand its own slot on"],
  ]);
  const yes = cmd.bool("yes");
  const tx = { chainId: ctx.chainId, from: signer.address, ...call };
  const r = await runFlow(out, ctx, signer, [{ label: "createSplit", tx }], { prompting: !yes && !out.json && canPrompt(), yes, what: "This creates the split with these shares forever.", expected: draft.name }, [GULLYCORE_SPLIT_FACTORY_ABI as unknown as Abi]);
  const created = r.sent.flatMap((s) => s.events).find((e) => e.name === "SplitCreated");
  out.result("split", { chainId: ctx.chainId, tx, result: { ...r, split: created?.args["split"] ?? null } });
  return flowExit(r);
}

/* ---------------------------------------------------------------- lock */

export const LOCK_SPEC: CommandSpec = {
  name: "lock",
  summary: "lock tokens or a CL position until a date, or vest tokens with a cliff",
  usage: "gullycore lock --token <native|address> --amount <n> --beneficiary <a> (--unlock-days <n> | --cliff-days <n> --vest-days <n>) --chain <chain> [signing]\n  gullycore lock position --token-id <id> --unlock-days <n> --chain <chain> [signing]\n  gullycore lock status <lockId> --chain <chain>\n  gullycore lock claim <lockId> --chain <chain> [signing]",
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    token: { kind: "string", describe: "native, or the token address", placeholder: "<native|address>" },
    amount: { kind: "string", describe: "amount in whole tokens", placeholder: "<n>" },
    beneficiary: { kind: "string", describe: "who can claim (default: the sender)", placeholder: "<address>" },
    "unlock-days": { kind: "string", describe: "time lock: everything unlocks after this many days", placeholder: "<n>" },
    "cliff-days": { kind: "string", describe: "vesting: nothing before this many days", placeholder: "<n>" },
    "vest-days": { kind: "string", describe: "vesting: fully vested after this many days", placeholder: "<n>" },
    "token-id": { kind: "string", describe: "lock position: the CL position's NFT id", placeholder: "<id>" },
  },
};

function unlockFee(ctx: ChainContext, feeWei: bigint): string {
  return `${formatUnits(feeWei, 18)} ${ctx.chain.nativeCurrency.symbol}, to the protocol`;
}

async function lockPosition(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, { ...LOCK_SPEC, name: "lock position" });
  const out = cmd.out;
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const d = requireDeployment(ctx);
  const lock = requireFeature(ctx, "Position locks", d.positionLock);
  await assertLiveChain(ctx);
  const tokenIdText = requireFlag(cmd, "token-id");
  if (!/^\d+$/.test(tokenIdText)) throw new UsageError("--token-id must be a whole number");
  const tokenId = BigInt(tokenIdText);
  const days = parseIntStrict(requireFlag(cmd, "unlock-days"), "unlock days", 1, 36_500);
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const now = (await ctx.client.getBlock()).timestamp;
  const unlockAt = now + BigInt(days) * 86_400n;
  const issues = validatePositionLock({ unlockAt, owner: signer.address, nowSeconds: now, lock });
  if (issues.length > 0) throw new UserError(issues.map((i) => i.message).join(" "));
  const terms = await readFeeGate(ctx.client, lock);
  const txs: FlowTx[] = [];
  const base = { chainId: ctx.chainId, from: signer.address };
  if (!(await readPositionApproval(ctx.client, { positionManager: d.clPositionManager, lock, tokenId, owner: signer.address }))) {
    txs.push({ label: "approve the position to the locker", tx: { ...base, ...buildApprovePositionForLock({ positionManager: d.clPositionManager, lock, tokenId }) } });
  }
  txs.push({ label: "lock position", tx: { ...base, ...buildLockPosition({ lock, tokenId, unlockAt, owner: signer.address, terms }) }, afterPrevious: txs.length > 0 });
  out.line(ui.bold("Review"));
  out.rows([
    ["Position", tokenId.toString()],
    ["Unlocks", new Date(Number(unlockAt) * 1000).toISOString()],
    ["Fee", unlockFee(ctx, terms.feeWei)],
    ["Permanent", "the position cannot leave the locker before then; its fees stay collectable"],
  ]);
  const yes = cmd.bool("yes");
  const r = await runFlow(out, ctx, signer, txs, { prompting: !yes && !out.json && canPrompt(), yes, what: "This locks the position until that date.", expected: "lock" }, [GULLYCORE_POSITION_LOCK_ABI as unknown as Abi, CL_POSITION_MANAGER_ABI as unknown as Abi]);
  out.result("lock position", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: r });
  return flowExit(r);
}

async function lockStatus(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, { ...LOCK_SPEC, name: "lock status" });
  const out = cmd.out;
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const lock = requireFeature(ctx, "Token locks", ctx.deployment?.tokenLock);
  await assertLiveChain(ctx);
  const id = cmd.args.positionals[0];
  if (id === undefined || !/^\d+$/.test(id)) throw new UsageError("gullycore lock status <lockId> needs the lock's number");
  const rec = await readTokenLock(ctx.client, lock, BigInt(id));
  const now = (await ctx.client.getBlock()).timestamp;
  const view = viewTokenLock(rec, now);
  const cur = await currencyOf(ctx, rec.currency === zeroAddress ? "native" : rec.currency);
  out.rows([
    ["Token", `${cur.symbol}`],
    ["Beneficiary", rec.beneficiary],
    ["Locked", `${formatUnitsTrim(rec.amount, cur.decimals)} ${cur.symbol}`],
    ["Claimed", formatUnitsTrim(rec.claimed, cur.decimals)],
    ["Claimable now", formatUnitsTrim(view.claimable, cur.decimals)],
    ["Status", view.status],
    ["Fully unlocked", new Date(Number(rec.end) * 1000).toISOString()],
  ]);
  out.result("lock status", { chainId: ctx.chainId, result: view });
  return 0;
}

async function lockClaim(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, { ...LOCK_SPEC, name: "lock claim" });
  const out = cmd.out;
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const lock = requireFeature(ctx, "Token locks", ctx.deployment?.tokenLock);
  await assertLiveChain(ctx);
  const id = cmd.args.positionals[0];
  if (id === undefined || !/^\d+$/.test(id)) throw new UsageError("gullycore lock claim <lockId> needs the lock's number");
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const tx = { chainId: ctx.chainId, from: signer.address, ...buildClaimTokenLock({ lock, lockId: BigInt(id), to: signer.address }) };
  const yes = cmd.bool("yes");
  const r = await runFlow(out, ctx, signer, [{ label: "claim", tx }], { prompting: !yes && !out.json && canPrompt(), yes, what: "This claims what has unlocked.", expected: "claim" }, [GULLYCORE_TOKEN_LOCK_ABI as unknown as Abi]);
  out.result("lock claim", { chainId: ctx.chainId, tx, result: r });
  return flowExit(r);
}

export async function runLock(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "position" && !rest.includes("--help")) return lockPosition(rest);
  if (sub === "status" && !rest.includes("--help")) return lockStatus(rest);
  if (sub === "claim" && !rest.includes("--help")) return lockClaim(rest);
  const cmd = parseCommand(argv, LOCK_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(LOCK_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const lock = requireFeature(ctx, "Token locks", ctx.deployment?.tokenLock);
  await assertLiveChain(ctx);
  const cur = await currencyOf(ctx, requireFlag(cmd, "token"));
  const amount = parseUnitsExact(requireFlag(cmd, "amount"), cur.decimals, "amount");
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const beneficiary = getAddress(cmd.str("beneficiary") ?? signer.address);
  const now = (await ctx.client.getBlock()).timestamp;
  const day = 86_400n;
  const unlock = cmd.str("unlock-days");
  const schedule =
    unlock !== undefined
      ? timeLockSchedule(now + BigInt(parseIntStrict(unlock, "unlock days", 1, 36_500)) * day)
      : cliffLinearSchedule({ start: now, cliffSeconds: BigInt(parseIntStrict(requireFlag(cmd, "cliff-days"), "cliff days", 0, 36_500)) * day, durationSeconds: BigInt(parseIntStrict(requireFlag(cmd, "vest-days"), "vest days", 1, 36_500)) * day });
  const issues = validateTokenLock({ currency: cur.address, amount, beneficiary, schedule, nowSeconds: now, lock });
  if (issues.length > 0) throw new UserError(issues.map((i) => i.message).join(" "));
  const terms = await readFeeGate(ctx.client, lock);
  const call = buildTokenLock({ lock, currency: cur.address, amount, beneficiary, schedule, terms });
  const txs: FlowTx[] = [];
  if (!cur.native && (await readErc20Allowance(ctx.client, cur.address, signer.address, lock)) < amount) {
    txs.push({ label: "approve (exact amount)", tx: { chainId: ctx.chainId, from: signer.address, ...buildErc20Approve({ token: cur.address, spender: lock, amount }) } });
  }
  txs.push({ label: "lock", tx: { chainId: ctx.chainId, from: signer.address, ...call }, afterPrevious: txs.length > 0 });
  const iso = (t: bigint): string => new Date(Number(t) * 1000).toISOString();
  out.line(ui.bold("Review"));
  out.rows([
    ["Amount", `${formatUnitsTrim(amount, cur.decimals)} ${cur.symbol}`],
    ["Beneficiary", beneficiary],
    ["Schedule", schedule.cliff === schedule.end ? `all unlocks ${iso(schedule.end)}` : `nothing before ${iso(schedule.cliff)}, fully vested ${iso(schedule.end)}`],
    ["Fee", `${formatUnits(terms.feeWei, 18)} ${ctx.chain.nativeCurrency.symbol}, to the protocol`],
    ["Permanent", "nobody can withdraw early or shorten the schedule, including you"],
  ]);
  const yes = cmd.bool("yes");
  const r = await runFlow(out, ctx, signer, txs, { prompting: !yes && !out.json && canPrompt(), yes, what: "This locks the tokens until the schedule releases them.", expected: "lock" }, [GULLYCORE_TOKEN_LOCK_ABI as unknown as Abi, erc20Abi as unknown as Abi]);
  out.result("lock", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: r });
  return flowExit(r);
}

