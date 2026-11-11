/**
 * Two defects found by the first real signed transactions, reproduced against a local anvil.
 *
 *  1. READ-BACK LAG. The RPC behind a chain is often several nodes; right after a receipt a read can reach one that
 *     is a block behind. A proxy in front of anvil answers `eth_blockNumber` one block low for the first reads after
 *     it served a receipt. `send()` must not return until two reads in a row see the receipt's block.
 *  2. A POOL THAT WAS NEVER INITIALISED. `initializePool` can succeed (a hook that catches its own failure) and
 *     leave slot0 empty. `requireInitialised` must read slot0 and fail loudly, naming the hash, instead of calling
 *     the pool created. A contract that answers `getSlot0` with zeros stands for that pool manager.
 *
 * Needs `anvil` on PATH (Foundry); the file skips without it, as the Solidity-reading tests skip without a checkout.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChainContext } from "../src/lib/chain.js";
import { requireInitialised } from "../src/lib/pools.js";
import { resetSent, sentHashes } from "../src/lib/sentLog.js";
import { send, type Signer } from "../src/lib/tx.js";
import { failureEnvelope, successEnvelope } from "../src/lib/output.js";

const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

/* anvil's first dev account: a public test key that holds only local test ether. */
const DEV_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ANVIL_PORT = 18_545;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

let anvil: ChildProcess | null = null;
let proxy: Server | null = null;
let proxyUrl = "";
const proxyState = { lagReads: 0, blockNumberReads: 0, afterReceiptReads: 0 };

async function rpc(body: unknown): Promise<unknown> {
  const res = await fetch(ANVIL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await rpc({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("anvil did not start");
}

beforeAll(async () => {
  if (!hasAnvil) return;
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  await waitForAnvil();
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
      const answer = (await rpc(body)) as { id: number; result?: unknown };
      if (body.method === "eth_getTransactionReceipt" && answer.result !== null && answer.result !== undefined) {
        proxyState.lagReads = 2;
        proxyState.afterReceiptReads = 0;
      }
      if (body.method === "eth_blockNumber") {
        proxyState.blockNumberReads += 1;
        if (proxyState.lagReads > 0) {
          proxyState.lagReads -= 1;
          answer.result = `0x${(BigInt(answer.result as string) - 1n).toString(16)}`;
        }
        proxyState.afterReceiptReads += 1;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => proxy?.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => {
  proxy?.close();
  anvil?.kill();
});

function contextFor(url: string): ChainContext {
  const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const;
  const transport = http(url);
  const client = createPublicClient({ chain, transport });
  return { chainId: 31337, name: "anvil", chain, client, transport, rpcUrls: [url], rpcFromUser: true } as unknown as ChainContext;
}

describe.skipIf(!hasAnvil)("against a local anvil", () => {
  it("send() waits until two reads in a row see the receipt's block", async () => {
    resetSent();
    const ctx = contextFor(proxyUrl);
    const account = privateKeyToAccount(DEV_KEY);
    const signer = { address: account.address, account } as unknown as Signer;
    const to = "0x000000000000000000000000000000000000dEaD" as const;
    proxyState.blockNumberReads = 0;
    const r = await send(ctx, signer, { chainId: 31337, from: account.address, to, data: "0x", value: 1n });
    expect(r.receipt.status).toBe("success");
    // two lagged reads, then at least two that see the block: four reads, none skipped
    expect(proxyState.blockNumberReads).toBeGreaterThanOrEqual(4);
    expect(await ctx.client.getBlockNumber({ cacheTime: 0 })).toBeGreaterThanOrEqual(r.receipt.blockNumber);
    // the hash is on record the moment it left the process
    expect(sentHashes()).toEqual([r.hash]);
  }, 60_000);

  it("a pool manager that returns without setting a price is an error naming the hash", async () => {
    const ctx = contextFor(ANVIL_URL);
    const account = privateKeyToAccount(DEV_KEY);
    const wallet = createWalletClient({ account, chain: ctx.chain, transport: http(ANVIL_URL) });
    // runtime: return 128 zero bytes for any call (getSlot0 reads as sqrtPriceX96 = 0; getLiquidity as 0)
    const initcode = "0x6005600c60003960056000f360806000f3" as Hex; // copies the 5-byte runtime 6080 6000 f3 and returns it
    const deployHash = await wallet.sendTransaction({ data: initcode });
    const receipt = await ctx.client.waitForTransactionReceipt({ hash: deployHash });
    const manager = receipt.contractAddress as Hex;
    const key = {
      currency0: "0x0000000000000000000000000000000000000001",
      currency1: "0x0000000000000000000000000000000000000002",
      hooks: "0x0000000000000000000000000000000000000000",
      poolManager: manager,
      fee: 3000,
      parameters: `0x${(60n << 16n).toString(16).padStart(64, "0")}`,
    } as never;
    const fakeHash = `0x${"ab".repeat(32)}` as Hex;
    await expect(requireInitialised(ctx, { poolId: `0x${"11".repeat(32)}`, kind: "CL", key }, fakeHash, { tries: 2, delayMs: 10 })).rejects.toThrow(/succeeded but pool .* is not initialised/);
    await expect(requireInitialised(ctx, { poolId: `0x${"11".repeat(32)}`, kind: "CL", key }, fakeHash, { tries: 1, delayMs: 10 })).rejects.toThrow(fakeHash);
  }, 30_000);
});

describe("the JSON document always names the hashes that left the process", () => {
  it("success and failure envelopes carry them", () => {
    resetSent();
    expect(successEnvelope("x", {}).hash).toBeUndefined();
    const h = `0x${"cd".repeat(32)}` as Hex;
    // recorded through send(); here directly, as the module's contract
    return import("../src/lib/sentLog.js").then(({ recordSent }) => {
      recordSent(h);
      const ok = successEnvelope("x", { result: {} }) as unknown as { hash: string; hashes: string[] };
      expect(ok.hash).toBe(h);
      expect(ok.hashes).toEqual([h]);
      const bad = failureEnvelope("x", "boom", null, 4) as unknown as { hashes: string[] };
      expect(bad.hashes).toEqual([h]);
      resetSent();
    });
  });
});
