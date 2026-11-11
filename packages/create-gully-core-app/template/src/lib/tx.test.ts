// SPDX-License-Identifier: MIT
import { GULLYCORE_MERKLE_DROP_ABI } from "@gullylabs/core-sdk/drop";
import { GULLYCORE_TOKEN_LOCK_ABI } from "@gullylabs/core-sdk/lock";
import { encodeErrorResult, UserRejectedRequestError, type Abi } from "viem";
import { describe, expect, it } from "vitest";

import { decodeRevert, describeError, revertDataOf } from "./tx";

const ABIS: readonly Abi[] = [GULLYCORE_TOKEN_LOCK_ABI as Abi, GULLYCORE_MERKLE_DROP_ABI as Abi];

const insufficientFee = encodeErrorResult({ abi: GULLYCORE_TOKEN_LOCK_ABI, errorName: "InsufficientFee", args: [100n, 50n] });
const invalidProof = encodeErrorResult({ abi: GULLYCORE_MERKLE_DROP_ABI, errorName: "InvalidProof" });

describe("revertDataOf", () => {
  it("finds revert bytes however deep viem nested them", () => {
    const err = { message: "a", cause: { message: "b", cause: { data: insufficientFee } } };
    expect(revertDataOf(err)).toBe(insufficientFee);
    expect(revertDataOf({ cause: { data: { data: invalidProof } } })).toBe(invalidProof);
    expect(revertDataOf({ raw: invalidProof })).toBe(invalidProof);
  });

  it("returns null when there is none", () => {
    expect(revertDataOf(new Error("timeout"))).toBeNull();
    expect(revertDataOf({ data: "0x" })).toBeNull();
    expect(revertDataOf(null)).toBeNull();
  });
});

describe("decodeRevert", () => {
  it("names a utility contract's custom error, with its arguments and a hint", () => {
    const d = decodeRevert(insufficientFee, ABIS);
    expect(d?.name).toBe("InsufficientFee");
    expect(d?.text).toBe("InsufficientFee(100, 50)");
    expect(d?.hint).toMatch(/fee rose/);
  });

  it("finds the error in whichever ABI declares it", () => {
    expect(decodeRevert(invalidProof, ABIS)?.name).toBe("InvalidProof");
  });

  it("decodes a plain Error(string) with no ABI", () => {
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["nope"],
    });
    expect(decodeRevert(data, [])?.text).toBe("nope");
  });

  it("returns null for bytes no ABI knows", () => {
    expect(decodeRevert("0xdeadbeef", ABIS)).toBeNull();
  });
});

describe("describeError", () => {
  it("says a rejection is a rejection", () => {
    expect(describeError(new UserRejectedRequestError(new Error("user said no")))).toMatch(/rejected/);
  });

  it("decodes a revert into one sentence", () => {
    expect(describeError({ cause: { data: invalidProof } }, ABIS)).toMatch(/InvalidProof\(\).*claims file/);
  });

  it("admits an undecodable revert rather than guessing", () => {
    expect(describeError({ cause: { data: "0xdeadbeef00" } }, ABIS)).toMatch(/cannot decode \(0xdeadbeef\)/);
  });

  it("falls back to the message", () => {
    expect(describeError(new Error("the RPC timed out"))).toBe("the RPC timed out");
  });
});
