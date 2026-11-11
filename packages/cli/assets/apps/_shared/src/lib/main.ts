// SPDX-License-Identifier: MIT
/** Run a script's body, print an error as one line, and set the exit code. */

import { existsSync } from "node:fs";

export function main(help: string, fn: () => Promise<void>): void {
  // `.env` (git-ignored) fills only variables the shell has not already set.
  if (existsSync(".env")) process.loadEnvFile(".env");
  if (process.argv.includes("--help")) {
    console.log(help);
    return;
  }
  fn().then(
    () => undefined,
    (err: unknown) => {
      console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
