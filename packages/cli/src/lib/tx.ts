// SPDX-License-Identifier: MIT
/**
 * Signing modes, simulation, and sending.
 *
 * THE RULE: this CLI never prompts for, accepts or prints a raw private key or a mnemonic.
 *
 *   --print (default)   the unsigned transaction and an equivalent `cast send` line. Nothing is signed.
 *   --dry-run           simulates and shows the same review, and never unlocks or signs, even with a
 *                       keystore named. Simulation itself is not optional: it runs before every send.
 *   --keystore <path>   a Web3 Secret Storage v3 file, unlocked with a hidden prompt, --password-file or
 *                       GULLYCORE_KEYSTORE_PASSWORD. GULLYCORE_KEYSTORE or the keystore setting name the
 *                       file for scripts. The environment only ever points at an encrypted file.
 *   --hardware <kind>   signs on a Ledger or Trezor through Foundry's cast (`lib/hardware.ts`).
 *
 * Flags that would carry a secret (`--private-key`, `--pk`, `--key`, `--mnemonic`, `--seed`,
 * `--secret`) are refused BY NAME before argument parsing, with a pointer to `--keystore`, and any flag
 * value shaped like a 32-byte key is refused unless the flag is one that legitimately takes a bytes32
 * (a salt, a Merkle root). `PRIVATE_KEY` in the environment is never read.
 *
 * Nothing is offered for signing that did not simulate: `simulate` runs the exact bytes as an
 * `eth_call` from the sender with the value attached.
 */

import { readFileSync } from "node:fs";

