// SPDX-License-Identifier: MIT
/**
 * One click, as few confirmations as the wallet allows (owner, 2026-10-11: "I had to do 2 transactions
 * just to sell the token how can we cut it to 1?").
 *
 *  - The Permit2 grant to the router is a SIGNATURE carried in the swap (`PERMIT2_PERMIT`, first), and the
 *    SDK's verifier accepts exactly that and nothing wider.
 *  - The plan: allow (one-time ERC-20 approve of Permit2) + sign + swap; with an EIP-5792 wallet the allow
 *    and the swap go as ONE batch; without one, the allow is mined first and the swap follows in the same
 *    call; a batch the wallet cannot take falls back to one by one.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCLPoolKey, type PoolKey } from "@gullylabs/core-sdk";
import { verifySwapCalldata } from "@gullylabs/core-sdk/router";
import { COMMANDS, UNIVERSAL_ROUTER_ABI } from "../src/callpath/constants.js";
import { buildPermitSingle, PERMIT_MAX_AMOUNT, permitTypedData, type SignedPermit } from "../src/callpath/permit2.js";
import { buildSwapCall } from "../src/callpath/swap.js";
import { NO_INTEGRATOR_FEE } from "../src/config/integrator.js";
import { BatchUnavailableError, type ApprovalRequirement, type ProtocolAdapter, type TokenInfo, type WidgetTransactionRequest } from "../src/adapters/protocol.js";
import { planSwapStages, runSwapPlan } from "../src/hooks/useSwapExecute.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const TOKEN = "0x8D901a1b3f3a57f9C36A71382Fa183476C41545b" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const ROUTER = "0x00000000000000000000000000000000000000b1" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const MANAGER = "0x00000000000000000000000000000000000000a2" as const;
// anvil's public dev key #0: a throwaway, never a real key
const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const KEY: PoolKey = createCLPoolKey({ currency0: WETH, currency1: TOKEN, hooks: ZERO, poolManager: MANAGER, fee: 3_000, tickSpacing: 60 });
const token: TokenInfo = { address: TOKEN, symbol: "DTC", name: "DTC", decimals: 18 };

async function signed(o: { spender?: Address; token?: Address } = {}): Promise<SignedPermit> {
  const permit = buildPermitSingle({ token: o.token ?? TOKEN, spender: o.spender ?? ROUTER, nonce: 0, nowSeconds: 1_800_000_000 });
  const signature = await signer.signTypedData(permitTypedData(4663, PERMIT2, permit));
  return { permit, signature };
}

describe("Permit2 by signature, carried in the swap", () => {
  it("signs Permit2's own EIP-712 PermitSingle: the signer recovers from the typed data", async () => {
    const s = await signed();
    const recovered = await recoverTypedDataAddress({ ...permitTypedData(4663, PERMIT2, s.permit), signature: s.signature });
    expect(recovered).toBe(signer.address);
    expect(s.permit.details.amount).toBe(PERMIT_MAX_AMOUNT);
    expect(s.permit.details.expiration).toBe(1_800_000_000 + 30 * 24 * 3600);
  });

  it("puts PERMIT2_PERMIT first, and the SDK verifier accepts the transaction", async () => {
    const call = buildSwapCall({
      router: ROUTER,
      hops: [{ poolKey: KEY, poolType: "CL", currencyIn: TOKEN, currencyOut: WETH }],
      amountIn: 10n ** 18n,
      minAmountOutGross: 1n,
      minAmountOutNet: 1n,
      integrator: NO_INTEGRATOR_FEE,
      recipient: signer.address,
      sender: signer.address,
      deadline: 1_900_000_000n,
      permit: await signed(),
    });
    const [commands] = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: call.data }).args;
    expect(Number.parseInt(commands.slice(2, 4), 16)).toBe(COMMANDS.PERMIT2_PERMIT);
    expect(() =>
      verifySwapCalldata("universal-router", call, { tokenIn: TOKEN, tokenOut: WETH, amountIn: 10n ** 18n, recipient: signer.address, minAmountOut: 1n, deadline: 1_900_000_000 }),
    ).not.toThrow();
  });

  it("refuses to encode a permit for another router or token, or on a native trade", async () => {
    const args = {
      router: ROUTER,
      hops: [{ poolKey: KEY, poolType: "CL" as const, currencyIn: TOKEN, currencyOut: WETH }],
      amountIn: 1n,
      minAmountOutGross: 1n,
      minAmountOutNet: 1n,
      integrator: NO_INTEGRATOR_FEE,
      recipient: signer.address,
      sender: signer.address,
      deadline: 1n,
    };
    expect(() => buildSwapCall({ ...args, permit: { permit: buildPermitSingle({ token: TOKEN, spender: MANAGER, nonce: 0, nowSeconds: 0 }), signature: "0x00" } })).toThrow(/not for this router/);
    expect(() => buildSwapCall({ ...args, permit: { permit: buildPermitSingle({ token: WETH, spender: ROUTER, nonce: 0, nowSeconds: 0 }), signature: "0x00" } })).toThrow(/not for this router/);
  });
});

/* ------------------------------------------------------------------ the plan */

