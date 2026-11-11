// SPDX-License-Identifier: MIT
/**
 * The two generations of launch guard (`kitV2/guardGeneration.ts`) and the trade
 * fee of the newer one (`kitV2/guardFees.ts`).
 *
 * Nothing here is a chain. Revert data is ENCODED from the generated ABI and
 * decoded back, so a fixture cannot drift from the contract's interface; every
 * amount asserted is worked out in the comment beside it.
 *
 * The last block reads numbers out of the Solidity when the monorepo is present
 * (the public mirror has none): the SDK's constants are claims about bytecode.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  getAbiItem,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  BIN_LAUNCH_GUARD_HOOK_ABI,
  GUARD_FEE_PIPS_DENOMINATOR,
  GUARD_LP_SHARE_LIMITS,
  GUARD_QUOTE_FEE_BIT,
  KIT_V2_BIN_HOOK_BITMAP,
  KIT_V2_CL_HOOK_BITMAP,
  LAUNCH_FEE_SPLIT_LIMITS,
  LAUNCH_GUARD_BITMAPS,
  LAUNCH_GUARD_HOOK_ABI,
  LAUNCH_TAX_LIMITS,
  SWAP_NOT_FILLED_SELECTOR,
  UNIVERSAL_ROUTER_ABI,
  WRAPPED_ERROR_ABI,
  decodeBinHookPermissions,
  decodeCLHookPermissions,
  decodeSwapNotFilled,
  encodeAcceptFeeCreator,
  encodeSettleFee,
  encodeTransferFeeCreator,
  feeCreatorIdOf,
  guardBuyCharges,
  guardChargePoint,
  guardFeeParts,
  guardGenerationOf,
  guardQuoteTake,
  guardSwapRates,
  largestExactInputFor,
  readGuardBitmap,
  readGuardFeeParts,
  readGuardGeneration,
  readGuardLpShareBps,
  splitGuardPot,
  validateHookRegistrationBitmap,
} from "../src/index.js";

/* Checksummed, because that is how viem hands a decoded address back. */
const GUARD: Address = getAddress("0x00000000000000000000000000000000000000d1");
const POOL: Hex = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const USD: Address = getAddress("0x8000000000000000000000000000000000000000");
const SOMEONE: Address = getAddress("0x0000000000000000000000000000000000000c01");

/* ----------------------------------------------------------- generation --- */

describe("launch guard bitmaps", () => {
  it("are the four the contracts register", () => {
    expect(LAUNCH_GUARD_BITMAPS).toEqual({ "lp-fee": { CL: 0x08c1, Bin: 0x08c5 }, "quote-fee": { CL: 0x0cc1, Bin: 0x0cc5 } });
    expect(LAUNCH_GUARD_BITMAPS["lp-fee"]).toEqual({ CL: KIT_V2_CL_HOOK_BITMAP, Bin: KIT_V2_BIN_HOOK_BITMAP });
    expect(GUARD_QUOTE_FEE_BIT).toBe(0x0400);
  });

  it("differ between the generations by `beforeSwapReturnsDelta` and by nothing else", () => {
    const lp = decodeCLHookPermissions(LAUNCH_GUARD_BITMAPS["lp-fee"].CL);
    const quote = decodeCLHookPermissions(LAUNCH_GUARD_BITMAPS["quote-fee"].CL);
    expect(lp.beforeSwapReturnsDelta).toBe(false);
    expect(quote).toEqual({ ...lp, beforeSwapReturnsDelta: true });
    expect(Object.entries(quote).filter(([, on]) => on).map(([name]) => name)).toEqual([
      "beforeInitialize",
      "beforeSwap",
      "afterSwap",
      "beforeSwapReturnsDelta",
      "afterSwapReturnsDelta",
    ]);
    const lpBin = decodeBinHookPermissions(LAUNCH_GUARD_BITMAPS["lp-fee"].Bin);
    expect(decodeBinHookPermissions(LAUNCH_GUARD_BITMAPS["quote-fee"].Bin)).toEqual({ ...lpBin, beforeSwapReturnsDelta: true });
    /* Bin is the CL set plus `beforeMint`, on both generations. */
    expect(lpBin.beforeMint).toBe(true);
    expect(LAUNCH_GUARD_BITMAPS["quote-fee"].Bin ^ LAUNCH_GUARD_BITMAPS["quote-fee"].CL).toBe(LAUNCH_GUARD_BITMAPS["lp-fee"].Bin ^ LAUNCH_GUARD_BITMAPS["lp-fee"].CL);
  });

  it("each pass the pool managers' own bitmap rules", () => {
    for (const generation of ["lp-fee", "quote-fee"] as const) {
      expect(validateHookRegistrationBitmap("CL", LAUNCH_GUARD_BITMAPS[generation].CL).issues).toEqual([]);
      expect(validateHookRegistrationBitmap("BIN", LAUNCH_GUARD_BITMAPS[generation].Bin).issues).toEqual([]);
    }
  });
});