import {
  BaseError,
  createWalletClient,
  decodeErrorResult,
  formatEther,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

import { ui } from "./brand.js";
import { recordSent } from "./sentLog.js";
import type { ChainContext } from "./chain.js";
import { firstLine } from "./chain.js";
import { loadConfig } from "./config.js";
import { sendOnHardware, type HardwareKind } from "./hardware.js";
import { decryptKeystore, keystoreAddress, readKeystoreFile } from "./keystore.js";
import type { Output } from "./output.js";
import { askPassword, canPrompt } from "./prompt.js";
import { UsageError, UserError } from "../util/log.js";
import type { FlagSpecs, ParsedArgs } from "../util/args.js";

export interface PreparedTx {
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/* ------------------------------------------------------- raw-key refusal */

const SECRET_FLAG = /^--?(private[-_]?key|privkey|pk|key|mnemonic|seed|seed[-_]?phrase|secret|interactive-key)(=.*)?$/i;
const KEY_SHAPED = /^(0x)?[0-9a-fA-F]{64}$/;
const MNEMONIC_SHAPED = /^([a-z]+\s+){11,23}[a-z]+$/;

/**
 * Refuses a raw key before anything parses it. `bytes32Flags` names flags that legitimately take a
 * 32-byte hex value (salts, roots); a key-shaped value anywhere else is refused.
 */
export function refuseRawKeys(argv: readonly string[], bytes32Flags: ReadonlySet<string> = new Set(), bytes32Positional = false): void {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (SECRET_FLAG.test(token)) {
      throw new UserError(
        `${token.split("=")[0]} is refused: gullycore never accepts a raw private key or mnemonic`,
        "sign with --keystore <file> (cast wallet import / new writes one), or use --print and sign elsewhere",
      );
    }
    const eq = token.indexOf("=");
    const flag = token.startsWith("--") ? token.slice(2, eq === -1 ? undefined : eq) : null;
    const value = eq !== -1 && token.startsWith("--") ? token.slice(eq + 1) : token;
    const owner = flag !== null && eq !== -1 ? flag : (argv[i - 1]?.startsWith("--") === true ? (argv[i - 1] as string).slice(2) : null);
    const keyLike = KEY_SHAPED.test(value.trim()) || MNEMONIC_SHAPED.test(value.trim());
    const positional = !token.startsWith("-") && owner === null;
    if (keyLike && !(positional && bytes32Positional) && (owner === null || !bytes32Flags.has(owner))) {
      throw new UserError(
        "an argument looks like a private key or mnemonic; gullycore refuses it",
        "sign with --keystore <file>, or use --print and sign elsewhere. A salt or root goes after its own flag.",
      );
    }
  }
}

/* ------------------------------------------------------------- modes */

export const SIGNER_FLAGS = {
  print: { kind: "boolean", describe: "print the unsigned transaction instead of signing (default)" },
  "dry-run": { kind: "boolean", describe: "simulate and show the review; never unlock a key, never sign" },
  keystore: { kind: "string", describe: "sign with a Web3 Secret Storage v3 keystore file; else GULLYCORE_KEYSTORE; else the keystore setting", placeholder: "<file>" },
  "password-file": { kind: "string", describe: "read the keystore password from a file (bots / CI); else GULLYCORE_KEYSTORE_PASSWORD", placeholder: "<file>" },
  hardware: { kind: "string", describe: "sign on a device through Foundry's cast (needs --from)", placeholder: "<ledger|trezor>" },
  "hd-path": { kind: "string", describe: "derivation path for --hardware", placeholder: "<path>" },
  from: { kind: "string", describe: "the sending address, for --print, --dry-run and --hardware", placeholder: "<address>" },
  yes: { kind: "boolean", short: "y", describe: "no prompts. On a mainnet it also needs --network <name> on the command line" },
} as const satisfies FlagSpecs;

export type SignMode =
  | { readonly kind: "print"; readonly dryRun?: true; readonly keystore?: string }
  | { readonly kind: "keystore"; readonly path: string; readonly passwordFile: string | null }
  | { readonly kind: "hardware"; readonly device: HardwareKind; readonly hdPath: string | null };

export function signModeOf(args: ParsedArgs, env: Record<string, string | undefined> = process.env): SignMode {
  const flag = args.flags["keystore"];
  const print = args.flags["print"] === true;
  const dry = args.flags["dry-run"] === true;
  const device = args.flags["hardware"];
  const pf = args.flags["password-file"];
  if (typeof flag === "string" && print) throw new UsageError("--print and --keystore are exclusive");
  if (typeof device === "string") {
    if (device !== "ledger" && device !== "trezor") throw new UsageError(`--hardware must be ledger or trezor, received ${device}`);
    if (typeof flag === "string") throw new UsageError("--hardware and --keystore are exclusive");
    if (print) throw new UsageError("--hardware and --print are exclusive");
    if (!dry) {
      const hd = args.flags["hd-path"];
      return { kind: "hardware", device, hdPath: typeof hd === "string" ? hd : null };
    }
  }
  /* A keystore named by the environment or the config is used only when a signing mode was not ruled out. */
  const named = typeof flag === "string" ? flag : print ? undefined : (env["GULLYCORE_KEYSTORE"] ?? (env === process.env ? loadConfig(env).keystore : undefined));
  if (dry) return { kind: "print", dryRun: true, ...(named !== undefined && named !== "" ? { keystore: named } : {}) };
  if (named !== undefined && named !== "") return { kind: "keystore", path: named, passwordFile: typeof pf === "string" ? pf : null };
  if (typeof pf === "string") throw new UsageError("--password-file needs --keystore");
  return { kind: "print" };
}

export interface Signer {
  readonly address: Address;
  /** The unlocked key. Null when nothing here signs: --print, --dry-run, or a hardware device. */
  readonly account: PrivateKeyAccount | null;
  readonly hardware?: { readonly device: HardwareKind; readonly hdPath: string | null };
}

/** Whether this signer can send at all. */
export function canSend(signer: Signer): boolean {
  return signer.account !== null || signer.hardware !== undefined;
}

/** Unlocks the keystore (hidden prompt or --password-file) or takes `--from` for --print. */
export async function resolveSigner(mode: SignMode, from: string | undefined, isAddr: (s: string) => boolean): Promise<Signer> {
  if (mode.kind === "print") {
    /* A dry run reads the address the keystore declares, without decrypting anything. */
    const declared = mode.keystore !== undefined ? keystoreAddress(readKeystoreFile(mode.keystore)) : null;
    const sender = from ?? declared ?? undefined;
    if (sender === undefined) throw new UsageError("--from <address> is required with --print and --dry-run", "it decides the addresses the transaction creates");
    if (!isAddr(sender)) throw new UsageError(`--from is not an address: ${sender}`);
    return { address: sender as Address, account: null };
  }
  if (mode.kind === "hardware") {
    if (from === undefined) throw new UsageError("--from <address> is required with --hardware", "the address on the device that signs");
    if (!isAddr(from)) throw new UsageError(`--from is not an address: ${from}`);
    return { address: from as Address, account: null, hardware: { device: mode.device, hdPath: mode.hdPath } };
  }
  const ks = readKeystoreFile(mode.path);
  let password: string;
  const envPassword = process.env["GULLYCORE_KEYSTORE_PASSWORD"];
  if (mode.passwordFile !== null) {
    try {
      password = readFileSync(mode.passwordFile, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw new UserError(`cannot read --password-file ${mode.passwordFile}`);
    }
  } else if (envPassword !== undefined && envPassword !== "") {
    password = envPassword;
  } else if (canPrompt()) {
    password = await askPassword("Keystore password");
  } else {
    throw new UserError("the keystore needs a password", "pass --password-file <file> or set GULLYCORE_KEYSTORE_PASSWORD when there is no terminal");
  }
  const account = decryptKeystore(ks, password);
  if (from !== undefined && from.toLowerCase() !== account.address.toLowerCase()) {
    throw new UserError(`--from ${from} is not the keystore's address ${account.address}`);
  }
  return { address: account.address, account };
}

/* ------------------------------------------------------------ simulate */

export type Simulation = { readonly ok: true } | { readonly ok: false; readonly error: string };

function revertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  let found: Hex | undefined;
  err.walk((e) => {
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) found = d as Hex;
    else if (typeof d === "object" && d !== null && typeof (d as { data?: unknown }).data === "string") found = (d as { data: Hex }).data;
    return false;
  });
  return found;
}

