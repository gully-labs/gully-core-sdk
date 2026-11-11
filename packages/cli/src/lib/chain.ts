// SPDX-License-Identifier: MIT
/**
 * Which chain, which addresses, which RPC.
 *
 * Every address comes from `@gullylabs/core-sdk`'s address book. The CLI hardcodes none. Two overrides
 * exist, both the user's own, both announced on every screen that uses them:
 *
 *   --rpc <url>            or GULLYCORE_RPC_<chainId>              (the SDK's own env name)
 *   --deployment <file>    or GULLYCORE_DEPLOYMENT_OVERRIDE_<id>   (a path, or inline JSON)
 *
 * The override is a PARTIAL `GullyCoreDeployment` merged over the book entry, `launchpadV2` merged field by
 * field — the same shape the dapp accepts as `VITE_GULLYCORE_DEPLOYMENT_OVERRIDE_<chainId>`. As there,
 * `deployedAtBlock` must be a string; a number would lose precision and is refused rather than ignored.
 *
 * A chain the SDK knows but has no deployment for says so ("Gully Core has no deployment on <chain>"), and
 * a deployment whose feature address is null says "<feature> is not deployed on <chain>". An address is
 * never made up to fill the gap, and nothing is signed on such a chain (exit code 3).
 */

import { readFileSync, existsSync } from "node:fs";

import {
  CHAIN_RPCS,
  GULLYCORE_DEPLOYMENTS,
  chainById,
  getDeployment,
  gullycoreTransport,
  type GullyCoreDeployment,
} from "@gullylabs/core-sdk";
import { createPublicClient, defineChain, fallback, http, type Address, type Chain, type PublicClient, type Transport } from "viem";

import { loadConfig } from "./config.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

/**
 * The chains Gully Core is planned on, in order. Only the address book says which of them are live: this
 * list is what `gullycore chain list` walks, so a planned chain with no record shows as that.
 */
export const CHAIN_TARGETS: readonly number[] = [485590, 6714, 4663, 8453, 56, 99901, 999];

/** One line a chain needs beside its name. */
export const CHAIN_NOTES: Readonly<Record<number, string>> = {
  6714: "gas is paid in gasDAI, a gas-only ledger: no native pools, every pool quotes in an ERC-20",
};

/** Every name a chain answers to on the command line, lowercased, spaces/dashes removed. */
function chainAliases(): Map<string, number> {
  const out = new Map<string, number>();
  const add = (alias: string, id: number): void => {
    const key = alias.toLowerCase().replace(/[\s_-]/g, "");
    if (!out.has(key)) out.set(key, id);
  };
  for (const d of bookEntries()) {
    add(d.key, d.chainId);
    add(d.name, d.chainId);
    add(d.name.replace(/\s*chain$/i, ""), d.chainId);
    add(String(d.chainId), d.chainId);
  }
  for (const [key, c] of Object.entries(CHAIN_RPCS)) {
    add(key, c.chainId);
    add(c.name, c.chainId);
    add(String(c.chainId), c.chainId);
  }
  add("hyperliquid", 999);
  add("bnb", 56);
  add("testnet", 485590);
  add("gully", 485590);
  return out;
}

/** The address book's records. Empty until Gully Core's first deployment is recorded in the SDK. */
function bookEntries(): readonly GullyCoreDeployment[] {
  return Object.values(GULLYCORE_DEPLOYMENTS as Readonly<Record<number, GullyCoreDeployment>>);
}

/** A chain id from a name or number. Unknown names are an error, never a default. */
export function parseChain(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const id = chainAliases().get(trimmed.toLowerCase().replace(/[\s_-]/g, ""));
  if (id === undefined) {
    const known = bookEntries()
      .map((d) => `${d.key} (${d.chainId})`)
      .join(", ");
    throw new UsageError(`unknown chain "${input}"`, `Gully Core runs on: ${known}. A chain id also works. See gullycore chain list.`);
  }
  return id;
}

/** A readable name for any chain id the SDK has heard of. */
export function chainName(chainId: number): string {
  return getDeployment(chainId)?.name ?? chainById(chainId)?.name ?? `chain ${chainId}`;
}

/** A partial deployment, as a user writes it in JSON. */
export type DeploymentOverride = Partial<Omit<GullyCoreDeployment, "launchpadV2" | "deployedAtBlock">> & {
  readonly launchpadV2?: Partial<GullyCoreDeployment["launchpadV2"]>;
  readonly deployedAtBlock?: string;
};

