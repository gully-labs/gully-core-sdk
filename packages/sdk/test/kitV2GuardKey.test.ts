// SPDX-License-Identifier: MIT
/**
 * The generation of a launch guard from a pool KEY (`guardGenerationOfKey`): no
 * read, only the bitmap the key carries. Keys are built with the SDK's own
 * parameter encoders, so a fixture cannot drift from the layout core uses.
 */

import { encodeErrorResult, getAbiItem, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  BIN_QUOTER_ABI,
  CL_QUOTER_ABI,
  LAUNCH_GUARD_BITMAPS,
  LAUNCH_GUARD_HOOK_ABI,
  UNEXPECTED_REVERT_BYTES_ABI,
  UNIVERSAL_ROUTER_ABI,
  WRAPPED_ERROR_ABI,
  decodeSwapNotFilled,
  launchSplitBounds,
  encodeBinPoolParameters,
  encodeCLPoolParameters,
  guardGenerationOfKey,
} from "../src/index.js";

const cl = (bitmap: number, tickSpacing = 60) => ({ parameters: encodeCLPoolParameters(bitmap, tickSpacing) });
const bin = (bitmap: number, binStep = 25) => ({ parameters: encodeBinPoolParameters(bitmap, binStep) });

describe("guardGenerationOfKey", () => {
  it("reads both generations off a CL key, whatever the tick spacing", () => {
    expect(guardGenerationOfKey(cl(LAUNCH_GUARD_BITMAPS["lp-fee"].CL), "CL")).toBe("lp-fee");
    expect(guardGenerationOfKey(cl(LAUNCH_GUARD_BITMAPS["quote-fee"].CL), "CL")).toBe("quote-fee");
    expect(guardGenerationOfKey(cl(LAUNCH_GUARD_BITMAPS["quote-fee"].CL, 1), "CL")).toBe("quote-fee");
    expect(guardGenerationOfKey(cl(LAUNCH_GUARD_BITMAPS["quote-fee"].CL, 200), "CL")).toBe("quote-fee");
  });

  it("reads both generations off a Bin key, whatever the bin step", () => {
    expect(guardGenerationOfKey(bin(LAUNCH_GUARD_BITMAPS["lp-fee"].Bin), "Bin")).toBe("lp-fee");
    expect(guardGenerationOfKey(bin(LAUNCH_GUARD_BITMAPS["quote-fee"].Bin), "Bin")).toBe("quote-fee");
    expect(guardGenerationOfKey(bin(LAUNCH_GUARD_BITMAPS["quote-fee"].Bin, 1), "Bin")).toBe("quote-fee");
  });

  it("is unknown for a bitmap that is no launch guard's", () => {
    expect(guardGenerationOfKey(cl(0), "CL")).toBe("unknown");
    // Bit 10 alone: any hook that returns a delta from beforeSwap.
    expect(guardGenerationOfKey(cl(0x0400), "CL")).toBe("unknown");
    expect(guardGenerationOfKey(cl(0x0cc3), "CL")).toBe("unknown");
  });

  it("is unknown for the other pool type's bitmap", () => {
    expect(guardGenerationOfKey(cl(LAUNCH_GUARD_BITMAPS["quote-fee"].Bin), "CL")).toBe("unknown");
    expect(guardGenerationOfKey(bin(LAUNCH_GUARD_BITMAPS["quote-fee"].CL), "Bin")).toBe("unknown");
  });

  it("is unknown, not a throw, for parameters that do not decode", () => {
    // Bits above the layout's last used one are set: core would never have produced this word.
    const junk = { parameters: `0x${"ff".repeat(32)}` as const };
    expect(guardGenerationOfKey(junk, "CL")).toBe("unknown");
    expect(guardGenerationOfKey(junk, "Bin")).toBe("unknown");
  });
});

/* ------------------------------------------------ a refused QUOTE --- */

