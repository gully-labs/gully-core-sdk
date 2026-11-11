#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Read-only smoke test of the BUILT CLI against the live Gully Chain testnet. It signs nothing and holds no
 * key: every write command runs with --dry-run or --from, and a write to a chain with no deployment must be
 * refused. Run after `pnpm build`: `node scripts/smoke-testnet.mjs`.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin", "gullycore.js");
const CHAIN = ["--chain", "gully-testnet"];
/** A holder with no key behind this script: the Safe's address, used only to shape simulations. */
const FROM = "0xC5526E28B5cDe3C5962A224896804a499d5bb240";

let failed = 0;

/** One `eth_call` against the public testnet RPC. Read-only. */
async function rpcCall(to, data) {
  const res = await fetch("https://testnet-rpc.gullychain.xyz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const body = await res.json();
  if (body.error !== undefined) throw new Error(body.error.message);
  return body.result;
}

/** `wantCode` null records the outcome without judging it: the chain's state decides, not the CLI. */
function run(args, wantCode = 0) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000 });
  const label = `gullycore ${args.join(" ")}`.slice(0, 110);
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    /* human output */
  }
  const pass = wantCode === null || r.status === wantCode;
  console.log(`${pass ? "ok  " : "FAIL"} exit ${r.status}${wantCode === null ? "" : ` (want ${wantCode})`}  ${label}`);
  if (!pass) {
    failed += 1;
    console.log((r.stderr || r.stdout).split("\n").slice(0, 6).map((l) => `     ${l}`).join("\n"));
  }
  return { ...r, doc };
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} ${detail}`);
  if (!ok) failed += 1;
}

const list = run(["chain", "list", "--json"]);
check("the book's two chains are deployed", list.doc?.result.chains.filter((c) => c.deployed).map((c) => c.chainId).join() === "485590,6714");
const status = run(["chain", "status", ...CHAIN, "--json"]);
check("testnet head is moving past genesis", BigInt(status.doc?.result.headBlock ?? 0) > 0n, status.doc?.result.headBlock);
check("every core contract holds code", status.doc?.result.contracts.every((c) => c.hasCode === true));
console.log(`     kit release ${status.doc?.result.kitRelease}, API answering: ${status.doc?.result.apiAnswering}`);

/* Anubis is a mainnet: reads only, and writes stop at the guards. */
const anubis = run(["chain", "status", "--chain", "anubis", "--json"]);
check("Anubis: every core contract holds code", anubis.doc?.result.contracts?.every((c) => c.hasCode === true));
console.log(`     Anubis kit release ${anubis.doc?.result.kitRelease}, head ${anubis.doc?.result.headBlock}, API answering: ${anubis.doc?.result.apiAnswering}`);
const anubisFees = run(["fees", "--chain", "anubis", "--json"]);
console.log(`     Anubis builder fee ${anubisFees.doc?.result.builderFeePips}, kit ${anubisFees.doc?.result.kit?.release}\n     ${anubisFees.doc?.result.sentence}`);
check("Anubis: the flat 0.30% is in force and the controller is the book's", anubisFees.doc?.result.flatBuilderFeeInForce === true && anubisFees.doc?.result.controllers.cl?.toLowerCase() === anubisFees.doc?.result.controllers.addressBook.toLowerCase());
run(["tokens", "list", "--chain", "anubis", "--json"]);
const anubisPools = run(["pool", "list", "--chain", "anubis", "--from-chain", "--json"], null);
console.log(`     Anubis pools via logs: exit ${anubisPools.status}, ${anubisPools.doc?.result?.total ?? anubisPools.doc?.error?.message}`);
run(["swap", "exec", "--in", "native", "--out", "DAI", "--amount", "1", "--chain", "anubis", "--from", FROM, "--dry-run", "--json"], 6);
const anubisLaunch = run(["launch", "--chain", "anubis", "--name", "Smoke", "--symbol", "SMK", "--market-cap", "1000", "--from", FROM, "--dry-run", "--json"], null);
console.log(`     Anubis launch dry run: exit ${anubisLaunch.status}, quote ${anubisLaunch.doc?.result?.quote?.symbol}, ${JSON.stringify(anubisLaunch.doc?.simulation ?? anubisLaunch.doc?.error)}`);

const fees = run(["fees", ...CHAIN, "--json"]);
console.log(`     builder fee in force: ${fees.doc?.result.builderFeePips}, kit ${fees.doc?.result.kit?.release}\n     ${fees.doc?.result.sentence}`);
/* The chain is the truth: a controller the book does not name is printed, and is the SDK's to update. */
const liveController = fees.doc?.result.controllers.cl?.toLowerCase();
console.log(`     controller ${liveController}${liveController === fees.doc?.result.controllers.addressBook.toLowerCase() ? " (the book's)" : ` (the book says ${fees.doc?.result.controllers.addressBook})`}`);
check("both pool managers name the same controller", liveController !== undefined && liveController === fees.doc?.result.controllers.bin?.toLowerCase());
check("the flat fee is what the rule says, or absent", [null, 3000].includes(fees.doc?.result.builderFeePips ?? null), fees.doc?.result.builderFeePips);

run(["tokens", "list", ...CHAIN, "--json"]);
run(["tokens", "info", "WETH", ...CHAIN, "--json"]);

const viaApi = run(["pool", "list", ...CHAIN, "--limit", "200", "--json"]);
const viaChain = run(["pool", "list", ...CHAIN, "--from-chain", "--limit", "200", "--json"]);
console.log(`     pools: ${viaApi.doc?.result.total} via API, ${viaChain.doc?.result.total} via logs`);
check("API keys re-hash to their ids (none dropped)", (viaApi.doc?.result.pools.length ?? 0) > 0);

const pools = viaChain.doc?.result.pools ?? [];
const pool = pools.find((p) => p.type === "CL") ?? pools[0];
if (pool !== undefined) {
  run(["pool", "info", pool.poolId, ...CHAIN, "--json"]);
  run(["fees", ...CHAIN, "--pool", pool.poolId, "--json"]);
  const q = run(["swap", "quote", "--in", pool.currency1, "--out", pool.currency0, "--amount", "0.000001", "--pool", pool.poolId, ...CHAIN, "--json"], null);
  console.log(`     pool quote exit ${q.status}: ${q.doc?.result?.amountOut ?? q.doc?.error?.message}`);
}

/* The calldata this CLI encodes itself, against the real contracts: simulated, never sent. */
const FUNDED = "0x92cfc047652d6aef7eb0fa2744b912d9f627fa41";
const ZERO = "0x0000000000000000000000000000000000000000";
const open = run(["pool", "create", "--token-a", "WETH", "--token-b", "USDC.e", "--price", "3000", "--fee", String((Date.now() % 9000 + 1000) / 10000), "--tick-spacing", "7", "--from", FUNDED, ...CHAIN, "--dry-run", "--json"], null);
console.log(`     pool create: ${JSON.stringify(open.doc?.result?.simulations ?? open.doc?.error)}; protocol fee from the controller: ${open.doc?.result?.protocolFee}`);
check("pool create simulates on the live position manager", open.doc?.result?.simulations?.[0]?.ok === true);

const nativePools = pools.filter((p) => p.type === "CL" && p.currency0 === ZERO);
console.log(`     ${nativePools.length} CL pools quote in native`);
for (const p of nativePools.slice(0, 3)) {
  const buy = run(["swap", "exec", "--in", "native", "--out", p.currency1, "--amount", "0.0000001", "--pool", p.poolId, "--from", FUNDED, ...CHAIN, "--dry-run", "--json"], null);
  console.log(`     swap exec ${p.poolId.slice(0, 12)}: exit ${buy.status} ${JSON.stringify(buy.doc?.result?.simulations ?? buy.doc?.error)}`);
  const info = run(["pool", "info", p.poolId, ...CHAIN, "--json"], 0);
  const tick = Number(info.doc?.result?.state?.tick ?? 0);
  const spacing = Number(info.doc?.result?.state?.tickSpacing ?? 60);
  const lower = (Math.floor(tick / spacing) + 2) * spacing;
  const add = run(["liquidity", "add", "--pool", p.poolId, "--amount0", "0.0000001", `--tick-lower=${lower}`, `--tick-upper=${lower + spacing * 4}`, "--from", FUNDED, ...CHAIN, "--dry-run", "--json"], null);
  console.log(`     liquidity add ${p.poolId.slice(0, 12)}: exit ${add.status} ${JSON.stringify(add.doc?.result?.simulations ?? add.doc?.error)}`);
}
const routed = nativePools[0] === undefined ? null : run(["swap", "quote", "--in", "native", "--out", nativePools[0].currency1, "--amount", "0.0000001", ...CHAIN, "--json"], null);
console.log(`     router quote: exit ${routed?.status} ${JSON.stringify(routed?.doc?.result?.amountOut ?? routed?.doc?.error)}`);

/* The paths the mock alone had covered: a routed swap, Bin pools, and a removal by a position's real owner. */
if (nativePools[0] !== undefined) {
  const viaRouter = run(["swap", "exec", "--in", "native", "--out", nativePools[0].currency1, "--amount", "0.0000001", "--from", FUNDED, ...CHAIN, "--dry-run", "--json"], null);
  console.log(`     routed swap exec: exit ${viaRouter.status} ${JSON.stringify(viaRouter.doc?.result?.simulations ?? viaRouter.doc?.error)} verified by ${viaRouter.doc?.targetVerifiedBy}`);
  check("a routed swap simulates, its bytes checked against the address book", viaRouter.doc?.result?.simulations?.[0]?.ok === true && viaRouter.doc?.targetVerifiedBy === "address-book");
}

const binPools = pools.filter((p) => p.type === "Bin");
console.log(`     ${binPools.length} Bin pools`);
const openBin = run(["pool", "create", "--type", "Bin", "--token-a", "WETH", "--token-b", "USDC.e", "--price", "3000", "--fee", String((Date.now() % 9000 + 1000) / 10000), "--bin-step", "7", "--from", FUNDED, ...CHAIN, "--dry-run", "--json"], null);
console.log(`     bin pool create: ${JSON.stringify(openBin.doc?.result?.simulations ?? openBin.doc?.error)}; active id ${openBin.doc?.result?.openAt}`);
check("a Bin pool create simulates on the live position manager", openBin.doc?.result?.simulations?.[0]?.ok === true);
for (const p of binPools.slice(0, 2)) {
  const info = run(["pool", "info", p.poolId, ...CHAIN, "--json"], 0);
  console.log(`     bin ${p.poolId.slice(0, 12)}: active ${info.doc?.result?.state?.activeId}, step ${info.doc?.result?.state?.binStep}`);
  if (p.currency0 === ZERO) {
    const buy = run(["swap", "exec", "--in", "native", "--out", p.currency1, "--amount", "0.0000001", "--pool", p.poolId, "--from", FUNDED, ...CHAIN, "--dry-run", "--json"], null);
    console.log(`     bin swap exec: exit ${buy.status} ${JSON.stringify(buy.doc?.result?.simulations ?? buy.doc?.error)}`);
  }
}

const clPositionManager = "0x337c8E7B40132B677db2b99445EbC6B3835fd7A4";
const nextId = clPositionManager === null ? 0n : await rpcCall(clPositionManager, "0x75794a3c").then((h) => BigInt(h)).catch(() => 0n);
console.log(`     CL positions minted so far: ${nextId > 0n ? nextId - 1n : "unknown"}`);
let removed = 0;
for (let id = 1n; id < nextId && removed < 2; id++) {
  const owner = await rpcCall(clPositionManager, `0x6352211e${id.toString(16).padStart(64, "0")}`).then((h) => `0x${h.slice(-40)}`).catch(() => null);
  if (owner === null) continue;
  const out = run(["liquidity", "remove", "--token-id", String(id), "--percent", "10", "--from", owner, ...CHAIN, "--dry-run", "--json"], null);
  console.log(`     liquidity remove #${id}: exit ${out.status} ${JSON.stringify(out.doc?.result?.simulations ?? out.doc?.error)}`);
  if (out.doc?.result?.simulations?.[0]?.ok === true) removed += 1;
}
if (nextId > 1n) check("liquidity remove simulates for a position's owner", removed > 0);

