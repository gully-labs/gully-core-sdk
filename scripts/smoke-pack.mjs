#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/* Tarball smoke test: what npm would ship, installed the way a user installs it.

   1. `pnpm pack` each package (workspace:* ranges become real versions) into .smoke/tarballs.
   2. A fresh project in .smoke/project installs the three tarballs and viem from the npm registry.
   3. Checks, all read-only (nothing is signed or sent):
      - ESM import and CommonJS require of @gullylabs/core-sdk resolve, with the six chains in the book;
      - the installed CLI's dependency on the SDK is a real version, not a workspace range;
      - Gully Chain Testnet (485590): the CLI lists pools from the chain's own logs, and the SDK quotes a swap on
        one of them with the CL quoter (eth_call through the keyless Gully RPC endpoint);
      - a mainnet (Base, 8453 by default): every core contract in the book has code, the fee controller's
        builderFee() is the published 0.30 %, and the quoter answers a quote (or, where no pool exists yet,
        refuses it on chain with a revert, which proves the contract and RPC path);
      - `gullycore chain list --json` and `gullycore --version` from the installed bin;
      - `create-app` scaffolds a project from the installed tarball (no install of the generated app).

   node scripts/smoke-pack.mjs [--mainnet 8453] [--keep]
     SMOKE_RPC_BASE   default https://rpc.gullyrpc.xyz/gullychain/evm  (the chain id is appended)
   Exit 0 = every check passed. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mainnet = Number(args[args.indexOf("--mainnet") + 1] && args.includes("--mainnet") ? args[args.indexOf("--mainnet") + 1] : 8453);
