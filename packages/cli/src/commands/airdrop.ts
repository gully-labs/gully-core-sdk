// SPDX-License-Identifier: MIT
/**
 * `gullycore airdrop` — CSV to a Merkle drop, and back.
 *
 *   build   CSV -> claims file (root, total, every account's proof). Offline with --decimals.
 *   create  claims file -> `approve` (ERC-20) + `GullyCoreDropFactory.createDrop`; writes the drop address
 *           back into the claims file.
 *   verify  rebuilds the root from the file, compares it with the drop's stored `merkleRoot`, and then
 *           asks THE CONTRACT: each sampled unclaimed leaf's `claim(...)` is run as an `eth_call`, so the
 *           drop's own `MerkleProof.verify` judges the proof, not ours.
 *   claim   one account's claim, from the file.
 *
 * The leaf is the SDK's `dropLeaf` — `keccak256(bytes.concat(keccak256(abi.encode(index, account,
 * amount))))`, OpenZeppelin's double hash, the same bytes `GullyCoreMerkleDrop.claim` hashes.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  GULLYCORE_DROP_FACTORY_ABI,
  GULLYCORE_MERKLE_DROP_ABI,
  buildClaimDrop,
  buildCreateDrop,
  buildDropClaimsFile,
  buildErc20Approve,
  claimsOf,
  parseDropClaimsFile,
  parseRecipientsCsv,
  readDrop,
  readErc20Allowance,
  readFeeGate,
  validateDropDraft,
  verifyDropClaimsFile,
  type DropClaimsFile,
} from "@gullylabs/core-sdk/drop";
import { readTokenMeta } from "@gullylabs/core-sdk/launchpad";
import { erc20Abi, formatUnits, getAddress, isAddress, zeroAddress, type Abi, type Address } from "viem";

import { formatUnitsTrim, parseIntStrict } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, assertLiveChain, requireFeature, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, requireFlag, type CommandSpec } from "../lib/command.js";
import { flowExit, runFlow, type FlowTx } from "../lib/flow.js";
import { canPrompt } from "../lib/prompt.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf, simulate } from "../lib/tx.js";
import { UserError } from "../util/log.js";

export const AIRDROP_SPEC: CommandSpec = {
  name: "airdrop",
  summary: "build, create, verify and claim Merkle airdrops",
  usage:
    "gullycore airdrop build --csv <file> --token <native|address> --chain <chain> [--decimals n] [--out claims.json]\n" +
    "  gullycore airdrop create --claims <file> --chain <chain> [--days 30] [signing]\n" +
    "  gullycore airdrop verify --claims <file> --chain <chain> [--drop <address>] [--sample 3]\n" +
    "  gullycore airdrop claim --claims <file> --account <address> --chain <chain> [signing]",
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    csv: { kind: "string", describe: "address,amount per line (whole tokens)", placeholder: "<file>" },
    token: { kind: "string", describe: "native, or the token address", placeholder: "<native|address>" },
    decimals: { kind: "string", describe: "token decimals (skips reading them from chain)", placeholder: "<n>" },
    out: { kind: "string", describe: "where to write the claims file", placeholder: "<file>", defaultLabel: "claims.json" },
    claims: { kind: "string", describe: "a claims file from `gullycore airdrop build`", placeholder: "<file>" },
    days: { kind: "string", describe: "days the drop stays claimable (1 to 1825)", placeholder: "<n>", defaultLabel: "30" },
    metadata: { kind: "string", describe: "metadata URI stored with the drop", placeholder: "<uri>" },
    drop: { kind: "string", describe: "the drop address (default: the one in the claims file)", placeholder: "<address>" },
    sample: { kind: "string", describe: "unclaimed leaves to test against the contract", placeholder: "<n>", defaultLabel: "3" },
    account: { kind: "string", describe: "the account to claim for", placeholder: "<address>" },
  },
};

function readClaims(path: string): DropClaimsFile {
  try {
    return parseDropClaimsFile(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UserError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function tokenOf(ctx: ChainContext | null, token: string, decimalsFlag: string | undefined): Promise<{ address: Address; symbol: string | null; decimals: number }> {
  if (token.trim().toLowerCase() === "native") {
    return { address: zeroAddress, symbol: ctx?.chain.nativeCurrency.symbol ?? null, decimals: ctx?.chain.nativeCurrency.decimals ?? 18 };
  }
  if (!isAddress(token)) throw new UserError(`--token must be native or an address, received ${token}`);
  if (decimalsFlag !== undefined) return { address: getAddress(token), symbol: null, decimals: parseIntStrict(decimalsFlag, "decimals", 0, 36) };
  if (ctx === null) throw new UserError("pass --decimals, or --chain so they can be read");
  const meta = await readTokenMeta(ctx.client, getAddress(token));
  if (meta === null) throw new UserError(`${token} does not answer as an ERC-20`);
  return { address: meta.address, symbol: meta.symbol, decimals: meta.decimals };
}

export async function runAirdrop(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !["build", "create", "verify", "claim"].includes(sub)) {
    process.stdout.write(`${helpText(AIRDROP_SPEC)}\n`);
    return sub === undefined || sub.startsWith("-") ? 0 : 1;
  }
  const cmd = parseCommand(rest, { ...AIRDROP_SPEC, name: `airdrop ${sub}` });
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(AIRDROP_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });

  if (sub === "build") {
    const csvPath = requireFlag(cmd, "csv");
    const token = await tokenOf(cmd.str("decimals") !== undefined ? null : ctx, requireFlag(cmd, "token"), cmd.str("decimals"));
    const parsed = parseRecipientsCsv(readFileSync(csvPath, "utf8"), { decimals: token.decimals });
    for (const i of parsed.issues) out.warn(`line ${i.line}: ${i.message}`);
    if (!parsed.ok) throw new UserError(`${csvPath} has errors; nothing was written`);
    const file = buildDropClaimsFile({ chainId: ctx.chainId, currency: token.address, recipients: parsed.rows, symbol: token.symbol, decimals: token.decimals });
    const outPath = cmd.str("out") ?? "claims.json";
    writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
    out.line(`${ui.success("✓")} ${file.claims.length} claims, root ${file.merkleRoot}`);
    out.rows([
      ["total", `${formatUnitsTrim(BigInt(file.total), token.decimals)} ${token.symbol ?? ""}`.trim()],
      ["written", outPath],
    ]);
    out.result("airdrop build", { chainId: ctx.chainId, result: { root: file.merkleRoot, total: file.total, claims: file.claims.length, currency: file.currency, file: outPath } });
    return 0;
  }

  const factory = requireFeature(ctx, "Airdrops", ctx.deployment?.dropFactory);
  if (ctx.overrideSource !== null) out.line(ui.muted(`addresses: from ${ctx.overrideSource}`));
  await assertLiveChain(ctx);
  const claimsPath = requireFlag(cmd, "claims");
  const file = readClaims(claimsPath);
  if (file.chainId !== ctx.chainId) throw new UserError(`the claims file is for chain ${file.chainId}, not ${ctx.chainId}`);
  const abis = [GULLYCORE_DROP_FACTORY_ABI as unknown as Abi, GULLYCORE_MERKLE_DROP_ABI as unknown as Abi, erc20Abi as unknown as Abi];
  const yes = cmd.bool("yes");
  const prompting = !yes && !out.json && canPrompt();

  if (sub === "verify") {
    const dropFlag = cmd.str("drop");
    const drop = dropFlag !== undefined ? getAddress(dropFlag) : file.drop;
    if (drop === null) throw new UserError("--drop is required: the claims file does not name its drop yet");
    const info = await readDrop(ctx.client, drop);
    const check = verifyDropClaimsFile(file, { root: info.merkleRoot, chainId: ctx.chainId, currency: info.currency });
    out.line(check.ok ? `${ui.success("✓")} The file rebuilds the drop's root ${info.merkleRoot}` : `${ui.bold("✕")} ${check.issues.join(" ")}`);
    const sample = parseIntStrict(cmd.str("sample") ?? "3", "sample", 0, 1000);
    const results: Array<{ index: number; account: Address; contract: string }> = [];
    for (const c of file.claims) {
      if (results.length >= sample) break;
      const claimed = (await ctx.client.readContract({ address: drop, abi: GULLYCORE_MERKLE_DROP_ABI, functionName: "isClaimed", args: [BigInt(c.index)] })) as boolean;
      if (claimed) continue;
      const call = buildClaimDrop({ drop, claim: c });
      const sim = await simulate(ctx, { chainId: ctx.chainId, from: c.account, ...call }, abis);
      results.push({ index: c.index, account: c.account, contract: sim.ok ? "accepts" : `refuses: ${sim.error}` });
      out.line(`  ${sim.ok ? ui.success("✓") : ui.bold("✕")} leaf ${c.index} (${c.account}): the drop ${sim.ok ? "accepts the proof" : `refuses it: ${sim.error}`}`);
    }
    const ok = check.ok && results.every((r) => r.contract === "accepts");
    out.result("airdrop verify", { chainId: ctx.chainId, result: { drop, root: info.merkleRoot, rebuiltRoot: check.rebuiltRoot, fileOk: check.ok, issues: check.issues, contractChecks: results, ok } });
    return ok ? 0 : 1;
  }

  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));

  if (sub === "claim") {
    const dropFlag = cmd.str("drop");
    const drop = dropFlag !== undefined ? getAddress(dropFlag) : file.drop;
    if (drop === null) throw new UserError("--drop is required: the claims file does not name its drop yet");
    const account = requireFlag(cmd, "account");
    const mine = claimsOf(file, account);
    if (mine.length === 0) throw new UserError(`${account} has no claim in this file`);
    const txs: FlowTx[] = mine.map((c) => ({ label: `claim leaf ${c.index}`, tx: { chainId: ctx.chainId, from: signer.address, ...buildClaimDrop({ drop, claim: c }) } }));
    const r = await runFlow(out, ctx, signer, txs, { prompting, yes, what: "This claims the listed leaves.", expected: "claim" }, abis);
    out.result("airdrop claim", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: r });
    return flowExit(r);
  }

  /* create */
  const days = parseIntStrict(cmd.str("days") ?? "30", "days", 1, 1825);
  const now = (await ctx.client.getBlock()).timestamp;
  const expiresAt = now + BigInt(days) * 86_400n;
  const amount = BigInt(file.total);
  const metadata = cmd.str("metadata") ?? "";
  const issues = validateDropDraft({ amount, merkleRoot: file.merkleRoot, expiresAt, metadataURI: metadata, nowSeconds: now });
  if (issues.length > 0) throw new UserError(issues.map((i) => i.message).join(" "));
  const terms = await readFeeGate(ctx.client, factory);
  const create = buildCreateDrop({ factory, currency: file.currency, amount, merkleRoot: file.merkleRoot, expiresAt, metadataURI: metadata, terms });
  const txs: FlowTx[] = [];
  const isNative = file.currency === zeroAddress;
  if (!isNative) {
    const allowance = await readErc20Allowance(ctx.client, file.currency, signer.address, factory);
    if (allowance < amount) txs.push({ label: "approve (exact amount)", tx: { chainId: ctx.chainId, from: signer.address, ...buildErc20Approve({ token: file.currency, spender: factory, amount }) } });
  }
  txs.push({ label: "createDrop", tx: { chainId: ctx.chainId, from: signer.address, ...create }, afterPrevious: txs.length > 0 });
  const symbol = file.symbol ?? (isNative ? ctx.chain.nativeCurrency.symbol : "tokens");
  out.line(ui.bold("Review"));
  out.rows([
    ["Recipients", String(file.claims.length)],
    ["Total", `${file.decimals !== null ? formatUnitsTrim(amount, file.decimals) : amount.toString()} ${symbol}`],
    ["Root", file.merkleRoot],
    ["Claimable until", new Date(Number(expiresAt) * 1000).toISOString()],
    ["Fee", `${formatUnits(terms.feeWei, 18)} ${ctx.chain.nativeCurrency.symbol}, to the protocol`],
    ["After expiry", "only you can sweep what is left"],
  ]);
  const r = await runFlow(out, ctx, signer, txs, { prompting, yes, what: "This funds the drop.", expected: "drop" }, abis);
  const created = r.sent.flatMap((s) => s.events).find((e) => e.name === "DropCreated");
  const dropAddr = created !== undefined && typeof created.args["drop"] === "string" ? (created.args["drop"] as Address) : undefined;
  let readBack: unknown = null;
  if (dropAddr !== undefined) {
    writeFileSync(claimsPath, `${JSON.stringify({ ...file, drop: getAddress(dropAddr) }, null, 2)}\n`);
    readBack = await readDrop(ctx.client, getAddress(dropAddr));
    out.line(`${ui.success("✓")} Drop ${dropAddr}; ${claimsPath} now names it`);
  }
  out.result("airdrop create", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: { ...r, drop: dropAddr ?? null, expiresAt, readBack } });
  return flowExit(r);
}
