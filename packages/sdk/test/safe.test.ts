// SPDX-License-Identifier: MIT
/* ============================================================================
   Safe transaction encoding, hashing and signature handling.

   The fixtures are synthetic Transaction Builder batches in the exact shape the
   Safe Transaction Builder exports, with obviously fake addresses (...dc0deNN).
   Each `_expectedCalldata` is written out by hand from the ABI (selector plus
   32-byte words), independent of the encoder under test.

   Signatures are produced here with throwaway keys (viem local accounts) and
   recovered; nothing is sent and nothing reaches the network.
   ============================================================================ */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  DO_NOT_QUEUE,
  SAFE_ABI,
  SAFE_TX_TYPES,
  buildSafeTx,
  callsOfSafeTx,
  decodeMultiSendCalls,
  doNotQueueHits,
  encodeExecTransaction,
  encodeMultiSendCalls,
  packSignatures,
  parseTransactionBuilderBatch,
  recoverSafeSigner,
  safeTxHash,
  splitSignature,
  type SafeCall,
} from "../src/safe/index.js";

const fake = (n: number): Address => getAddress(`0x${"dc0de".padStart(38, "0")}${n.toString(16).padStart(2, "0")}`);
const word = (hex: string): string => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

const SAFE = fake(0);
const CL_OWNER = fake(1);
const BIN_OWNER = fake(2);
const OPS = fake(3);
const CANCELLER = fake(4);
const HOOK = fake(5);
const CURRENCY0 = fake(6);
const CURRENCY1 = fake(7);
const POOL_MANAGER = fake(8);
const MSCO = fake(9);
const MULTISEND = fake(10);
const CHAIN = 999;

const GRANT_CALLDATA = `0x2b6dcd21${word(OPS)}`;

const grantTx = (to: Address) => ({
  to,
  value: "0",
  data: null,
  contractMethod: { inputs: [{ internalType: "address", name: "account", type: "address" }], name: "grantPausableRole", payable: false },
  contractInputsValues: { account: OPS },
  _expectedCalldata: GRANT_CALLDATA,
});

const BATCHES = {
  grant: {
    version: "1.0",
    chainId: String(CHAIN),
    createdAt: 0,
    meta: { name: "grant the pausable role", description: "synthetic", txBuilderVersion: "1.16.5", createdFromSafeAddress: SAFE, createdFromOwnerAddress: "", checksum: "" },
    transactions: [grantTx(CL_OWNER), grantTx(BIN_OWNER)],
  },
  fund: {
    version: "1.0",
    chainId: String(CHAIN),
    meta: { name: "fund keys", createdFromSafeAddress: SAFE },
    transactions: [
      { to: CANCELLER, value: "10000000000000000", data: null, contractMethod: null, contractInputsValues: null },
      { to: OPS, value: "5000000000000000", data: null, contractMethod: null, contractInputsValues: null },
    ],
  },
  poolOwnership: {
    version: "1.0",
    chainId: String(CHAIN),
    meta: { name: "accept pool ownership", createdFromSafeAddress: SAFE },
    transactions: [
      {
        to: HOOK,
        value: "0",
        data: null,
        contractMethod: {
          inputs: [
            {
              components: [
                { internalType: "Currency", name: "currency0", type: "address" },
                { internalType: "Currency", name: "currency1", type: "address" },
                { internalType: "contract IHooks", name: "hooks", type: "address" },
                { internalType: "contract IPoolManager", name: "poolManager", type: "address" },
                { internalType: "uint24", name: "fee", type: "uint24" },
                { internalType: "bytes32", name: "parameters", type: "bytes32" },
              ],
              internalType: "struct PoolKey",
              name: "key",
              type: "tuple",
            },
          ],
          name: "acceptPoolOwnership",
          payable: false,
        },
        /* The Transaction Builder writes a tuple as a JSON string. */
        contractInputsValues: {
          key: JSON.stringify([CURRENCY0, CURRENCY1, HOOK, POOL_MANAGER, "3000", `0x${word("3c0881")}`]),
        },
        _expectedCalldata: `0x2487c382${word(CURRENCY0)}${word(CURRENCY1)}${word(HOOK)}${word(POOL_MANAGER)}${word("bb8")}${word("3c0881")}`,
      },
    ],
  },
} as const;

