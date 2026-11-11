// SPDX-License-Identifier: MIT
/**
 * `gullycore vault list|info|create|deposit`.
 *
 * A managed vault holds one CL position pair (a base range and a limit range) for its depositors and rebalances
 * from a TWAP. This command reads the vaults a chain's factory made, makes a new one, and deposits. Approvals
 * are exact and go to the vault itself (it pulls the tokens; Permit2 is not involved).
 *
 * `create` pays the factory's creation fee and makes the sender the curator; the vault address is fixed by the
 * sender and the salt, so the same command run twice with the same `--salt` cannot make two vaults.
 */

import { poolKeyToId, readCLPoolKeyParameters } from "@gullylabs/core-sdk";
import { buildErc20Approve, readErc20Allowance } from "@gullylabs/core-sdk/lock";
import {
  MANAGED_VAULT_ABI,
  VAULT_FACTORY_ABI,
  buildCreateVault,
  buildDeposit,
  buildDepositInitial,
  decodeVaultCreated,
  defaultVaultConfig,
  readFactoryFees,
  readVault,
  readVaultAddresses,
  sharesForAmounts,
  vaultCreateSafeValue,
  withSlippage,
  type VaultConfig,
  type VaultState,
} from "@gullylabs/core-sdk/vaults";
import { randomBytes } from "node:crypto";
import { erc20Abi, getAddress, isAddress, type Abi, type Address, type Hex } from "viem";

import { API_FLAGS, apiBase } from "../lib/api.js";
import { formatUnitsTrim, parseIntStrict, parseUnitsExact } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, assertLiveChain, requireDeployment, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, requireFlag, type CommandSpec } from "../lib/command.js";
import { loadConfig } from "../lib/config.js";
import { assertMayWrite, flowExit, runFlow, type FlowTx } from "../lib/flow.js";
import { assertPoolId, findPool } from "../lib/pools.js";
import { canPrompt } from "../lib/prompt.js";
import { SLIPPAGE_FLAGS, slippageBps } from "../lib/slippage.js";
import { resolveToken, type ResolvedToken } from "../lib/tokens.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf } from "../lib/tx.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

function showHelp(spec: CommandSpec, out: { line(t: string): void }): number {
  out.line(helpText(spec));
  return 0;
}

function factoryOf(ctx: ChainContext): Address {
  const d = requireDeployment(ctx) as { readonly vaultFactory?: Address | null };
  if (d.vaultFactory === undefined || d.vaultFactory === null) {
    throw new UserError(`${ctx.name} has no vault factory in the address book`, "vaults are not deployed on this chain yet", EXIT.NO_DEPLOYMENT);
  }
  return d.vaultFactory;
}

function vaultAddress(text: string | undefined, flag: string): Address {
  if (text === undefined || !isAddress(text)) throw new UsageError(`${flag} must be a vault address`);
  return getAddress(text);
}

export const VAULT_LIST_SPEC: CommandSpec = {
  name: "vault list",
  summary: "the vaults the chain's factory has made",
  usage: "gullycore vault list --chain <chain> [--limit <n>]",
  flags: { ...CHAIN_FLAGS, limit: { kind: "string", describe: "how many, newest first", placeholder: "<n>", defaultLabel: "25" } },
  examples: ["gullycore vault list --chain gully-testnet"],
};

export const VAULT_INFO_SPEC: CommandSpec = {
  name: "vault info",
  summary: "one vault: pool, curator, totals, ranges, whether it can rebalance",
  usage: "gullycore vault info <vault> --chain <chain>",
  flags: { ...CHAIN_FLAGS },
  examples: ["gullycore vault info 0x… --chain gully-testnet"],
};

export const VAULT_CREATE_SPEC: CommandSpec = {
  name: "vault create",
  summary: "make a managed vault on a CL pool; you become its curator",
  usage: "gullycore vault create --pool <id> [--oracle-pool <id>] [--curator-fee-bps <n>] [--salt <bytes32>] --chain <chain> [signing]",
  bytes32Flags: ["pool", "oracle-pool", "salt"],
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    ...API_FLAGS,
    pool: { kind: "string", describe: "the CL pool the vault holds", placeholder: "<poolId>" },
    "oracle-pool": { kind: "string", describe: "the pool whose oracle hook supplies the TWAP (default: --pool)", placeholder: "<poolId>" },
    "curator-fee-bps": { kind: "string", describe: "the curator's performance fee, basis points (cap 2000)", placeholder: "<bps>", defaultLabel: "0" },
    salt: { kind: "string", describe: "32 bytes that fix the vault address with your wallet (default: random)", placeholder: "<bytes32>" },
  },
  examples: ["gullycore vault create --pool 0x… --chain gully-testnet --dry-run --from 0x…"],
};

