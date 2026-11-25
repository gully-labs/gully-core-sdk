// SPDX-License-Identifier: MIT
/**
 * Dependency-free base58 / base64 and a little-endian byte reader for Solana account data.
 * Runs the same in Node and in browsers (no Buffer).
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A Solana address (base58 of 32 bytes). */
export type SolanaAddress = string;

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === "1") out.unshift(0);
    else break;
  }
  return Uint8Array.from(out);
}

/** True when `s` is a base58 string that decodes to 32 bytes. */
export function isSolanaAddress(s: unknown): s is SolanaAddress {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (const c of clean) {
    buf = (buf << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

/** Sequential little-endian reader over account data. */
export class ByteReader {
  private o: number;
  private readonly v: DataView;
  constructor(private readonly b: Uint8Array, offset = 0) {
    this.o = offset;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get offset(): number {
    return this.o;
  }
  skip(n: number): this {
    this.o += n;
    return this;
  }
  u8(): number {
    return this.v.getUint8(this.o++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    const x = this.v.getUint16(this.o, true);
    this.o += 2;
    return x;
  }
  u64(): bigint {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64(): bigint {
    const x = this.v.getBigInt64(this.o, true);
    this.o += 8;
    return x;
  }
  pubkey(): SolanaAddress {
    const s = base58Encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return s;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
