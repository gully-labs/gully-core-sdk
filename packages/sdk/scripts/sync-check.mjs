#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/* One address book, three places. Fails (exit 1) when any of them disagree for a Gully Core chain:

     1. records/gully-core-<id>.json in this package (what the SDK's address book is generated from),
     2. deployments/<id>.json in the public contracts repo https://github.com/gully-labs/gully-core,
     3. the chain's `contracts` in https://gullycore.xyz/manifest.json (what every Gully Core site renders).

   It also checks the built address book (dist/) against the records, field by field, so a stale build fails too.

   node scripts/sync-check.mjs [--json]
     GULLYCORE_DEPLOYMENTS   a local deployments/ folder or a base URL (default: raw GitHub, gully-core main)
     GULLYCORE_MANIFEST      a local file or a URL (default: https://gullycore.xyz/manifest.json)

   Exit 0 = in sync, 1 = drift (each row printed), 2 = a source could not be read. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KIT, TOP_LEVEL } from "./generate-deployments.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHAIN_IDS = [6714, 4663, 8453, 56, 99901, 485590];
const DEFAULT_DEPLOYMENTS = "https://raw.githubusercontent.com/gully-labs/gully-core/main/deployments";
const DEFAULT_MANIFEST = "https://gullycore.xyz/manifest.json";

async function readJson(source) {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source, { headers: { "user-agent": "gullycore-sdk-sync/1" } });
    if (!r.ok) throw new Error(`${source}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v).toLowerCase()]));
const addressesOf = (contracts) => lower(Object.fromEntries(Object.entries(contracts ?? {}).map(([k, v]) => [k, v.address])));

function diffMaps(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push(`${k}: only in the second`);
    else if (!(k in b)) out.push(`${k}: only in the first`);
    else if (a[k] !== b[k]) out.push(`${k}: ${a[k]} != ${b[k]}`);
  }
  return out;
}

/** Runs every check. Returns rows { chainId, check, ok, detail }. */
export async function syncCheck({ deployments = process.env.GULLYCORE_DEPLOYMENTS || DEFAULT_DEPLOYMENTS, manifest = process.env.GULLYCORE_MANIFEST || DEFAULT_MANIFEST, book } = {}) {
  const rows = [];
  const row = (chainId, check, problems) => rows.push({ chainId, check, ok: problems.length === 0, detail: problems.slice(0, 8).join("; ") });
  const m = await readJson(manifest);
  const manifestChains = new Map(m.chains.map((c) => [c.chainId, c]));
  if (book === undefined) {
    const dist = join(root, "dist", "deployments", "index.js");
    book = existsSync(dist) ? (await import(pathToFileURL(dist).href)).GULLYCORE_DEPLOYMENTS : null;
  }
  const withContracts = m.chains.filter((c) => Object.keys(c.contracts ?? {}).length > 0).map((c) => c.chainId).sort((a, b) => a - b);
  row("all", "manifest chains with contracts == the SDK's chains", diffMaps(Object.fromEntries(withContracts.map((i) => [i, "x"])), Object.fromEntries([...CHAIN_IDS].sort((a, b) => a - b).map((i) => [i, "x"]))));
  for (const id of CHAIN_IDS) {
    const local = JSON.parse(readFileSync(join(root, "records", `gully-core-${id}.json`), "utf8"));
    const src = /^https?:\/\//.test(deployments) ? `${deployments}/${id}.json` : join(deployments, `${id}.json`);
    const pub = await readJson(src);
    row(id, "SDK record == gully-core deployments/<id>.json (whole file)", JSON.stringify(local) === JSON.stringify(pub) ? [] : [`differs: copy ${src} to records/gully-core-${id}.json and run npm run generate:deployments`]);
    const mc = manifestChains.get(id);
    row(id, "manifest contracts == gully-core deployments/<id>.json contracts", mc ? diffMaps(addressesOf(mc.contracts), addressesOf(pub.contracts)) : ["chain missing from the manifest"]);
    if (book === null) { row(id, "built address book == record", ["dist/ missing: run npm run build"]); continue; }
    const b = book[id];
    const problems = [];
    if (!b) problems.push("chain missing from the address book");
    else {
      /* Same lookup as the generator: the deployment record's contracts, then what it reused, then the chain facts file
         (canonical contracts such as Multicall3 that no Gully Core deployment created). */
      const factsFile = join(root, "records", `chain-${id}.json`);
      const chainFacts = existsSync(factsFile) ? JSON.parse(readFileSync(factsFile, "utf8")) : {};
      const want = (name) => (pub.contracts[name]?.address ?? pub.reused?.[name] ?? chainFacts.reused?.[name] ?? null);
      for (const [field, name] of Object.entries(TOP_LEVEL)) {
        const w = want(name); const g = b[field] ?? null;
        if (w === null && g === null) continue;
        if (w === null || g === null || String(w).toLowerCase() !== String(g).toLowerCase()) problems.push(`${field}: book ${g} != record ${name} ${w}`);
      }
      for (const [field, name] of Object.entries(KIT)) {
        const w = want(name); const g = b.launchpadV2?.[field] ?? null;
        if (w === null && g === null) continue;
        if (w === null || g === null || String(w).toLowerCase() !== String(g).toLowerCase()) problems.push(`launchpadV2.${field}: book ${g} != record ${name} ${w}`);
      }
    }
    row(id, "built address book == record (every mapped contract)", problems);
  }
  return rows;
}

const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  let rows;
  try { rows = await syncCheck(); } catch (e) { console.error(`SDK SYNC: cannot read a source: ${e.message}`); process.exit(2); }
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${String(r.chainId).padEnd(6)} ${r.check}${r.detail ? `  (${r.detail})` : ""}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`SDK SYNC: ${bad === 0 ? "PASS" : "FAIL"} ${rows.length - bad}/${rows.length}`);
  process.exit(bad === 0 ? 0 : 1);
}
