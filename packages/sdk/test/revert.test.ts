/* A contract that refused is told from an endpoint that did not answer (src/chains/revert.ts). */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, ExecutionRevertedError, HttpRequestError, TimeoutError } from "viem";
import { describe, expect, it } from "vitest";

import { isRevertError } from "../src/chains/revert.js";

/** An error shaped like another copy of viem would raise it: the right name, a foreign class. */
class ForeignError extends Error {
  constructor(
    name: string,
    override readonly cause?: unknown,
  ) {
    super(name);
    this.name = name;
  }
}

const abi = [{ type: "function", name: "f", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;

describe("isRevertError", () => {
  it("knows this copy's own revert classes", () => {
    expect(isRevertError(new ExecutionRevertedError({ message: "nope" }))).toBe(true);
    expect(isRevertError(new ContractFunctionRevertedError({ abi, functionName: "f", message: "nope" }))).toBe(true);
  });

  it("finds a revert under the errors that wrap it", () => {
    const wrapped = new BaseError("read failed", { cause: new BaseError("call failed", { cause: new ExecutionRevertedError({ message: "x" }) }) });
    expect(isRevertError(wrapped)).toBe(true);
  });

  it("knows a revert raised by another copy of the library, by its name", () => {
    expect(isRevertError(new ForeignError("ContractFunctionRevertedError"))).toBe(true);
    expect(isRevertError(new ForeignError("ContractFunctionExecutionError", new ForeignError("ExecutionRevertedError")))).toBe(true);
  });

  it("counts a call that returned no data only when asked to", () => {
    const own = new ContractFunctionZeroDataError({ functionName: "f" });
    const foreign = new ForeignError("ContractFunctionZeroDataError");
    expect(isRevertError(own)).toBe(false);
    expect(isRevertError(foreign)).toBe(false);
    expect(isRevertError(own, { zeroData: true })).toBe(true);
    expect(isRevertError(foreign, { zeroData: true })).toBe(true);
  });

  it("never reads a transport failure as a revert", () => {
    expect(isRevertError(new HttpRequestError({ url: "https://rpc.invalid", status: 429 }))).toBe(false);
    expect(isRevertError(new TimeoutError({ body: {}, url: "https://rpc.invalid" }))).toBe(false);
    expect(isRevertError(new ForeignError("HttpRequestError"), { zeroData: true })).toBe(false);
    expect(isRevertError(new BaseError("read failed", { cause: new ForeignError("TimeoutError") }), { zeroData: true })).toBe(false);
  });

  it("is false for what is not an error", () => {
    for (const x of [null, undefined, "ExecutionRevertedError", 7, {}]) expect(isRevertError(x, { zeroData: true })).toBe(false);
  });

  it("stops on a chain of causes that loops", () => {
    const a = new ForeignError("A") as ForeignError & { cause?: unknown };
    const b = new ForeignError("B", a);
    (a as { cause?: unknown }).cause = b;
    expect(isRevertError(a)).toBe(false);
  });
});
