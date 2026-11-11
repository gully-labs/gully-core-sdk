// SPDX-License-Identifier: MIT
/**
 * Web3 Secret Storage v3 keystores — the files `cast wallet new` / `cast wallet import`, geth and ethers
 * write — decrypted in-process.
 *
 * Why our own ~70 lines instead of a dependency: the format is small and fully specified
 * (https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/), Node's
 * `crypto` already has scrypt, pbkdf2 and AES-CTR, and viem (already a dependency) has keccak256. Every
 * extra package that touches a private key is attack surface; this adds none. Cross-checked in the tests
 * against a keystore Foundry's `cast` wrote.
 *
 * The decrypted key never leaves this module except as a viem `LocalAccount`, and it is never printed.
 */

import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { bytesToHex, getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { UserError } from "../util/log.js";

interface ScryptParams {
  readonly dklen: number;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
}
interface Pbkdf2Params {
  readonly dklen: number;
  readonly c: number;
  readonly prf: string;
  readonly salt: string;
}

export interface KeystoreV3 {
  readonly version: number;
  readonly address?: string;
  readonly crypto: {
    readonly cipher: string;
    readonly cipherparams: { readonly iv: string };
    readonly ciphertext: string;
    readonly kdf: string;
    readonly kdfparams: ScryptParams | Pbkdf2Params;
    readonly mac: string;
  };
}

function hexBytes(hex: string, what: string): Buffer {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new UserError(`keystore: ${what} is not hex`);
  return Buffer.from(h, "hex");
}

/** Parses and shape-checks a keystore document. Accepts the legacy capitalised `Crypto` key. */
export function parseKeystore(text: string): KeystoreV3 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UserError("the keystore file is not JSON");
  }
  const o = raw as Record<string, unknown>;
  const crypto = (o["crypto"] ?? o["Crypto"]) as KeystoreV3["crypto"] | undefined;
  if (o["version"] !== 3 || crypto === undefined) {
    throw new UserError("unsupported keystore", "expected a version 3 (Web3 Secret Storage) file, as cast/geth/ethers write");
  }
  if (crypto.cipher !== "aes-128-ctr") throw new UserError(`keystore cipher ${crypto.cipher} is not supported (aes-128-ctr only)`);
  if (crypto.kdf !== "scrypt" && crypto.kdf !== "pbkdf2") throw new UserError(`keystore kdf ${crypto.kdf} is not supported`);
  return { version: 3, ...(typeof o["address"] === "string" ? { address: o["address"] } : {}), crypto };
}

function deriveKey(ks: KeystoreV3, password: string): Buffer {
  const pw = Buffer.from(password.normalize("NFKD"), "utf8");
  const { kdf, kdfparams } = ks.crypto;
  if (kdf === "scrypt") {
    const k = kdfparams as ScryptParams;
    if (k.dklen < 32) throw new UserError("keystore dklen is below 32 bytes");
    // Node refuses anything above `maxmem`; scrypt needs 128 * N * r bytes, plus headroom for p.
    const maxmem = 128 * k.n * k.r * (k.p + 2) + 1024 * 1024;
    return scryptSync(pw, hexBytes(k.salt, "salt"), k.dklen, { N: k.n, r: k.r, p: k.p, maxmem });
  }
  const k = kdfparams as Pbkdf2Params;
  if (k.prf !== "hmac-sha256") throw new UserError(`keystore prf ${k.prf} is not supported`);
  if (k.dklen < 32) throw new UserError("keystore dklen is below 32 bytes");
  return pbkdf2Sync(pw, hexBytes(k.salt, "salt"), k.c, k.dklen, "sha256");
}

/**
 * Decrypts a keystore to an account. A wrong password is a clear error, never a garbage key: the MAC
 * is checked before the ciphertext is touched.
 */
export function decryptKeystore(ks: KeystoreV3, password: string): PrivateKeyAccount {
  const derived = deriveKey(ks, password);
  const ciphertext = hexBytes(ks.crypto.ciphertext, "ciphertext");
  const mac = keccak256(bytesToHex(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  const expected = `0x${(ks.crypto.mac.startsWith("0x") ? ks.crypto.mac.slice(2) : ks.crypto.mac).toLowerCase()}`;
  if (mac.toLowerCase() !== expected) throw new UserError("wrong keystore password");

  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), hexBytes(ks.crypto.cipherparams.iv, "iv"));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new UserError("keystore decrypted to a key of the wrong length");
  const account = privateKeyToAccount(bytesToHex(key) as Hex);
  key.fill(0);
  derived.fill(0);
  if (ks.address !== undefined && ks.address !== "") {
    const claimed = ks.address.startsWith("0x") ? ks.address : `0x${ks.address}`;
    if (getAddress(claimed) !== account.address) {
      throw new UserError("the keystore's address field does not match its key", "the file is corrupt or was edited");
    }
  }
  return account;
}

export function readKeystoreFile(path: string): KeystoreV3 {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new UserError(`cannot read keystore ${path}`);
  }
  return parseKeystore(text);
}

/** The address a keystore claims, without decrypting (for `--print` defaults). Null when absent. */
export function keystoreAddress(ks: KeystoreV3): string | null {
  if (ks.address === undefined || ks.address === "") return null;
  return getAddress(ks.address.startsWith("0x") ? ks.address : `0x${ks.address}`);
}
