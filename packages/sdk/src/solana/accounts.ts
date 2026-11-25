// SPDX-License-Identifier: MIT
/**
 * Decoders for the Gully Core Solana program accounts. Layouts follow the program sources of Gully CP-Swap
 * (Raydium CP-Swap fork: `PoolState` is `repr(C, packed)` zero-copy, `AmmConfig` and `GullyFeeSettings` are Anchor
 * borsh accounts) and Gully Launch (`Launch`, borsh). Every account starts with Anchor's 8-byte discriminator
 * (`sha256("account:<Name>")[0..8]`), checked before decoding.
 */
import { ByteReader, bytesEqual, hexToBytes, type SolanaAddress } from "./codec.js";

export const ACCOUNT_DISCRIMINATORS = {
  PoolState: "f7ede3f5d7c3de46",
  AmmConfig: "daf42168cbcb2b6f",
  GullyFeeSettings: "290d8533a368fc48",
  Launch: "903333a3ce55d526",
} as const;

/** Account sizes, used as `dataSize` filters when listing program accounts. */
export const ACCOUNT_SIZES = { PoolState: 637, Launch: 269, GullyFeeSettings: 275 } as const;

/** Rates on Solana are in millionths (1e6 = 100%), the same unit as the EVM pips. */
export const RATE_DENOMINATOR = 1_000_000;

function expectKind(data: Uint8Array, kind: keyof typeof ACCOUNT_DISCRIMINATORS): void {
  if (data.length < 8 || !bytesEqual(data.subarray(0, 8), hexToBytes(ACCOUNT_DISCRIMINATORS[kind]))) {
    throw new Error(`not a ${kind} account`);
  }
}

export interface SolanaPoolState {
  ammConfig: SolanaAddress;
  poolCreator: SolanaAddress;
  token0Vault: SolanaAddress;
  token1Vault: SolanaAddress;
  lpMint: SolanaAddress;
  token0Mint: SolanaAddress;
  token1Mint: SolanaAddress;
  token0Program: SolanaAddress;
  token1Program: SolanaAddress;
  observationKey: SolanaAddress;
  status: number;
  lpMintDecimals: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  openTime: bigint;
  creatorFeeOn: number;
  enableCreatorFee: boolean;
  creatorFeesToken0: bigint;
  creatorFeesToken1: bigint;
  /** Set when the Squads lowered this pool's trade fee (lower only). */
  gullyFeeOverride: bigint | null;
  /** status bit 2: swaps disabled. */
  swapDisabled: boolean;
}

export function decodePoolState(data: Uint8Array): SolanaPoolState {
  expectKind(data, "PoolState");
  const r = new ByteReader(data, 8);
  const ammConfig = r.pubkey(), poolCreator = r.pubkey(), token0Vault = r.pubkey(), token1Vault = r.pubkey(), lpMint = r.pubkey();
  const token0Mint = r.pubkey(), token1Mint = r.pubkey(), token0Program = r.pubkey(), token1Program = r.pubkey(), observationKey = r.pubkey();
  r.u8(); // auth_bump
  const status = r.u8(), lpMintDecimals = r.u8(), mint0Decimals = r.u8(), mint1Decimals = r.u8();
  const lpSupply = r.u64(), protocolFeesToken0 = r.u64(), protocolFeesToken1 = r.u64(), fundFeesToken0 = r.u64(), fundFeesToken1 = r.u64();
  const openTime = r.u64();
  r.u64(); // recent_epoch
  const creatorFeeOn = r.u8(), enableCreatorFee = r.bool();
  r.skip(6);
  const creatorFeesToken0 = r.u64(), creatorFeesToken1 = r.u64();
  const overrideOn = r.u64(), overrideRate = r.u64();
  return {
    ammConfig, poolCreator, token0Vault, token1Vault, lpMint, token0Mint, token1Mint, token0Program, token1Program, observationKey,
    status, lpMintDecimals, mint0Decimals, mint1Decimals, lpSupply, protocolFeesToken0, protocolFeesToken1, fundFeesToken0, fundFeesToken1,
    openTime, creatorFeeOn, enableCreatorFee, creatorFeesToken0, creatorFeesToken1,
    gullyFeeOverride: overrideOn === 1n ? overrideRate : null,
    swapDisabled: (status & 4) !== 0,
  };
}

export type SolanaLaunchStatus = "created" | "live" | "unknown";

export interface SolanaLaunch {
  status: SolanaLaunchStatus;
  taxBps: number;
  creator: SolanaAddress;
  mint: SolanaAddress;
  pool: SolanaAddress;
  ammConfig: SolanaAddress;
  seedLamports: bigint;
  creatorBuyLamports: bigint;
  creatorTokens: bigint;
  seedTaxBurned: bigint;
  creatorFeePaidLamports: bigint;
  taxPaidGully: bigint;
  taxPaidCreator: bigint;
  createdAt: number;
}

export function decodeLaunch(data: Uint8Array): SolanaLaunch {
  expectKind(data, "Launch");
  const r = new ByteReader(data, 8);
  r.u8(); r.u8(); // bump, signer_bump
  const s = r.u8();
  const taxBps = r.u16();
  const creator = r.pubkey(), mint = r.pubkey(), pool = r.pubkey(), ammConfig = r.pubkey();
  const seedLamports = r.u64(), creatorBuyLamports = r.u64(), creatorTokens = r.u64(), seedTaxBurned = r.u64();
  const creatorFeePaidLamports = r.u64(), taxPaidGully = r.u64(), taxPaidCreator = r.u64();
  const createdAt = Number(r.i64());
  return {
    status: s === 1 ? "created" : s === 2 ? "live" : "unknown",
    taxBps, creator, mint, pool, ammConfig, seedLamports, creatorBuyLamports, creatorTokens, seedTaxBurned,
    creatorFeePaidLamports, taxPaidGully, taxPaidCreator, createdAt,
  };
}

/** Gully Core's fee controller on Solana (the counterpart of FeeControllerV5). */
export interface SolanaFeeSettings {
  version: number;
  admin: SolanaAddress;
  treasury: SolanaAddress;
  builderFeeRate: number;
  kre8TradeFeeRate: number;
  kre8CreatorFeeRate: number;
  creatorTaxShareRate: number;
  launchFeeLamports: bigint;
  antiSnipeStartRate: number;
  antiSnipeDurationSeconds: number;
  /** The one pending raise, or null. */
  pending: { param: number; value: bigint; effectiveAt: number } | null;
}

export function decodeFeeSettings(data: Uint8Array): SolanaFeeSettings {
  expectKind(data, "GullyFeeSettings");
  const r = new ByteReader(data, 8);
  r.u8(); // bump
  const version = r.u8(), admin = r.pubkey(), treasury = r.pubkey();
  const builderFeeRate = Number(r.u64()), kre8TradeFeeRate = Number(r.u64()), kre8CreatorFeeRate = Number(r.u64()), creatorTaxShareRate = Number(r.u64());
  const launchFeeLamports = r.u64(), antiSnipeStartRate = Number(r.u64()), antiSnipeDurationSeconds = Number(r.u64());
  const param = r.u8(), value = r.u64(), effectiveAt = Number(r.i64());
  return {
    version, admin, treasury, builderFeeRate, kre8TradeFeeRate, kre8CreatorFeeRate, creatorTaxShareRate, launchFeeLamports,
    antiSnipeStartRate, antiSnipeDurationSeconds, pending: param === 255 ? null : { param, value, effectiveAt },
  };
}