const readBatch = (k: keyof typeof BATCHES): unknown => structuredClone(BATCHES[k]) as unknown;

describe("parseTransactionBuilderBatch: Transaction Builder exports import as-is", () => {
  it("grant: two grantPausableRole(ops) calls, exact calldata", () => {
    const b = parseTransactionBuilderBatch(readBatch("grant"));
    expect(b.chainId).toBe(CHAIN);
    expect(b.createdFromSafeAddress).toBe(SAFE);
    expect(b.calls).toHaveLength(2);
    for (const c of b.calls) {
      expect(c.data).toBe(GRANT_CALLDATA);
      expect(c.value).toBe(0n);
    }
    expect(b.calls.map((c) => c.to)).toEqual([CL_OWNER, BIN_OWNER]);
  });

  it("fund: two native transfers with empty data", () => {
    const b = parseTransactionBuilderBatch(readBatch("fund"));
    expect(b.calls.map((c) => [c.to, c.value, c.data])).toEqual([
      [CANCELLER, 10_000_000_000_000_000n, "0x"],
      [OPS, 5_000_000_000_000_000n, "0x"],
    ]);
  });

  it("poolOwnership: a PoolKey tuple given as a JSON string encodes to the hand-written calldata", () => {
    const b = parseTransactionBuilderBatch(readBatch("poolOwnership"));
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]!.to).toBe(HOOK);
    expect(b.calls[0]!.data.startsWith("0x2487c382")).toBe(true);
    // Round trip through the ABI the file carries.
    const abi = parseAbi(["function acceptPoolOwnership((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) key)"]);
    const d = decodeFunctionData({ abi, data: b.calls[0]!.data });
    expect(d.args[0].fee).toBe(3000);
    expect(d.args[0].hooks).toBe(HOOK);
  });

  it("refuses a file whose contractMethod encoding disagrees with its _expectedCalldata", () => {
    const raw = readBatch("grant") as { transactions: { contractInputsValues: { account: string } }[] };
    raw.transactions[0]!.contractInputsValues.account = "0x0000000000000000000000000000000000000001";
    expect(() => parseTransactionBuilderBatch(raw)).toThrow(/_expectedCalldata/);
  });

  it("refuses non-address targets, bad integers and unknown versions; accepts raw data without contractMethod", () => {
    expect(() => parseTransactionBuilderBatch({ version: "1.0", chainId: "999", transactions: [{ to: "nope", value: "0", data: "0x" }] })).toThrow(/not an address/);
    expect(() => parseTransactionBuilderBatch({ version: "2.0", chainId: "999", transactions: [{ to: SAFE, value: "0", data: "0x" }] })).toThrow(/version/);
    expect(() => parseTransactionBuilderBatch({ version: "1.0", chainId: "999", transactions: [] })).toThrow(/no transactions/);
    expect(() =>
      parseTransactionBuilderBatch({ version: "1.0", chainId: "999", transactions: [{ to: SAFE, value: "0", data: null, contractMethod: { name: "f", inputs: [{ name: "x", type: "uint256" }] }, contractInputsValues: { x: "1.5" } }] }),
    ).toThrow(/integer/);
    const ok = parseTransactionBuilderBatch({ version: "1.0", chainId: "999", transactions: [{ to: SAFE, value: "1", data: "0xdeadbeef" }] });
    expect(ok.calls[0]).toEqual({ to: SAFE, value: 1n, data: "0xdeadbeef" });
  });
});

