// SPDX-License-Identifier: MIT
/**
 * `gullycore config`: a small settings file so a builder need not repeat flags.
 *
 * It holds preferences and nothing secret: a default network, slippage, a keystore PATH, a Router API
 * origin, and RPC URLs per chain. A key, a mnemonic or a password has no setting here, and a value shaped
 * like one is refused. An RPC URL may embed a provider key, so `redactUrl` is what every screen prints.
 *
 * Where: GULLYCORE_CONFIG, else %APPDATA%\gullycore\config.json on Windows, else
 * $XDG_CONFIG_HOME/gullycore/config.json, else ~/.config/gullycore/config.json. Written with mode 0600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { UsageError, UserError } from "../util/log.js";

export interface GullyCoreConfig {
  readonly network?: string;
  readonly slippage?: string;
  readonly keystore?: string;
  readonly api?: string;
  readonly rpc?: Readonly<Record<string, string>>;
}

type Env = Record<string, string | undefined>;

export const CONFIG_KEYS = ["network", "slippage", "keystore", "api", "rpc.<chainId>"] as const;

export function configPath(env: Env = process.env): string {
  const explicit = env["GULLYCORE_CONFIG"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const appData = env["APPDATA"];
  if (process.platform === "win32" && appData !== undefined && appData !== "") return join(appData, "gullycore", "config.json");
  const xdg = env["XDG_CONFIG_HOME"];
  return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config"), "gullycore", "config.json");
}

/** The settings, or an empty object when there is no file. A damaged file is an error, never ignored. */
export function loadConfig(env: Env = process.env): GullyCoreConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UserError(`the config file is not valid JSON: ${path}`, "fix it, or delete it to start clean");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UserError(`the config file must hold a JSON object: ${path}`);
  return raw as GullyCoreConfig;
}

export function saveConfig(config: GullyCoreConfig, env: Env = process.env): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows has no such mode; the folder sits in the user's own profile. */
  }
  return path;
}

/** Scheme, host and port only: a provider key often sits in the path or the query of an RPC URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasSecretPart = u.username !== "" || u.password !== "" || u.search !== "" || (u.pathname !== "" && u.pathname !== "/");
    return hasSecretPart ? `${u.protocol}//${u.host}/…` : `${u.protocol}//${u.host}`;
  } catch {
    return "<rpc>";
  }
}

function assertKnownKey(key: string): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key) || key === "rpc.<chainId>") {
    throw new UsageError(`unknown setting "${key}"`, `settings: ${CONFIG_KEYS.join(", ")}. Keys and passwords have no setting.`);
  }
}

/** One setting by name: `network`, `slippage`, `keystore`, `api`, or `rpc.<chainId>`. */
export function getSetting(config: GullyCoreConfig, key: string): string | undefined {
  if (key.startsWith("rpc.")) return config.rpc?.[key.slice(4)];
  assertKnownKey(key);
  return config[key as "network" | "slippage" | "keystore" | "api"];
}

/** A copy with one setting changed; `null` removes it. */
export function setSetting(config: GullyCoreConfig, key: string, value: string | null): GullyCoreConfig {
  if (key.startsWith("rpc.")) {
    const id = key.slice(4);
    if (!/^\d+$/.test(id)) throw new UsageError(`rpc settings are per chain id, like rpc.485590, received ${key}`);
    const rpc: Record<string, string> = { ...(config.rpc ?? {}) };
    if (value === null) delete rpc[id];
    else rpc[id] = value;
    const { rpc: _dropped, ...rest } = config;
    return Object.keys(rpc).length === 0 ? rest : { ...rest, rpc };
  }
  assertKnownKey(key);
  const copy: Record<string, unknown> = { ...config };
  if (value === null) delete copy[key];
  else copy[key] = value;
  return copy as GullyCoreConfig;
}