function readOverrideSource(source: string): { json: unknown; label: string } {
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) return { json: JSON.parse(trimmed) as unknown, label: "inline JSON" };
  if (!existsSync(trimmed)) throw new UserError(`deployment override file not found: ${trimmed}`);
  return { json: JSON.parse(readFileSync(trimmed, "utf8")) as unknown, label: trimmed };
}

/** Merges an override over a base deployment. Pure; exported for tests. */
export function mergeDeployment(base: GullyCoreDeployment | undefined, chainId: number, raw: unknown): GullyCoreDeployment {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UserError("the deployment override must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if ("deployedAtBlock" in o && typeof o["deployedAtBlock"] !== "string") {
    throw new UserError(
      "deployedAtBlock in the deployment override must be a string",
      'write "deployedAtBlock": "1", not 1 — a number is ambiguous past 2^53',
    );
  }
  if ("chainId" in o && o["chainId"] !== chainId) {
    throw new UserError(`the deployment override is for chain ${String(o["chainId"])}, not ${chainId}`);
  }
  const lp = (o["launchpadV2"] ?? {}) as Record<string, unknown>;
  const baseLp = base?.launchpadV2 ?? {
    launchpadKitV2: null,
    launchLegs: null,
    launchTokenFactory: null,
    clLPLocker: null,
    binLPLocker: null,
    clLaunchGuardHook: null,
    binLaunchGuardHook: null,
    padFactory: null,
  };
  const merged = {
    ...(base ?? {}),
    ...o,
    chainId,
    name: (o["name"] as string | undefined) ?? base?.name ?? chainName(chainId),
    deployedAtBlock: typeof o["deployedAtBlock"] === "string" ? BigInt(o["deployedAtBlock"]) : (base?.deployedAtBlock ?? 0n),
    launchpadV2: { ...baseLp, ...lp },
  };
  return merged as unknown as GullyCoreDeployment;
}

export interface ChainContext {
  readonly chainId: number;
  readonly name: string;
  /** The book entry, with the override merged in when there is one. `null` means "Coming soon". */
  readonly deployment: GullyCoreDeployment | null;
  /** Where the addresses came from when not the book alone. */
  readonly overrideSource: string | null;
  readonly rpcUrls: readonly string[];
  readonly rpcFromUser: boolean;
  /** Real money unless the record says otherwise: an override that does not say counts as a mainnet. */
  readonly isMainnet: boolean;
  readonly chain: Chain;
  readonly client: PublicClient;
  readonly transport: Transport;
}

export interface ChainOptions {
  readonly chain?: string | undefined;
  readonly rpc?: string | undefined;
  readonly deployment?: string | undefined;
  readonly env?: Record<string, string | undefined>;
}

