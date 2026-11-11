// SPDX-License-Identifier: MIT
/**
 * `gullycore doctor` — is this chain, this RPC and this wallet fit to use?
 *
 *  1. Every endpoint: chain id, latency, head, and the CONTRACT CLOCK — the contract-creation `eth_call`
 *     `0x436000524260205260406000f3` that returns (NUMBER, TIMESTAMP) as a contract sees them. On an
 *     Arbitrum Nitro chain NUMBER is the parent chain's block number and differs from eth_blockNumber;
 *     the address book records which clock each chain has, and a disagreement is flagged. So is a
 *     TIMESTAMP more than 60 s from the header's (a load-balanced RPC whose backends disagree), and
 *     endpoints that disagree with each other.
 *  2. The address book: every user-facing contract has code.
 *  3. Launch-kit wiring: the kit's own immutables agree with the address book.
 *  4. A wallet: balance, nonce, and EIP-7702 delegation code (which silently makes an address behave
 *     like a smart account).
 *  5. Drift: a site's stored terms against a terms file; or a scaffolded project's own
 *     `npm run gullycore:verify`, run in that project rather than re-implemented here.
 *
 * Read-only. Sends nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CONTRACT_CLOCK_PROBE_CALLDATA, decodeContractClockProbe, getContractClock } from "@gullylabs/core-sdk";
import { GULLYCORE_PAD_FACTORY_ABI, padTermsOf, readKitV2Env, readPad, type PadTerms } from "@gullylabs/core-sdk/launchpad";
import { resolveNativeUsd } from "@gullylabs/core-sdk/price";
import { createPublicClient, formatUnits, getAddress, http, isAddress, type Address } from "viem";

import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, firstLine, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, type CommandSpec } from "../lib/command.js";
import { termsFromFile } from "./site.js";
import { UserError } from "../util/log.js";

export const DOCTOR_SPEC: CommandSpec = {
  name: "doctor",
  summary: "check RPC health, the contract clock, the address book, a wallet and config drift",
  usage: "gullycore doctor --chain <chain> [--address <a>] [--site <a> --terms <file>] [--project <dir>]",
  flags: {
    ...CHAIN_FLAGS,
    address: { kind: "string", describe: "a wallet to check: balance, nonce, delegation code", placeholder: "<address>" },
    site: { kind: "string", describe: "a Launchpad/DEX site whose stored terms to compare", placeholder: "<address>" },
    terms: { kind: "string", describe: "the terms file to compare --site against", placeholder: "<file>" },
    project: { kind: "string", describe: "a scaffolded project: run its own gullycore:verify", placeholder: "<dir>" },
  },
  examples: ["gullycore doctor --chain gully-testnet", "gullycore doctor --chain gully-testnet --address 0x… --json"],
};

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export interface Check {
  readonly group: string;
  readonly status: CheckStatus;
  readonly label: string;
  readonly detail: string;
}

/** User-facing contracts in the address book, the only ones the doctor inspects. */
const BOOK_KEYS = [
  "vault",
  "clPoolManager",
  "binPoolManager",
  "clPositionManager",
  "binPositionManager",
  "clQuoter",
  "binQuoter",
  "universalRouter",
  "fillRouter",
  "permit2",
  "weth",
  "registry",
  "launchRegistry",
  "splitFactory",
  "positionLock",
  "tokenLock",
  "multisend",
  "dropFactory",
] as const;
const KIT_KEYS = ["launchpadKitV2", "launchTokenFactory", "clLPLocker", "binLPLocker", "clLaunchGuardHook", "binLaunchGuardHook", "padFactory"] as const;
/** The stock-pair contracts (the book's `rwa` group). */
const RWA_KEYS = ["marketHoursHook", "stockPairHook", "chainlinkPriceBandAdapter", "allowlistComplianceOracle"] as const;

