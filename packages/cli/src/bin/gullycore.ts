#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/** `gullycore <command>`: everything a builder does on Gully Core, from a terminal. */

import { runAirdrop } from "../commands/airdrop.js";
import { runBitmap } from "../commands/bitmap.js";
import { runCompletion } from "../commands/completion.js";
import { runConfig } from "../commands/config.js";
import { runDevnet } from "../commands/devnet.js";
import { runDoctor } from "../commands/doctor.js";
import { runChain, runFees, runTokens } from "../commands/info.js";
import { runInit } from "../commands/init.js";
import { runLaunch } from "../commands/launch.js";
import { runLiquidity } from "../commands/liquidity.js";
import { runNew } from "../commands/new.js";
import { runPool } from "../commands/pool.js";
import { runSite } from "../commands/site.js";
import { runSwap } from "../commands/swap.js";
import { runLock, runMultisend, runSplit } from "../commands/utilities.js";
import { runVault } from "../commands/vault.js";
import { BRAND_LINE, ui } from "../lib/brand.js";
import { printLogo } from "../lib/logo.js";
import { currentCommand, normalizeError } from "../lib/command.js";
import { JSON_SCHEMA } from "../lib/output.js";
import { Aborted, installKitPalette } from "../lib/prompt.js";
import { EXIT, UsageError, UserError, info, reportFatal } from "../util/log.js";
import { CLI_VERSION } from "../version.js";

const COMMANDS = [
  ["swap", "quote and swap: fee and minimum out shown, simulated, then signed"],
  ["pool", "list pools, read one, open a new one"],
  ["liquidity", "add to or remove from a CL or Bin pool"],
  ["launch", "launch a token on a locked pool with the launch kit, priced by its opening market cap"],
  ["vault", "list, read, create and deposit into managed vaults"],
  ["lock", "lock tokens or a CL position, vest, check, claim"],
  ["fees", "what Gully charges, read from the chain: the flat 0.30% for outside builders"],
  ["tokens", "the tokens on a chain, one token, a balance"],
  ["chain", "where Gully Core runs, and one chain's live status"],
  ["config", "settings: default network, slippage, keystore path, RPCs"],
  ["doctor", "check RPC health, the contract clock, the address book and your wallet"],
  ["site", "create or edit a hosted Launchpad or DEX site"],
  ["airdrop", "build, create, verify and claim Merkle airdrops"],
  ["multisend", "send to many addresses from a CSV"],
  ["split", "create a Team split"],
  ["init", "scaffold a Gully Core app: DEX, Launchpad or both (@gullylabs/create-core-app)"],
  ["new", "scaffold a hook project"],
  ["devnet", "run a local node with the whole protocol deployed"],
  ["bitmap", "encode, decode and explain hook permission bitmaps"],
  ["completion", "print a shell completion script: bash, zsh, fish, powershell"],
] as const;

const USAGE = `${ui.bold("gullycore")} ${ui.muted(`v${CLI_VERSION}`)}
${ui.muted(BRAND_LINE)}

${ui.bold("USAGE")}
  gullycore <command> [options]

${ui.bold("COMMANDS")}
${COMMANDS.map(([name, describe]) => `  ${ui.accent(name.padEnd(12))}${describe}`).join("\n")}

${ui.bold("SIGNING")}
  Default is --print: the unsigned transaction, nothing signed. Every transaction is simulated first.
  --dry-run simulates and shows the review; it never unlocks a key.
  --keystore <file> signs with an encrypted keystore (cast wallet new / import); GULLYCORE_KEYSTORE or
  the keystore setting name it for scripts. --hardware ledger|trezor signs on a device through cast.
  gullycore never accepts a raw private key or mnemonic.

${ui.bold("SAFETY")}
  A chain with no deployment refuses writes. A mainnet write asks you to type a confirmation; --yes
  skips it only with --network named on the command line. Slippage above 5% needs --accept-high-slippage.

${ui.bold("EXIT CODES")}
  0 done · 1 failed · 2 usage · 3 no deployment · 4 would revert or did · 5 network · 6 refused · 130 cancelled

${ui.bold("EXAMPLES")}
  gullycore chain list
  gullycore doctor --chain gully-testnet
  gullycore swap quote --in ETH --out 0x3De9Cbf8E013897c4CAc6C0dc523abf965372358 --amount 0.001 --chain gully-testnet
  gullycore pool list --chain gully-testnet --json
  gullycore launch --chain gully-testnet --name Mochi --symbol MOCHI --market-cap 2 --from 0x… --json

Run \`gullycore <command> --help\` for a command's options. Every prompt has a flag; --yes and --json
make any command scriptable, and --json prints one document on stdout (schema ${JSON_SCHEMA}).
`;

/**
 * --json for the commands that talk to the terminal directly (`new`, `init`, `bitmap`): their output goes
 * to stderr, and stdout gets the one document every other command gives, with the text under `output`.
 */
async function asJson(command: string, argv: readonly string[], run: (rest: readonly string[]) => Promise<number> | number): Promise<number> {
  if (!argv.includes("--json")) return run(argv);
  const write = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await run(argv.filter((a) => a !== "--json"));
  } finally {
    process.stdout.write = write;
  }
  process.stdout.write(`${JSON.stringify({ schema: JSON_SCHEMA, command, ok: code === 0, exitCode: code, output: captured }, null, 2)}\n`);
  return code;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    printLogo();
    info(USAGE);
    return command === undefined ? EXIT.USAGE : 0;
  }
  if (command === "--version" || command === "-v") {
    info(CLI_VERSION);
    return 0;
  }
  installKitPalette();
  switch (command) {
    case "swap":
      return runSwap(rest);
    case "quote":
      return runSwap(["quote", ...rest]);
    case "pool":
      return runPool(rest);
    case "liquidity":
      return runLiquidity(rest);
    case "launch":
      return runLaunch(rest);
    case "vault":
    case "vaults":
      return runVault(rest);
    case "lock":
      return runLock(rest);
    case "fees":
      return runFees(rest);
    case "tokens":
      return runTokens(rest);
    case "chain":
    case "chains":
      return runChain(rest);
    case "config":
      return runConfig(rest);
    case "doctor":
      return runDoctor(rest);
    case "site":
      return runSite(rest);
    case "airdrop":
      return runAirdrop(rest);
    case "multisend":
      return runMultisend(rest);
    case "split":
      return runSplit(rest);
    case "init":
      return asJson("init", rest, runInit);
    case "new":
    case "create":
      return asJson("new", rest, (a) => runNew(a, "gullycore new", CLI_VERSION));
    case "devnet":
      return runDevnet(rest);
    case "bitmap":
    case "permissions":
      return asJson("bitmap", rest, runBitmap);
    case "completion":
      return runCompletion(rest);
    default:
      throw new UsageError(`unknown command "${command}"`, `available commands: ${COMMANDS.map(([name]) => name).join(", ")}`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (raw: unknown) => {
    const err = normalizeError(raw);
    const cur = currentCommand();
    if (err instanceof Aborted) {
      process.stderr.write(`${err.message}\n`);
      cur?.out.failure(cur.command, err.message, null, EXIT.CANCELLED);
      process.exitCode = EXIT.CANCELLED;
      return;
    }
    const code = err instanceof UserError ? err.exitCode : EXIT.ERROR;
    if (cur !== null && cur.out.json) {
      const message = err instanceof Error ? err.message : String(err);
      cur.out.failure(cur.command, message, err instanceof UserError ? (err.hint ?? null) : null, code);
    }
    process.exitCode = reportFatal(err);
  },
);
