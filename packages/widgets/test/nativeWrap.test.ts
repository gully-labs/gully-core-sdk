// SPDX-License-Identifier: MIT
/**
 * The chain's native coin against a pool quoted in its WRAPPED native (2026-10-11): the router wraps the
 * native coin in (`WRAP_ETH`, a router-paid `SETTLE`) or unwraps it out (`TAKE` to the router,
 * `UNWRAP_WETH`) inside the swap transaction. Every built transaction is checked by the SDK's
 * `verifySwapCalldata`, the same check the router API's transactions pass.
 */

import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { createCLPoolKey, poolKeyToId, type PoolKey } from "@gullylabs/core-sdk";
import { UnverifiedSwapCalldata, verifySwapCalldata } from "@gullylabs/core-sdk/router";
import { ACTIONS, ADDRESS_THIS, COMMANDS, MSG_SENDER, UNIVERSAL_ROUTER_ABI } from "../src/callpath/constants.js";
import { buildSwapCall, type SwapHop } from "../src/callpath/swap.js";
import { NO_INTEGRATOR_FEE } from "../src/config/integrator.js";
import { createViemAdapter } from "../src/adapters/viem.js";
import type { PoolInfo, SwapQuoteResult, TokenInfo } from "../src/adapters/protocol.js";
import type { ChainConfig } from "../src/config/chain.js";
import { autoQuoteCoin } from "../src/components/swap/state.js";

const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const TOKEN = "0x8D901a1b3f3a57f9C36A71382Fa183476C41545b" as const;
const ROUTER = "0x00000000000000000000000000000000000000b1" as const;
const MANAGER = "0x00000000000000000000000000000000000000a2" as const;
const QUOTER = "0x00000000000000000000000000000000000000c1" as const;
const USER = "0x00000000000000000000000000000000000000ff" as const;
const OTHER = "0x00000000000000000000000000000000000000ee" as const;
const DEADLINE = 1_900_000_000n;

const KEY: PoolKey = createCLPoolKey({ currency0: WETH, currency1: TOKEN, hooks: NATIVE, poolManager: MANAGER, fee: 3_000, tickSpacing: 60 });
const weth: TokenInfo = { address: WETH, symbol: "WETH", name: "WETH", decimals: 18 };
const token: TokenInfo = { address: TOKEN, symbol: "DTC", name: "DTC", decimals: 18 };
const eth: TokenInfo = { address: NATIVE, symbol: "ETH", name: "Ether", decimals: 18, isNative: true };
const POOL: PoolInfo = { id: poolKeyToId(KEY), key: KEY, poolType: "CL", token0: weth, token1: token, lpFeePips: 3_000, tickSpacing: 60, hooks: NATIVE };

const hop = (currencyIn: Address, currencyOut: Address): SwapHop => ({ poolKey: KEY, poolType: "CL", currencyIn, currencyOut });

function decode(data: Hex): { commands: number[]; inputs: readonly Hex[] } {
  const { args } = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
  const [commands, inputs] = args;
  return { commands: Array.from(Buffer.from(commands.slice(2), "hex")), inputs };
}
function planOf(input: Hex): { actions: number[]; params: readonly Hex[] } {
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);
  return { actions: Array.from(Buffer.from(actions.slice(2), "hex")), params };
}

const base = {
  router: ROUTER,
  amountIn: 10n ** 16n,
  minAmountOutGross: 1_000n,
  minAmountOutNet: 1_000n,
  integrator: NO_INTEGRATOR_FEE,
  recipient: USER,
  sender: USER,
  deadline: DEADLINE,
  wrappedNative: WETH,
} as const;

describe("buildSwapCall · pay the native coin into a wrapped-native pool", () => {
  const call = buildSwapCall({ ...base, hops: [hop(WETH, TOKEN)], wrapInput: true });

  it("wraps msg.value to the router, settles from the router, takes the token to the caller, refunds native", () => {
    expect(call.value).toBe(base.amountIn);
    const { commands, inputs } = decode(call.data);
    expect(commands).toEqual([COMMANDS.WRAP_ETH, COMMANDS.INFI_SWAP, COMMANDS.SWEEP]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[0]!)).toEqual([ADDRESS_THIS, base.amountIn]);
    const plan = planOf(inputs[1]!);
    expect(plan.actions).toEqual([ACTIONS.CL_SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE, ACTIONS.TAKE_ALL]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], plan.params[1]!)).toEqual([WETH, 0n, false]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], plan.params[2]!)).toEqual([TOKEN, base.minAmountOutNet]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], inputs[2]!)).toEqual([NATIVE, MSG_SENDER, 0n]);
  });

  it("passes verifySwapCalldata as the native trade it is, and fails it as any other", () => {
    const req = { tokenIn: NATIVE, tokenOut: TOKEN, amountIn: base.amountIn, recipient: USER, minAmountOut: base.minAmountOutNet, deadline: Number(DEADLINE), wrappedNative: WETH } as const;
    expect(() => verifySwapCalldata("universal-router", call, req)).not.toThrow();
    expect(() => verifySwapCalldata("universal-router", call, { ...req, wrappedNative: OTHER })).toThrow(UnverifiedSwapCalldata);
    expect(() => verifySwapCalldata("universal-router", { ...call, value: 0n }, req)).toThrow(UnverifiedSwapCalldata);
  });

  it("refuses a wrap into a route that does not take the wrapped native", () => {
    expect(() => buildSwapCall({ ...base, hops: [hop(TOKEN, WETH)], wrapInput: true })).toThrow(/wrapInput/);
    expect(() => buildSwapCall({ ...base, wrappedNative: undefined, hops: [hop(WETH, TOKEN)], wrapInput: true } as never)).toThrow(/wrappedNative/);
  });
});

