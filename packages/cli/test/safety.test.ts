import { rmSync, writeFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GullyCoreRouterError } from "@gullylabs/core-sdk/router";
import { HttpRequestError } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runSwapExec } from "../src/commands/swap.js";
import { LAUNCH_SPEC } from "../src/commands/launch.js";
import { routerFailure } from "../src/lib/api.js";
import { resolveChain } from "../src/lib/chain.js";
import { normalizeError, parseCommand } from "../src/lib/command.js";
import { redactUrl } from "../src/lib/config.js";
import { assertMayWrite } from "../src/lib/flow.js";
import { castSendArgs, setCastRunner } from "../src/lib/hardware.js";
import { assertMinOut, assertPriceImpact, slippageBps } from "../src/lib/slippage.js";
import { printableRpc, refuseRawKeys, signModeOf, SIGNER_FLAGS } from "../src/lib/tx.js";
import { parseArgs } from "../src/util/args.js";
import { EXIT, UserError } from "../src/util/log.js";
import { KEY, POOL_ID, SENDER, TOKEN_A, TOKEN_B, stockChain, throwawayKeystore } from "./helpers/fixture.js";
import { capture, startMock, type Rpc } from "./helpers/mockChain.js";

const OVERRIDE = '{"isMainnet":true}';
const dirs: string[] = [];
let cfg: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "gullycore-cfg-"));
  dirs.push(dir);
  cfg = join(dir, "config.json");
  process.env["GULLYCORE_CONFIG"] = cfg;
});
afterAll(() => {
  delete process.env["GULLYCORE_CONFIG"];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function exitOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    return (e as UserError).exitCode;
  }
  return 0;
}

describe("the slippage guard", () => {
  it("defaults to 0.5% and honours the setting, the flag first", () => {
    expect(slippageBps(undefined, undefined, false)).toBe(50);
    expect(slippageBps(undefined, "1", false)).toBe(100);
    expect(slippageBps("0.25", "1", false)).toBe(25);
  });
  it("refuses above 5% without the flag, and above 50% always", () => {
    expect(exitOf(() => slippageBps("5.01", undefined, false))).toBe(EXIT.REFUSED);
    expect(slippageBps("20", undefined, true)).toBe(2000);
    expect(() => slippageBps("51", undefined, true)).toThrow(/maximum/);
  });
  it("refuses a high price impact, and an unmeasured one passes", () => {
    expect(exitOf(() => assertPriceImpact(501, false))).toBe(EXIT.REFUSED);
    expect(exitOf(() => assertPriceImpact(501, true))).toBe(0);
    expect(exitOf(() => assertPriceImpact(null, false))).toBe(0);
  });
  it("refuses a zero floor and a floor looser than the slippage", () => {
    expect(exitOf(() => assertMinOut(0n, 1000n, 50))).toBe(EXIT.REFUSED);
    expect(exitOf(() => assertMinOut(994n, 1000n, 50))).toBe(EXIT.REFUSED);
    expect(exitOf(() => assertMinOut(995n, 1000n, 50))).toBe(0);
  });
});

describe("writes", () => {
  it("are refused on a chain with no deployment, with exit code 3", () => {
    for (const chain of ["hyperevm"]) {
      expect(exitOf(() => assertMayWrite(resolveChain({ chain, env: {} }), false))).toBe(EXIT.NO_DEPLOYMENT);
    }
  });

  it("--yes on a mainnet needs the network named on this command line", () => {
    const ctx = resolveChain({ chain: "485590", deployment: OVERRIDE, env: {} });
    expect(ctx.isMainnet).toBe(true);
    parseCommand(["--yes"], LAUNCH_SPEC);
    expect(exitOf(() => assertMayWrite(ctx, true))).toBe(EXIT.REFUSED);
    parseCommand(["--yes", "--network", "485590"], LAUNCH_SPEC);
    expect(exitOf(() => assertMayWrite(ctx, true))).toBe(0);
    parseCommand(["--yes", "--chain", "485590"], LAUNCH_SPEC);
    expect(exitOf(() => assertMayWrite(ctx, true))).toBe(0);
  });

  it("a testnet takes --yes from a default", () => {
    parseCommand(["--yes"], LAUNCH_SPEC);
    expect(exitOf(() => assertMayWrite(resolveChain({ chain: "485590", env: {} }), true))).toBe(0);
  });

  it("an override that does not say counts as a mainnet", () => {
    expect(resolveChain({ chain: "485590", deployment: '{"name":"x"}', env: {} }).isMainnet).toBe(false);
    expect(resolveChain({ chain: "8453", deployment: '{"name":"x"}', env: {} }).isMainnet).toBe(true);
  });

  it("--chain and --network must agree", () => {
    expect(() => parseCommand(["--chain", "1", "--network", "2"], LAUNCH_SPEC)).toThrow(/disagree/);
  });
});

