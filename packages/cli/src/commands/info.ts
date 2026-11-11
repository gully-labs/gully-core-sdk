// SPDX-License-Identifier: MIT
/**
 * The read-only commands: `gullycore fees`, `gullycore tokens`, `gullycore chain`.
 *
 * `fees` keeps the rule and the chain apart, as the SDK's `fees/terms.ts` does: the flat 0.30% for outside
 * builders is the rule, and the numbers beside it are read from the pool managers and the installed fee
 * controller. Where the chain does not charge the rule yet, the output says so.
 */

import { BUILDER_POOL_RULES, GULLYCORE_CHAIN_IDS, MAX_PROTOCOL_FEE, chainById, feeTermsTable, getDeployment, pipsPercentText, readChainFeeTerms, chainTermsSentence, type ChainFeeTerms } from "@gullylabs/core-sdk";
import { erc20Abi, getAddress, isAddress, isAddressEqual, type Address } from "viem";

import { API_FLAGS, DEFAULT_API, apiBase, apiGet } from "../lib/api.js";
import { formatUnitsTrim, parseIntStrict } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, CHAIN_NOTES, CHAIN_TARGETS, assertLiveChain, chainName, requireDeployment, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, type CommandSpec } from "../lib/command.js";
import { redactUrl } from "../lib/config.js";
import { formatProtocolFee, readController } from "../lib/fees.js";
import { assertPoolId, findPool, readPoolState } from "../lib/pools.js";
import { balanceOf, bookTokens, nativeToken, resolveToken } from "../lib/tokens.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

/* ---------------------------------------------------------------- fees --- */

export const FEES_SPEC: CommandSpec = {
  name: "fees",
  summary: "what Gully charges, read from the chain: the flat 0.30% for outside builders, the fee controller, a pool",
  usage: "gullycore fees --chain <chain> [--pool <id>] [--launchpad <address>]",
  bytes32Flags: ["pool"],
  flags: {
    ...CHAIN_FLAGS,
    ...API_FLAGS,
    pool: { kind: "string", describe: "also read this pool's protocol and LP fee", placeholder: "<poolId>" },
    launchpad: { kind: "string", describe: "ask whether this Launchpad has Gully terms (release 3)", placeholder: "<address>" },
  },
  examples: ["gullycore fees --chain gully-testnet", "gullycore fees --chain 485590 --pool 0x… --json"],
};

/**
 * The Gully launch fee, per tenant. Release 3 charges it only to a Launchpad the Gully Safe designated; an
 * outside builder pays none (2026-11-05). Release 2
 * has one set of terms for everybody. `tenantAsked` is whether `--launchpad` named one.
 */
export function launchFeeText(terms: ChainFeeTerms, amount: string, symbol: string, tenantAsked: boolean): string {
  const fee = `${amount} ${symbol}`;
  if (terms.release < 3) return fee;
  if (tenantAsked && terms.tenantDesignated !== null) return terms.tenantDesignated ? fee : "none (outside terms: Gully charges outside builders no launch fee)";
  return `${fee} on a Gully-designated Launchpad; none for outside builders`;
}

