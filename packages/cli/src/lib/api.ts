// SPDX-License-Identifier: MIT
/**
 * The Gully Core API: the Router tier (`swap`) and the indexed reads (`pool list`, `tokens list --all`).
 *
 * Nothing the API says is taken on trust for money. `GullyCoreRouterClient` checks a swap's target and its
 * bytes against the SDK's own address book, and a pool key from the API is re-hashed to its pool id
 * (`lib/pools.ts`). Reads fall back to the chain when the API cannot be reached.
 *
 * Origin: --api, else GULLYCORE_API, else the `api` setting, else https://app.gullycore.xyz.
 * GULLYCORE_API_KEY is sent if set (a server-side key) and is never printed.
 */

import { GullyCoreRouterClient, GullyCoreRouterError } from "@gullylabs/core-sdk/router";
import type { Address } from "viem";

import type { ChainContext } from "./chain.js";
import { loadConfig } from "./config.js";
import { EXIT, UserError } from "../util/log.js";

export const DEFAULT_API = "https://app.gullycore.xyz";

export const API_FLAGS = {
  api: { kind: "string", describe: "Gully Core API origin; else GULLYCORE_API; else the api setting", placeholder: "<url>", defaultLabel: DEFAULT_API },
} as const;

export function apiBase(flag: string | undefined, env: Record<string, string | undefined> = process.env): string {
  return (flag ?? env["GULLYCORE_API"] ?? loadConfig(env).api ?? DEFAULT_API).replace(/\/+$/, "");
}

/** A Router client that also accepts the targets of a `--deployment` override (a devnet, a fork). */
export function routerClient(base: string, ctx: ChainContext, env: Record<string, string | undefined> = process.env): GullyCoreRouterClient {
  const d = ctx.deployment;
  const targets: Address[] = d === null || ctx.overrideSource === null ? [] : [d.universalRouter, ...(d.fillRouter !== null ? [d.fillRouter] : [])];
  const key = env["GULLYCORE_API_KEY"];
  return new GullyCoreRouterClient({
    baseUrl: base,
    ...(key !== undefined && key !== "" ? { apiKey: key } : {}),
    ...(targets.length > 0 ? { allowedTargets: { [ctx.chainId]: targets } } : {}),
  });
}

/** `data` of a GET, or null when the API is down or says no. For reads that have another way. */
export async function apiGet(base: string, path: string): Promise<unknown> {
  try {
    const res = await fetch(`${base}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    return json.data ?? null;
  } catch {
    return null;
  }
}

const ROUTER_HINTS: Readonly<Record<string, string>> = {
  NO_ROUTE: "no pool can fill this pair at this size; try --pool <id> or a smaller amount",
  RATE_LIMITED: "set GULLYCORE_API_KEY for a higher limit",
  INSUFFICIENT_BALANCE: "the sender does not hold enough of the input token",
};

/** A Router failure as a user error with the right exit code; anything else unchanged. */
export function routerFailure(err: unknown): unknown {
  if (!(err instanceof GullyCoreRouterError)) return err;
  const code = String(err.code);
  const network = code === "TRANSPORT" || code === "STATE_UNREADABLE" || code === "INTERNAL";
  const refused = code === "UNTRUSTED_RESPONSE";
  const exit = network ? EXIT.NETWORK : refused ? EXIT.REFUSED : code === "SIMULATION_FAILED" ? EXIT.SIMULATION : EXIT.ERROR;
  const hint = ROUTER_HINTS[code] ?? (refused ? "the API's answer failed verification against the address book; nothing was signed" : undefined);
  return new UserError(`router: ${err.message}`, hint, exit);
}
