// SPDX-License-Identifier: MIT
/**
 * Connection, keys and addresses. Every value comes from the environment:
 *
 *   RPC_URL       required. The chain is whatever this endpoint answers.
 *   PRIVATE_KEY   only for --execute. Never a flag: flags land in shell history.
 *   FROM          optional, for a dry run without a key: simulate as this address.
 *   GULLYCORE_*       optional address overrides (a local devnet); otherwise the
 *                 SDK's address book, where `null` means "not deployed here".
 */

import { getDeployment, type GullyCoreDeployment } from "@gullylabs/core-sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface Ctx {
  readonly client: PublicClient;
  readonly chain: Chain;
  readonly chainId: number;
  /** The SDK's address book for this chain, or `null` when Gully Core has none for it. */
  readonly book: GullyCoreDeployment | null;
  /** `true` only with --execute. */
  readonly execute: boolean;
  /** Who transactions are simulated (and, with --execute, sent) from. `null`: nothing can be simulated. */
  readonly from: Address | null;
  readonly wallet: WalletClient | null;
  readonly account: PrivateKeyAccount | null;
}

export function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** Refuse a key passed on the command line, loudly, before anything else runs. */
export function refuseKeyFlags(argv: readonly string[]): void {
  if (argv.some((a) => /^--?(private-?key|pk|key|mnemonic)(=|$)/i.test(a))) {
    throw new Error("Keys are read only from the PRIVATE_KEY environment variable, never from a flag.");
  }
}

export async function connect(execute: boolean): Promise<Ctx> {
  const rpc = env("RPC_URL");
  if (rpc === undefined) throw new Error("Set RPC_URL (see .env.example).");
  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId();
  const book = getDeployment(chainId) ?? null;
  const chain = defineChain({
    id: chainId,
    name: book?.name ?? `chain ${chainId}`,
    nativeCurrency: book?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;

  const key = env("PRIVATE_KEY");
  if (execute && key === undefined) throw new Error("--execute needs PRIVATE_KEY in the environment.");
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("PRIVATE_KEY is not a 32-byte hex key.");
  const account = key === undefined ? null : privateKeyToAccount(key as `0x${string}`);
  const wallet = account === null ? null : createWalletClient({ account, chain, transport: http(rpc) });

  const fromEnv = env("FROM");
  if (fromEnv !== undefined && !isAddress(fromEnv, { strict: false })) throw new Error("FROM is not an address.");
  const from = account?.address ?? (fromEnv === undefined ? null : getAddress(fromEnv));
  return { client, chain, chainId, book, execute, from, wallet, account };
}

/** Keys of the address book this project uses, and the env var that overrides each. */
export type ContractKey = "positionLock" | "tokenLock" | "multisend" | "dropFactory";
const OVERRIDE: Record<ContractKey, string> = {
  positionLock: "GULLYCORE_POSITION_LOCK",
  tokenLock: "GULLYCORE_TOKEN_LOCK",
  multisend: "GULLYCORE_MULTISEND",
  dropFactory: "GULLYCORE_DROP_FACTORY",
};

/** The contract's address: the env override, else the address book. Throws when neither has one. */
export function contract(ctx: Ctx, key: ContractKey): Address {
  const o = env(OVERRIDE[key]);
  if (o !== undefined) {
    if (!isAddress(o, { strict: false })) throw new Error(`${OVERRIDE[key]} is not an address.`);
    return getAddress(o);
  }
  const a = ctx.book?.[key] ?? null;
  if (a === null) {
    throw new Error(
      `No Gully Core ${key} on ${ctx.chain.name} (chain ${ctx.chainId}): the address book says it is not deployed. ` +
        `For a local devnet, set ${OVERRIDE[key]} to the address your deployment printed.`,
    );
  }
  return a;
}
