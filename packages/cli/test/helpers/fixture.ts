// SPDX-License-Identifier: MIT
/** A pool on the testnet record, the reads every command makes about it, and a throwaway keystore. */

import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCLPoolParameters, getDeployment, poolKeyToId, type PoolKey } from "@gullylabs/core-sdk";
import { CL_QUOTER_ABI } from "@gullylabs/core-sdk/trading";
import { bytesToHex, erc20Abi, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { PERMIT2_ABI } from "../../src/lib/approvals.js";
import { POOL_MANAGER_FEE_ABI } from "../../src/lib/fees.js";
import type { Rpc } from "./mockChain.js";

export const BOOK = getDeployment(485590)!;
export const SENDER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const TOKEN_A: Address = "0x1000000000000000000000000000000000000001";
export const TOKEN_B: Address = "0x2000000000000000000000000000000000000002";

export const KEY: PoolKey = {
  currency0: TOKEN_A,
  currency1: TOKEN_B,
  hooks: "0x0000000000000000000000000000000000000000",
  poolManager: BOOK.clPoolManager,
  fee: 3000,
  parameters: encodeCLPoolParameters(0, 60),
};
export const POOL_ID: Hex = poolKeyToId(KEY);

export const SQRT_ONE = 1n << 96n;

export const SLOT0_ABI = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "liquidity", type: "uint128" }] },
] as const;

/** The pool on the API, as `GET /pools/:id` answers it. */
export function apiPool(key: PoolKey = KEY, id: Hex = POOL_ID): Record<string, unknown> {
  return {
    poolId: id,
    poolType: "CL",
    poolManager: key.poolManager.toLowerCase(),
    token0: { address: key.currency0.toLowerCase(), symbol: "AAA", decimals: 18 },
    token1: { address: key.currency1.toLowerCase(), symbol: "BBB", decimals: 18 },
    config: { feeRaw: key.fee, parameters: key.parameters },
    hook: null,
  };
}

/** Everything a swap or a liquidity command reads about the fixture pool. */
export function stockChain(rpc: Rpc, opts: { allowance?: bigint; balance?: bigint; protocolFee?: number } = {}): void {
  const allowance = opts.allowance ?? 10n ** 30n;
  for (const [address, symbol] of [[TOKEN_A, "AAA"], [TOKEN_B, "BBB"]] as const) {
    rpc.on(address, erc20Abi, "symbol", symbol);
    rpc.on(address, erc20Abi, "name", `Token ${symbol}`);
    rpc.on(address, erc20Abi, "decimals", 18);
    rpc.on(address, erc20Abi, "balanceOf", opts.balance ?? 10n ** 24n);
    rpc.on(address, erc20Abi, "allowance", allowance);
    rpc.on(address, erc20Abi, "totalSupply", 10n ** 27n);
  }
  rpc.on(BOOK.permit2, PERMIT2_ABI, "allowance", [allowance > 2n ** 159n ? 2n ** 159n : allowance, 4_102_444_800, 0]);
  rpc.on(BOOK.clPoolManager, SLOT0_ABI, "getSlot0", [SQRT_ONE, 0, opts.protocolFee ?? 0, 3000]);
  rpc.on(BOOK.clPoolManager, SLOT0_ABI, "getLiquidity", 10n ** 21n);
  rpc.on(BOOK.clPoolManager, POOL_MANAGER_FEE_ABI, "protocolFeeController", BOOK.feeController);
  rpc.on(BOOK.binPoolManager, POOL_MANAGER_FEE_ABI, "protocolFeeController", BOOK.feeController);
  rpc.on(BOOK.clQuoter, CL_QUOTER_ABI, "quoteExactInputSingle", [997_000_000_000_000_000n, 100_000n]);
  rpc.api(`/v1/chains/485590/pools/${POOL_ID}`, apiPool());
}

/** A scrypt keystore with a key generated for this run. Returns its file, password and address. */
export function throwawayKeystore(): { file: string; password: string; address: Address; dir: string } {
  const key = generatePrivateKey();
  const password = "correct horse";
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(Buffer.from(password), salt, 32, { N: 1024, r: 8, p: 1 });
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), "hex")), cipher.final()]);
  const mac = keccak256(bytesToHex(Buffer.concat([derived.subarray(16, 32), ciphertext]))).slice(2);
  const address = privateKeyToAccount(key).address;
  const dir = mkdtempSync(join(tmpdir(), "gullycore-ks-"));
  const file = join(dir, "key.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      address: address.slice(2).toLowerCase(),
      crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ciphertext.toString("hex"), kdf: "scrypt", kdfparams: { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString("hex") }, mac },
    }),
  );
  return { file, password, address, dir };
}