export const VAULT_DEPOSIT_SPEC: CommandSpec = {
  name: "vault deposit",
  summary: "deposit into a vault; the first deposit places its range",
  usage: "gullycore vault deposit <vault> --amount0 <n> --amount1 <n> --chain <chain> [signing]",
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    ...SLIPPAGE_FLAGS,
    amount0: { kind: "string", describe: "currency0 to deposit, whole tokens", placeholder: "<n>" },
    amount1: { kind: "string", describe: "currency1 to deposit, whole tokens", placeholder: "<n>" },
  },
  examples: ["gullycore vault deposit 0x… --amount0 1 --amount1 3500 --chain gully-testnet --dry-run --from 0x…"],
};

export const VAULT_SPECS = [VAULT_LIST_SPEC, VAULT_INFO_SPEC, VAULT_CREATE_SPEC, VAULT_DEPOSIT_SPEC];

const rangeText = (r: { lower: number; upper: number }): string => `ticks ${r.lower} to ${r.upper}`;

function stateJson(v: VaultState): Record<string, unknown> {
  return {
    address: v.address,
    poolId: poolKeyToId(v.key),
    curator: v.curator,
    performanceFeeBps: v.performanceFeeBps,
    totalSupply: v.totalSupply,
    total0: v.total0,
    total1: v.total1,
    base: v.base,
    limit: v.limit,
    lastRebalanceAt: v.lastRebalanceAt,
    canRebalance: v.canRebalance,
    config: v.config,
  };
}