/** Resolves the chain, its addresses and a client. Does not touch the network. */
export function resolveChain(opts: ChainOptions): ChainContext {
  const env = opts.env ?? process.env;
  if (opts.chain === undefined) {
    throw new UsageError("--chain is required", "e.g. --chain gully-testnet, or a chain id; gullycore config set network <chain> sets a default");
  }
  const chainId = parseChain(opts.chain);
  const base = getDeployment(chainId);

  const overrideRaw = opts.deployment ?? env[`GULLYCORE_DEPLOYMENT_OVERRIDE_${chainId}`];
  let deployment: GullyCoreDeployment | null = base ?? null;
  let overrideSource: string | null = null;
  if (overrideRaw !== undefined && overrideRaw.trim() !== "") {
    const { json, label } = readOverrideSource(overrideRaw);
    deployment = mergeDeployment(base, chainId, json);
    overrideSource = label;
  }

  /* A user-supplied RPC (flag, else GULLYCORE_RPC_<id>) is used EXCLUSIVELY. The SDK's transport appends the
     chain's public endpoints as a safety net; for a tool that signs, that net is a hazard: a local node on
     a mainnet chain id (a devnet, a fork) that errors once would have the next request — possibly a signed
     transaction — fall through to the real network. So the public list is used only when the user gave none. */
  const split = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const userRpc = split(opts.rpc);
  const envRpc = split(env[`GULLYCORE_RPC_${chainId}`]);
  /* The saved setting only applies to the real environment, so an explicit `env` stays self-contained. */
  const savedRpc = opts.env === undefined ? split(loadConfig().rpc?.[String(chainId)]) : [];
  const chosen = userRpc.length > 0 ? userRpc : envRpc.length > 0 ? envRpc : savedRpc;
  const rpcFromUser = chosen.length > 0;

  let transport: Transport;
  let rpcUrls: string[];
  if (rpcFromUser) {
    rpcUrls = chosen;
    transport =
      chosen.length === 1
        ? http(chosen[0], { timeout: 30_000, retryCount: 1 })
        : fallback(chosen.map((u) => http(u, { timeout: 30_000, retryCount: 0 })), { rank: false, retryCount: 1 });
  } else {
    rpcUrls = chainById(chainId)?.endpoints.map((e) => e.url) ?? [];
    if (rpcUrls.length === 0) {
      throw new UserError(`no RPC endpoint is known for ${chainName(chainId)}`, "pass --rpc <url>");
    }
    transport = gullycoreTransport(chainId, { env: {}, timeout: 20_000 });
  }

  const name = deployment?.name ?? chainName(chainId);
  const native = deployment?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 };
  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: native.name, symbol: native.symbol, decimals: native.decimals },
    rpcUrls: { default: { http: rpcUrls } },
  });
  const client = createPublicClient({ chain, transport }) as PublicClient;
  return { chainId, name, deployment, overrideSource, rpcUrls, rpcFromUser, isMainnet: deployment?.isMainnet !== false, chain, client, transport };
}

/** The deployment, or the refusal a user sees on a chain Gully Core has not reached. */
export function requireDeployment(ctx: ChainContext): GullyCoreDeployment {
  if (ctx.deployment === null) throw new UserError(`Gully Core has no deployment on ${ctx.name}`, "gullycore chain list shows where it runs", EXIT.NO_DEPLOYMENT);
  return ctx.deployment;
}

/** A feature's address, or a refusal naming the feature. */
export function requireFeature(ctx: ChainContext, feature: string, address: Address | null | undefined): Address {
  requireDeployment(ctx);
  if (address === null || address === undefined) throw new UserError(`${feature}: not deployed on ${ctx.name}`, undefined, EXIT.NO_DEPLOYMENT);
  return address;
}

/** Refuses native value on a chain whose gas coin cannot move inside the EVM. */
export function assertNativeValue(ctx: ChainContext): void {
  if (ctx.deployment?.nativeValueTransfers !== false) return;
  const quote = ctx.deployment.quoteToken;
  throw new UserError(`${ctx.chain.nativeCurrency.symbol} on ${ctx.name} pays for gas only: it cannot be sent, swapped or pooled`, quote !== undefined ? `use its ERC-20 quote token, ${quote}` : undefined, EXIT.REFUSED);
}

/** Confirms the RPC is the chain it claims to be. A wrong chain is how testnet calls land on mainnet. */
export async function assertLiveChain(ctx: ChainContext): Promise<void> {
  let live: number;
  try {
    live = await ctx.client.getChainId();
  } catch (e) {
    throw new UserError(`${ctx.name} could not be reached`, "check --rpc, or try again", EXIT.NETWORK);
  }
  if (live !== ctx.chainId) {
    throw new UserError(`the RPC answers chain ${live}, not ${ctx.chainId}`, "check --rpc / GULLYCORE_RPC_<chainId>");
  }
}

export function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/** Common flags every chain-touching command takes. */
export const CHAIN_FLAGS = {
  chain: { kind: "string", describe: "chain name or id (gully-testnet, 485590, …); else the network setting", placeholder: "<chain>" },
  network: { kind: "string", describe: "the same as --chain", placeholder: "<chain>" },
  rpc: { kind: "string", describe: "your own RPC URL(s), comma list; else GULLYCORE_RPC_<chainId>; else the public endpoints. A given RPC is used alone, never mixed with public ones", placeholder: "<url>" },
  deployment: {
    kind: "string",
    describe: "JSON file (or inline JSON) of addresses merged over the address book; else GULLYCORE_DEPLOYMENT_OVERRIDE_<chainId>",
    placeholder: "<file>",
  },
  json: { kind: "boolean", describe: "print one JSON document on stdout (schema gullycore.cli/1)" },
} as const;