describe("guardGenerationOf", () => {
  it.each([
    [0x08c1, undefined, "lp-fee"],
    [0x08c5, undefined, "lp-fee"],
    [0x0cc1, undefined, "quote-fee"],
    [0x0cc5, undefined, "quote-fee"],
    [0x08c1, "CL", "lp-fee"],
    [0x08c5, "Bin", "lp-fee"],
    [0x0cc1, "CL", "quote-fee"],
    [0x0cc5, "Bin", "quote-fee"],
  ] as const)("0x%s (%s) is %s", (bitmap, kind, expected) => {
    expect(guardGenerationOf(bitmap, kind)).toBe(expected);
  });

  it.each([
    ["the other pool type's bitmap", 0x0cc5, "CL"],
    ["the other pool type's bitmap", 0x0cc1, "Bin"],
    ["the other pool type's bitmap", 0x08c5, "CL"],
    ["the other pool type's bitmap", 0x08c1, "Bin"],
    ["bit 10 alone", 0x0400, undefined],
    ["bit 10 without the swap callbacks", 0x0c01, undefined],
    ["a quote-fee bitmap with one more callback", 0x0cc1 | 0x0002, undefined],
    ["a quote-fee bitmap with one callback fewer", 0x0cc1 & ~0x0001, undefined],
    ["the first guards' bitmap, before the creator tax", 0x0041, undefined],
    ["a hookless pool", 0, undefined],
    ["a value no uint16 holds", 0x1_0cc1, undefined],
    ["a guard that did not answer", null, undefined],
    ["a bitmap nobody read", undefined, undefined],
  ] as const)("%s (%s as %s) is unknown", (_, bitmap, kind) => {
    expect(guardGenerationOf(bitmap, kind)).toBe("unknown");
  });

  it("knows exactly four bitmaps out of every uint16", () => {
    const known: number[] = [];
    for (let bitmap = 0; bitmap <= 0xffff; bitmap++) if (guardGenerationOf(bitmap) !== "unknown") known.push(bitmap);
    expect(known).toEqual([0x08c1, 0x08c5, 0x0cc1, 0x0cc5]);
  });
});

describe("readGuardBitmap / readGuardGeneration", () => {
  function clientAnswering(answer: () => unknown) {
    const calls: { address: Address; functionName: string }[] = [];
    const client = {
      calls,
      async readContract(req: { address: Address; functionName: string }): Promise<unknown> {
        calls.push({ address: req.address, functionName: req.functionName });
        return answer();
      },
    };
    return { calls, client: client as unknown as PublicClient };
  }

  it("asks the guard itself for getHooksRegistrationBitmap and classifies the answer", async () => {
    const { calls, client } = clientAnswering(() => 0x0cc1);
    await expect(readGuardGeneration(client, GUARD, "CL")).resolves.toEqual({ guard: GUARD, bitmap: 0x0cc1, generation: "quote-fee" });
    expect(calls).toEqual([{ address: GUARD, functionName: "getHooksRegistrationBitmap" }]);
    await expect(readGuardGeneration(clientAnswering(() => 0x08c5).client, GUARD)).resolves.toMatchObject({ bitmap: 0x08c5, generation: "lp-fee" });
  });

  it("keeps the bitmap it read even when it is no guard's, so a caller can show it", async () => {
    await expect(readGuardGeneration(clientAnswering(() => 0x0881).client, GUARD)).resolves.toEqual({ guard: GUARD, bitmap: 0x0881, generation: "unknown" });
    /* The right generation, the wrong pool type. */
    await expect(readGuardGeneration(clientAnswering(() => 0x0cc5).client, GUARD, "CL")).resolves.toEqual({ guard: GUARD, bitmap: 0x0cc5, generation: "unknown" });
  });

  it.each([
    ["a revert", () => new ContractFunctionRevertedError({ abi: [], functionName: "getHooksRegistrationBitmap" })],
    ["an address with no code", () => new ContractFunctionZeroDataError({ functionName: "getHooksRegistrationBitmap" })],
  ])("%s is unknown with a null bitmap, never a generation", async (_, error) => {
    const { client } = clientAnswering(() => {
      throw error();
    });
    await expect(readGuardBitmap(client, GUARD)).resolves.toBeNull();
    await expect(readGuardGeneration(client, GUARD, "CL")).resolves.toEqual({ guard: GUARD, bitmap: null, generation: "unknown" });
  });

  it("throws on a transport failure: an endpoint that did not answer says nothing about the guard", async () => {
    const { client } = clientAnswering(() => {
      throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
    });
    await expect(readGuardBitmap(client, GUARD)).rejects.toBeInstanceOf(HttpRequestError);
    await expect(readGuardGeneration(client, GUARD)).rejects.toBeInstanceOf(HttpRequestError);
  });
});

/* ----------------------------------------------------------------- pots --- */

describe("splitGuardPot", () => {
  it("floors the creator's and the integrator's shares and gives the protocol the rest", () => {
    /* 1_000_003 * 0.7 = 700_002.1 -> 700_002; * 0.1 = 100_000.3 -> 100_000; rest 200_001 (20% is 200_000.6). */
    expect(splitGuardPot(1_000_003n, { creatorBps: 7_000, integratorBps: 1_000 })).toEqual({ toCreator: 700_002n, toIntegrator: 100_000n, toProtocol: 200_001n });
  });

  it("a pot too small to share goes to the protocol whole", () => {
    expect(splitGuardPot(1n, { creatorBps: 7_000, integratorBps: 1_000 })).toEqual({ toCreator: 0n, toIntegrator: 0n, toProtocol: 1n });
    expect(splitGuardPot(0n, { creatorBps: 7_000, integratorBps: 1_000 })).toEqual({ toCreator: 0n, toIntegrator: 0n, toProtocol: 0n });
  });

  it("always drains the pot, and never pays a rate more than its exact share", () => {
    for (const pot of [1n, 7n, 9_999n, 10_001n, 123_456_789n, (1n << 127n) - 1n]) {
      for (const [creatorBps, integratorBps] of [[8_000, 0], [6_000, 2_000], [5_000, 0], [3_000, 2_000], [1, 1]] as const) {
        const s = splitGuardPot(pot, { creatorBps, integratorBps });
        expect(s.toCreator + s.toIntegrator + s.toProtocol).toBe(pot);
        expect(s.toCreator * 10_000n).toBeLessThanOrEqual(pot * BigInt(creatorBps));
        expect(s.toIntegrator * 10_000n).toBeLessThanOrEqual(pot * BigInt(integratorBps));
        expect(s.toProtocol * 10_000n).toBeGreaterThanOrEqual(pot * BigInt(10_000 - creatorBps - integratorBps));
      }
    }
  });

  it("refuses shares no split can carry", () => {
    expect(() => splitGuardPot(-1n, { creatorBps: 1, integratorBps: 1 })).toThrow(RangeError);
    expect(() => splitGuardPot(1n, { creatorBps: 9_000, integratorBps: 2_000 })).toThrow(/above 10000/);
    expect(() => splitGuardPot(1n, { creatorBps: 0.5, integratorBps: 0 })).toThrow(RangeError);
    expect(() => splitGuardPot(1n, { creatorBps: -1, integratorBps: 0 })).toThrow(RangeError);
  });
});

