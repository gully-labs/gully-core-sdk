// SPDX-License-Identifier: MIT
/**
 * `gullycore init [dir]` — the Gully Core app template (DEX, Launchpad or both), scaffolded by `@gullylabs/create-core-app`.
 *
 * This wraps @gullylabs/create-core-app rather than copying it: one scaffolder, one template, one set of tests.
 * If the package can be imported (installed beside this CLI, or linked in a checkout) its programmatic
 * `runCreate(argv)` runs in-process with every argument passed through untouched; otherwise its bin is
 * run through `npx`. Its own flags (`--chain`, `--fee-wallet`, `--fee-bps`, `--features`, `--name`,
 * `--yes`) are documented by `gullycore init --help`, which prints its help.
 */

import { spawnSync } from "node:child_process";

import { ui } from "../lib/brand.js";
import { refuseRawKeys } from "../lib/tx.js";

type RunCreate = (argv: readonly string[]) => Promise<number>;

/** Loads @gullylabs/create-core-app's entry. The name is a variable so TypeScript does not require the package. */
export async function loadScaffolder(name = "@gullylabs/create-core-app"): Promise<RunCreate | null> {
  try {
    const mod = (await import(name)) as { runCreate?: unknown };
    return typeof mod.runCreate === "function" ? (mod.runCreate as RunCreate) : null;
  } catch {
    return null;
  }
}

export async function runInit(argv: readonly string[]): Promise<number> {
  refuseRawKeys(argv);
  const runCreate = await loadScaffolder();
  if (runCreate !== null) return runCreate(argv);

  process.stderr.write(`${ui.muted("@gullylabs/create-core-app is not installed beside gullycore; running it with npx")}\n`);
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "@gullylabs/create-core-app", ...argv], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error !== undefined) {
    process.stderr.write(`could not run npx: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}