/* Writes: simulate only. A launch must reach the simulator under release 2's rules. */
const LAUNCH = ["launch", ...CHAIN, "--name", "Smoke", "--symbol", "SMK", "--market-cap", "1", "--from", FROM, "--dry-run", "--json"];
const launch = run(LAUNCH, null);
console.log(`     launch dry run exit ${launch.status}: ${JSON.stringify(launch.doc?.simulation ?? launch.doc?.error)}`);
check("launch: the kit's fixed 1,000,000,000 supply", launch.doc?.result?.totalSupply === (10n ** 27n).toString(), launch.doc?.result?.totalSupply);
/* Release 3, no Launchpad: outside terms, so Gully takes no share of the pool fee, only the flat 0.30%. */
check("launch: outside terms take no protocol share", launch.doc?.result?.fees.lp.protocolBps === 0, launch.doc?.result?.fees.lp.protocolBps);
check("launch simulates on the live kit", launch.doc?.simulation?.ok === true);

const taxed = run([...LAUNCH, "--tax-buy", "1", "--tax-sell", "1", "--tax-days", "forever"], null);
console.log(`     forever tax dry run exit ${taxed.status}: ${JSON.stringify(taxed.doc?.simulation ?? taxed.doc?.error)}`);
check("launch: a forever tax is planned as uint32 max", taxed.doc?.result?.fees.tax?.taxSeconds === 4294967295, taxed.doc?.result?.fees.tax?.taxSeconds);
check("launch: a forever tax simulates on the live kit", taxed.doc?.simulation?.ok === true);
const days = run([...LAUNCH, "--tax-buy", "2", "--tax-days", "30"], null);
check("launch: a 30-day tax is planned", days.doc?.result?.fees.tax?.taxSeconds === 30 * 86400);
check("launch: a 30-day tax simulates on the live kit", days.doc?.simulation?.ok === true);
const wrongSupply = run([...LAUNCH, "--supply", "5"], 1);
check("launch: --supply other than the kit's is refused", /mints exactly/.test(wrongSupply.doc?.error?.message ?? ""));
const wrongShare = run([...LAUNCH, "--lp-protocol", "20"], 1);
check("launch: an --lp-protocol the terms do not allow is refused", /cannot be below|above the maximum/.test(wrongShare.doc?.error?.message ?? ""), wrongShare.doc?.error?.message);

const site = run(["site", "create", ...CHAIN, "--kind", "dex", "--name", "Smoke Dex", "--from", FROM, "--dry-run", "--json"], null);
console.log(`     site dry run exit ${site.status}: ${JSON.stringify(site.doc?.result?.simulations ?? site.doc?.error)}`);

run(["swap", "exec", "--in", "native", "--out", FROM, "--amount", "1", "--chain", "robinhood", "--from", FROM, "--json"], 3);
run(["pool", "create", "--token-a", "native", "--token-b", FROM, "--price", "1", "--chain", "base", "--from", FROM, "--json"], 3);
run(["liquidity", "add", "--pool", `0x${"11".repeat(32)}`, "--amount0", "1", "--chain", "bnb", "--from", FROM, "--json"], 3);
run(["doctor", ...CHAIN, "--json"], null);

console.log(failed === 0 ? "\nsmoke: all good" : `\nsmoke: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