/* ---------------------------------------------------------------- parts --- */

describe("guardFeeParts", () => {
  it("a buy pays the pool floor(fee * share / 10_000) and the guard the rest; a sell pays the guard everything", () => {
    /* 1% fee, a quarter to the pool. */
    expect(guardFeeParts(10_000, 2_500)).toEqual({ buyLpPips: 2_500, buyGuardPips: 7_500, sellGuardPips: 10_000 });
    /* 83_833 * 25% = 20_958.25: the pool's part is floored, so the rounding pip is the guard's. */
    expect(guardFeeParts(83_833, 2_500)).toEqual({ buyLpPips: 20_958, buyGuardPips: 62_875, sellGuardPips: 83_833 });
    /* The cap: half. 3_001 * 50% = 1_500.5. */
    expect(guardFeeParts(3_001, 5_000)).toEqual({ buyLpPips: 1_500, buyGuardPips: 1_501, sellGuardPips: 3_001 });
  });

  it("a share of zero leaves the pool nothing, and a fee too small to share is the guard's whole", () => {
    expect(guardFeeParts(10_000, 0)).toEqual({ buyLpPips: 0, buyGuardPips: 10_000, sellGuardPips: 10_000 });
    expect(guardFeeParts(3, 2_500)).toEqual({ buyLpPips: 0, buyGuardPips: 3, sellGuardPips: 3 });
    expect(guardFeeParts(0, 5_000)).toEqual({ buyLpPips: 0, buyGuardPips: 0, sellGuardPips: 0 });
  });

  it("the two parts of a buy are always the whole fee, and the pool's is never above its share", () => {
    for (const fee of [0, 1, 3, 2_999, 3_000, 10_000, 83_833, 499_999, 500_000]) {
      for (const share of [0, 1, 999, 2_500, 4_999, 5_000]) {
        const p = guardFeeParts(fee, share);
        expect(p.buyLpPips + p.buyGuardPips).toBe(fee);
        expect(p.sellGuardPips).toBe(fee);
        expect(p.buyLpPips * 10_000).toBeLessThanOrEqual(fee * share);
        expect((p.buyLpPips + 1) * 10_000).toBeGreaterThan(fee * share);
      }
    }
  });

  it("refuses a fee or a share that is not one: there is no default share", () => {
    expect(() => guardFeeParts(1_000_001, 0)).toThrow(/feePips/);
    expect(() => guardFeeParts(-1, 0)).toThrow(RangeError);
    expect(() => guardFeeParts(10_000, 10_001)).toThrow(/lpShareBps/);
    expect(() => guardFeeParts(10_000, -1)).toThrow(/lpShareBps/);
    expect(() => guardFeeParts(10_000, 0.5)).toThrow(/lpShareBps/);
    expect(() => guardFeeParts(10_000, Number.NaN)).toThrow(/lpShareBps/);
    expect(() => guardFeeParts(10_000, undefined as unknown as number)).toThrow(/lpShareBps/);
    expect(() => guardFeeParts(10_000, null as unknown as number)).toThrow(/lpShareBps/);
  });
});

describe("guardSwapRates", () => {
  const parts = { buyLpPips: 2_500, buyGuardPips: 7_500, sellGuardPips: 10_000 };

  it("a buy pays both parts; a sell pays the guard the whole fee and the pool nothing", () => {
    expect(guardSwapRates(parts, true)).toEqual({ guardPips: 7_500, lpPips: 2_500 });
    expect(guardSwapRates(parts, false)).toEqual({ guardPips: 10_000, lpPips: 0 });
  });
});

