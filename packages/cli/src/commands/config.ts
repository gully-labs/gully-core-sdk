// SPDX-License-Identifier: MIT
/** `gullycore config get|set|unset|list|path`: settings a builder need not repeat. Never a secret. */

import { parseChain } from "../lib/chain.js";
import { helpText, parseCommand, type CommandSpec } from "../lib/command.js";
import { CHAIN_FLAGS } from "../lib/chain.js";
import { configPath, getSetting, loadConfig, redactUrl, saveConfig, setSetting, type GullyCoreConfig } from "../lib/config.js";
import { HIGH_SLIPPAGE_BPS } from "../lib/slippage.js";
import { parsePercentBps } from "../lib/amounts.js";
import { refuseRawKeys } from "../lib/tx.js";
import { UsageError } from "../util/log.js";

export const CONFIG_SPEC: CommandSpec = {
  name: "config",
  summary: "settings: network, slippage, keystore (a path), api, rpc.<chainId>. Never a key or a password",
  usage: "gullycore config list\n  gullycore config get <key>\n  gullycore config set <key> <value>\n  gullycore config unset <key>\n  gullycore config path",
  flags: { json: CHAIN_FLAGS.json },
  examples: ["gullycore config set network gully-testnet", "gullycore config set slippage 0.5", "gullycore config set rpc.485590 https://my-node.example"],
};

/** Refuses what cannot work now rather than at the moment a swap needs it. */
function validate(key: string, value: string): void {
  refuseRawKeys([value]);
  if (key === "network") parseChain(value);
  if (key === "slippage" && parsePercentBps(value, "slippage", HIGH_SLIPPAGE_BPS) === 0) throw new UsageError("a slippage of 0 refuses every trade");
  if (key === "api" || key.startsWith("rpc.")) {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      throw new UsageError(`${key} must be a URL`);
    }
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new UsageError(`${key} must be https (http only for localhost)`);
  }
}

/** What the screens show: an RPC URL may hold a provider key. */
function printable(config: GullyCoreConfig): Record<string, unknown> {
  const { rpc, ...rest } = config;
  return { ...rest, ...(rpc !== undefined ? { rpc: Object.fromEntries(Object.entries(rpc).map(([k, v]) => [k, redactUrl(v)])) } : {}) };
}

export function runConfig(argv: readonly string[]): number {
  const cmd = parseCommand(argv, CONFIG_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(CONFIG_SPEC));
    return 0;
  }
  const [sub = "list", key, value] = cmd.args.positionals;
  switch (sub) {
    case "path":
      out.line(configPath());
      out.result("config", { result: { path: configPath() } });
      return 0;
    case "list": {
      const shown = printable(loadConfig());
      out.line(Object.keys(shown).length === 0 ? "No settings yet." : JSON.stringify(shown, null, 2));
      out.result("config", { result: { path: configPath(), settings: shown } });
      return 0;
    }
    case "get": {
      if (key === undefined) throw new UsageError("gullycore config get <key>");
      const v = getSetting(loadConfig(), key);
      const shown = v === undefined ? null : key.startsWith("rpc.") ? redactUrl(v) : v;
      out.line(shown ?? "(not set)");
      out.result("config", { result: { key, value: shown } });
      return 0;
    }
    case "set": {
      if (key === undefined || value === undefined) throw new UsageError("gullycore config set <key> <value>");
      validate(key, value);
      const path = saveConfig(setSetting(loadConfig(), key, value));
      out.line(`${key} saved in ${path}`);
      out.result("config", { result: { key, path } });
      return 0;
    }
    case "unset": {
      if (key === undefined) throw new UsageError("gullycore config unset <key>");
      const path = saveConfig(setSetting(loadConfig(), key, null));
      out.line(`${key} removed from ${path}`);
      out.result("config", { result: { key, path } });
      return 0;
    }
    default:
      throw new UsageError(`unknown config command "${sub}"`, "gullycore config list | get | set | unset | path");
  }
}
