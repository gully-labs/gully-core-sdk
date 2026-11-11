// SPDX-License-Identifier: MIT
/**
 * The two quoters share one parameter struct and differ only by address and
 * ABI constant. These pin that the Bin helper encodes the same call the CL
 * helper does, direction included, so a widget can pick the quoter by pool
 * type and nothing else.
 */
import { encodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  BIN_QUOTER_ABI,
  CL_QUOTER_ABI,
  quoteBinExactInputSingle,
  quoteExactInputSingle,
  quoterAbiFor,
  type PoolKey,
} from "../src/index.js";

const A: Address = "0x0000000000000000000000000000000000000001";
const B: Address = "0x0000000000000000000000000000000000000002";
const QUOTER: Address = "0x00000000000000000000000000000000000000aa";
const key: PoolKey = {
  currency0: A,
  currency1: B,
  hooks: "0x0000000000000000000000000000000000000000",
  poolManager: "0x00000000000000000000000000000000000000bb",
  fee: 0x800000,
  parameters: "0x0000000000000000000000000000000000000000000000000000000000640045",
};

describe("Bin quoter", () => {
  it("carries the same single-hop functions as the CL quoter", () => {
    const names = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((x) => x.type === "function").map((x) => x.name).sort();
    for (const fn of ["quoteExactInputSingle", "quoteExactOutputSingle", "quoteExactInput", "quoteExactOutput"]) {
      expect(names(BIN_QUOTER_ABI)).toContain(fn);
      expect(names(CL_QUOTER_ABI)).toContain(fn);
    }
    expect(quoterAbiFor("BIN")).toBe(BIN_QUOTER_ABI);
    expect(quoterAbiFor("CL")).toBe(CL_QUOTER_ABI);
  });

  it("encodes byte-identical calldata to the CL helper for the same hop", () => {
    const cl = quoteExactInputSingle({ quoter: QUOTER, poolKey: key, tokenIn: B, amountIn: 123n });
    const bin = quoteBinExactInputSingle({ quoter: QUOTER, poolKey: key, tokenIn: B, amountIn: 123n });
    expect(bin.args[0].zeroForOne).toBe(false);
    expect(encodeFunctionData(bin)).toBe(encodeFunctionData(cl));
  });

  it("refuses a token that is not in the pool", () => {
    expect(() => quoteBinExactInputSingle({ quoter: QUOTER, poolKey: key, tokenIn: QUOTER, amountIn: 1n })).toThrow(/not in this pool/);
  });
});