export async function runVaultList(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, VAULT_LIST_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(VAULT_LIST_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const factory = factoryOf(ctx);
  await assertLiveChain(ctx);
  const limit = parseIntStrict(cmd.str("limit") ?? "25", "--limit", 1, 500);
  const all = await readVaultAddresses(ctx.client, factory);
  const shown = [...all].reverse().slice(0, limit);
  const states = await Promise.all(shown.map((a) => readVault(ctx.client, a)));
  out.line(ui.bold(`${all.length} vault${all.length === 1 ? "" : "s"} on ${ctx.name} (factory ${factory})`));
  for (const s of states) out.line(`  ${s.address}  pool ${poolKeyToId(s.key).slice(0, 12)}…  shares ${s.totalSupply}  curator ${s.curator}`);
  out.result("vault list", { chainId: ctx.chainId, result: { factory, total: all.length, vaults: states.map(stateJson) } });
  return 0;
}

export async function runVaultInfo(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, VAULT_INFO_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(VAULT_INFO_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  await assertLiveChain(ctx);
  const vault = vaultAddress(cmd.args.positionals[0], "<vault>");
  let v: VaultState;
  try {
    v = await readVault(ctx.client, vault);
  } catch {
    throw new UserError(`${vault} does not answer as a Gully Core vault on ${ctx.name}`, "check the address and the chain: gullycore vault list");
  }
  const [t0, t1] = await Promise.all([resolveToken(ctx, v.key.currency0, "currency0"), resolveToken(ctx, v.key.currency1, "currency1")]);
  out.line(ui.bold(`${t0.symbol}/${t1.symbol} vault`));
  out.rows([
    ["Vault", v.address],
    ["Pool id", poolKeyToId(v.key)],
    ["Curator", v.curator],
    ["Performance fee", `${v.performanceFeeBps / 100}%`],
    ["Shares", v.totalSupply.toString()],
    [`Holds ${t0.symbol}`, formatUnitsTrim(v.total0, t0.decimals)],
    [`Holds ${t1.symbol}`, formatUnitsTrim(v.total1, t1.decimals)],
    ["Base range", rangeText(v.base)],
    ["Limit range", rangeText(v.limit)],
    ["Can rebalance", v.canRebalance.ok ? "yes" : `no: ${v.canRebalance.reason}`],
  ]);
  out.result("vault info", { chainId: ctx.chainId, result: { ...stateJson(v), tokens: [t0, t1] } });
  return 0;
}

const CREATE_ABIS = [VAULT_FACTORY_ABI as unknown as Abi, MANAGED_VAULT_ABI as unknown as Abi];

export async function runVaultCreate(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, VAULT_CREATE_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(VAULT_CREATE_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const factory = factoryOf(ctx);
  const d = requireDeployment(ctx);
  const yes = cmd.bool("yes");
  assertMayWrite(ctx, yes);
  await assertLiveChain(ctx);
  const api = apiBase(cmd.str("api"));
  const pool = await findPool(ctx, api, assertPoolId(requireFlag(cmd, "pool")));
  if (pool.kind !== "CL") throw new UsageError("a vault holds a CL pool; --pool is a Bin pool");
  const oracleFlag = cmd.str("oracle-pool");
  const oracle = oracleFlag === undefined ? pool : await findPool(ctx, api, assertPoolId(oracleFlag));
  const spacing = readCLPoolKeyParameters(pool.key).tickSpacing;
  const curatorFeeBps = parseIntStrict(cmd.str("curator-fee-bps") ?? "0", "--curator-fee-bps", 0, 2_000);
  const config: VaultConfig = defaultVaultConfig(spacing, curatorFeeBps);
  const saltFlag = cmd.str("salt");
  const salt: Hex = saltFlag !== undefined ? (saltFlag as Hex) : (`0x${randomBytes(32).toString("hex")}` as Hex);
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  const fees = await readFactoryFees(ctx.client, factory);
  const built = buildCreateVault({ factory, key: pool.key, oracleKey: oracle.key, config, salt, feeWei: vaultCreateSafeValue(fees), clPoolManager: d.clPoolManager });
  const [t0, t1] = await Promise.all([resolveToken(ctx, pool.key.currency0, "currency0"), resolveToken(ctx, pool.key.currency1, "currency1")]);
  const native = ctx.chain.nativeCurrency.symbol;
  out.line(ui.bold("Review"));
  out.rows([
    ["Vault on", `${t0.symbol}/${t1.symbol} CL pool ${pool.poolId.slice(0, 12)}…`],
    ["Curator", `${signer.address} (you)`],
    ["Creation fee", `${formatUnitsTrim(fees.feeWei, 18)} ${native} (the factory refunds anything above it)`],
    ["Range", `base half-width ${config.baseHalfWidth} ticks, rebalance cooldown ${config.cooldown}s, TWAP ${config.twapWindow}s`],
    ["Curator fee", `${curatorFeeBps / 100}% of the vault's earnings`],
  ]);
  const tx = { chainId: ctx.chainId, from: signer.address, to: built.to, data: built.data, value: built.value };
  const confirm = { prompting: !yes && !out.json && canPrompt(), yes, what: "This makes the vault and pays the creation fee.", expected: "create" };
  const r = await runFlow(out, ctx, signer, [{ label: "createVault", tx }], confirm, CREATE_ABIS);
  let created: Address | null = null;
  if (r.ok && r.sent.length > 0) {
    const first = r.sent[0] as { hash: Hex };
    const receipt = await ctx.client.getTransactionReceipt({ hash: first.hash });
    created = decodeVaultCreated(receipt.logs, factory);
    if (created === null) throw new UserError("the transaction succeeded but the factory logged no VaultCreated", `look at ${first.hash} before retrying: the vault may exist`, EXIT.SIMULATION);
    out.line(`${ui.success("✓")} Vault ${created}`);
  }
  out.result("vault create", { chainId: ctx.chainId, tx, result: { ...r, vault: created, poolId: pool.poolId, salt, config } });
  return flowExit(r);
}

const DEPOSIT_ABIS = [erc20Abi as unknown as Abi, MANAGED_VAULT_ABI as unknown as Abi];

export async function runVaultDeposit(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, VAULT_DEPOSIT_SPEC);
  const out = cmd.out;
  if (cmd.help) return showHelp(VAULT_DEPOSIT_SPEC, out);
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  requireDeployment(ctx);
  const yes = cmd.bool("yes");
  assertMayWrite(ctx, yes);
  await assertLiveChain(ctx);
  const bps = slippageBps(cmd.str("slippage"), loadConfig().slippage, cmd.bool("accept-high-slippage"));
  const vault = vaultAddress(cmd.args.positionals[0], "<vault>");
  const signer = await resolveSigner(signModeOf(cmd.args), cmd.str("from"), (a) => isAddress(a));
  let v: VaultState;
  try {
    v = await readVault(ctx.client, vault);
  } catch {
    throw new UserError(`${vault} does not answer as a Gully Core vault on ${ctx.name}`, "gullycore vault list shows the vaults on this chain");
  }
  const [t0, t1]: [ResolvedToken, ResolvedToken] = await Promise.all([resolveToken(ctx, v.key.currency0, "currency0"), resolveToken(ctx, v.key.currency1, "currency1")]);
  const want0 = parseUnitsExact(cmd.str("amount0") ?? "0", t0.decimals, "--amount0");
  const want1 = parseUnitsExact(cmd.str("amount1") ?? "0", t1.decimals, "--amount1");
  if (want0 === 0n && want1 === 0n) throw new UsageError("say how much: --amount0 and/or --amount1");
  const now = (await ctx.client.getBlock()).timestamp;
  const deadline = now + 1_200n;
  const max0 = want0 === 0n ? 0n : withSlippage(want0, bps, "max");
  const max1 = want1 === 0n ? 0n : withSlippage(want1, bps, "max");
  const initial = v.totalSupply === 0n;
  let shares = 0n;
  let call;
  if (initial) {
    call = buildDepositInitial({ vault, key: v.key, max0: want0, max1: want1, to: signer.address, deadline });
  } else {
    shares = sharesForAmounts({ total0: v.total0, total1: v.total1, supply: v.totalSupply, amount0: want0, amount1: want1 });
    if (shares === 0n) throw new UserError("those amounts buy no shares", "the vault holds both currencies in a ratio: add the amounts in that ratio");
    call = buildDeposit({ vault, key: v.key, shares, max0, max1, to: signer.address, deadline });
  }
  const txs: FlowTx[] = [];
  for (const [t, amount] of [[t0, initial ? want0 : max0], [t1, initial ? want1 : max1]] as const) {
    if (t.native || amount === 0n) continue;
    if ((await readErc20Allowance(ctx.client, t.address, signer.address, vault)) >= amount) continue;
    txs.push({
      label: `approve ${t.symbol} to the vault (exact amount)`,
      tx: { chainId: ctx.chainId, from: signer.address, ...buildErc20Approve({ token: t.address, spender: vault, amount }) },
      afterPrevious: txs.length > 0,
    });
  }
  txs.push({ label: initial ? "first deposit" : "deposit", tx: { chainId: ctx.chainId, from: signer.address, to: call.to, data: call.data, value: call.value }, afterPrevious: txs.length > 0 });
  out.line(ui.bold("Review"));
  out.rows([
    ["Vault", vault],
    [`Deposit ${t0.symbol}`, `${formatUnitsTrim(want0, t0.decimals)}${initial ? "" : `, at most ${formatUnitsTrim(max0, t0.decimals)}`}`],
    [`Deposit ${t1.symbol}`, `${formatUnitsTrim(want1, t1.decimals)}${initial ? "" : `, at most ${formatUnitsTrim(max1, t1.decimals)}`}`],
    ["Shares", initial ? "the first deposit sets the share price" : shares.toString()],
  ]);
  const confirm = { prompting: !yes && !out.json && canPrompt(), yes, what: `This deposits into the ${t0.symbol}/${t1.symbol} vault.`, expected: "deposit" };
  const r = await runFlow(out, ctx, signer, txs, confirm, DEPOSIT_ABIS);
  out.result("vault deposit", { chainId: ctx.chainId, txs: txs.map((t) => t.tx), result: { ...r, vault, initial, shares, amount0: want0, amount1: want1 } });
  return flowExit(r);
}

export async function runVault(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "list") return runVaultList(rest);
  if (sub === "info") return runVaultInfo(rest);
  if (sub === "create") return runVaultCreate(rest);
  if (sub === "deposit") return runVaultDeposit(rest);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    const cmd = parseCommand([], { name: "vault", summary: "", usage: "", flags: {} });
    cmd.out.line(VAULT_SPECS.map(helpText).join("\n\n"));
    return sub === undefined ? EXIT.USAGE : 0;
  }
  throw new UsageError(`unknown vault command "${sub}"`, "gullycore vault list | info | create | deposit");
}