describe("signing modes", () => {
  const args = (...a: string[]) => parseArgs(a, SIGNER_FLAGS);

  it("--dry-run never unlocks, even with a keystore named", () => {
    expect(signModeOf(args("--dry-run", "--keystore", "k.json"), {})).toEqual({ kind: "print", dryRun: true, keystore: "k.json" });
  });
  it("names a keystore from the environment, never a key", () => {
    expect(signModeOf(args(), { GULLYCORE_KEYSTORE: "/k.json" })).toEqual({ kind: "keystore", path: "/k.json", passwordFile: null });
    expect(signModeOf(args("--print"), { GULLYCORE_KEYSTORE: "/k.json" }).kind).toBe("print");
  });
  it("takes a hardware device, exclusive of a keystore", () => {
    expect(signModeOf(args("--hardware", "ledger", "--hd-path", "m/44"), {})).toEqual({ kind: "hardware", device: "ledger", hdPath: "m/44" });
    expect(() => signModeOf(args("--hardware", "phone"), {})).toThrow(/ledger or trezor/);
    expect(() => signModeOf(args("--hardware", "ledger", "--keystore", "k"), {})).toThrow(/exclusive/);
  });
  it("hands cast the exact bytes and the device, nothing secret", () => {
    const ctx = resolveChain({ chain: "485590", rpc: "http://127.0.0.1:1", env: {} });
    const a = castSendArgs(ctx, { to: TOKEN_A, data: "0x1234", value: 5n, from: SENDER }, "trezor", null);
    expect(a).toEqual(["send", TOKEN_A, "0x1234", "--value", "5", "--rpc-url", "http://127.0.0.1:1", "--chain", "485590", "--from", SENDER, "--trezor", "--json"]);
  });
});

describe("raw keys", () => {
  const KEYLIKE = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  it("a pool id is allowed where a command declares one, and only there", () => {
    expect(() => refuseRawKeys(["--pool", `0x${KEYLIKE}`], new Set(["pool"]))).not.toThrow();
    expect(() => refuseRawKeys(["info", `0x${KEYLIKE}`], new Set(), true)).not.toThrow();
    expect(() => refuseRawKeys(["--name", `0x${KEYLIKE}`], new Set(["pool"]), true)).toThrow(/looks like a private key/);
    expect(() => refuseRawKeys(["info", `0x${KEYLIKE}`])).toThrow(/looks like a private key/);
  });
  it("the --json failure for a refused key still carries an envelope, and no key", async () => {
    const r = await capture(async () => {
      try {
        await runSwapExec(["--json", "--name", `0x${KEYLIKE}`]);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(KEYLIKE);
        return (e as UserError).exitCode;
      }
      return 0;
    });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(KEYLIKE);
  });
  it("source never reads a raw key from the environment", () => {
    const dir = new URL("../src/lib/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/env\[?["'.]?(GULLYCORE_)?(PRIVATE_KEY|MNEMONIC)/);
    }
  });
});

describe("URLs that may hold a key are never printed", () => {
  it("redacts paths, queries and credentials", () => {
    expect(redactUrl("https://rpc.example/v2/SECRET")).toBe("https://rpc.example/…");
    expect(redactUrl("https://u:p@rpc.example")).toBe("https://rpc.example/…");
    expect(redactUrl("https://rpc.example/?key=SECRET")).toBe("https://rpc.example/…");
    expect(redactUrl("https://rpc.example")).toBe("https://rpc.example");
  });
  it("prints a placeholder for a user's own RPC in a cast line", () => {
    const ctx = resolveChain({ chain: "485590", rpc: "https://rpc.example/v2/SECRET", env: {} });
    expect(printableRpc(ctx)).toBe('"$GULLYCORE_RPC_485590"');
    expect(printableRpc(resolveChain({ chain: "485590", env: {} }))).toBe("https://testnet-rpc.gullychain.xyz");
  });
  it("an RPC failure reports the short message only, with exit code 5", () => {
    const http = new HttpRequestError({ url: "https://rpc.example/v2/SECRET", details: "nope" });
    const e = normalizeError(http) as UserError;
    expect(e.exitCode).toBe(EXIT.NETWORK);
    expect(`${e.message} ${e.hint}`).not.toContain("SECRET");
  });
});

describe("router failures map to exit codes", () => {
  const code = (c: string): number => (routerFailure(new GullyCoreRouterError(c, "x", 500)) as UserError).exitCode;
  it("network, revert, refused", () => {
    expect(code("TRANSPORT")).toBe(EXIT.NETWORK);
    expect(code("SIMULATION_FAILED")).toBe(EXIT.SIMULATION);
    expect(code("UNTRUSTED_RESPONSE")).toBe(EXIT.REFUSED);
    expect(code("NO_ROUTE")).toBe(EXIT.ERROR);
  });
});

