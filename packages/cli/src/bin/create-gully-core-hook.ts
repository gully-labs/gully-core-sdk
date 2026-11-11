#!/usr/bin/env node
/** `npx create-gully-core-hook <name>` - the scaffolder, on its own. */

import { runNew } from "../commands/new.js";
import { info, reportFatal } from "../util/log.js";
import { CLI_VERSION } from "../version.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-v") {
    info(CLI_VERSION);
    return 0;
  }
  // `@gullylabs/create-core-hook` runs this entry and sets GULLYCORE_INVOKED_AS so the help it prints
  // names the command the user actually typed. Unset, the name is this bin's own.
  const invokedAs = process.env["GULLYCORE_INVOKED_AS"]?.trim() || "create-gully-core-hook";
  return runNew(argv, invokedAs, CLI_VERSION);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.exitCode = reportFatal(err);
  },
);