const allow: ApprovalRequirement = { kind: "erc20-to-permit2", token, spender: PERMIT2, current: 0n, required: 1n };
const grant: ApprovalRequirement = { kind: "permit2-to-router", token, spender: ROUTER, current: 0n, required: 1n };

function stub(o: { approvals: ApprovalRequirement[]; canSign: boolean; atomic: boolean; batchFails?: boolean }) {
  const sent: string[] = [];
  const batches: string[][] = [];
  let n = 0;
  const hash = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
  const adapter = {
    getApprovalRequirements: async () => o.approvals,
    canSignPermit2: () => o.canSign,
    signPermit2: async () => ({ permit: buildPermitSingle({ token: TOKEN, spender: ROUTER, nonce: 0, nowSeconds: 0 }), signature: "0x11" as Hex }),
    buildApproval: async (r: ApprovalRequirement): Promise<WidgetTransactionRequest> => ({ to: r.token.address, data: r.kind === "erc20-to-permit2" ? "0xa1" : "0xa2", value: 0n, summary: r.kind, source: "live" }),
    supportsAtomicBatch: async () => o.atomic,
    sendBatch: async (reqs: readonly WidgetTransactionRequest[]) => {
      if (o.batchFails) throw new BatchUnavailableError("the RPC cannot simulate a batch");
      batches.push(reqs.map((r) => r.summary));
      return hash();
    },
    sendTransaction: async (r: WidgetTransactionRequest) => {
      sent.push(r.summary);
      return hash();
    },
    waitForTransaction: async (h: Hex) => ({ hash: h, status: "success" as const, blockNumber: 1n, source: "live" as const }),
  } as unknown as ProtocolAdapter;
  const built: (SignedPermit | undefined)[] = [];
  const stages: string[] = [];
  const run = () =>
    runSwapPlan({
      adapter,
      tokenIn: token,
      owner: signer.address,
      amountIn: 1n,
      buildSwap: async (permit) => {
        built.push(permit);
        return { to: ROUTER, data: "0x5a", value: 0n, summary: "swap", source: "live" };
      },
      onStage: (st, sp) => stages.push(`${st}:${sp}`),
    });
  return { run, sent, batches, built, stages };
}

describe("planSwapStages", () => {
  it("names the one-time allow, the signed grant and the swap", () => {
    expect(planSwapStages([allow, grant], true)).toEqual(["allow", "sign", "swap"]);
    expect(planSwapStages([allow, grant], false)).toEqual(["allow", "grant", "swap"]);
    expect(planSwapStages([grant], true)).toEqual(["sign", "swap"]);
    expect(planSwapStages([], true)).toEqual(["swap"]);
  });
});

describe("runSwapPlan", () => {
  it("first sell with an EIP-5792 wallet: a signature, then the approval and the swap as ONE batch", async () => {
    const t = stub({ approvals: [allow, grant], canSign: true, atomic: true });
    await t.run();
    expect(t.built[0]).toBeDefined(); // the swap carries the permit
    expect(t.batches).toEqual([["erc20-to-permit2", "swap"]]);
    expect(t.sent).toEqual([]);
    expect(t.stages[0]).toBe("sign:signing");
  });

  it("first sell without batching: the approval mined first, then the swap with the permit (2 transactions, one click)", async () => {
    const t = stub({ approvals: [allow, grant], canSign: true, atomic: false });
    await t.run();
    expect(t.sent).toEqual(["erc20-to-permit2", "swap"]);
    expect(t.built[0]).toBeDefined();
    expect(t.stages).toContain("allow:approving");
  });

  it("a second sell (Permit2 allowance standing): one transaction, no signature", async () => {
    const t = stub({ approvals: [], canSign: true, atomic: true });
    await t.run();
    expect(t.sent).toEqual(["swap"]);
    expect(t.batches).toEqual([]);
    expect(t.built[0]).toBeUndefined();
  });

  it("an expired grant only (allowance to Permit2 standing): a signature and one transaction", async () => {
    const t = stub({ approvals: [grant], canSign: true, atomic: false });
    await t.run();
    expect(t.sent).toEqual(["swap"]);
    expect(t.built[0]).toBeDefined();
  });

  it("a wallet that cannot sign typed data: the grant is a transaction, never skipped", async () => {
    const t = stub({ approvals: [allow, grant], canSign: false, atomic: false });
    await t.run();
    expect(t.sent).toEqual(["erc20-to-permit2", "permit2-to-router", "swap"]);
    expect(t.built[0]).toBeUndefined();
  });

  it("a batch the wallet or RPC cannot take falls back to one by one", async () => {
    const t = stub({ approvals: [allow, grant], canSign: true, atomic: true, batchFails: true });
    await t.run();
    expect(t.batches).toEqual([]);
    expect(t.sent).toEqual(["erc20-to-permit2", "swap"]);
  });
});