export interface EndpointReport {
  readonly url: string;
  readonly ok: boolean;
  readonly chainId: number | null;
  readonly latencyMs: number | null;
  readonly rpcBlock: bigint | null;
  readonly headerTimestamp: bigint | null;
  readonly contractNumber: bigint | null;
  readonly contractTimestamp: bigint | null;
  readonly error: string | null;
}

/** Hides credentials in a URL path or query (keyed provider URLs embed them). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").map((seg) => (seg.length >= 20 && /[0-9a-f]{8}/i.test(seg) ? "***" : seg)).join("/");
    return `${u.protocol}//${u.host}${path}${u.search !== "" ? "?***" : ""}`;
  } catch {
    return "***";
  }
}

async function probeEndpoint(url: string): Promise<EndpointReport> {
  const client = createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 0 }) });
  const t0 = Date.now();
  try {
    const chainId = await client.getChainId();
    const latencyMs = Date.now() - t0;
    const [block, probe] = await Promise.all([
      client.getBlock({ blockTag: "latest" }),
      client.call({ data: CONTRACT_CLOCK_PROBE_CALLDATA }).then(
        (r) => (r.data !== undefined ? decodeContractClockProbe(r.data) : null),
        () => null,
      ),
    ]);
    return {
      url,
      ok: true,
      chainId,
      latencyMs,
      rpcBlock: block.number,
      headerTimestamp: block.timestamp,
      contractNumber: probe?.number ?? null,
      contractTimestamp: probe?.timestamp ?? null,
      error: null,
    };
  } catch (e) {
    return { url, ok: false, chainId: null, latencyMs: null, rpcBlock: null, headerTimestamp: null, contractNumber: null, contractTimestamp: null, error: e instanceof Error ? firstLine(e.message) : String(e) };
  }
}

/** Judges one endpoint's reading against the chain's recorded clock. Pure; exported for tests. */
export function judgeEndpoint(r: EndpointReport, chainId: number, recordedClock: "parent-l1" | "native" | null): Check[] {
  const label = redactUrl(r.url);
  const out: Check[] = [];
  if (!r.ok) return [{ group: "rpc", status: "fail", label, detail: `unreachable: ${r.error ?? "no answer"}` }];
  if (r.chainId !== chainId) return [{ group: "rpc", status: "fail", label, detail: `answers chain ${r.chainId}, not ${chainId}` }];
  out.push({ group: "rpc", status: "ok", label, detail: `chain ${r.chainId}, ${r.latencyMs} ms, head ${r.rpcBlock}` });
  if (r.contractNumber === null || r.contractTimestamp === null) {
    out.push({ group: "clock", status: "warn", label, detail: "refused the contract-clock probe (creation eth_call); block-number maths cannot be checked here" });
    return out;
  }
  const same = r.contractNumber === r.rpcBlock;
  const observed = same ? "native" : "parent-l1";
  const detail = `contract NUMBER ${r.contractNumber}, eth_blockNumber ${r.rpcBlock}`;
  if (recordedClock === null) {
    out.push({ group: "clock", status: "info", label, detail: `${detail}: this chain's contract clock looks ${observed}` });
  } else if (recordedClock !== observed) {
    out.push({
      group: "clock",
      status: "fail",
      label,
      detail:
        recordedClock === "parent-l1"
          ? `${detail}: they are EQUAL, but this chain's contracts should see the parent chain's block number. This endpoint is not the network the address book describes.`
          : `${detail}: they DIFFER, but this chain's contracts should see its own block number.`,
    });
  } else {
    out.push({ group: "clock", status: "ok", label, detail: `${detail} (${observed}, as recorded)` });
  }
  if (r.headerTimestamp !== null) {
    const skew = Number(r.contractTimestamp - r.headerTimestamp);
    if (Math.abs(skew) > 60) {
      out.push({ group: "clock", status: "warn", label, detail: `contract TIMESTAMP is ${skew} s from the header's: the endpoint's backends disagree` });
    }
  }
  return out;
}

