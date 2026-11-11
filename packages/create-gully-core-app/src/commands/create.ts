// SPDX-License-Identifier: MIT
/** `@gullylabs/create-core-app <directory>` — the one command this package has. */

import { relative } from "node:path";

import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from "../util/args.js";
import { bold, cyan, dim, info, step, warn } from "../util/log.js";
import { ask, askChoice, isInteractive } from "../util/prompt.js";
import {
  MAX_FEE_BPS,
  resolveOptions,
  SUPPORTED_CHAINS,
  UNDEPLOYED_CHAINS,
  ZERO_ADDRESS,
  type ResolveInput,
  type ScaffoldOptions,
} from "../options.js";
import { scaffold } from "../scaffold.js";
import { CLI_VERSION } from "../version.js";

const HELP = `
${bold("@gullylabs/create-core-app")} — the Gully Core app template (DEX, Launchpad or both) on Gully Core's shared core.

  ${cyan("node packages/create-gully-core-app/dist/bin/create-app.js")} <directory> [options]   (from a checkout)
  ${cyan("npm create @gullylabs/core-app")} <directory> -- [options]      (once the package is on npm)
  ${cyan("npx @gullylabs/create-core-app")} <directory> [options]         (once the package is on npm)

${bold("Options")}
  --chain <name|id>        Chain to point at. Deployed: ${
    SUPPORTED_CHAINS.size === 0
      ? "none yet"
      : [...SUPPORTED_CHAINS.entries()].map(([id, name]) => `${name.toLowerCase()} (${id})`).join(", ")
  }.${
    UNDEPLOYED_CHAINS.size === 0
      ? ""
      : `
                           Coming soon: ${[...UNDEPLOYED_CHAINS.entries()]
          .map(([id, name]) => `${name.toLowerCase()} (${id})`)
          .join(", ")}; the app says "Coming soon" there.`
  }
  --fee-wallet <address>   Address your front end's swap fee is paid to.
  --fee-bps <n>            Swap fee in basis points of the OUTPUT. 0..${MAX_FEE_BPS}. Default 0.
  --features <set>         dex | launchpad | both, or a comma list of
                           swap,pools,launchpad,splits,locks,airdrops.
                           dex = swap,pools,locks,airdrops; launchpad = launchpad,
                           splits,locks,airdrops; both = everything.
  --name <string>          Product name shown in the UI. Defaults from the directory name.
  --package-manager <pm>   npm | pnpm | yarn | bun. Only affects the printed next steps.
  --yes                    Never prompt. Every unset option takes its default, and any
                           option with no safe default is an error rather than a guess.
  --version, -v
  --help, -h

${bold("What it makes")}
  A Vite + React app, one config file (${cyan("gullycore.config.ts")}), and a verify/deploy
  script. It does NOT deploy Vault or the pool managers — your pools live in the
  core Gully Core deploys and verifies on the chain you pick. Swaps go through
  Gully Core's router and its routing API by default; both are one config line to
  replace with your own.

${bold("Licence")}
  This scaffold and everything it emits are MIT. The protocol contracts are
  GPL-2.0-or-later and stay that way; the front end reaches them through ABIs,
  which is not linking. See the generated README for the exact boundary.
`;

/**
 * Interactive fill-in for anything the flags did not supply.
 *
 * Skipped entirely when `--yes` is passed or stdin is not a TTY, so CI gets a
 * clean failure naming the missing flag instead of a hang.
 */
async function promptForMissing(input: ResolveInput, flags: ParsedArgs): Promise<ResolveInput> {
  if (boolFlag(flags, "yes") || !isInteractive()) return input;

  const out: {
    -readonly [K in keyof ResolveInput]: ResolveInput[K];
  } = { ...input };

  if (out.directory.trim().length === 0) {
    out.directory = await ask("Project directory", "my-gullycore-dex");
  }

  if (out.chain === undefined) {
    const names = [...SUPPORTED_CHAINS.keys(), ...UNDEPLOYED_CHAINS.keys()].map(String);
    out.chain = await askChoice("Chain id", names, names[0] ?? "8453");
  }

  if (out.features === undefined) {
    out.features = await askChoice("Features", ["dex", "launchpad", "both"], "both");
  }

  if (out.feeBps === undefined) {
    out.feeBps = await ask(
      `Front-end swap fee in bps (0-${MAX_FEE_BPS}, taken from the swap output)`,
      "0",
    );
  }

  if (out.feeWallet === undefined && Number(out.feeBps) > 0) {
    out.feeWallet = await ask("Fee wallet (address the fee is paid to)");
  }

  return out;
}