describe("buildSafeTx / MultiSend", () => {
  const calls = parseTransactionBuilderBatch(readBatch("grant")).calls;

  it("one call is a CALL from the Safe; two are one DELEGATECALL into MultiSendCallOnly", () => {
    const one = buildSafeTx({ calls: [calls[0]!], multiSendCallOnly: MSCO, nonce: 8n });
    expect(one.operation).toBe(0);
    expect(one.to).toBe(calls[0]!.to);
    const two = buildSafeTx({ calls, multiSendCallOnly: MSCO, nonce: 8n });
    expect(two.operation).toBe(1);
    expect(two.to).toBe(MSCO);
    expect(two.value).toBe(0n);
    expect(decodeMultiSendCalls(two.data)).toEqual(calls.map(({ to, value, data }) => ({ to, value, data })));
  });

  it("callsOfSafeTx reads the calls back from the fields and refuses a delegatecall elsewhere", () => {
    const two = buildSafeTx({ calls, multiSendCallOnly: MSCO, nonce: 8n });
    expect(callsOfSafeTx(two, MSCO)).toHaveLength(2);
    expect(() => callsOfSafeTx({ ...two, to: MULTISEND }, MSCO)).toThrow(/MultiSendCallOnly/);
    expect(() => callsOfSafeTx({ ...two, value: 1n }, MSCO)).toThrow(/value/);
  });

  it("decodeMultiSendCalls refuses a DELEGATECALL entry and truncated packing", () => {
    const packed = encodeMultiSendCalls(calls);
    // Flip the first entry's operation byte (offset: 4 selector + 32 offset + 32 length = 68 bytes -> hex index 2 + 136).
    const flipped = (packed.slice(0, 138) + "01" + packed.slice(140)) as Hex;
    expect(() => decodeMultiSendCalls(flipped)).toThrow(/CALL only/);
    const inner = encodeFunctionData({ abi: parseAbi(["function multiSend(bytes transactions)"]), functionName: "multiSend", args: ["0x00aa"] });
    expect(() => decodeMultiSendCalls(inner)).toThrow(/truncated/);
  });

  it("refuses the zero address, odd hex and an empty batch", () => {
    expect(() => buildSafeTx({ calls: [], multiSendCallOnly: MSCO, nonce: 0n })).toThrow(/at least one/);
    expect(() => buildSafeTx({ calls: [{ to: "0x0000000000000000000000000000000000000000", value: 0n, data: "0x" }], multiSendCallOnly: MSCO, nonce: 0n })).toThrow(/zero address/);
    expect(() => buildSafeTx({ calls: [{ to: SAFE, value: 0n, data: "0xabc" as Hex }], multiSendCallOnly: MSCO, nonce: 0n })).toThrow(/hex/);
  });
});

describe("do-not-queue list", () => {
  it("names the four selectors CLAUDE.md forbids, with setProtocolFeeController only for address(0)", () => {
    expect(DO_NOT_QUEUE.map((r) => r.signature)).toEqual(["renounceOwnership()", "updateDelay(uint256)", "setProtocolFeeController(address)", "registerApp(address)"]);
    const abi = parseAbi(["function renounceOwnership()", "function updateDelay(uint256 d)", "function setProtocolFeeController(address c)", "function registerApp(address a)", "function transferOwnership(address o)"]);
    const call = (fn: string, args: unknown[] = []): SafeCall => ({ to: SAFE, value: 0n, data: encodeFunctionData({ abi, functionName: fn as never, args: args as never }) });
    expect(doNotQueueHits([call("renounceOwnership")]).map((h) => h.signature)).toEqual(["renounceOwnership()"]);
    expect(doNotQueueHits([call("updateDelay", [0n])]).map((h) => h.signature)).toEqual(["updateDelay(uint256)"]);
    expect(doNotQueueHits([call("updateDelay", [172_800n])]).map((h) => h.signature)).toEqual(["updateDelay(uint256)"]);
    expect(doNotQueueHits([call("registerApp", [SAFE])]).map((h) => h.signature)).toEqual(["registerApp(address)"]);
    expect(doNotQueueHits([call("setProtocolFeeController", ["0x0000000000000000000000000000000000000000"])])).toHaveLength(1);
    expect(doNotQueueHits([call("setProtocolFeeController", [SAFE])])).toHaveLength(0);
    expect(doNotQueueHits([call("transferOwnership", [SAFE]), { to: SAFE, value: 1n, data: "0x" }])).toHaveLength(0);
  });

  it("finds a forbidden call inside a batch by index", () => {
    const abi = parseAbi(["function renounceOwnership()"]);
    const bad: SafeCall = { to: SAFE, value: 0n, data: encodeFunctionData({ abi, functionName: "renounceOwnership" }) };
    const calls = [...parseTransactionBuilderBatch(readBatch("grant")).calls, bad];
    const hits = doNotQueueHits(calls);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.index).toBe(2);
  });
});