describe("readGuardFeeParts / readGuardLpShareBps", () => {
  function clientOf(answers: Record<string, () => unknown>) {
    const calls: { address: Address; functionName: string; args?: readonly unknown[] }[] = [];
    const client = {
      async readContract(req: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> {
        calls.push(req.args === undefined ? { address: req.address, functionName: req.functionName } : { address: req.address, functionName: req.functionName, args: req.args });
        const answer = answers[req.functionName];
        if (answer === undefined) throw new Error(`fake: unexpected readContract ${req.functionName}`);
        return answer();
      },
    };
    return { calls, client: client as unknown as PublicClient };
  }
  const reverted = (functionName: string) => () => {
    throw new ContractFunctionRevertedError({ abi: [], functionName });
  };
  const noSuchFunction = (functionName: string) => () => {
    throw new ContractFunctionZeroDataError({ functionName });
  };
  const down = () => {
    throw new HttpRequestError({ url: "http://fake", details: "fake: connection refused" });
  };

  it("asks the guard for its share and for the pool's parts, and carries both as answered", async () => {
    const { calls, client } = clientOf({ LP_SHARE_BPS: () => 2_500, currentFeeParts: () => [20_958, 62_875, 83_833] });
    await expect(readGuardFeeParts(client, GUARD, POOL)).resolves.toEqual({
      lpShareBps: 2_500,
      parts: { buyLpPips: 20_958, buyGuardPips: 62_875, sellGuardPips: 83_833 },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { address: GUARD, functionName: "LP_SHARE_BPS" },
        { address: GUARD, functionName: "currentFeeParts", args: [POOL] },
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it("a share of zero is an answer, carried as zero", async () => {
    const { client } = clientOf({ LP_SHARE_BPS: () => 0, currentFeeParts: () => [0, 3_000, 3_000] });
    await expect(readGuardFeeParts(client, GUARD, POOL)).resolves.toEqual({ lpShareBps: 0, parts: { buyLpPips: 0, buyGuardPips: 3_000, sellGuardPips: 3_000 } });
    await expect(readGuardLpShareBps(client, GUARD)).resolves.toBe(0);
  });

  it.each([
    ["reverts", reverted],
    ["has no such function", noSuchFunction],
  ])("a guard that %s reads as null, never as a share of zero", async (_, silent) => {
    const { client } = clientOf({ LP_SHARE_BPS: silent("LP_SHARE_BPS"), currentFeeParts: silent("currentFeeParts") });
    await expect(readGuardFeeParts(client, GUARD, POOL)).resolves.toEqual({ lpShareBps: null, parts: null });
    await expect(readGuardLpShareBps(client, GUARD)).resolves.toBeNull();
  });

  it("a revert raised by ANOTHER copy of viem is still a revert: matched by name, down the causes", async () => {
    /* What a client built by a host application raises when its viem is not the one this module imports:
       the same error, of a class `instanceof` does not know. */
    class ContractFunctionRevertedError extends Error {
      override name = "ContractFunctionRevertedError";
    }
    class ContractFunctionExecutionError extends Error {
      override name = "ContractFunctionExecutionError";
      constructor(cause: Error) {
        super("The contract function reverted.", { cause });
      }
    }
    const foreign = () => {
      throw new ContractFunctionExecutionError(new ContractFunctionRevertedError("reverted"));
    };
    const { client } = clientOf({ LP_SHARE_BPS: foreign, currentFeeParts: foreign });
    await expect(readGuardFeeParts(client, GUARD, POOL)).resolves.toEqual({ lpShareBps: null, parts: null });
    /* And a foreign TRANSPORT failure is still thrown: only the three names of a contract's refusal are matched. */
    class HttpRequestError extends Error {
      override name = "HttpRequestError";
    }
    const foreignDown = () => {
      throw new ContractFunctionExecutionError(new HttpRequestError("connection refused"));
    };
    await expect(readGuardFeeParts(clientOf({ LP_SHARE_BPS: foreignDown, currentFeeParts: foreignDown }).client, GUARD, POOL)).rejects.toThrow(/reverted/);
    /* Something that is no error at all is thrown as it came. */
    const odd = () => {
      throw "a string";
    };
    await expect(readGuardFeeParts(clientOf({ LP_SHARE_BPS: odd, currentFeeParts: odd }).client, GUARD, POOL)).rejects.toBe("a string");
  });

  it("each half is its own answer", async () => {
    const onlyShare = clientOf({ LP_SHARE_BPS: () => 5_000, currentFeeParts: reverted("currentFeeParts") });
    await expect(readGuardFeeParts(onlyShare.client, GUARD, POOL)).resolves.toEqual({ lpShareBps: 5_000, parts: null });
    const onlyParts = clientOf({ LP_SHARE_BPS: noSuchFunction("LP_SHARE_BPS"), currentFeeParts: () => [1_500, 1_500, 3_000] });
    await expect(readGuardFeeParts(onlyParts.client, GUARD, POOL)).resolves.toEqual({ lpShareBps: null, parts: { buyLpPips: 1_500, buyGuardPips: 1_500, sellGuardPips: 3_000 } });
  });

  it("throws on a transport failure: an endpoint that did not answer says nothing about the split", async () => {
    await expect(readGuardFeeParts(clientOf({ LP_SHARE_BPS: down, currentFeeParts: () => [0, 0, 0] }).client, GUARD, POOL)).rejects.toBeInstanceOf(HttpRequestError);
    await expect(readGuardFeeParts(clientOf({ LP_SHARE_BPS: () => 0, currentFeeParts: down }).client, GUARD, POOL)).rejects.toBeInstanceOf(HttpRequestError);
    await expect(readGuardLpShareBps(clientOf({ LP_SHARE_BPS: down }).client, GUARD)).rejects.toBeInstanceOf(HttpRequestError);
  });
});

/* ---------------------------------------------------------------- swaps --- */

describe("guardChargePoint", () => {
  it("charges the two shapes that name the quote before the swap, the other two after it", () => {
    expect(guardChargePoint({ isBuy: true, exactInput: true })).toBe("beforeSwap");
    expect(guardChargePoint({ isBuy: false, exactInput: false })).toBe("beforeSwap");
    expect(guardChargePoint({ isBuy: false, exactInput: true })).toBe("afterSwap");
    expect(guardChargePoint({ isBuy: true, exactInput: false })).toBe("afterSwap");
  });
});

describe("guardQuoteTake", () => {
  it("takes fee and tax on the SAME base, each floored on its own, and says what must reach the pool", () => {
    /* 1e18 at 1% and 3%: fee 1e16, tax 3e16, take 4e16. */
    expect(guardQuoteTake({ amount: 10n ** 18n, feePips: 10_000, taxBps: 300, exactInput: true })).toEqual({
      fee: 10n ** 16n,
      tax: 3n * 10n ** 16n,
      take: 4n * 10n ** 16n,
      poolAmount: 96n * 10n ** 16n,
    });
    expect(guardQuoteTake({ amount: 10n ** 18n, feePips: 10_000, taxBps: 300, exactInput: false }).poolAmount).toBe(104n * 10n ** 16n);
  });

  it("floors each rate separately: 199 at 1% and 1% takes 1 + 1, not floor(3.98)", () => {
    expect(guardQuoteTake({ amount: 199n, feePips: 10_000, taxBps: 100, exactInput: true })).toEqual({ fee: 1n, tax: 1n, take: 2n, poolAmount: 197n });
    /* And never the tax on what is left after the fee: at 50% + 10% of 1000 the take is 600, not 550. */
    expect(guardQuoteTake({ amount: 1_000n, feePips: 500_000, taxBps: 1_000, exactInput: true }).take).toBe(600n);
  });

  it("an amount too small to be charged is not charged, and an expired tax is a zero rate", () => {
    expect(guardQuoteTake({ amount: 99n, feePips: 10_000, taxBps: 100, exactInput: true })).toEqual({ fee: 0n, tax: 0n, take: 0n, poolAmount: 99n });
    expect(guardQuoteTake({ amount: 10_000n, feePips: 10_000, taxBps: 0, exactInput: true })).toEqual({ fee: 100n, tax: 0n, take: 100n, poolAmount: 9_900n });
    expect(guardQuoteTake({ amount: 0n, feePips: 500_000, taxBps: 1_000, exactInput: false })).toEqual({ fee: 0n, tax: 0n, take: 0n, poolAmount: 0n });
  });

  it("refuses rates and amounts that are not ones", () => {
    expect(() => guardQuoteTake({ amount: -1n, feePips: 0, taxBps: 0, exactInput: true })).toThrow(RangeError);
    expect(() => guardQuoteTake({ amount: 1n, feePips: 1_000_001, taxBps: 0, exactInput: true })).toThrow(/feePips/);
    expect(() => guardQuoteTake({ amount: 1n, feePips: 0, taxBps: 10_001, exactInput: true })).toThrow(/taxBps/);
    expect(() => guardQuoteTake({ amount: 1n, feePips: 1.5, taxBps: 0, exactInput: true })).toThrow(RangeError);
    /* More than the swap on exact input is what core refuses as HookDeltaExceedsSwapAmount. */
    expect(() => guardQuoteTake({ amount: 1_000n, feePips: 1_000_000, taxBps: 100, exactInput: true })).toThrow(/more than the swap/);
    /* The same rates on exact output add to what the pool pays out; nothing is exceeded. */
    expect(guardQuoteTake({ amount: 1_000n, feePips: 1_000_000, taxBps: 100, exactInput: false }).poolAmount).toBe(2_010n);
  });

  it("uses the contract's two denominators", () => {
    expect(GUARD_FEE_PIPS_DENOMINATOR).toBe(1_000_000);
    expect(guardQuoteTake({ amount: 1_000_000n, feePips: 1, taxBps: 0, exactInput: true }).fee).toBe(1n);
    expect(guardQuoteTake({ amount: 10_000n, feePips: 0, taxBps: 1, exactInput: true }).tax).toBe(1n);
  });
});

describe("guardBuyCharges", () => {
  it("the guard takes its part and the tax of the amount named, and the pool charges its part on what is left", () => {
    /* 1e18 at a 1% fee, a quarter to the pool, and a 3% tax.
       guard: 0.75% of 1e18 = 7.5e15; tax 3e16; take 3.75e16; 9.625e17 reaches the pool.
       pool:  0.25% of 9.625e17 = 2.40625e15; 9.6009375e17 buys tokens. */
    const c = guardBuyCharges({ amount: 10n ** 18n, parts: guardFeeParts(10_000, 2_500), taxBps: 300 });
    expect(c).toEqual({
      guardFee: 7_500_000_000_000_000n,
      tax: 30_000_000_000_000_000n,
      take: 37_500_000_000_000_000n,
      poolAmount: 962_500_000_000_000_000n,
      lpFee: 2_406_250_000_000_000n,
      traded: 960_093_750_000_000_000n,
      tradeFee: 9_906_250_000_000_000n,
    });
    /* What reaches the pool is what `guardQuoteTake` says when fed the GUARD's part. */
    expect(guardQuoteTake({ amount: 10n ** 18n, feePips: 7_500, taxBps: 300, exactInput: true }).poolAmount).toBe(c.poolAmount);
    /* Feeding it the whole fee would take the pool's part twice: 9.6e17 would reach the pool, not 9.625e17. */
    expect(guardQuoteTake({ amount: 10n ** 18n, feePips: 10_000, taxBps: 300, exactInput: true }).poolAmount).toBe(960_000_000_000_000_000n);
  });

  it("with a share of zero the pool charges nothing and the guard's take is the whole fee", () => {
    const c = guardBuyCharges({ amount: 1_000_000n, parts: guardFeeParts(10_000, 0), taxBps: 0 });
    expect(c).toEqual({ guardFee: 10_000n, tax: 0n, take: 10_000n, poolAmount: 990_000n, lpFee: 0n, traded: 990_000n, tradeFee: 10_000n });
  });

  it("the pool's fee is rounded up, as a pool rounds it, and the guard's is floored", () => {
    /* 199 at 1%, half to the pool, no tax: guard floor(199 * 0.5%) = 0; pool ceil(199 * 0.5%) = ceil(0.995) = 1. */
    expect(guardBuyCharges({ amount: 199n, parts: guardFeeParts(10_000, 5_000), taxBps: 0 })).toMatchObject({ guardFee: 0n, poolAmount: 199n, lpFee: 1n, traded: 198n });
  });

  it("a buyer never pays more than the trade fee's rate on the amount named, by more than the pool's rounding unit", () => {
    for (const amount of [1n, 199n, 10_000n, 1_000_003n, 10n ** 18n, 10n ** 27n + 7n]) {
      for (const fee of [3_000, 10_000, 83_833, 500_000]) {
        for (const share of [0, 1, 2_500, 5_000]) {
          for (const taxBps of [0, 300, 1_000]) {
            const c = guardBuyCharges({ amount, parts: guardFeeParts(fee, share), taxBps });
            /* ceil(amount * fee / 1e6): the whole fee's rate, rounded up once for the pool's rounding. */
            const whole = (amount * BigInt(fee) + 999_999n) / 1_000_000n;
            expect(c.tradeFee).toBeLessThanOrEqual(whole);
            expect(c.take + c.lpFee + c.traded).toBe(amount);
            expect(c.tradeFee).toBe(c.guardFee + c.lpFee);
          }
        }
      }
    }
  });

  it("refuses parts that are not rates", () => {
    expect(() => guardBuyCharges({ amount: 1n, parts: { buyLpPips: 1_000_001, buyGuardPips: 0, sellGuardPips: 0 }, taxBps: 0 })).toThrow(/buyLpPips/);
    expect(() => guardBuyCharges({ amount: 1n, parts: { buyLpPips: 0, buyGuardPips: 1.5, sellGuardPips: 0 }, taxBps: 0 })).toThrow(/feePips/);
  });
});

describe("largestExactInputFor", () => {
  const reaches = (amount: bigint, feePips: number, taxBps: number) => guardQuoteTake({ amount, feePips, taxBps, exactInput: true }).poolAmount;

  it.each([
    [1_000_000n, 10_000, 0],
    [1_000_000n, 10_000, 300],
    [999_983n, 3_000, 1_000],
    [10n ** 18n + 7n, 500_000, 1_000],
    [1n, 500_000, 1_000],
    [0n, 10_000, 300],
    [12_345n, 0, 0],
    [10n ** 30n, 83_833, 250],
  ])("capacity %s at %s pips and %s bps: the answer fits and one unit more does not", (poolCapacity, feePips, taxBps) => {
    const amount = largestExactInputFor({ poolCapacity, feePips, taxBps });
    expect(reaches(amount, feePips, taxBps)).toBeLessThanOrEqual(poolCapacity);
    expect(reaches(amount + 1n, feePips, taxBps)).toBeGreaterThan(poolCapacity);
    /* Naming the capacity itself always fits, so the answer is never less. */
    expect(amount).toBeGreaterThanOrEqual(poolCapacity);
  });

  it("with nothing taken, the most that can be named is the capacity", () => {
    expect(largestExactInputFor({ poolCapacity: 12_345n, feePips: 0, taxBps: 0 })).toBe(12_345n);
  });

  it("works the example in the design: a pool that can take 6.02 at rates summing to 5.3%", () => {
    /* 5% fee + 0.3% tax. Naming 6_356_915: fee floor(317_845.75) = 317_845, tax floor(19_070.745) = 19_070,
       so 6_020_000 reaches the pool. One unit more leaves both floors where they are and 6_020_001 reaches it. */
    const amount = largestExactInputFor({ poolCapacity: 6_020_000n, feePips: 50_000, taxBps: 30 });
    expect(amount).toBe(6_356_915n);
    expect(guardQuoteTake({ amount, feePips: 50_000, taxBps: 30, exactInput: true })).toEqual({ fee: 317_845n, tax: 19_070n, take: 336_915n, poolAmount: 6_020_000n });
    expect(reaches(amount + 1n, 50_000, 30)).toBe(6_020_001n);
  });

  it("refuses rates that leave nothing to reach the pool", () => {
    expect(() => largestExactInputFor({ poolCapacity: 1n, feePips: 900_000, taxBps: 1_000 })).toThrow(/whole amount/);
    expect(() => largestExactInputFor({ poolCapacity: -1n, feePips: 0, taxBps: 0 })).toThrow(RangeError);
  });
});

/* --------------------------------------------------------------- errors --- */

describe("decodeSwapNotFilled", () => {
  const bare = encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "SwapNotFilled", args: [947_000n, 602_000n] });
  const AFTER_SWAP: Hex = "0x12345678";
  const wrap = (reason: Hex, target: Address = GUARD): Hex =>
    encodeErrorResult({ abi: WRAPPED_ERROR_ABI, errorName: "WrappedError", args: [target, AFTER_SWAP, reason, "0xdeadbeef"] });
  const routed = (message: Hex): Hex => encodeErrorResult({ abi: UNIVERSAL_ROUTER_ABI, errorName: "ExecutionFailed", args: [0n, message] });

  it("decodes the bare error", () => {
    expect(decodeSwapNotFilled(bare)).toEqual({ expected: 947_000n, traded: 602_000n, guard: null });
  });

  it("decodes it out of core's wrapper, and names the guard that refused", () => {
    expect(decodeSwapNotFilled(wrap(bare))).toEqual({ expected: 947_000n, traded: 602_000n, guard: GUARD });
  });

  it("decodes it out of the router's wrapper around core's", () => {
    expect(decodeSwapNotFilled(routed(wrap(bare)))).toEqual({ expected: 947_000n, traded: 602_000n, guard: GUARD });
  });

  it("names the wrapper closest to the error when several are nested", () => {
    expect(decodeSwapNotFilled(wrap(wrap(bare, GUARD), SOMEONE))?.guard).toBe(GUARD);
  });

  it("decodes core's wrapper as core lays it out: the reason padded to a word, the context after it", () => {
    /* `CustomRevert.bubbleUpAndRevertWith` writes the words by hand; this is that layout, not viem's encoder's. */
    const reason = bare.slice(2);
    const padded = reason.padEnd(Math.ceil(reason.length / 64) * 64, "0");
    const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, "0");
    const selector = keccak256(toHex("WrappedError(address,bytes4,bytes,bytes)")).slice(0, 10);
    const data = (selector +
      GUARD.slice(2).padStart(64, "0") +
      AFTER_SWAP.slice(2).padEnd(64, "0") +
      word(0x80) +
      word(0xa0 + padded.length / 2) +
      word(reason.length / 2) +
      padded +
      word(4) +
      "deadbeef".padEnd(64, "0")) as Hex;
    expect(decodeSwapNotFilled(data)).toEqual({ expected: 947_000n, traded: 602_000n, guard: GUARD });
  });

  it("is null for any other error, wrapped or not", () => {
    const other = encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "BuyExceedsMaxPerTx", args: [2n, 1n] });
    expect(decodeSwapNotFilled(other)).toBeNull();
    expect(decodeSwapNotFilled(wrap(other))).toBeNull();
    expect(decodeSwapNotFilled(routed(wrap(other)))).toBeNull();
    expect(decodeSwapNotFilled("0x")).toBeNull();
    expect(decodeSwapNotFilled("0x08c379a0")).toBeNull();
  });

  it("never finds the error by searching: the selector inside some other error's bytes is not a match", () => {
    /* Two uint256 whose encoding happens to CONTAIN SwapNotFilled's full revert data. */
    const smuggled = encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "BuyExceedsMaxPerTx", args: [BigInt(bare.slice(0, 66)), 1n] });
    expect(smuggled.includes(SWAP_NOT_FILLED_SELECTOR.slice(2))).toBe(true);
    expect(decodeSwapNotFilled(smuggled)).toBeNull();
  });

  it("is null for truncated data and for wrappers nested past any a swap produces", () => {
    expect(decodeSwapNotFilled(bare.slice(0, 70) as Hex)).toBeNull();
    let deep = bare;
    for (let i = 0; i < 12; i++) deep = wrap(deep);
    expect(decodeSwapNotFilled(deep)).toBeNull();
  });

  it("is the same error on both guards, under the selector of its signature", () => {
    expect(getAbiItem({ abi: BIN_LAUNCH_GUARD_HOOK_ABI, name: "SwapNotFilled" })).toEqual(getAbiItem({ abi: LAUNCH_GUARD_HOOK_ABI, name: "SwapNotFilled" }));
    expect(SWAP_NOT_FILLED_SELECTOR).toBe(keccak256(toHex("SwapNotFilled(uint256,uint256)")).slice(0, 10));
    expect(bare.startsWith(SWAP_NOT_FILLED_SELECTOR)).toBe(true);
  });

  it("agrees with the sizing helper: `expected` is what the helper says must reach the pool", () => {
    const named = 1_000_000n;
    const { poolAmount } = guardQuoteTake({ amount: named, feePips: 50_000, taxBps: 30, exactInput: true });
    const refused = encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "SwapNotFilled", args: [poolAmount, 602_000n] });
    expect(decodeSwapNotFilled(wrap(refused))?.expected).toBe(947_000n);
    expect(poolAmount).toBe(947_000n);
  });
});