describe("buildSwapCall · receive the native coin from a wrapped-native pool", () => {
  const call = buildSwapCall({ ...base, hops: [hop(TOKEN, WETH)], unwrapOutput: true });

  it("takes the wrapped native to the router and unwraps it to the caller at the floor", () => {
    expect(call.value).toBe(0n);
    const { commands, inputs } = decode(call.data);
    expect(commands).toEqual([COMMANDS.INFI_SWAP, COMMANDS.UNWRAP_WETH]);
    const plan = planOf(inputs[0]!);
    expect(plan.actions).toEqual([ACTIONS.CL_SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], plan.params[2]!)).toEqual([WETH, ADDRESS_THIS, 0n]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[1]!)).toEqual([MSG_SENDER, base.minAmountOutNet]);
  });

  it("pays another recipient by address, and passes verifySwapCalldata", () => {
    const toOther = buildSwapCall({ ...base, recipient: OTHER, hops: [hop(TOKEN, WETH)], unwrapOutput: true });
    const { inputs } = decode(toOther.data);
    const [to, min] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[1]!);
    expect([to.toLowerCase(), min]).toEqual([OTHER, base.minAmountOutNet]);
    const req = { tokenIn: TOKEN, tokenOut: NATIVE, amountIn: base.amountIn, recipient: USER, minAmountOut: base.minAmountOutNet, deadline: Number(DEADLINE), wrappedNative: WETH } as const;
    expect(() => verifySwapCalldata("universal-router", call, req)).not.toThrow();
    expect(() => verifySwapCalldata("universal-router", toOther, { ...req, recipient: OTHER })).not.toThrow();
    // Built for OTHER, checked as a trade for USER: the unwrap pays a third party.
    expect(() => verifySwapCalldata("universal-router", toOther, req)).toThrow(/unwrap pays a third party/);
  });
});

/* -------------------------------------------------------------- adapter --- */

function chain(wrapped: boolean): ChainConfig {
  return {
    chainId: 31337,
    name: "Fake",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    contracts: { vault: "0x00000000000000000000000000000000000000a1", clPoolManager: MANAGER, universalRouter: ROUTER, permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", quoter: QUOTER, ...(wrapped ? { wrappedNative: WETH } : {}) },
  };
}

function fakeClient(amountOut: bigint) {
  const sims: { zeroForOne: boolean; poolKey: PoolKey }[] = [];
  const client = {
    sims,
    async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
      if (req.functionName !== "quoteExactInputSingle") throw new Error("unexpected");
      sims.push(req.args[0] as { zeroForOne: boolean; poolKey: PoolKey });
      return { result: [amountOut, 100_000n] };
    },
    async readContract(): Promise<unknown> {
      throw new Error("fake: no reads");
    },
  };
  return client;
}

