import { describe, expect, it, vi } from "vitest";

import { judgeEndpoint, judgeSpread, redactUrl, termsDrift, type EndpointReport } from "../src/commands/doctor.js";
import { Output, failureEnvelope, successEnvelope, toJson } from "../src/lib/output.js";

const base: EndpointReport = {
  url: "https://rpc.example/abc",
  ok: true,
  chainId: 4663,
  latencyMs: 40,
  rpcBlock: 100n,
  headerTimestamp: 1_000n,
  contractNumber: 100n,
  contractTimestamp: 1_000n,
  error: null,
};

describe("doctor: contract clock", () => {
  it("fails an endpoint whose NUMBER equals eth_blockNumber on a parent-l1 chain", () => {
    const checks = judgeEndpoint(base, 4663, "parent-l1");
    const clock = checks.find((c) => c.group === "clock");
    expect(clock?.status).toBe("fail");
    expect(clock?.detail).toMatch(/EQUAL/);
  });

  it("passes the parent-l1 clock when NUMBER differs", () => {
    const checks = judgeEndpoint({ ...base, contractNumber: 25_000_000n }, 4663, "parent-l1");
    expect(checks.find((c) => c.group === "clock")?.status).toBe("ok");
  });

  it("fails a native chain whose NUMBER differs, and flags a timestamp skew", () => {
    const checks = judgeEndpoint({ ...base, chainId: 8453, contractNumber: 90n, contractTimestamp: 1_300n }, 8453, "native");
    expect(checks.filter((c) => c.status === "fail")).toHaveLength(1);
    expect(checks.find((c) => c.status === "warn")?.detail).toMatch(/300 s/);
  });

  it("reports a wrong chain id and an unreachable endpoint", () => {
    expect(judgeEndpoint({ ...base, chainId: 1 }, 4663, "parent-l1")[0]?.status).toBe("fail");
    expect(judgeEndpoint({ ...base, ok: false, error: "timeout" }, 4663, "parent-l1")[0]?.detail).toMatch(/unreachable/);
  });

  it("warns when endpoints disagree by more than a minute", () => {
    expect(judgeSpread([base, { ...base, headerTimestamp: 1_200n }])?.status).toBe("warn");
    expect(judgeSpread([base, { ...base, headerTimestamp: 1_010n }])?.status).toBe("ok");
  });

  it("redacts keyed RPC URLs", () => {
    expect(redactUrl("https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789")).toBe("https://eth-mainnet.g.alchemy.com/v2/***");
    expect(redactUrl("https://rpc.example/?apikey=secret")).toBe("https://rpc.example/?***");
  });
});

describe("doctor: terms drift", () => {
  const t = {
    integrator: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
    integratorBps: 1000,
    integratorLaunchFeeWei: 0n,
    allowedPresets: ["FairLaunch", "NoTax"] as const,
    allowedBinShapes: ["Linear"] as const,
    restrictQuotes: false,
    active: true,
    maxTaxBps: 1000,
    taxIntegratorBps: 0,
  };
  it("is empty when equal (address case and list order ignored)", () => {
    expect(termsDrift({ ...t, allowedPresets: [...t.allowedPresets] , allowedBinShapes: [...t.allowedBinShapes] }, { ...t, integrator: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", allowedPresets: ["NoTax", "FairLaunch"], allowedBinShapes: ["Linear"] })).toEqual([]);
  });
  it("names each drifted field", () => {
    const d = termsDrift({ ...t, allowedPresets: [...t.allowedPresets], allowedBinShapes: [...t.allowedBinShapes] }, { ...t, allowedPresets: [...t.allowedPresets], allowedBinShapes: [...t.allowedBinShapes], integratorBps: 500, integratorLaunchFeeWei: 5n });
    expect(d.map((x) => x.split(":")[0])).toEqual(["integratorBps", "integratorLaunchFeeWei"]);
  });
});

describe("--json envelope (schema gullycore.cli/1)", () => {
  it("stringifies bigints and drops undefined", () => {
    expect(toJson({ a: 1n, b: undefined, c: [2n, "x"], d: null })).toEqual({ a: "1", c: ["2", "x"], d: null });
  });

  it("has a stable success and failure shape", () => {
    const ok = successEnvelope("launch", { chainId: 4663, tx: { value: 5n } });
    expect(ok).toEqual({ schema: "gullycore.cli/1", command: "launch", ok: true, chainId: 4663, tx: { value: "5" } });
    expect(failureEnvelope("launch", "boom", null)).toEqual({ schema: "gullycore.cli/1", command: "launch", ok: false, error: { message: "boom", hint: null, exitCode: 1 } });
  });

  it("keeps stdout to one document: human lines go to stderr in --json mode", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => (stdout.push(String(c)), true));
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => (stderr.push(String(c)), true));
    try {
      const out = new Output(true);
      out.line("progress");
      out.rows([["a", "b"]]);
      out.result("x", { n: 1n });
      expect(() => out.result("x", {})).toThrow(/two JSON documents/);
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    expect(JSON.parse(stdout.join(""))).toEqual({ schema: "gullycore.cli/1", command: "x", ok: true, n: "1" });
    expect(stderr.join("")).toContain("progress");
  });
});