const rpcBase = process.env.SMOKE_RPC_BASE || "https://rpc.gullyrpc.xyz/gullychain/evm";
const smoke = join(root, ".smoke");
const tarballs = join(smoke, "tarballs");
const project = join(smoke, "project");
const win = process.platform === "win32";
const run = (cmd, argv, cwd, opts = {}) => execFileSync(cmd, argv, { cwd, stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", shell: win, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 64 << 20 });

rmSync(smoke, { recursive: true, force: true });
mkdirSync(tarballs, { recursive: true });
mkdirSync(project, { recursive: true });

for (const pkg of ["sdk", "create-gully-core-app", "cli"]) run("pnpm", ["pack", "--pack-destination", tarballs], join(root, "packages", pkg));
const tgz = readdirSync(tarballs).filter((f) => f.endsWith(".tgz"));
const find = (prefix) => { const f = tgz.find((x) => x.startsWith(prefix)); if (!f) throw new Error(`no tarball ${prefix}*`); return join(tarballs, f); };
const sdkTgz = find("gullylabs-core-sdk-"), cliTgz = find("gullylabs-core-cli-"), createTgz = find("gullylabs-create-core-app-");

writeFileSync(join(project, "package.json"), JSON.stringify({ name: "gully-core-smoke", private: true, type: "module" }, null, 2));
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", sdkTgz, createTgz, cliTgz, "viem@^2"], project);

const cliPkg = JSON.parse(readFileSync(join(project, "node_modules", "@gullylabs", "core-cli", "package.json"), "utf8"));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
check("CLI depends on a real SDK version", /^\d+\.\d+\.\d+/.test(cliPkg.dependencies["@gullylabs/core-sdk"]), cliPkg.dependencies["@gullylabs/core-sdk"]);

/* CommonJS */
writeFileSync(join(project, "cjs.cjs"), `const sdk = require("@gullylabs/core-sdk");
const d = require("@gullylabs/core-sdk/deployments");
process.stdout.write(JSON.stringify({ ids: sdk.GULLYCORE_CHAIN_IDS, same: d.GULLYCORE_DEPLOYMENTS === sdk.GULLYCORE_DEPLOYMENTS, vault: sdk.requireDeployment(485590).vault }));`);
try {
  const r = JSON.parse(run("node", ["cjs.cjs"], project, { capture: true }));
  check("require('@gullylabs/core-sdk') (CommonJS)", [...r.ids].map(Number).sort((a, b) => a - b).join() === "56,4663,6714,8453,99901,485590" && /^0x[0-9a-fA-F]{40}$/.test(r.vault), `chains ${r.ids.join(",")}`);
} catch (e) { check("require('@gullylabs/core-sdk') (CommonJS)", false, String(e.stderr || e.message).slice(0, 300)); }

/* CLI bin */
const bin = (name) => join(project, "node_modules", ".bin", win ? `${name}.cmd` : name);
try { const v = run(bin("gullycore"), ["--version"], project, { capture: true }).trim(); check("gullycore --version", v.includes(cliPkg.version), v); } catch (e) { check("gullycore --version", false, String(e.stderr || e.message).slice(0, 300)); }
try {
  const out = JSON.parse(run(bin("gullycore"), ["chain", "list", "--json"], project, { capture: true }));
  const rows = out.result?.chains ?? [];
  check("gullycore chain list --json", rows.filter((c) => c.deployed).length === 6, `${rows.length} rows, ${rows.filter((c) => c.deployed).length} deployed`);
} catch (e) { check("gullycore chain list --json", false, String(e.stderr || e.message).slice(0, 300)); }

/* Testnet pools from the chain's own logs, through the keyless RPC */
let pools = [];
try {
  const out = JSON.parse(run(bin("gullycore"), ["pool", "list", "--chain", "485590", "--from-chain", "--json", "--rpc", `${rpcBase}/485590`], project, { capture: true }));
  pools = out.result?.pools ?? out.result ?? [];
  check("gullycore pool list --chain 485590 --from-chain", Array.isArray(pools) && pools.length > 0, `${Array.isArray(pools) ? pools.length : 0} pools`);
} catch (e) { check("gullycore pool list --chain 485590 --from-chain", false, String(e.stderr || e.message).slice(0, 300)); }
writeFileSync(join(smoke, "pools-485590.json"), JSON.stringify(pools, null, 2));

/* ESM: quotes */
writeFileSync(join(project, "quote.mjs"), `import { readFileSync } from "node:fs";
import { createPublicClient, http, parseUnits } from "viem";
import { BUILDER_FEE_ABI, GULLYCORE_CHAIN_IDS, applySlippage, quoteExactInputSingle, requireDeployment } from "@gullylabs/core-sdk";

const rpcBase = ${JSON.stringify(rpcBase)};
const out = { ids: GULLYCORE_CHAIN_IDS };
const client = (id) => createPublicClient({ transport: http(\`\${rpcBase}/\${id}\`, { retryCount: 3, retryDelay: 800 }) });

// Testnet: quote a small exact-input swap on each listed CL pool until one fills.
{
  const book = requireDeployment(485590);
  const c = client(485590);
  const pools = JSON.parse(readFileSync(${JSON.stringify(join(smoke, "pools-485590.json"))}, "utf8"));
  out.testnet = { tried: 0, quoted: null, errors: [] };
  for (const p of pools.filter((p) => (p.type ?? p.kind ?? p.poolType) === "CL").slice(0, 12)) {
    out.testnet.tried++;
    const key = p.key ?? { currency0: p.currency0, currency1: p.currency1, hooks: p.hooks, poolManager: p.poolManager, fee: p.fee, parameters: p.parameters };
    try {
      const amountIn = parseUnits("0.0001", 18);
      const { result } = await c.simulateContract(quoteExactInputSingle({ quoter: book.clQuoter, poolKey: key, tokenIn: key.currency0, amountIn }));
      if (result[0] > 0n) { out.testnet.quoted = { poolId: p.poolId ?? p.id, amountIn: String(amountIn), amountOut: String(result[0]), minOut: String(applySlippage(result[0], 50)) }; break; }
    } catch (e) { out.testnet.errors.push(String(e.shortMessage || e.message).slice(0, 120)); }
  }
}

// Mainnet: code at every core contract, builderFee, and the quoter path.
{
  const id = ${mainnet};
  const book = requireDeployment(id);
  const c = client(id);
  const names = ["vault", "clPoolManager", "binPoolManager", "universalRouter", "clQuoter", "binQuoter", "feeController", "clPositionManager"];
  const code = {};
  for (const n of names) code[n] = book[n] ? ((await c.getCode({ address: book[n] }))?.length ?? 0) > 2 : null;
  const builderFee = Number(await c.readContract({ address: book.feeController, abi: BUILDER_FEE_ABI, functionName: "builderFee" }));
  // USDC on the chain (the book lists only what Gully Core deployed or reads; these are the issuers' own tokens).
  const USDC = { 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" };
  const usdc = (book.tokens ?? []).find((t) => /^USDC/.test(t.symbol)) ?? (USDC[id] ? { address: USDC[id] } : undefined);
  let quote = null;
  try {
    const [a, b] = [book.weth, usdc?.address].filter(Boolean).map((x) => x.toLowerCase()).sort();
    const key = { currency0: a, currency1: b, hooks: "0x0000000000000000000000000000000000000000", poolManager: book.clPoolManager, fee: 3000, parameters: "0x00000000000000000000000000000000000000000000000000000000000a0000" };
    const { result } = await c.simulateContract(quoteExactInputSingle({ quoter: book.clQuoter, poolKey: key, tokenIn: key.currency0, amountIn: 10n ** 15n }));
    quote = { answered: true, amountOut: String(result[0]) };
  } catch (e) { quote = { answered: false, revert: String(e.shortMessage || e.message).slice(0, 160) }; }
  out.mainnet = { id, block: String(await c.getBlockNumber()), code, builderFee, quote };
}
process.stdout.write(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v)));
`);
try {
  const r = JSON.parse(run("node", ["quote.mjs"], project, { capture: true }));
  check("import '@gullylabs/core-sdk' (ESM), six chains", [...r.ids].length === 6, r.ids.join(","));
  check("testnet 485590: SDK quote through keyless Gully RPC", r.testnet.quoted !== null, r.testnet.quoted ? `pool ${String(r.testnet.quoted.poolId).slice(0, 12)}… out ${r.testnet.quoted.amountOut}` : `tried ${r.testnet.tried}: ${r.testnet.errors.slice(0, 2).join(" | ")}`);
  const m = r.mainnet;
  check(`mainnet ${m.id}: code at every core contract`, Object.values(m.code).every((v) => v !== false), JSON.stringify(m.code));
  check(`mainnet ${m.id}: builderFee() == 3000 pips (0.30 %)`, m.builderFee === 3000, `builderFee ${m.builderFee} pips`);
  check(`mainnet ${m.id}: quoter reached on chain (block ${m.block})`, m.quote.answered || /revert|PoolNotInitialized|execution reverted/i.test(m.quote.revert), m.quote.answered ? `out ${m.quote.amountOut}` : `no pool yet: ${m.quote.revert}`);
} catch (e) { check("ESM quotes", false, String(e.stderr || e.message).slice(0, 600)); }

/* create-app from the installed tarball */
try {
  run(bin("create-app"), ["smoke-app", "--chain", "gully-testnet", "--features", "dex", "--fee-bps", "0", "--yes", "--no-install"], project, { capture: true });
  check("create-app scaffolds a project", existsSync(join(project, "smoke-app", "gullycore.config.ts")));
} catch (e) {
  try { run(bin("create-app"), ["smoke-app", "--chain", "gully-testnet", "--features", "dex", "--fee-bps", "0", "--yes"], project, { capture: true }); check("create-app scaffolds a project", existsSync(join(project, "smoke-app", "gullycore.config.ts"))); }
  catch (e2) { check("create-app scaffolds a project", false, String(e2.stderr || e2.stdout || e2.message).slice(0, 400)); }
}

const bad = results.filter((r) => !r.ok);
writeFileSync(join(smoke, "report.json"), JSON.stringify(results, null, 2));
console.log(`SMOKE: ${bad.length === 0 ? "PASS" : "FAIL"} ${results.length - bad.length}/${results.length}`);
if (!args.includes("--keep") && bad.length === 0) rmSync(project, { recursive: true, force: true });
process.exit(bad.length === 0 ? 0 : 1);