/** Decodes a revert against the ABIs a command knows, then viem's own message. */
export function describeRevert(err: unknown, abis: readonly Abi[]): string {
  const data = revertData(err);
  if (data !== undefined) {
    for (const abi of abis) {
      try {
        const d = decodeErrorResult({ abi, data });
        const args = (d.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
        return `${d.errorName}(${args})`;
      } catch {
        /* next ABI */
      }
    }
    return `reverted with ${data.slice(0, 10)} (not in this command's ABIs)`;
  }
  if (err instanceof BaseError) return firstLine(err.shortMessage);
  return err instanceof Error ? firstLine(err.message) : String(err);
}

/** Runs the exact bytes as an `eth_call` from the sender, value attached. */
export async function simulate(ctx: ChainContext, tx: PreparedTx, abis: readonly Abi[]): Promise<Simulation> {
  try {
    await ctx.client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeRevert(err, abis) };
  }
}

/* --------------------------------------------------------------- print */

export function castSendLine(tx: PreparedTx, rpc: string): string {
  const value = tx.value === 0n ? "" : ` --value ${tx.value.toString()}`;
  return `cast send ${tx.to} ${tx.data}${value} --rpc-url ${rpc} --keystore <your-keystore>`;
}

/** The RPC to print: a public one as is, a user's own as a placeholder, because its URL may hold a key. */
export function printableRpc(ctx: ChainContext): string {
  return ctx.rpcFromUser ? `"$GULLYCORE_RPC_${ctx.chainId}"` : (ctx.rpcUrls[0] ?? "<rpc>");
}

export function renderTx(out: Output, ctx: ChainContext, tx: PreparedTx, symbol: string): void {
  out.line(ui.bold("Unsigned transaction"));
  out.rows([
    ["chain", `${ctx.name} (${tx.chainId})`],
    ["from", tx.from],
    ["to", tx.to],
    ["value", `${tx.value.toString()} wei (${formatEther(tx.value)} ${symbol})`],
    ["data", tx.data.length > 138 ? `${tx.data.slice(0, 138)}… (${(tx.data.length - 2) / 2} bytes)` : tx.data],
  ]);
  out.line("");
  out.line(ui.muted("Sign it with any wallet that takes raw calldata, for example:"));
  out.line(`  ${castSendLine(tx, printableRpc(ctx))}`);
}

/* ---------------------------------------------------------------- send */

export interface Sent {
  readonly hash: Hex;
  readonly receipt: TransactionReceipt;
}

export async function send(ctx: ChainContext, signer: Signer, tx: PreparedTx): Promise<Sent> {
  if (signer.address.toLowerCase() !== tx.from.toLowerCase()) throw new Error("the signer is not the simulated sender");
  let hash: Hex;
  if (signer.hardware !== undefined) {
    hash = sendOnHardware(ctx, tx, signer.hardware.device, signer.hardware.hdPath);
  } else if (signer.account !== null) {
    const account = signer.account;
    const wallet = createWalletClient({ account, chain: ctx.chain, transport: ctx.transport });
    /* Gas with headroom. A bare estimate is the smallest limit at which the call does not revert, and a call
       that wraps a hook in try/catch (CLPositionManager.initializePool) can "succeed" at a limit that is too
       low for the hook, returning without initialising the pool. Unused gas is refunded. */
    const estimate = await ctx.client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value });
    hash = await wallet.sendTransaction({ account, chain: ctx.chain, to: tx.to, data: tx.data, value: tx.value, gas: (estimate * 13n) / 10n });
  } else {
    throw new Error("nothing can sign this transaction");
  }
  recordSent(hash);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  await settleReads(ctx, receipt.blockNumber);
  return { hash, receipt };
}

/** The RPC behind a chain is often several nodes. Reads right after a receipt can reach one that is a block
    behind (a read-back then fails with "returned no data", a simulation with a stale allowance). Wait until two
    reads in a row see the receipt's block, for at most 30 seconds, then go on: never an error. */
export async function settleReads(ctx: ChainContext, block: bigint): Promise<void> {
  const deadline = Date.now() + 30_000;
  let seen = 0;
  while (Date.now() < deadline && seen < 2) {
    const head = await ctx.client.getBlockNumber({ cacheTime: 0 }).catch(() => 0n);
    seen = head >= block ? seen + 1 : 0;
    if (seen < 2) await new Promise((r) => setTimeout(r, 1_000));
  }
}

export function receiptJson(r: TransactionReceipt): Record<string, unknown> {
  return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, transactionHash: r.transactionHash };
}