/** Endpoints that disagree with each other by more than a minute of chain time. */
export function judgeSpread(reports: readonly EndpointReport[]): Check | null {
  const ts = reports.filter((r) => r.ok && r.headerTimestamp !== null).map((r) => Number(r.headerTimestamp));
  if (ts.length < 2) return null;
  const spread = Math.max(...ts) - Math.min(...ts);
  return spread > 60
    ? { group: "rpc", status: "warn", label: "endpoints", detail: `heads differ by ${spread} s of chain time: some endpoints lag` }
    : { group: "rpc", status: "ok", label: "endpoints", detail: `${ts.length} agree within ${spread} s` };
}

/** Field-by-field comparison of stored and intended terms. Pure; exported for tests. */
export function termsDrift(stored: PadTerms, intended: PadTerms): string[] {
  const out: string[] = [];
  const cmp = (k: string, a: unknown, b: unknown): void => {
    const na = typeof a === "string" ? a.toLowerCase() : JSON.stringify(a, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const nb = typeof b === "string" ? b.toLowerCase() : JSON.stringify(b, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    if (na !== nb) out.push(`${k}: on chain ${na}, file ${nb}`);
  };
  cmp("integrator", stored.integrator, intended.integrator);
  cmp("integratorBps", stored.integratorBps, intended.integratorBps);
  cmp("integratorLaunchFeeWei", stored.integratorLaunchFeeWei, intended.integratorLaunchFeeWei);
  cmp("allowedPresets", [...stored.allowedPresets].sort(), [...intended.allowedPresets].sort());
  cmp("allowedBinShapes", [...stored.allowedBinShapes].sort(), [...intended.allowedBinShapes].sort());
  cmp("restrictQuotes", stored.restrictQuotes, intended.restrictQuotes);
  cmp("active", stored.active, intended.active);
  cmp("maxTaxBps", stored.maxTaxBps ?? 0, intended.maxTaxBps ?? 0);
  cmp("taxIntegratorBps", stored.taxIntegratorBps ?? 0, intended.taxIntegratorBps ?? 0);
  return out;
}

async function bookChecks(ctx: ChainContext): Promise<Check[]> {
  const d = ctx.deployment;
  if (d === null) return [{ group: "book", status: "info", label: ctx.name, detail: `Gully Core has no deployment on ${ctx.name}` }];
  const entries: Array<[string, Address]> = [];
  for (const k of BOOK_KEYS) {
    const v = (d as unknown as Record<string, unknown>)[k];
    if (typeof v === "string" && isAddress(v)) entries.push([k, v]);
  }
  for (const k of KIT_KEYS) {
    const v = d.launchpadV2[k];
    if (v !== null && v !== undefined) entries.push([k, v]);
  }
  for (const k of RWA_KEYS) {
    const v = d.rwa?.[k];
    if (v !== null && v !== undefined) entries.push([k, v]);
  }
  const codes = await Promise.all(entries.map(([, a]) => ctx.client.getCode({ address: a }).catch(() => undefined)));
  return entries.map(([k, a], i) => {
    const code = codes[i];
    if (code === undefined) return { group: "book", status: "warn" as const, label: k, detail: `${a}: could not be read` };
    if (code === "0x" || code === null) return { group: "book", status: "fail" as const, label: k, detail: `${a}: no code on this chain` };
    return { group: "book", status: "ok" as const, label: k, detail: `${a} (${(code.length - 2) / 2} bytes)` };
  });
}

async function kitChecks(ctx: ChainContext): Promise<Check[]> {
  const d = ctx.deployment;
  const kit = d?.launchpadV2.launchpadKitV2 ?? null;
  if (d === null || kit === null) return [];
  const out: Check[] = [];
  try {
    const env = await readKitV2Env(ctx.client, kit);
    const expect: Array<[string, Address | null, Address]> = [
      ["clPoolManager", d.clPoolManager, env.clPoolManager],
      ["binPoolManager", d.binPoolManager, env.binPoolManager],
      ["clLaunchGuardHook", d.launchpadV2.clLaunchGuardHook, env.clHook],
      ["binLaunchGuardHook", d.launchpadV2.binLaunchGuardHook, env.binHook],
      ["clLPLocker", d.launchpadV2.clLPLocker, env.clLocker],
      ["binLPLocker", d.launchpadV2.binLPLocker, env.binLocker],
      ["launchTokenFactory", d.launchpadV2.launchTokenFactory, env.tokenFactory],
      ["launchRegistry", d.launchRegistry, env.launchRegistry],
    ];
    for (const [k, book, onKit] of expect) {
      if (book === null) continue;
      out.push(
        book.toLowerCase() === onKit.toLowerCase()
          ? { group: "kit", status: "ok", label: k, detail: "kit and address book agree" }
          : { group: "kit", status: "fail", label: k, detail: `the kit uses ${onKit}, the address book says ${book}` },
      );
    }
    out.push({ group: "kit", status: "ok", label: "clock", detail: "the launch kit runs on timestamps" });
  } catch (e) {
    out.push({ group: "kit", status: "fail", label: "launchpadKitV2", detail: e instanceof Error ? firstLine(e.message) : String(e) });
  }
  const pf = d.launchpadV2.padFactory;
  if (pf !== null) {
    try {
      const k = (await ctx.client.readContract({ address: pf, abi: GULLYCORE_PAD_FACTORY_ABI, functionName: "KIT" })) as Address;
      out.push(k.toLowerCase() === kit.toLowerCase() ? { group: "kit", status: "ok", label: "padFactory", detail: "sites launch through this kit" } : { group: "kit", status: "fail", label: "padFactory", detail: `sites launch through ${k}, not ${kit}` });
    } catch (e) {
      out.push({ group: "kit", status: "fail", label: "padFactory", detail: e instanceof Error ? firstLine(e.message) : String(e) });
    }
  }
  return out;
}

async function walletChecks(ctx: ChainContext, address: Address): Promise<Check[]> {
  const [balance, nonce, code] = await Promise.all([
    ctx.client.getBalance({ address }),
    ctx.client.getTransactionCount({ address }),
    ctx.client.getCode({ address }).catch(() => undefined),
  ]);
  const symbol = ctx.chain.nativeCurrency.symbol;
  const out: Check[] = [
    { group: "wallet", status: balance === 0n ? "warn" : "ok", label: "balance", detail: `${formatUnits(balance, ctx.chain.nativeCurrency.decimals)} ${symbol}${balance === 0n ? ": nothing to pay gas with" : ""}` },
    { group: "wallet", status: "info", label: "nonce", detail: String(nonce) },
  ];
  if (code !== undefined && code !== null && code !== "0x") {
    out.push(
      code.toLowerCase().startsWith("0xef0100")
        ? { group: "wallet", status: "warn", label: "delegation", detail: `EIP-7702 delegated to 0x${code.slice(8, 48)}: this address runs contract code` }
        : { group: "wallet", status: "info", label: "contract", detail: `a contract (${(code.length - 2) / 2} bytes)` },
    );
  }
  return out;
}

function projectCheck(dir: string): Check {
  const root = resolve(dir);
  const pkgPath = join(root, "package.json");
  if (!existsSync(join(root, "gullycore.config.ts")) || !existsSync(pkgPath)) {
    return { group: "drift", status: "fail", label: "project", detail: `${root} is not a scaffolded Gully Core project (no gullycore.config.ts)` };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  if (pkg.scripts?.["gullycore:verify"] === undefined) return { group: "drift", status: "fail", label: "project", detail: "no gullycore:verify script in package.json" };
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "gullycore:verify"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0
    ? { group: "drift", status: "ok", label: "gullycore:verify", detail: "the project's config matches the chain" }
    : { group: "drift", status: "fail", label: "gullycore:verify", detail: `exited ${r.status ?? "abnormally"}; see its output above` };
}

export async function runDoctor(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, DOCTOR_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(DOCTOR_SPEC));
    return 0;
  }
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  out.line(`${ui.bold(`Gully Core doctor · ${ctx.name}`)} ${ui.muted(`(chain ${ctx.chainId})`)}`);
  if (ctx.overrideSource !== null) out.line(ui.muted(`addresses: from ${ctx.overrideSource}`));

  const recorded = ctx.deployment?.contractBlockClock ?? getContractClock(ctx.chainId)?.clock ?? null;
  const reports = await Promise.all(ctx.rpcUrls.map((u) => probeEndpoint(u)));
  const checks: Check[] = [];
  for (const r of reports) checks.push(...judgeEndpoint(r, ctx.chainId, recorded));
  const spread = judgeSpread(reports);
  if (spread !== null) checks.push(spread);

  const reachable = reports.some((r) => r.ok && r.chainId === ctx.chainId);
  if (reachable) {
    checks.push(...(await bookChecks(ctx)));
    checks.push(...(await kitChecks(ctx)));
    const usd = await resolveNativeUsd({ client: ctx.client, chainId: ctx.chainId });
    checks.push(
      usd.ok
        ? { group: "price", status: "ok", label: "USD source", detail: usd.provenance.label }
        : { group: "price", status: "info", label: "USD source", detail: `none: ${usd.detail} Launches price in ${ctx.chain.nativeCurrency.symbol}.` },
    );
    const addr = cmd.str("address");
    if (addr !== undefined) {
      if (!isAddress(addr)) throw new UserError(`--address is not an address: ${addr}`);
      checks.push(...(await walletChecks(ctx, getAddress(addr))));
    }
    const site = cmd.str("site");
    const termsPath = cmd.str("terms");
    if (site !== undefined || termsPath !== undefined) {
      if (site === undefined || termsPath === undefined || !isAddress(site)) throw new UserError("--site <address> and --terms <file> go together");
      const rec = await readPad(ctx.client, getAddress(site));
      const drift = termsDrift(padTermsOf(rec), termsFromFile(termsPath));
      checks.push(
        drift.length === 0
          ? { group: "drift", status: "ok", label: rec.name, detail: "stored terms match the file" }
          : { group: "drift", status: "fail", label: rec.name, detail: drift.join("; ") },
      );
    }
  }
  const project = cmd.str("project");
  if (project !== undefined) checks.push(projectCheck(project));
  else if (existsSync("gullycore.config.ts")) checks.push({ group: "drift", status: "info", label: "project", detail: "a Gully Core project is here: run `gullycore doctor --project .` to verify it" });

  const ORDER = ["rpc", "clock", "book", "kit", "price", "wallet", "drift"];
  checks.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  const mark: Record<CheckStatus, string> = { ok: ui.success("✓"), warn: ui.bold("!"), fail: ui.bold("✕"), info: ui.muted("·") };
  let group = "";
  const titles: Record<string, string> = { rpc: "RPC", clock: "Contract clock", book: "Address book", kit: "Launch kit", price: "Price", wallet: "Wallet", drift: "Drift" };
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      out.line("");
      out.line(ui.accent(titles[group] ?? group));
    }
    out.line(`  ${mark[c.status]} ${c.label}  ${ui.muted(c.detail)}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  out.line("");
  out.line(fails === 0 ? `${ui.success("Healthy")}${warns > 0 ? ` with ${warns} warning(s)` : ""}` : `${ui.bold(`${fails} problem(s)`)}${warns > 0 ? `, ${warns} warning(s)` : ""}`);
  out.result("doctor", {
    chainId: ctx.chainId,
    result: {
      healthy: fails === 0,
      failures: fails,
      warnings: warns,
      recordedClock: recorded,
      endpoints: reports.map((r) => ({ ...r, url: redactUrl(r.url) })),
      checks,
    },
  });
  return fails === 0 ? 0 : 1;
}