describe("safeTxHash and signatures", () => {
  const tx = buildSafeTx({ calls: parseTransactionBuilderBatch(readBatch("grant")).calls, multiSendCallOnly: MSCO, nonce: 8n });
  const hash = safeTxHash(CHAIN, SAFE, tx);

  it("is deterministic and binds chain, safe, nonce and data", () => {
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(safeTxHash(CHAIN, SAFE, tx)).toBe(hash);
    expect(safeTxHash(998, SAFE, tx)).not.toBe(hash);
    expect(safeTxHash(CHAIN, "0x0000000000000000000000000000000000000001", tx)).not.toBe(hash);
    expect(safeTxHash(CHAIN, SAFE, { ...tx, nonce: 9n })).not.toBe(hash);
    expect(safeTxHash(CHAIN, SAFE, { ...tx, data: (tx.data.slice(0, -2) + "ff") as Hex })).not.toBe(hash);
  });

  it("a typed-data signature recovers to its owner; a personal_sign of the hash is refused; a stranger is a stranger", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const typed = await owner.signTypedData({ domain: { chainId: CHAIN, verifyingContract: SAFE }, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: { ...tx } });
    expect(splitSignature(typed).v === 27 || splitSignature(typed).v === 28).toBe(true);
    expect(await recoverSafeSigner(hash, typed)).toBe(owner.address);

    // eth_sign flavour: personal_sign over the hash, v bumped by 4 as Safe expects.
    const personal = await owner.signMessage({ message: { raw: hash } });
    const { v } = splitSignature(personal);
    const ethSign = (personal.slice(0, -2) + (v + 4).toString(16).padStart(2, "0")) as Hex;
    await expect(recoverSafeSigner(hash, ethSign)).rejects.toThrow(/eth_signTypedData_v4/);

    // A signature over some other hash recovers to somebody else.
    const other = await owner.signTypedData({ domain: { chainId: CHAIN, verifyingContract: SAFE }, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: { ...tx, nonce: 9n } });
    expect(await recoverSafeSigner(hash, other)).not.toBe(owner.address);
  });

  it("packSignatures sorts ascending by owner and refuses duplicates; execTransaction decodes back", async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    const sign = (acct: typeof a) => acct.signTypedData({ domain: { chainId: CHAIN, verifyingContract: SAFE }, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: { ...tx } });
    const sigs = [
      { owner: a.address, signature: await sign(a) },
      { owner: b.address, signature: await sign(b) },
    ];
    const packed = packSignatures(sigs);
    const [lo, hi] = [...sigs].sort((x, y) => (x.owner.toLowerCase() < y.owner.toLowerCase() ? -1 : 1));
    expect(packed).toBe((lo!.signature + hi!.signature.slice(2)) as Hex);
    expect(packSignatures([sigs[1]!, sigs[0]!])).toBe(packed);
    expect(() => packSignatures([sigs[0]!, sigs[0]!])).toThrow(/duplicate/);

    const exec = encodeExecTransaction(tx, sigs);
    const d = decodeFunctionData({ abi: SAFE_ABI, data: exec });
    expect(d.functionName).toBe("execTransaction");
    expect(d.args[0]).toBe(tx.to);
    expect(d.args[3]).toBe(1);
    expect(d.args[9]).toBe(packed);
  });
});