/* ---------------------------------------------------------------- calls --- */

describe("the fee's calls", () => {
  it("feeCreatorIdOf is the pool id read as a number", () => {
    expect(feeCreatorIdOf(POOL)).toBe(0xa1n);
    const high: Hex = `0x${"ff".repeat(32)}`;
    expect(feeCreatorIdOf(high)).toBe((1n << 256n) - 1n);
    expect(toHex(feeCreatorIdOf(POOL), { size: 32 })).toBe(POOL);
    expect(() => feeCreatorIdOf("0xa1")).toThrow(/32-byte pool id/);
    expect(() => feeCreatorIdOf(GUARD)).toThrow(/32-byte pool id/);
  });

  it("encodeSettleFee is settleFee(poolId, currency), by pool ID and not by key", () => {
    const data = encodeSettleFee(POOL, USD);
    expect(decodeFunctionData({ abi: LAUNCH_GUARD_HOOK_ABI, data })).toEqual({ functionName: "settleFee", args: [POOL, USD] });
    expect(data.slice(0, 10)).toBe(keccak256(toHex("settleFee(bytes32,address)")).slice(0, 10));
    expect(data).toBe(`${data.slice(0, 10)}${encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [POOL, USD]).slice(2)}`);
  });

  it("the creator's two calls carry the lockers' signatures, with the pool id as the number", () => {
    const nominate = encodeTransferFeeCreator(POOL, SOMEONE);
    expect(decodeFunctionData({ abi: LAUNCH_GUARD_HOOK_ABI, data: nominate })).toEqual({ functionName: "transferCreator", args: [0xa1n, SOMEONE] });
    expect(nominate.slice(0, 10)).toBe(keccak256(toHex("transferCreator(uint256,address)")).slice(0, 10));
    const accept = encodeAcceptFeeCreator(POOL);
    expect(decodeFunctionData({ abi: LAUNCH_GUARD_HOOK_ABI, data: accept })).toEqual({ functionName: "acceptCreator", args: [0xa1n] });
    expect(accept.slice(0, 10)).toBe(keccak256(toHex("acceptCreator(uint256)")).slice(0, 10));
    /* The Bin guard takes the same bytes. */
    expect(decodeFunctionData({ abi: BIN_LAUNCH_GUARD_HOOK_ABI, data: nominate }).functionName).toBe("transferCreator");
  });
});