describe("viem adapter · native coin through a wrapped-native pool", () => {
  it("lists the native coin just before the wrapped native, only when wrappedNative is configured", async () => {
    const withWrap = createViemAdapter({ chain: chain(true), publicClient: fakeClient(0n) as unknown as PublicClient, tokens: [token, weth], pools: [POOL] });
    expect((await withWrap.listTokens()).map((t) => t.symbol)).toEqual(["DTC", "ETH", "WETH"]);
    const without = createViemAdapter({ chain: chain(false), publicClient: fakeClient(0n) as unknown as PublicClient, tokens: [token, weth], pools: [POOL] });
    expect((await without.listTokens()).map((t) => t.symbol)).toEqual(["DTC", "WETH"]);
  });

  it("quotes ETH -> DTC against the WETH pool (WETH is currency0, so zeroForOne) and nothing without wrappedNative", async () => {
    const client = fakeClient(777n);
    const adapter = createViemAdapter({ chain: chain(true), publicClient: client as unknown as PublicClient, tokens: [token, weth], pools: [POOL] });
    const q = await adapter.quoteSwap({ tokenIn: eth, tokenOut: token, amountIn: 10n ** 16n });
    expect(q.grossAmountOut).toBe(777n);
    expect(client.sims[0]?.zeroForOne).toBe(true);
    expect(q.route[0]?.tokenIn.symbol).toBe("ETH");
    const sell = await adapter.quoteSwap({ tokenIn: token, tokenOut: eth, amountIn: 5n });
    expect(client.sims[1]?.zeroForOne).toBe(false);
    expect(sell.route[0]?.tokenOut.symbol).toBe("ETH");

    const off = createViemAdapter({ chain: chain(false), publicClient: fakeClient(777n) as unknown as PublicClient, tokens: [token, weth], pools: [POOL] });
    await expect(off.quoteSwap({ tokenIn: eth, tokenOut: token, amountIn: 1n })).rejects.toThrow(/no configured pool/);
  });

  it("builds the wrap and unwrap shapes, verified, with no approval for the native side", async () => {
    const adapter = createViemAdapter({
      chain: chain(true),
      publicClient: fakeClient(777n) as unknown as PublicClient,
      tokens: [token, weth],
      pools: [POOL],
      wallet: { getAccount: async () => USER, sendTransaction: async () => "0x" },
    });
    expect(await adapter.getApprovalRequirements(eth, USER, 10n ** 16n)).toEqual([]);
    const buyQuote: SwapQuoteResult = await adapter.quoteSwap({ tokenIn: eth, tokenOut: token, amountIn: 10n ** 16n });
    const buy = await adapter.buildSwap({ quote: buyQuote, tokenIn: eth, tokenOut: token, amountIn: 10n ** 16n, minAmountOutGross: 700n, minAmountOutNet: 700n, integrator: NO_INTEGRATOR_FEE, recipient: USER, deadline: DEADLINE });
    expect(buy.value).toBe(10n ** 16n);
    expect(decode(buy.data).commands).toEqual([COMMANDS.WRAP_ETH, COMMANDS.INFI_SWAP, COMMANDS.SWEEP]);

    const sellQuote = await adapter.quoteSwap({ tokenIn: token, tokenOut: eth, amountIn: 5n });
    const sell = await adapter.buildSwap({ quote: sellQuote, tokenIn: token, tokenOut: eth, amountIn: 5n, minAmountOutGross: 700n, minAmountOutNet: 700n, integrator: NO_INTEGRATOR_FEE, recipient: USER, deadline: DEADLINE });
    expect(sell.value).toBe(0n);
    expect(decode(sell.data).commands).toEqual([COMMANDS.INFI_SWAP, COMMANDS.UNWRAP_WETH]);

    // The plain WETH trade is unchanged: SETTLE_ALL through Permit2, no wrap.
    const wethQuote = await adapter.quoteSwap({ tokenIn: weth, tokenOut: token, amountIn: 10n ** 16n });
    const plain = await adapter.buildSwap({ quote: wethQuote, tokenIn: weth, tokenOut: token, amountIn: 10n ** 16n, minAmountOutGross: 700n, minAmountOutNet: 700n, integrator: NO_INTEGRATOR_FEE, recipient: USER, deadline: DEADLINE });
    expect(plain.value).toBe(0n);
    expect(decode(plain.data).commands).toEqual([COMMANDS.INFI_SWAP]);
    expect(planOf(decode(plain.data).inputs[0]!).actions).toEqual([ACTIONS.CL_SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL]);
  });
});

describe("autoQuoteCoin", () => {
  it("pays the native coin unless the wrapped balance covers the buy or there is no native", () => {
    expect(autoQuoteCoin({ side: "buy", wrappedBalance: null, nativeBalance: null, buyAmount: null })).toBe("native");
    expect(autoQuoteCoin({ side: "buy", wrappedBalance: 0n, nativeBalance: 5n, buyAmount: 1n })).toBe("native");
    expect(autoQuoteCoin({ side: "buy", wrappedBalance: 3n, nativeBalance: 5n, buyAmount: 4n })).toBe("native");
    expect(autoQuoteCoin({ side: "buy", wrappedBalance: 4n, nativeBalance: 5n, buyAmount: 4n })).toBe("wrapped");
    expect(autoQuoteCoin({ side: "buy", wrappedBalance: 4n, nativeBalance: 5n, buyAmount: null })).toBe("wrapped");
    expect(autoQuoteCoin({ side: "buy", wrappedBalance: 1n, nativeBalance: 0n, buyAmount: 9n })).toBe("wrapped");
    expect(autoQuoteCoin({ side: "sell", wrappedBalance: 4n, nativeBalance: 5n, buyAmount: null })).toBe("native");
    expect(autoQuoteCoin({ side: "sell", wrappedBalance: 4n, nativeBalance: 0n, buyAmount: null })).toBe("wrapped");
  });
});
