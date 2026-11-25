// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_SIZES,
  GULLYCORE_SOLANA_DEPLOYMENTS,
  GullyCoreSolanaRouterClient,
  base58Decode,
  base58Encode,
  base64Decode,
  cpOutForExactIn,
  createSolanaRpc,
  decodeFeeSettings,
  decodeLaunch,
  decodePoolState,
  explorerAddressUrl,
  getDeployment,
  isSolanaAddress,
  listLaunches,
  readChainFeeTerms,
  requireDeployment,
} from "../src/solana/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fx = (f: string) => base64Decode(readFileSync(join(root, "test/fixtures/solana", f), "utf8").trim());
const REC = JSON.parse(readFileSync(join(root, "records/gully-core-solana-devnet.json"), "utf8"));
const FEE_SNAP = "KQ2FM6No/Ej8AW21HASnJ7YrTZDUPulzbJ0U3MdmOsDrDDmA4xkGY1acVqa5XaTSKgXL4Hz3bXjq9WB0f+DE1PIRFZdeEIVNlTe4CwAAAAAAABAnAAAAAAAAiBMAAAAAAACghgEAAAAAAECS0gAAAAAAIKEHAAAAAAA8AAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("Solana address book", () => {
  const d = GULLYCORE_SOLANA_DEPLOYMENTS.devnet;
  it("equals the public record field by field", () => {
    expect(d.programs).toEqual({ cpSwap: REC.programs.cpSwap.address, launch: REC.programs.launch.address });
    const { note: _n, ...gov } = REC.governance;
    expect(d.governance).toEqual(gov);
    expect(d.feeSettings).toBe(REC.accounts.feeSettings);
    expect(d.configs).toEqual(REC.accounts.configs);
    const { $comment: _c, ...fees } = REC.fees;
    expect(d.fees).toEqual(fees);
    expect(d.router.url).toBe(REC.router.devnet);
    expect(d.router.mainnetQuotes).toBe(REC.router.mainnetQuotes);
  });
  it("is devnet only: no mainnet lookup succeeds", () => {
    expect(getDeployment("devnet")?.kind).toBe("devnet");
    expect(getDeployment("mainnet-beta")).toBeUndefined();
    expect(() => requireDeployment("mainnet-beta")).toThrow(/devnet only/);
  });
  it("every address is base58 of 32 bytes", () => {
    for (const a of [...Object.values(d.programs), d.feeSettings, d.governance.multisig, ...Object.values(d.governance.vaults), ...Object.values(d.configs), d.wsol]) {
      expect(isSolanaAddress(a)).toBe(true);
      expect(base58Encode(base58Decode(a))).toBe(a);
    }
    expect(explorerAddressUrl("devnet", d.programs.cpSwap)).toBe(`https://explorer.solana.com/address/${d.programs.cpSwap}?cluster=devnet`);
  });
});

describe("account decoders", () => {
  it("discriminators are sha256('account:<Name>')[0..8]", () => {
    for (const [name, hex] of Object.entries(ACCOUNT_DISCRIMINATORS)) {
      expect(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8).toString("hex")).toBe(hex);
    }
  });
  it("decodes a real devnet pool", () => {
    const data = fx("pool-eiJzWrayWnyCoLzvRn62jF13ZHFzGXWRWUqvBGCRk5g.b64");
    expect(data.length).toBe(ACCOUNT_SIZES.PoolState);
    const p = decodePoolState(data);
    expect(isSolanaAddress(p.token0Mint) && isSolanaAddress(p.token1Mint)).toBe(true);
    expect([p.token0Mint, p.token1Mint]).toContain(GULLYCORE_SOLANA_DEPLOYMENTS.devnet.wsol);
    expect(p.swapDisabled).toBe(false);
    expect([p.mint0Decimals, p.mint1Decimals].sort()).toEqual([6, 9]);
  });
  it("decodes a real devnet launch", () => {
    const data = fx("launch-4dTgxkaQZsReDPkrtGH7R36czMSrB8X8LoPKmFQ3Qhpv.b64");
    expect(data.length).toBe(ACCOUNT_SIZES.Launch);
    const l = decodeLaunch(data);
    expect(l.status).toBe("live");
    expect(l.pool).toBe("eiJzWrayWnyCoLzvRn62jF13ZHFzGXWRWUqvBGCRk5g");
    expect(l.taxBps).toBeLessThanOrEqual(500);
    expect(l.createdAt).toBeGreaterThan(1_700_000_000);
  });
  it("decodes the fee settings and they equal the record (one fee schedule)", () => {
    const f = decodeFeeSettings(base64Decode(FEE_SNAP));
    expect(f.admin).toBe(REC.governance.vaults.admin);
    expect(f.treasury).toBe(REC.governance.vaults.treasury);
    expect(f.builderFeeRate).toBe(REC.fees.builderFeeRate);
    expect(f.launchFeeLamports).toBe(BigInt(REC.fees.launchFeeLamports));
    expect(f.pending).toBeNull();
  });
  it("refuses an account of another kind", () => {
    expect(() => decodeLaunch(base64Decode(FEE_SNAP))).toThrow(/not a Launch/);
  });
});

