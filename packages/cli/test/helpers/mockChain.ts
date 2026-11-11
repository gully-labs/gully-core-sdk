// SPDX-License-Identifier: MIT
/**
 * A local JSON-RPC node and Gully Core API for command tests. Calls are answered from a table keyed by
 * target and selector, so a test states exactly what the chain says and an unexpected read fails loudly.
 * Every send and every request is recorded, so a test can assert that nothing was signed.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { encodeFunctionResult, keccak256, toFunctionSelector, type Abi, type Address, type Hex } from "viem";

export interface Rpc {
  readonly url: string;
  /** Answers `eth_call` to `address` for `functionName`, encoding `result` with `abi`. */
  on(address: Address, abi: Abi | readonly unknown[], functionName: string, result: unknown): void;
  /** Makes `eth_call` to that function revert. */
  revert(address: Address, abi: Abi | readonly unknown[], functionName: string): void;
  /** A GET on the API path answers `{ data }`. */
  api(path: string, data: unknown): void;
  /** An API path answers an error, as the API does. */
  apiError(pathPrefix: string, status: number, code: string, message: string, details?: unknown): void;
  /** A POST on the API path answers `{ data }`. */
  apiPost(path: string, data: unknown): void;
  readonly sent: Hex[];
  readonly calls: { to: string; data: string }[];
  balance: bigint;
  stop(): Promise<void>;
}

const HEAD = 5_000;

export async function startMock(chainId = 485590): Promise<Rpc> {
  const table = new Map<string, { result?: Hex; revert?: boolean }>();
  const routes = new Map<string, unknown>();
  const posts = new Map<string, unknown>();
  const errors: { prefix: string; status: number; body: unknown }[] = [];
  const sent: Hex[] = [];
  const calls: { to: string; data: string }[] = [];

  const selector = (abi: Abi | readonly unknown[], functionName: string): Hex => {
    const items = (abi as Abi).filter((a) => a.type === "function" && a.name === functionName);
    if (items[0] === undefined) throw new Error(`no ${functionName} in the ABI`);
    return toFunctionSelector(items[0] as never);
  };

  const rpc = (method: string, params: readonly any[]): unknown => {
    switch (method) {
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "eth_blockNumber":
        return `0x${HEAD.toString(16)}`;
      case "eth_getBlockByNumber":
        return { number: `0x${HEAD.toString(16)}`, timestamp: "0x6735f000", baseFeePerGas: "0x1", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, transactions: [], logsBloom: `0x${"00".repeat(256)}`, difficulty: "0x0", nonce: "0x0000000000000000", miner: `0x${"00".repeat(20)}`, gasLimit: "0x1000000", gasUsed: "0x0", extraData: "0x", size: "0x1", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"33".repeat(32)}`, transactionsRoot: `0x${"33".repeat(32)}`, sha3Uncles: `0x${"33".repeat(32)}`, uncles: [] };
      case "eth_getCode":
        return "0x6000";
      case "eth_getBalance":
        return `0x${state.balance.toString(16)}`;
      case "eth_getLogs":
        return [];
      case "eth_getTransactionCount":
        return "0x1";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_estimateGas":
        return "0x30000";
      case "eth_sendRawTransaction": {
        sent.push(params[0] as Hex);
        return keccak256(params[0] as Hex);
      }
      case "eth_getTransactionReceipt":
        return { transactionHash: params[0], blockHash: `0x${"44".repeat(32)}`, blockNumber: `0x${HEAD.toString(16)}`, status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, transactionIndex: "0x0", type: "0x2", from: `0x${"00".repeat(20)}`, to: `0x${"00".repeat(20)}` };
      case "eth_call": {
        const to = String(params[0].to).toLowerCase();
        const data = String(params[0].data ?? "0x");
        calls.push({ to, data });
        const hit = table.get(`${to}:${data.slice(0, 10)}`);
        if (hit === undefined) return "0x"; // An unconfigured target simulates as a plain success.
        if (hit.revert === true) throw new Error("execution reverted");
        return hit.result;
      }
      default:
        throw Object.assign(new Error(`mock RPC: no ${method}`), { code: -32601 });
    }
  };

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (url.startsWith("/v1/")) {
        const err = errors.find((e) => url.startsWith(e.prefix));
        if (err !== undefined) return reply(err.status, err.body);
        const data = req.method === "POST" ? posts.get(url) : routes.get(url.split("?")[0] as string);
        if (data === undefined) return reply(404, { error: { code: "NOT_FOUND", message: "not found" } });
        return reply(200, { data });
      }
      const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      try {
        reply(200, { jsonrpc: "2.0", id: body.id, result: rpc(body.method, body.params) });
      } catch (e) {
        reply(200, { jsonrpc: "2.0", id: body.id, error: { code: (e as { code?: number }).code ?? 3, message: (e as Error).message } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const state: Rpc = {
    url: `http://127.0.0.1:${port}`,
    on(address, abi, functionName, result) {
      table.set(`${address.toLowerCase()}:${selector(abi, functionName)}`, { result: encodeFunctionResult({ abi: abi as Abi, functionName, result } as never) });
    },
    revert(address, abi, functionName) {
      table.set(`${address.toLowerCase()}:${selector(abi, functionName)}`, { revert: true });
    },
    api(path, data) {
      routes.set(path, data);
    },
    apiPost(path, data) {
      posts.set(path, data);
    },
    apiError(prefix, status, code, message, details) {
      errors.push({ prefix, status, body: { error: { code, message, details } } });
    },
    sent,
    calls,
    balance: 10n ** 21n,
    stop: () => new Promise((r) => server.close(() => r())),
  };
  return state;
}

/** Runs a command, capturing what it wrote to stdout and stderr. */
export async function capture(run: () => Promise<number> | number): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