export async function runFees(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, FEES_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(FEES_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const d = requireDeployment(ctx);
  await assertLiveChain(ctx);
  const launchpad = cmd.str("launchpad");
  if (launchpad !== undefined && !isAddress(launchpad)) throw new UsageError(`--launchpad is not an address: ${launchpad}`);

  const [clController, binController] = await Promise.all([readController(ctx, d.clPoolManager), readController(ctx, d.binPoolManager)]);
  const kit = d.launchpadV2.launchpadKitV2;
  const terms: ChainFeeTerms | null = kit === null ? null : await readChainFeeTerms(ctx.client, { kit, protocolFeeController: clController, tenant: launchpad === undefined ? null : getAddress(launchpad) });
  const builderFee = terms?.builderFeePips ?? null;
  const flatInForce = builderFee === BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS;
  const wired = (c: Address | null): string => (c === null ? "none" : isAddressEqual(c, d.feeController) ? `${c} (the address book's)` : `${c} (not the address book's)`);

  out.line(ui.bold(`On ${ctx.name}, read from the chain`));
  out.rows([
    ["CL fee controller", wired(clController)],
    ["Bin fee controller", wired(binController)],
    ["Flat builder fee", builderFee === null ? "not in force: the installed controller has no builderFee()" : pipsPercentText(builderFee)],
    ["Core cap", `${pipsPercentText(MAX_PROTOCOL_FEE)} per direction`],
    ["Launch kit", terms === null ? "not deployed" : `release ${terms.release}`],
    ...(terms !== null && terms.launchFeeWei !== null ? [["Launch fee", launchFeeText(terms, formatUnitsTrim(terms.launchFeeWei, ctx.chain.nativeCurrency.decimals), ctx.chain.nativeCurrency.symbol, launchpad !== undefined)] as const] : []),
    ...(launchpad !== undefined && terms !== null ? [["Launchpad", terms.tenantDesignated === null ? "this kit has one set of terms" : terms.tenantDesignated ? "Gully terms" : "outside terms"] as const] : []),
  ]);
  if (terms !== null) out.line(ui.muted(chainTermsSentence(terms, ctx.name)));

  const poolFlag = cmd.str("pool");
  let poolBody: Record<string, unknown> | null = null;
  if (poolFlag !== undefined) {
    const pool = await findPool(ctx, apiBase(cmd.str("api")), assertPoolId(poolFlag));
    const state = await readPoolState(ctx, pool);
    out.line("");
    out.line(ui.bold("This pool"));
    out.rows([
      ["Protocol fee", formatProtocolFee(state.protocolFee)],
      ["LP fee", pipsPercentText(state.lpFee)],
    ]);
    poolBody = { poolId: pool.poolId, protocolFee: state.protocolFee, protocolFeeText: formatProtocolFee(state.protocolFee), lpFeePips: state.lpFee };
  }

  out.line("");
  out.line(ui.bold("The rule (2026-11-05)"));
  const table = feeTermsTable();
  out.rows(table.map((r) => [r.label, `outside builders: ${r.outside}. Gully's own surfaces: ${r.gully}.`] as const));
  out.result("fees", {
    chainId: ctx.chainId,
    result: {
      controllers: { cl: clController, bin: binController, addressBook: d.feeController },
      builderFeePips: builderFee,
      flatBuilderFeeInForce: flatInForce,
      capPips: MAX_PROTOCOL_FEE,
      rulePips: BUILDER_POOL_RULES.PROTOCOL_FEE_PIPS,
      kit: terms,
      launchFee: terms === null || terms.launchFeeWei === null ? null : { gullyTermsWei: terms.launchFeeWei, outsideBuildersWei: terms.release >= 3 ? 0n : terms.launchFeeWei, perTenant: terms.release >= 3, thisLaunchpadWei: launchpad === undefined || terms.tenantDesignated === null ? null : terms.tenantDesignated ? terms.launchFeeWei : 0n },
      sentence: terms === null ? null : chainTermsSentence(terms, ctx.name),
      pool: poolBody,
      rule: table,
    },
  });
  return 0;
}

/* -------------------------------------------------------------- tokens --- */

export const TOKENS_LIST_SPEC: CommandSpec = {
  name: "tokens list",
  summary: "the tokens the address book lists; --all adds what the API has indexed",
  usage: "gullycore tokens list --chain <chain> [--all] [--limit <n>]",
  flags: { ...CHAIN_FLAGS, ...API_FLAGS, all: { kind: "boolean", describe: "include every token the API has indexed (launches too)" }, limit: { kind: "string", describe: "how many with --all", placeholder: "<n>", defaultLabel: "50" } },
  examples: ["gullycore tokens list --chain gully-testnet"],
};

export const TOKENS_INFO_SPEC: CommandSpec = {
  name: "tokens info",
  summary: "one token, as its contract answers",
  usage: "gullycore tokens info <token> --chain <chain> [--holder <address>]",
  flags: { ...CHAIN_FLAGS, holder: { kind: "string", describe: "also read this address's balance", placeholder: "<address>" } },
  examples: ["gullycore tokens info WETH --chain gully-testnet --holder 0x…"],
};

async function tokensList(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, TOKENS_LIST_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(TOKENS_LIST_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const d = requireDeployment(ctx);
  const rows: { address: Address; symbol: string; name: string; decimals: number; test: boolean; source: string }[] = [
    { ...pick(nativeToken(ctx)), source: "native" },
    ...bookTokens(d).map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, test: t.isTestToken, source: "address book" })),
  ];
  if (cmd.bool("all")) {
    const limit = parseIntStrict(cmd.str("limit") ?? "50", "--limit", 1, 500);
    const data = (await apiGet(apiBase(cmd.str("api")), `/v1/chains/${ctx.chainId}/tokens?limit=${limit}`)) as { items?: readonly { address: string; symbol: string | null; name: string | null; decimals: number | null; isTestToken?: boolean }[] } | null;
    if (data === null) out.warn(`the API did not answer; showing the address book only`);
    for (const t of data?.items ?? []) {
      const address = t.address;
      if (!isAddress(address) || rows.some((r) => isAddressEqual(r.address, address))) continue;
      rows.push({ address: getAddress(address), symbol: t.symbol ?? "?", name: t.name ?? "?", decimals: t.decimals ?? 0, test: t.isTestToken === true, source: "indexed, unverified" });
    }
  }
  for (const r of rows) out.line(`${ui.accent(r.symbol.padEnd(12))}${r.address}  ${ui.muted(`${r.name}, ${r.decimals} decimals${r.test ? ", test token" : ""}`)}`);
  out.result("tokens list", { chainId: ctx.chainId, result: { tokens: rows } });
  return 0;
}