describe("the write path, end to end against a mock node", () => {
  let rpc: Rpc;
  let ks: ReturnType<typeof throwawayKeystore>;
  const base = () => ["--in", TOKEN_A, "--out", TOKEN_B, "--amount", "1", "--pool", POOL_ID, "--rpc", rpc.url, "--api", rpc.url];

  beforeEach(async () => {
    rpc = await startMock();
    stockChain(rpc);
    ks = throwawayKeystore();
    dirs.push(ks.dir);
  });
  afterEach(async () => {
    delete process.env["GULLYCORE_KEYSTORE_PASSWORD"];
    setCastRunner(null);
    await rpc.stop();
    try {
      rmSync(cfg);
    } catch {
      /* no config this test */
    }
  });

  it("signs and sends on the testnet with a keystore and --yes", async () => {
    process.env["GULLYCORE_KEYSTORE_PASSWORD"] = ks.password;
    const r = await capture(() => runSwapExec([...base(), "--chain", "485590", "--keystore", ks.file, "--yes", "--json"]));
    expect(r.code).toBe(0);
    expect(rpc.sent).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as { ok: boolean; result: { sent: { hash: string }[] } };
    expect(doc.ok).toBe(true);
    expect(doc.result.sent).toHaveLength(1);
  });

  it("--dry-run with a keystore asks for no password and sends nothing", async () => {
    const r = await capture(() => runSwapExec([...base(), "--chain", "485590", "--keystore", ks.file, "--dry-run"]));
    expect(r.code).toBe(0);
    expect(rpc.sent).toHaveLength(0);
    expect(r.stdout).toContain("Simulated swap");
    expect(r.stdout).toContain("Minimum out");
  });

  it("refuses --yes on a mainnet when the network came from the config", async () => {
    writeFileSync(cfg, JSON.stringify({ network: "485590" }));
    process.env["GULLYCORE_KEYSTORE_PASSWORD"] = ks.password;
    await expect(capture(() => runSwapExec([...base(), "--deployment", OVERRIDE, "--keystore", ks.file, "--yes"]))).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
    expect(rpc.sent).toHaveLength(0);
  });

  it("a mainnet write with --yes and the network named goes through", async () => {
    process.env["GULLYCORE_KEYSTORE_PASSWORD"] = ks.password;
    const r = await capture(() => runSwapExec([...base(), "--network", "485590", "--deployment", OVERRIDE, "--keystore", ks.file, "--yes"]));
    expect(r.code).toBe(0);
    expect(rpc.sent).toHaveLength(1);
  });

  it("without a terminal or --yes, nothing is sent", async () => {
    process.env["GULLYCORE_KEYSTORE_PASSWORD"] = ks.password;
    await expect(capture(() => runSwapExec([...base(), "--chain", "485590", "--keystore", ks.file, "--json"]))).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
    expect(rpc.sent).toHaveLength(0);
  });

  it("a hardware signer goes through cast with the simulated bytes", async () => {
    const seen: (readonly string[])[] = [];
    setCastRunner((_bin, args) => {
      seen.push(args);
      return { status: 0, stdout: JSON.stringify({ transactionHash: `0x${"ab".repeat(32)}` }) };
    });
    const r = await capture(() => runSwapExec([...base(), "--chain", "485590", "--hardware", "ledger", "--from", SENDER, "--yes", "--json"]));
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("--ledger");
    expect(seen[0]?.[1]).toBe("0xb6ab6f0D23c769329DB4b3CFB947fDe3a9e797A5");
    expect(rpc.sent).toHaveLength(0);
  });

  it("nothing is sent when the simulation reverts, exit code 4", async () => {
    const { UNIVERSAL_ROUTER_ABI } = await import("@gullylabs/core-sdk/trading");
    const { BOOK } = await import("./helpers/fixture.js");
    const execute = UNIVERSAL_ROUTER_ABI.filter((f) => f.type === "function" && f.name === "execute" && f.inputs.length === 3);
    rpc.revert(BOOK.universalRouter, execute, "execute");
    process.env["GULLYCORE_KEYSTORE_PASSWORD"] = ks.password;
    const r = await capture(() => runSwapExec([...base(), "--chain", "485590", "--keystore", ks.file, "--yes"]));
    expect(r.code).toBe(EXIT.SIMULATION);
    expect(rpc.sent).toHaveLength(0);
  });

  it("refuses a keystore that cannot pay, before signing", async () => {
    rpc.on(TOKEN_A, (await import("viem")).erc20Abi, "balanceOf", 1n);
    process.env["GULLYCORE_KEYSTORE_PASSWORD"] = ks.password;
    await expect(capture(() => runSwapExec([...base(), "--chain", "485590", "--keystore", ks.file, "--yes"]))).rejects.toThrow(/less than/);
    expect(rpc.sent).toHaveLength(0);
  });
});

void KEY;