describe("read client (stubbed fetch)", () => {
  const d = requireDeployment("devnet");
  const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  it("readChainFeeTerms reads the fee settings account", async () => {
    const calls: string[] = [];
    const rpc = createSolanaRpc({ url: "http://rpc", fetch: async (_u, init) => { calls.push(JSON.parse(init.body!).method); return ok({ jsonrpc: "2.0", id: 1, result: { value: { data: [FEE_SNAP, "base64"], owner: d.programs.cpSwap, executable: false, lamports: 1 } } }); } });
    const t = await readChainFeeTerms(rpc, d);
    expect(t.builderFeePips).toBe(3000);
    expect(t.gullyCreatorFeePips * 2).toBe(t.gullyTradeFeePips);
    expect(calls).toEqual(["getAccountInfo"]);
  });
  it("waits out a 429 and keeps one request in flight", async () => {
    let n = 0, inFlight = 0, peak = 0;
    const launch = readFileSync(join(root, "test/fixtures/solana/launch-4dTgxkaQZsReDPkrtGH7R36czMSrB8X8LoPKmFQ3Qhpv.b64"), "utf8").trim();
    const rpc = createSolanaRpc({ url: "http://rpc", fetch: async () => {
      inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--;
      if (n++ === 0) return { ok: false, status: 429, headers: { get: () => "0" }, json: async () => ({}) };
      return ok({ jsonrpc: "2.0", id: 1, result: [{ pubkey: "4dTgxkaQZsReDPkrtGH7R36czMSrB8X8LoPKmFQ3Qhpv", account: { data: [launch, "base64"], owner: d.programs.launch, executable: false, lamports: 1 } }] });
    } });
    const [a, b] = await Promise.all([listLaunches(rpc, d), listLaunches(rpc, d)]);
    expect(a.length).toBe(1);
    expect(b[0]!.status).toBe("live");
    expect(peak).toBe(1);
  });
  it("router quote maps the Gully Router answer to the EVM names", async () => {
    const r = new GullyCoreSolanaRouterClient({ url: d.router.url, fetch: async (u) => {
      expect(u).toContain("/quote?inputMint=So111");
      return ok({ inputMint: d.wsol, inAmount: "1000000", outputMint: "8VUpNaguWMSroNw3rvc4CsLBQwHB2u4CgexMNHvqn2ji", outAmount: "1549697521762", minOutAmount: "1534200546544", slippageBps: 100, priceImpactPct: "0.001804", contextSlot: 5, routePlan: [{ venue: "Gully CP-Swap" }], gullyFee: { feeBps: 0 }, requestId: "x" });
    } });
    const q = await r.quote({ tokenIn: d.wsol, tokenOut: "8VUpNaguWMSroNw3rvc4CsLBQwHB2u4CgexMNHvqn2ji", amountIn: 1_000_000n, slippageBps: 100 });
    expect(q.amountOut).toBe(1549697521762n);
    expect(q.venues).toEqual(["Gully CP-Swap"]);
    expect(q.gullyFeeBps).toBe(0);
  });
  it("constant-product preview", () => {
    expect(cpOutForExactIn(1000n, 1_000_000n, 1_000_000n, 3000)).toBe(996n);
    expect(cpOutForExactIn(0n, 1n, 1n, 0)).toBe(0n);
  });
});