function pick(t: { address: Address; symbol: string; name: string; decimals: number; isTestToken: boolean }): { address: Address; symbol: string; name: string; decimals: number; test: boolean } {
  return { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, test: t.isTestToken };
}

async function tokensInfo(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, TOKENS_INFO_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(TOKENS_INFO_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  await assertLiveChain(ctx);
  const text = cmd.args.positionals[0];
  if (text === undefined) throw new UsageError("gullycore tokens info <token> needs a token");
  const t = await resolveToken(ctx, text, "token");
  const supply = t.native ? null : await ctx.client.readContract({ address: t.address, abi: erc20Abi, functionName: "totalSupply" }).catch(() => null);
  const holder = cmd.str("holder");
  if (holder !== undefined && !isAddress(holder)) throw new UsageError(`--holder is not an address: ${holder}`);
  const balance = holder === undefined ? null : await balanceOf(ctx, t, getAddress(holder));
  out.rows([
    ["Symbol", t.symbol],
    ["Name", t.name],
    ["Address", t.native ? "native" : t.address],
    ["Decimals", String(t.decimals)],
    ...(supply !== null ? [["Total supply", formatUnitsTrim(supply, t.decimals)] as const] : []),
    ...(balance !== null ? [["Balance", `${formatUnitsTrim(balance, t.decimals)} ${t.symbol}`] as const] : []),
    ...(t.isTestToken ? [["Test token", "no economic value"] as const] : []),
    ...(t.note !== undefined ? [["Note", t.note] as const] : []),
  ]);
  out.result("tokens info", { chainId: ctx.chainId, result: { ...t, totalSupply: supply, balance } });
  return 0;
}

export async function runTokens(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "info") return tokensInfo(rest);
  if (sub === "list") return tokensList(rest);
  /* Bare `gullycore tokens --chain x` lists, the common case. */
  if (sub === undefined || sub.startsWith("-")) return tokensList(argv);
  throw new UsageError(`unknown tokens command "${sub}"`, "gullycore tokens list | info");
}

/* --------------------------------------------------------------- chain --- */

export const CHAIN_LIST_SPEC: CommandSpec = {
  name: "chain list",
  summary: "the chains Gully Core is planned on, and which have a deployment",
  usage: "gullycore chain list",
  flags: { json: CHAIN_FLAGS.json },
};

export const CHAIN_STATUS_SPEC: CommandSpec = {
  name: "chain status",
  summary: "one chain, live: RPC, head block, core contracts, launch kit, API",
  usage: "gullycore chain status --chain <chain>",
  flags: { ...CHAIN_FLAGS, ...API_FLAGS },
  examples: ["gullycore chain status --chain gully-testnet", "gullycore chain status --chain anubis --json"],
};

interface ChainRow {
  readonly chainId: number;
  readonly name: string;
  readonly network: "mainnet" | "testnet" | "unknown";
  readonly deployed: boolean;
  readonly status: string;
  readonly note: string | null;
}