/** Made up. Checksummed, as a decoded address is. */
const GUARD = getAddress("0x00000000000000000000000000000000000c0cc1");
const bare = (expected: bigint, traded: bigint): Hex => encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "SwapNotFilled", args: [expected, traded] });
const wrapped = (reason: Hex): Hex => encodeErrorResult({ abi: WRAPPED_ERROR_ABI, errorName: "WrappedError", args: [GUARD, "0x12345678", reason, "0x"] });

describe("decodeSwapNotFilled: through a quoter", () => {
  it("the wrapper declared here is the one both generated quoter ABIs carry", () => {
    const mine = UNEXPECTED_REVERT_BYTES_ABI[0];
    for (const abi of [CL_QUOTER_ABI, BIN_QUOTER_ABI]) {
      const theirs = getAbiItem({ abi, name: "UnexpectedRevertBytes" }) as { type: string; name: string; inputs: readonly { type: string }[] };
      expect(theirs.type).toBe("error");
      expect(theirs.inputs.map((i) => i.type)).toEqual(mine.inputs.map((i) => i.type));
    }
  });

  it("reads the refusal out of a quote that failed: quoter, around core, around the guard", () => {
    const data = encodeErrorResult({ abi: CL_QUOTER_ABI, errorName: "UnexpectedRevertBytes", args: [wrapped(bare(947n, 600n))] });
    expect(decodeSwapNotFilled(data)).toEqual({ expected: 947n, traded: 600n, guard: GUARD });
  });

  it("and with nothing of core's around it", () => {
    const data = encodeErrorResult({ abi: UNEXPECTED_REVERT_BYTES_ABI, errorName: "UnexpectedRevertBytes", args: [bare(10n, 3n)] });
    expect(decodeSwapNotFilled(data)).toEqual({ expected: 10n, traded: 3n, guard: null });
  });

  it("still reads a refused SWAP: the router, around core, around the guard", () => {
    const data = encodeErrorResult({ abi: UNIVERSAL_ROUTER_ABI, errorName: "ExecutionFailed", args: [0n, wrapped(bare(947n, 600n))] });
    expect(decodeSwapNotFilled(data)).toEqual({ expected: 947n, traded: 600n, guard: GUARD });
  });

  it("is null for a quoter that met any other revert, and never searches the bytes for the selector", () => {
    const other = encodeErrorResult({ abi: LAUNCH_GUARD_HOOK_ABI, errorName: "TradingNotOpen", args: [`0x${"11".repeat(32)}`, 5n, 4n] });
    expect(decodeSwapNotFilled(encodeErrorResult({ abi: CL_QUOTER_ABI, errorName: "UnexpectedRevertBytes", args: [wrapped(other)] }))).toBeNull();
    /* The refusal's own bytes sit inside this payload, behind a selector nothing here names. */
    const hidden = `0xdeadbeef${bare(947n, 600n).slice(2)}` as Hex;
    expect(decodeSwapNotFilled(encodeErrorResult({ abi: CL_QUOTER_ABI, errorName: "UnexpectedRevertBytes", args: [hidden] }))).toBeNull();
  });
});

describe("launchSplitBounds", () => {
  const locker = { minProtocolBps: 1_000, maxProtocolBps: 6_000, maxIntegratorBps: 3_000 };
  const guard = { minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 };

  it("is the locker's bounds where the launch contract keeps no fee split", () => {
    expect(launchSplitBounds({ locker, feeSplit: null })).toEqual(locker);
  });

  it("is the tighter figure of each pair where it does", () => {
    expect(launchSplitBounds({ locker, feeSplit: guard })).toEqual({ minProtocolBps: 2_000, maxProtocolBps: 5_000, maxIntegratorBps: 2_000 });
    /* The locker can be the tighter one too, on every figure. */
    const tight = { minProtocolBps: 3_000, maxProtocolBps: 4_000, maxIntegratorBps: 1_000 };
    expect(launchSplitBounds({ locker: tight, feeSplit: guard })).toEqual(tight);
  });
});

