// SPDX-License-Identifier: MIT
/** Shared plumbing for the chain-touching commands: parsing, help, key refusal, output mode. */

import { BaseError, HttpRequestError, TimeoutError } from "viem";

import { getString, parseArgs, renderFlags, type FlagSpecs, type ParsedArgs } from "../util/args.js";
import { BRAND_LINE, ui } from "./brand.js";
import { loadConfig } from "./config.js";
import { Output } from "./output.js";
import { routerFailure } from "./api.js";
import { refuseRawKeys } from "./tx.js";
import { EXIT, UsageError, UserError } from "../util/log.js";

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags: FlagSpecs;
  /** Flags that legitimately take a 32-byte hex value (a salt, a Merkle root). */
  readonly bytes32Flags?: readonly string[];
  /** The command's positional is a 32-byte id (a pool id), so a key-shaped positional is expected. */
  readonly bytes32Positional?: boolean;
  readonly examples?: readonly string[];
}

/** The output of the command running now, so the top-level handler can emit a JSON failure. */
let current: { command: string; out: Output; chainNamed: boolean } | null = null;

export function currentCommand(): { command: string; out: Output; chainNamed: boolean } | null {
  return current;
}

/** Network errors as a user error with exit code 5. Only the short message: URLs can carry RPC keys. */
export function normalizeError(err: unknown): unknown {
  const routed = routerFailure(err);
  if (routed !== err) return routed;
  if (err instanceof BaseError && err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null) {
    return new UserError("an RPC could not be reached", `${err.shortMessage} Check --rpc, or try again.`, EXIT.NETWORK);
  }
  return err;
}

export function helpText(spec: CommandSpec): string {
  const lines = [
    `${ui.bold(`gullycore ${spec.name}`)} — ${spec.summary}`,
    "",
    ui.bold("USAGE"),
    `  ${spec.usage}`,
    "",
    ui.bold("OPTIONS"),
    renderFlags({ ...spec.flags, help: { kind: "boolean", short: "h", describe: "show this message" } }),
  ];
  if (spec.examples !== undefined && spec.examples.length > 0) {
    lines.push("", ui.bold("EXAMPLES"), ...spec.examples.map((e) => `  ${e}`));
  }
  return lines.join("\n");
}

export interface ParsedCommand {
  readonly args: ParsedArgs;
  readonly out: Output;
  readonly help: boolean;
  str(name: string): string | undefined;
  bool(name: string): boolean;
}

export function parseCommand(argv: readonly string[], spec: CommandSpec): ParsedCommand {
  const json = argv.includes("--json");
  const out = new Output(json);
  current = { command: spec.name, out, chainNamed: false };
  refuseRawKeys(argv, new Set(spec.bytes32Flags ?? []), spec.bytes32Positional === true);
  const args = parseArgs(argv, { ...spec.flags, help: { kind: "boolean", short: "h", describe: "show this message" } });
  /* --network is --chain's other name; naming either is what lets --yes write to a mainnet. */
  const chainFlag = getString(args, "chain");
  const networkFlag = getString(args, "network");
  if (chainFlag !== undefined && networkFlag !== undefined && chainFlag !== networkFlag) {
    throw new UsageError(`--chain ${chainFlag} and --network ${networkFlag} disagree`);
  }
  const named = chainFlag ?? networkFlag;
  current.chainNamed = named !== undefined;
  if (!json) out.line(ui.muted(BRAND_LINE));
  return {
    args,
    out,
    help: args.flags["help"] === true,
    str: (name) => {
      if (name !== "chain") return getString(args, name);
      return named ?? loadConfig().network;
    },
    bool: (name) => args.flags[name] === true,
  };
}

export function requireFlag(cmd: ParsedCommand, name: string, hint?: string): string {
  const v = cmd.str(name);
  if (v === undefined || v.trim() === "") throw new UsageError(`--${name} is required`, hint);
  return v;
}