/** Every target and every book entry. A chain with no record says so; nothing here is guessed. */
export function chainRows(): readonly ChainRow[] {
  const ids = [...CHAIN_TARGETS, ...GULLYCORE_CHAIN_IDS.filter((id) => !CHAIN_TARGETS.includes(id))];
  return ids.map((chainId) => {
    const d = getDeployment(chainId);
    const known = chainById(chainId);
    return {
      chainId,
      name: d?.name ?? known?.name ?? chainName(chainId),
      network: d === undefined ? (known === undefined ? "unknown" : "mainnet") : d.isMainnet ? "mainnet" : "testnet",
      deployed: d !== undefined,
      status: d !== undefined ? "deployed" : "no deployment yet",
      note: CHAIN_NOTES[chainId] ?? null,
    };
  });
}

async function chainList(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, CHAIN_LIST_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(CHAIN_LIST_SPEC));
    return 0;
  }
  const rows = chainRows();
  for (const r of rows) {
    const status = r.deployed ? ui.success(r.status) : ui.muted(r.status);
    out.line(`${r.name.padEnd(24)}${String(r.chainId).padEnd(9)}${r.network.padEnd(9)}${status}`);
    if (r.note !== null) out.line(ui.muted(`  ${r.note}`));
  }
  out.result("chain list", { result: { chains: rows } });
  return 0;
}

async function readCode(ctx: ChainContext, a: Address): Promise<boolean> {
  const code = await ctx.client.getCode({ address: a });
  return code !== undefined && code !== "0x";
}

async function chainStatus(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, CHAIN_STATUS_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(CHAIN_STATUS_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain") ?? cmd.args.positionals[0], rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const rpc = ctx.rpcUrls.map((u) => (ctx.rpcFromUser ? redactUrl(u) : u));
  if (ctx.deployment === null) {
    out.line(`${ctx.name} (${ctx.chainId}): no Gully Core deployment yet.`);
    if (CHAIN_NOTES[ctx.chainId] !== undefined) out.line(ui.muted(CHAIN_NOTES[ctx.chainId] as string));
    out.result("chain status", { chainId: ctx.chainId, result: { name: ctx.name, deployed: false, rpc, note: CHAIN_NOTES[ctx.chainId] ?? null } });
    return 0;
  }
  const d = ctx.deployment;
  await assertLiveChain(ctx);
  const head = await ctx.client.getBlockNumber();
  const checks: readonly (readonly [string, Address | null])[] = [
    ["Vault", d.vault],
    ["CL pool manager", d.clPoolManager],
    ["Bin pool manager", d.binPoolManager],
    ["Universal router", d.universalRouter],
    ["Launch kit", d.launchpadV2.launchpadKitV2],
  ];
  const code = await Promise.all(checks.map(async ([name, a]) => ({ name, address: a, hasCode: a === null ? null : await readCode(ctx, a) })));
  const missing = code.filter((c) => c.hasCode === false).map((c) => c.name);
  const api = apiBase(cmd.str("api"));
  const health = await apiGet(api, `/v1/chains/${ctx.chainId}/health`);
  const terms = d.launchpadV2.launchpadKitV2 === null ? null : await readChainFeeTerms(ctx.client, { kit: d.launchpadV2.launchpadKitV2, protocolFeeController: d.feeController });
  out.rows([
    ["Chain", `${ctx.name} (${ctx.chainId}), ${d.isMainnet ? "mainnet" : "testnet"}`],
    ["RPC", rpc[0] ?? ""],
    ["Head block", head.toString()],
    ["Explorer", d.explorer],
    ...code.map((c) => [c.name, c.hasCode === null ? "not deployed" : c.hasCode ? `${c.address}` : `${c.address} HAS NO CODE`] as const),
    ["Launch kit release", terms === null ? "none" : String(terms.release)],
    ["API", health === null ? `${api === DEFAULT_API ? "the Gully Core API" : api} did not answer` : "answering"],
  ]);
  out.result("chain status", { chainId: ctx.chainId, result: { name: ctx.name, deployed: true, isMainnet: d.isMainnet, rpc, headBlock: head, explorer: d.explorer, contracts: code, kitRelease: terms?.release ?? null, apiAnswering: health !== null } });
  if (missing.length > 0) throw new UserError(`no code at the address book's ${missing.join(", ")} on ${ctx.name}`, "this RPC may not be the chain it claims, or the book is stale", EXIT.NETWORK);
  return 0;
}

export async function runChain(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "list" || sub === undefined) return chainList(rest);
  if (sub === "status") return chainStatus(rest);
  if (sub === "--help" || sub === "-h") return chainList(["--help"]);
  if (sub === "--json") return chainList(argv);
  throw new UsageError(`unknown chain command "${sub}"`, "gullycore chain list | status");
}