/* ------------------------------------------------------- the generated ABI --- */

describe("the generated guard ABIs", () => {
  const names = (abi: readonly { type: string; name?: string }[], type: string): string[] =>
    abi.filter((x) => x.type === type).map((x) => x.name ?? "");

  it.each([
    ["LaunchGuardHook", LAUNCH_GUARD_HOOK_ABI],
    ["BinLaunchGuardHook", BIN_LAUNCH_GUARD_HOOK_ABI],
  ] as const)("%s carries the trade fee's members beside everything the lp-fee guards have", (_, abi) => {
    expect(names(abi, "function")).toEqual(
      expect.arrayContaining(["configureFeeSplit", "getFeeSplit", "feeTaken", "feeSettled", "pendingFee", "settleFee", "transferCreator", "acceptCreator", "pendingCreator", "MIN_FEE_PROTOCOL_BPS"]),
    );
    expect(names(abi, "event")).toEqual(expect.arrayContaining(["FeeSplitConfigured", "FeeTaken", "FeeSettled", "FeeCreatorTransferStarted", "FeeCreatorTransferred"]));
    expect(names(abi, "error")).toEqual(expect.arrayContaining(["FeeSplitAlreadySet", "FeeSplitNotConfigured", "NotFeeCreator", "NotPendingFeeCreator", "SwapNotFilled", "LpShareTooHigh"]));
    /* The liquidity providers' share: what the pool charges a buy and what the guard takes. */
    expect(names(abi, "function")).toEqual(expect.arrayContaining(["feePartsAt", "currentFeeParts", "LP_SHARE_BPS", "MAX_LP_SHARE_BPS"]));
    const parts = getAbiItem({ abi, name: "currentFeeParts" });
    expect(parts.inputs.map((i) => i.type)).toEqual(["bytes32"]);
    expect(parts.outputs.map((o) => [o.name, o.type])).toEqual([
      ["buyLpPips", "uint24"],
      ["buyGuardPips", "uint24"],
      ["sellGuardPips", "uint24"],
    ]);
    expect(getAbiItem({ abi, name: "feePartsAt" }).outputs).toEqual(parts.outputs);
    expect(getAbiItem({ abi, name: "LP_SHARE_BPS" }).outputs.map((o) => o.type)).toEqual(["uint16"]);
    /* What both generations answer, which every reader relies on before it knows the generation. */
    expect(names(abi, "function")).toEqual(
      expect.arrayContaining(["getHooksRegistrationBitmap", "getLaunch", "currentFee", "feeAt", "getTax", "currentTaxRates", "pendingTax", "settleTax", "claimable", "claim", "claimFrom", "redeem", "skim"]),
    );
    expect(names(abi, "event")).toEqual(expect.arrayContaining(["TaxConfigured", "TaxTaken", "TaxSettled", "TaxClaimed"]));
  });

  it("FeeTaken has TaxTaken's shape, so one decoder serves both pots", () => {
    const shape = (name: "FeeTaken" | "TaxTaken") => getAbiItem({ abi: LAUNCH_GUARD_HOOK_ABI, name }).inputs.map((i) => [i.name, i.type, i.indexed]);
    expect(shape("FeeTaken")).toEqual(shape("TaxTaken"));
    expect(shape("FeeTaken")).toEqual([
      ["poolId", "bytes32", true],
      ["currency", "address", true],
      ["isBuy", "bool", false],
      ["amount", "uint256", false],
    ]);
  });
});

