// SPDX-License-Identifier: MIT
/*
 * The only proof that counts: a project scaffolded OUTSIDE this repository,
 * installed from packed tarballs, typechecked, built and tested.
 *
 *   npm run test:template            (after `npm run build`)
 *   node scripts/test-template.mjs --keep     keeps the scratch directory
 *   node scripts/test-template.mjs --dir <scratch>
 *   node scripts/test-template.mjs --dir <scratch> --reuse-stage   keeps the tarballs packed last time
 *
 * WHY. `npm test` runs the template's pure suites against this package's own
 * node_modules (the SDK by symlink, viem) and proves nothing about the React
 * surfaces, the typecheck or `vite build`. Those need a REAL install: the
 * template ships no node_modules, and symlinking workspace packages drags
 * each one's own viem in and produces hundreds of false type errors
 * (CLAUDE.md, "A template typecheck needs a REAL install"). So this script:
 *
 *   1. packs @gullylabs/core-sdk, /widgets and /connect from the monorepo,
 *      unpacks each, rewrites its `file:` dependencies to the versions being
 *      packed (ops/public/stage-npm.mjs does the same for publishing) and packs
 *      it again — a tarball that installs where `../sdk` does not exist;
 *   2. scaffolds a project with THIS package's built scaffolder (dist/), in a
 *      directory with no checkout above it;
 *   3. points the project's @gullylabs/* dependencies at the tarballs and
 *      runs `npm install` there (React, wagmi, RainbowKit, Motion and d3 come
 *      from the registry);
 *   4. runs `tsc --noEmit`, `vite build` and `vitest run` in the project.
 *
 * It never publishes and never touches the registry except to download
 * third-party packages. Every step prints its command; a failure stops the
 * run with the step's output.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG, "..", "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const reuseStage = args.includes("--reuse-stage");
const dirAt = args.indexOf("--dir");
const scratch = dirAt !== -1 && args[dirAt + 1] ? resolve(args[dirAt + 1]) : mkdtempSync(join(tmpdir(), "gullycore-create-app-proof-"));
mkdirSync(scratch, { recursive: true });

const isWindows = process.platform === "win32";
const say = (m) => process.stdout.write(`\n== ${m}\n`);
function run(cmd, cmdArgs, cwd) {
  process.stdout.write(`$ ${cmd} ${cmdArgs.join(" ")}   (in ${cwd})\n`);
  /* npm and npx are .cmd shims on Windows; node is an executable. */
  const exe = isWindows && cmd !== "node" ? `${cmd}.cmd` : cmd;
  const r = spawnSync(exe, cmdArgs, { cwd, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) {
    process.stderr.write(`\nFAILED: ${cmd} ${cmdArgs.join(" ")} (exit ${r.status})\n`);
    process.exit(r.status ?? 1);
  }
}
const npmOut = (cwd, ...a) => execFileSync(isWindows ? "npm.cmd" : "npm", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: isWindows });

/* ---- 1. tarballs of the three Gully Core packages the template installs ---- */
const STAGE = join(scratch, "stage");
if (!reuseStage) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const versions = new Map();
for (const d of readdirSync(join(ROOT, "packages"))) {
  const f = join(ROOT, "packages", d, "package.json");
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, "utf8"));
  if (typeof j.name === "string") versions.set(j.name, j.version);
}
const tarballs = new Map();
for (const key of ["sdk", "widgets", "connect"]) {
  const dir = join(ROOT, "packages", key);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const expected = join(STAGE, `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`);
  if (reuseStage && existsSync(expected)) {
    say(`reuse ${expected}`);
    tarballs.set(manifest.name, expected);
    continue;
  }
  say(`pack ${manifest.name}@${manifest.version}`);
  /* A package with no `prepack` is packed as it lies (whatever `dist` was built last); build it. */
  if (manifest.scripts?.prepack === undefined && manifest.scripts?.prepare === undefined && manifest.scripts?.build !== undefined) {
    run("npm", ["run", "build", "--silent"], dir);
  }
  const first = npmOut(dir, "pack", "--silent", "--pack-destination", STAGE).trim().split("\n").pop().trim();
  const unpacked = join(STAGE, key);
  mkdirSync(unpacked, { recursive: true });
  execFileSync("tar", ["-xzf", first, "-C", key, "--strip-components=1"], { cwd: STAGE });
  rmSync(join(STAGE, first));
  const staged = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(staged[field] ?? {})) {
      if (typeof range !== "string" || !range.startsWith("file:")) continue;
      const v = versions.get(name);
      if (v === undefined) throw new Error(`${manifest.name} depends on ${name} by path, and no package of that name is in packages/`);
      staged[field][name] = `^${v}`;
    }
  }
  delete staged.devDependencies;
  delete staged.scripts;
  writeFileSync(join(unpacked, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  const tarball = npmOut(unpacked, "pack", "--silent", "--pack-destination", STAGE).trim().split("\n").pop().trim();
  tarballs.set(manifest.name, join(STAGE, tarball));
}

/* ---- 2. scaffold with the BUILT scaffolder, outside the repository ---- */
const bin = join(PKG, "dist", "bin", "create-app.js");
if (!existsSync(bin)) {
  process.stderr.write("dist/bin/create-app.js is missing: run `npm run build` in packages/create-gully-core-app first\n");
  process.exit(1);
}
const project = join(scratch, "proof-app");
rmSync(project, { recursive: true, force: true });
say(`scaffold ${project}`);
run("node", [bin, project, "--chain", "hyperevm", "--features", "both", "--yes"], scratch);

/* ---- 3. install: Gully Core packages from the tarballs, the rest from the registry ---- */
const pkgPath = join(project, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
for (const [name, tarball] of tarballs) {
  if (pkg.dependencies?.[name] === undefined) throw new Error(`the template no longer depends on ${name}; update this script`);
  pkg.dependencies[name] = `file:${tarball}`;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
say("npm install (the scaffolded project)");
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], project);
/* The widgets' own dependency on the SDK must resolve to the SAME copy the project installed, or two viems and two SDKs disagree. */
const nested = join(project, "node_modules", "@gullylabs", "widgets", "node_modules", "@gullylabs");
if (existsSync(nested)) {
  process.stderr.write(`a second @gullylabs copy was installed under widgets (${nested}); the tarball's version range does not match the staged SDK\n`);
  process.exit(1);
}

/* ---- 4. the proof ---- */
say("tsc --noEmit");
run("npx", ["tsc", "--noEmit", "--forceConsistentCasingInFileNames", "false"], project);
say("vite build");
run("npx", ["vite", "build"], project);
say("vitest run (the template's own suites, React included)");
run("npx", ["vitest", "run"], project);

say(`PASSED. Scaffolded project: ${project}`);
if (!keep && dirAt === -1) {
  rmSync(scratch, { recursive: true, force: true });
  process.stdout.write("(scratch directory removed; --keep keeps it)\n");
}