function nextSteps(options: ScaffoldOptions, target: string): string {
  const pm = options.packageManager;
  const run = pm === "npm" ? "npm run" : pm;
  const installCmd = pm === "yarn" ? "yarn" : `${pm} install`;
  const where = relative(process.cwd(), target) || ".";

  const lines = [
    "",
    bold("Next"),
    `  cd ${where}`,
    `  ${installCmd}`,
    `  ${run} gullycore:verify        ${dim("# read the configured addresses back off chain")}`,
    `  ${run} dev`,
    "",
    bold("Then, to go to market"),
    `  1. Edit ${cyan("gullycore.config.ts")}: brand name, logo, colours, links.`,
  ];

  if (options.feeBps === 0) {
    lines.push(
      `  2. Set ${cyan("fee.bps")} above 0 to take a swap fee, or keep it 0: routed fills through Gully Core's`,
      `     router API (${cyan("routing")} in the config, on by default) only run while it is 0.`,
    );
  } else {
    lines.push(
      `  2. Fee is ${options.feeBps} bps to ${options.feeWallet}. Check that address before launch.`,
      dim("     Routed fills are off while a swap fee is on (a routed fill cannot carry it); the app says so."),
    );
  }

  const step = options.features.includes("launchpad") ? 4 : 3;
  if (options.features.includes("launchpad")) {
    lines.push(
      `  3. Launches: set ${cyan("launch.integratorBps")} / ${cyan("launch.integratorLaunchFeeWei")}, then` +
        ` ${run} gullycore:tenant ${dim("# prints the transaction that stores your terms on the kit")}`,
    );
  }
  const utilities = options.features.filter((f) => f === "splits" || f === "locks" || f === "airdrops");
  if (utilities.length > 0) {
    lines.push(
      dim(
        `     Gully Core utilities on: ${utilities.join(", ")}. Their contracts charge their own flat fees, read live` +
          " and shown before signing; this app adds none. `gullycore:verify` lists which are deployed on your chain.",
      ),
    );
  }
  lines.push(
    `  ${step}. ${run} build, and host the ${cyan("dist/")} directory anywhere static.`,
    "",
    dim("No contracts were deployed and no transaction was sent."),
    "",
  );
  return lines.join("\n");
}

export async function runCreate(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (boolFlag(args, "help") || boolFlag(args, "h")) {
    info(HELP);
    return 0;
  }
  if (boolFlag(args, "version") || boolFlag(args, "v")) {
    info(CLI_VERSION);
    return 0;
  }

  const base: ResolveInput = {
    directory: args.positionals[0] ?? "",
    ...(stringFlag(args, "name") === undefined ? {} : { appName: stringFlag(args, "name") }),
    ...(stringFlag(args, "chain") === undefined ? {} : { chain: stringFlag(args, "chain") }),
    ...(stringFlag(args, "fee-wallet") === undefined
      ? {}
      : { feeWallet: stringFlag(args, "fee-wallet") }),
    ...(stringFlag(args, "fee-bps") === undefined ? {} : { feeBps: stringFlag(args, "fee-bps") }),
    ...(stringFlag(args, "features") === undefined
      ? {}
      : { features: stringFlag(args, "features") }),
    ...(stringFlag(args, "package-manager") === undefined
      ? {}
      : { packageManager: stringFlag(args, "package-manager") }),
  };

  const filled = await promptForMissing(base, args);
  const options = resolveOptions(filled);

  step(`${options.appName} -> ${options.directory}`);
  if (options.chainDeployed) {
    step(`chain ${options.chainId} (${options.chainName}), shared Gully Core core`);
  } else {
    warn(
      `chain ${options.chainId} (${options.chainName}): Gully Core is coming soon there. The app renders one ` +
        "\"Coming soon\" page until @gullylabs/core-sdk records the chain; nothing else in the project changes then.",
    );
  }
  step(`features: ${options.features.join(", ")}`);
  if (options.feeBps === 0 || options.feeWallet.toLowerCase() === ZERO_ADDRESS) {
    warn("no front-end fee configured — set fee.bps and fee.wallet in gullycore.config.ts to earn");
  } else {
    step(`fee: ${options.feeBps} bps of swap output to ${options.feeWallet}`);
  }

  const result = await scaffold(options);
  step(`${result.filesWritten} files written`);
  info(nextSteps(options, result.directory));
  return 0;
}
