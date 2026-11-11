// SPDX-License-Identifier: MIT
/**
 * The hardware-wallet path: `--hardware ledger|trezor` signs on the device through Foundry's `cast`.
 *
 * The CLI adds no USB dependency. It simulates, shows the review and confirms, then hands `cast send` the
 * exact bytes. The key never leaves the device and this process never sees it. Spawned without a shell.
 */

import { spawnSync } from "node:child_process";

import type { Hex } from "viem";

import type { ChainContext } from "./chain.js";
import { requireCommand } from "../util/exec.js";
import { UserError } from "../util/log.js";

export type HardwareKind = "ledger" | "trezor";

export interface CastRun {
  readonly status: number | null;
  readonly stdout: string;
}

export type CastRunner = (bin: string, args: readonly string[]) => CastRun;

const realCast: CastRunner = (bin, args) => {
  const r = spawnSync(bin, [...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  return { status: r.status, stdout: r.stdout ?? "" };
};

let runner: CastRunner | null = null;

/** For tests: replaces the `cast` process. */
export function setCastRunner(r: CastRunner | null): void {
  runner = r;
}

interface HardwareTx {
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
  readonly from: string;
}

export function castSendArgs(ctx: ChainContext, tx: HardwareTx, kind: HardwareKind, hdPath: string | null): string[] {
  return [
    "send",
    tx.to,
    tx.data,
    ...(tx.value === 0n ? [] : ["--value", tx.value.toString()]),
    "--rpc-url",
    ctx.rpcUrls[0] ?? "",
    "--chain",
    String(ctx.chainId),
    "--from",
    tx.from,
    `--${kind}`,
    ...(hdPath === null ? [] : ["--hd-path", hdPath]),
    "--json",
  ];
}

/** Signs and sends on the device; returns the transaction hash. */
export function sendOnHardware(ctx: ChainContext, tx: HardwareTx, kind: HardwareKind, hdPath: string | null): Hex {
  const bin = runner !== null ? "cast" : requireCommand("cast", "--hardware signs through Foundry's cast: install Foundry (https://getfoundry.sh), or use --print");
  const r = (runner ?? realCast)(bin, castSendArgs(ctx, tx, kind, hdPath));
  if (r.status !== 0) throw new UserError(`cast send failed on the ${kind}`, "check the device is unlocked, its Ethereum app is open, and --from matches it");
  let hash: unknown;
  try {
    hash = (JSON.parse(r.stdout) as { transactionHash?: unknown }).transactionHash;
  } catch {
    hash = undefined;
  }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new UserError("cast did not report a transaction hash", "check an explorer before you retry: it may have been sent");
  return hash as Hex;
}