/* ------------------------------------------------ constants vs the Solidity --- */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");
const TAX_MODULE_SOL = join(PACKAGES, "hooks", "src", "launch", "LaunchTaxModule.sol");
const CL_GUARD_SOL = join(PACKAGES, "hooks", "src", "launch", "LaunchGuardHook.sol");
const BIN_GUARD_SOL = join(PACKAGES, "hooks", "src", "launch", "BinLaunchGuardHook.sol");
const CUSTOM_REVERT_SOL = join(PACKAGES, "core", "src", "libraries", "CustomRevert.sol");

/* Monorepo-only; the public mirror has no Solidity. See launchpadPrice.test.ts. */
describe.skipIf(![TAX_MODULE_SOL, CL_GUARD_SOL, BIN_GUARD_SOL, CUSTOM_REVERT_SOL].every((p) => existsSync(p)))("constants match the Solidity", () => {
  const num = (src: string, re: RegExp): number => {
    const all = [...src.matchAll(re)];
    if (all.length !== 1) throw new Error(`${re} matched ${all.length} times, expected one declaration`);
    return Number(((all[0] as RegExpMatchArray)[1] as string).replace(/_/g, ""));
  };

  it("the split bounds and the two denominators", () => {
    const src = readFileSync(TAX_MODULE_SOL, "utf8");
    expect(num(src, /uint16 public constant MIN_FEE_PROTOCOL_BPS = ([\d_]+);/g)).toBe(LAUNCH_FEE_SPLIT_LIMITS.MIN_FEE_PROTOCOL_BPS);
    expect(num(src, /uint16 public constant MAX_PROTOCOL_BPS = ([\d_]+);/g)).toBe(LAUNCH_FEE_SPLIT_LIMITS.MAX_PROTOCOL_BPS);
    expect(num(src, /uint16 public constant MAX_INTEGRATOR_BPS = ([\d_]+);/g)).toBe(LAUNCH_FEE_SPLIT_LIMITS.MAX_INTEGRATOR_BPS);
    expect(num(src, /uint256 internal constant FEE_PIPS = ([\d_]+);/g)).toBe(GUARD_FEE_PIPS_DENOMINATOR);
    expect(num(src, /uint16 public constant BPS = ([\d_]+);/g)).toBe(10_000);
    /* The tax keeps its own floor, below the fee's. */
    expect(num(src, /uint16 public constant MIN_PROTOCOL_BPS = ([\d_]+);/g)).toBe(LAUNCH_TAX_LIMITS.MIN_PROTOCOL_BPS);
    expect(LAUNCH_TAX_LIMITS.MIN_PROTOCOL_BPS).toBeLessThan(LAUNCH_FEE_SPLIT_LIMITS.MIN_FEE_PROTOCOL_BPS);
  });

  it("the cap on the liquidity providers' share, and the arithmetic that divides a buy's fee", () => {
    const src = readFileSync(TAX_MODULE_SOL, "utf8");
    expect(num(src, /uint16 public constant MAX_LP_SHARE_BPS = ([\d_]+);/g)).toBe(GUARD_LP_SHARE_LIMITS.MAX_LP_SHARE_BPS);
    /* `guardFeeParts` is these three statements: a sell pays the pool nothing, a buy's pool part is floored, the guard takes the rest. */
    expect(src).toContain("if (!isBuy) return (0, feePips);");
    expect(src).toContain("lpPips = uint24((uint256(feePips) * LP_SHARE_BPS) / BPS);");
    expect(src).toContain("guardPips = feePips - lpPips;");
    /* And the share is one immutable per guard, not a per-pool setting. */
    expect(/uint16 public immutable LP_SHARE_BPS;/.test(src)).toBe(true);
  });

  it("the guards in this tree register a bitmap the SDK knows, each of its own pool type", () => {
    /* The guards state the value they return beside the flags they OR together. */
    const stated = (path: string): number => num(readFileSync(path, "utf8"), /\/\/\/[^\n]*== (0x[0-9A-Fa-f]{4})\.\s*\n\s*function getHooksRegistrationBitmap\(\)/g);
    const cl = stated(CL_GUARD_SOL);
    const bin = stated(BIN_GUARD_SOL);
    expect(guardGenerationOf(cl, "CL")).not.toBe("unknown");
    expect(guardGenerationOf(bin, "Bin")).toBe(guardGenerationOf(cl, "CL"));
  });

  it("core wraps a hook's revert in the error this SDK unwraps", () => {
    const src = readFileSync(CUSTOM_REVERT_SOL, "utf8");
    expect(/error WrappedError\(address target, bytes4 selector, bytes reason, bytes details\);/.test(src)).toBe(true);
    expect(WRAPPED_ERROR_ABI[0].inputs.map((i) => `${i.type} ${i.name}`)).toEqual(["address target", "bytes4 selector", "bytes reason", "bytes details"]);
  });
});
