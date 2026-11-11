import { spawnSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bytesToHex, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";

import { decryptKeystore, parseKeystore } from "../src/lib/keystore.js";

/**
 * A test-only v3 encryptor, written straight from the spec. The CLI itself has no encrypt path: it
 * never takes a raw key. Keys here are generated per run and never leave the process.
 */
function encryptV3(privateKey: `0x${string}`, password: string, kdf: "scrypt" | "pbkdf2", withAddress: boolean): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const pw = Buffer.from(password.normalize("NFKD"), "utf8");
  const derived = kdf === "scrypt" ? scryptSync(pw, salt, 32, { N: 1024, r: 8, p: 1 }) : pbkdf2Sync(pw, salt, 2048, 32, "sha256");
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  const mac = keccak256(bytesToHex(Buffer.concat([derived.subarray(16, 32), ciphertext]))).slice(2);
  const kdfparams = kdf === "scrypt" ? { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString("hex") } : { dklen: 32, c: 2048, prf: "hmac-sha256", salt: salt.toString("hex") };
  return JSON.stringify({
    version: 3,
    id: "00000000-0000-4000-8000-000000000000",
    ...(withAddress ? { address: privateKeyToAccount(privateKey).address.slice(2).toLowerCase() } : {}),
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ciphertext.toString("hex"), kdf, kdfparams, mac },
  });
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("keystore v3", () => {
  for (const kdf of ["scrypt", "pbkdf2"] as const) {
    it(`decrypts a ${kdf} keystore to the right address`, () => {
      const pk = generatePrivateKey();
      const account = decryptKeystore(parseKeystore(encryptV3(pk, "hunter2", kdf, false)), "hunter2");
      expect(account.address).toBe(privateKeyToAccount(pk).address);
    });
  }

  it("refuses a wrong password by MAC, before decrypting", () => {
    const ks = parseKeystore(encryptV3(generatePrivateKey(), "right", "scrypt", false));
    expect(() => decryptKeystore(ks, "wrong")).toThrow(/wrong keystore password/);
  });

  it("checks the address field when present", () => {
    const pk = generatePrivateKey();
    const good = JSON.parse(encryptV3(pk, "pw", "pbkdf2", true)) as Record<string, unknown>;
    expect(decryptKeystore(parseKeystore(JSON.stringify(good)), "pw").address).toBe(privateKeyToAccount(pk).address);
    const tampered = { ...good, address: "1111111111111111111111111111111111111111" };
    expect(() => decryptKeystore(parseKeystore(JSON.stringify(tampered)), "pw")).toThrow(/does not match/);
  });

  it("accepts the legacy capitalised Crypto key and refuses other versions", () => {
    const o = JSON.parse(encryptV3(generatePrivateKey(), "pw", "scrypt", false)) as Record<string, unknown>;
    const legacy = { ...o, Crypto: o["crypto"] };
    delete (legacy as Record<string, unknown>)["crypto"];
    expect(() => parseKeystore(JSON.stringify(legacy))).not.toThrow();
    expect(() => parseKeystore(JSON.stringify({ ...o, version: 1 }))).toThrow(/unsupported keystore/);
  });

  const cast = spawnSync("cast", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  it.skipIf(cast.status !== 0)("decrypts a keystore Foundry's cast wrote, to the address cast reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "gullycore-ks-"));
    dirs.push(dir);
    const password = "gullycore-test-password";
    const pwFile = join(dir, "pw.txt");
    writeFileSync(pwFile, password);
    const made = spawnSync("cast", ["wallet", "new", dir, "--unsafe-password", password], { encoding: "utf8", shell: process.platform === "win32" });
    expect(made.status).toBe(0);
    const file = readdirSync(dir).find((f) => f !== "pw.txt");
    expect(file).toBeDefined();
    const path = join(dir, file as string);
    const reported = spawnSync("cast", ["wallet", "address", "--keystore", path, "--password-file", pwFile], { encoding: "utf8", shell: process.platform === "win32" });
    expect(reported.status).toBe(0);
    const ours = decryptKeystore(parseKeystore(readFileSync(path, "utf8")), password);
    expect(ours.address.toLowerCase()).toBe(reported.stdout.trim().toLowerCase());
  });
});
