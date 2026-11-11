import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { erc20Abi } from "viem";
import { BIN_POSITION_MANAGER_ABI, CL_POSITION_MANAGER_ABI } from "@gullylabs/core-sdk/trading";
import { LAUNCHPAD_KIT_V2_RULES_ABI } from "@gullylabs/core-sdk";
import { GULLYCORE_TOKEN_LOCK_ABI } from "@gullylabs/core-sdk/launchpad";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bashScript, commandTree, fishScript, powershellScript, runCompletion, zshScript } from "../src/commands/completion.js";
import { runConfig } from "../src/commands/config.js";
import { chainRows, runChain, runFees, runTokens } from "../src/commands/info.js";
import { runLiquidityAdd, runLiquidityRemove, tickRange } from "../src/commands/liquidity.js";
import { orderPair, runPool, runPoolCreate, runPoolInfo, runPoolList } from "../src/commands/pool.js";
import { approvalsFrom, runSwap, runSwapExec, runSwapQuote } from "../src/commands/swap.js";
import { runLock } from "../src/commands/utilities.js";
import { resolveChain } from "../src/lib/chain.js";
import { loadConfig } from "../src/lib/config.js";
import { poolFromApi } from "../src/lib/pools.js";
import { resolveToken } from "../src/lib/tokens.js";
import { EXIT } from "../src/util/log.js";
import { BOOK, KEY, POOL_ID, SENDER, TOKEN_A, TOKEN_B, apiPool, stockChain } from "./helpers/fixture.js";
import { capture, startMock, type Rpc } from "./helpers/mockChain.js";

let rpc: Rpc;
let dir: string;
const chain = (): string[] => ["--chain", "485590", "--rpc", rpc.url, "--api", rpc.url];
const swapArgs = (): string[] => ["--in", TOKEN_A, "--out", TOKEN_B, "--amount", "1", ...chain()];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gullycore-cmd-"));
  process.env["GULLYCORE_CONFIG"] = join(dir, "config.json");
});
afterAll(() => {
  delete process.env["GULLYCORE_CONFIG"];
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  rpc = await startMock();
  stockChain(rpc);
});
afterEach(async () => {
  await rpc.stop();
});

const parse = (s: string): any => JSON.parse(s);
const QUOTE = {
  requestId: "r",
  chainId: 485590,
  tokenIn: TOKEN_A,
  tokenOut: TOKEN_B,
  amountIn: "1000000000000000000",
  amountOut: "990000000000000000",
  minAmountOut: "985050000000000000",
  slippageBps: 50,
  priceImpactBps: 12,
  gasEstimate: "150000",
  gasCostNative: "1000",
  gasAdjusted: false,
  protocolFee: { bps: 0, amount: "0", currency: TOKEN_A, budget: "0", refund: "0", exempt: true, readFrom: null },
  route: { source: "GULLYCORE_INFINITY_CL", execution: "gullycore-universal-router", to: BOOK.universalRouter, legs: [] },
  quotedAt: 1,
  expiresAt: 2,
  blockNumber: "5000",
  diagnostics: [],
};

describe("gullycore chain", () => {
  it("list: only the book's chains are deployed; every target is listed and none is invented", () => {
    const rows = chainRows();
    expect(rows.map((r) => r.chainId).slice(0, 7)).toEqual([485590, 6714, 4663, 8453, 56, 99901, 999]);
    expect(rows.filter((r) => r.deployed).map((r) => r.chainId)).toEqual([485590, 6714, 4663, 8453, 56, 99901]);
    expect(rows.find((r) => r.chainId === 6714)?.network).toBe("mainnet");
    expect(rows.find((r) => r.chainId === 999)?.status).toBe("no deployment yet");
    expect(rows.find((r) => r.chainId === 6714)?.note).toMatch(/gasDAI/);
  });
  it("list --json is one document", async () => {
    const r = await capture(() => runChain(["list", "--json"]));
    expect(parse(r.stdout).result.chains).toHaveLength(7);
    expect(r.stdout).not.toContain("audited");
  });
  it("human output opens with the brand line, with the exact audit wording", async () => {
    const r = await capture(() => runChain(["list"]));
    expect(r.stdout.split("\n")[0]).toBe("Gully Core by Gully Labs · built on PancakeSwap Infinity's audited core");
  });
  it("status reads the chain live", async () => {
    rpc.on(BOOK.launchpadV2.launchpadKitV2 as `0x${string}`, LAUNCHPAD_KIT_V2_RULES_ABI, "MIN_TRADE_FEE_PIPS", 10_000);
    rpc.on(BOOK.launchpadV2.launchpadKitV2 as `0x${string}`, LAUNCHPAD_KIT_V2_RULES_ABI, "PROTOCOL_TRADE_SHARE_BPS", 5_000);
    rpc.on(BOOK.launchpadV2.launchpadKitV2 as `0x${string}`, LAUNCHPAD_KIT_V2_RULES_ABI, "LAUNCH_TOTAL_SUPPLY", 10n ** 27n);
    const r = await capture(() => runChain(["status", ...chain(), "--json"]));
    const doc = parse(r.stdout);
    expect(doc.result.deployed).toBe(true);
    expect(doc.result.headBlock).toBe("5000");
    expect(doc.result.kitRelease).toBe(2);
    expect(r.stdout).not.toContain(rpc.url.split("//")[1]?.split(":")[1] === undefined ? "never" : "/v2/");
  });
  it("status says so on a chain with no deployment, and touches no network", async () => {
    const r = await capture(() => runChain(["status", "--chain", "hyperevm", "--json"]));
    expect(r.code).toBe(0);
    expect(parse(r.stdout).result.deployed).toBe(false);
  });
  it("an unknown subcommand is a usage error", async () => {
    await expect(capture(() => runChain(["nope"]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});

describe("gullycore config", () => {
  it("sets, reads and removes, with the file private", async () => {
    await capture(() => runConfig(["set", "network", "gully-testnet"]));
    await capture(() => runConfig(["set", "slippage", "1"]));
    expect(loadConfig()).toMatchObject({ network: "gully-testnet", slippage: "1" });
    const r = await capture(() => runConfig(["get", "network", "--json"]));
    expect(parse(r.stdout).result.value).toBe("gully-testnet");
    if (process.platform !== "win32") expect(statSync(process.env["GULLYCORE_CONFIG"] as string).mode & 0o777).toBe(0o600);
    await capture(() => runConfig(["unset", "network"]));
    await capture(() => runConfig(["unset", "slippage"]));
    expect(loadConfig().network).toBeUndefined();
  });
  it("redacts an RPC URL when listing, keeps it on disk", async () => {
    await capture(() => runConfig(["set", "rpc.485590", "https://rpc.example/v2/SECRET"]));
    const r = await capture(() => runConfig(["list", "--json"]));
    expect(r.stdout).not.toContain("SECRET");
    expect(readFileSync(process.env["GULLYCORE_CONFIG"] as string, "utf8")).toContain("SECRET");
    await capture(() => runConfig(["unset", "rpc.485590"]));
  });
  it("has no setting for a secret, and refuses a key-shaped value", async () => {
    await expect(capture(() => runConfig(["set", "privateKey", "x"]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(capture(() => runConfig(["set", "keystore", `0x${"ab".repeat(32)}`]))).rejects.toThrow(/looks like a private key/);
    await expect(capture(() => runConfig(["set", "slippage", "9"]))).rejects.toThrow(/maximum/);
    await expect(capture(() => runConfig(["set", "api", "http://example.com"]))).rejects.toThrow(/https/);
    await expect(capture(() => runConfig(["set", "network", "atlantis"]))).rejects.toThrow(/unknown chain/);
  });
  it("a default network reaches a command, and the flag beats it", async () => {
    await capture(() => runConfig(["set", "network", "485590"]));
    const r = await capture(() => runPoolList(["--rpc", rpc.url, "--api", rpc.url, "--from-chain", "--json"]));
    expect(parse(r.stdout).chainId).toBe(485590);
    await capture(() => runConfig(["unset", "network"]));
  });
});

describe("gullycore completion", () => {
  it("covers every command the CLI has and the flags that matter", () => {
    const tree = commandTree();
    for (const c of ["swap", "pool", "liquidity", "launch", "lock", "fees", "tokens", "chain", "config", "doctor", "site", "airdrop", "completion"]) expect(tree).toHaveProperty(c);
    expect(tree["swap"]?.subs["exec"]).toContain("--dry-run");
    expect(tree["swap"]?.subs["exec"]).toContain("--network");
  });
  it("prints a script per shell, and nothing but the script", async () => {
    const tree = commandTree();
    expect(bashScript(tree)).toContain("complete -F _gullycore gullycore");
    expect(zshScript(tree)).toContain("#compdef gullycore");
    expect(fishScript(tree)).toContain("complete -c gullycore");
    expect(powershellScript(tree)).toContain("Register-ArgumentCompleter");
    const r = await capture(() => runCompletion(["bash"]));
    expect(r.stdout.startsWith("# gullycore completion")).toBe(true);
    await expect(capture(() => runCompletion(["tcsh"]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});

describe("gullycore tokens", () => {
  it("lists native and the book's tokens, with decimals", async () => {
    const r = await capture(() => runTokens([...chain(), "--json"]));
    const tokens = parse(r.stdout).result.tokens;
    expect(tokens.map((t: { symbol: string }) => t.symbol)).toEqual(["ETH", "WETH", "USDC.e"]);
    expect(tokens[2].decimals).toBe(6);
  });
  it("info reads the contract, and a balance", async () => {
    const r = await capture(() => runTokens(["info", TOKEN_A, ...chain().slice(0, 4), "--holder", SENDER, "--json"]));
    const d = parse(r.stdout).result;
    expect(d.symbol).toBe("AAA");
    expect(d.balance).toBe((10n ** 24n).toString());
  });
  it("a symbol resolves from the address book only", async () => {
    await expect(capture(() => runTokens(["info", "PEPE", ...chain().slice(0, 4)]))).rejects.toThrow(/not a token on/);
  });
  it("refuses a chain with no deployment", async () => {
    await expect(capture(() => runTokens(["list", "--chain", "hyperevm", "--rpc", rpc.url]))).rejects.toMatchObject({ exitCode: EXIT.NO_DEPLOYMENT });
  });
});

describe("gullycore fees", () => {
  beforeEach(() => {
    const kit = BOOK.launchpadV2.launchpadKitV2 as `0x${string}`;
    rpc.on(kit, LAUNCHPAD_KIT_V2_RULES_ABI, "MIN_TRADE_FEE_PIPS", 10_000);
    rpc.on(kit, LAUNCHPAD_KIT_V2_RULES_ABI, "PROTOCOL_TRADE_SHARE_BPS", 5_000);
    rpc.on(kit, LAUNCHPAD_KIT_V2_RULES_ABI, "LAUNCH_TOTAL_SUPPLY", 10n ** 27n);
  });
  it("says the flat fee is not in force when the controller has no builderFee()", async () => {
    const r = await capture(() => runFees([...chain(), "--json"]));
    const d = parse(r.stdout).result;
    expect(d.builderFeePips).toBeNull();
    expect(d.flatBuilderFeeInForce).toBe(false);
    expect(d.rulePips).toBe(3000);
    expect(d.capPips).toBe(4000);
    expect(d.sentence).toMatch(/starts with release 3/);
  });
  it("reports the controller's flat fee when it has one", async () => {
    const { BUILDER_FEE_ABI } = await import("@gullylabs/core-sdk");
    rpc.on(BOOK.feeController, BUILDER_FEE_ABI, "builderFee", 3000);
    const d = parse((await capture(() => runFees([...chain(), "--json"]))).stdout).result;
    expect(d.builderFeePips).toBe(3000);
    expect(d.flatBuilderFeeInForce).toBe(true);
  });
  it("reads one pool's fee from its slot0, both directions decoded", async () => {
    rpc.on(BOOK.clPoolManager, (await import("./helpers/fixture.js")).SLOT0_ABI, "getSlot0", [1n << 96n, 0, (3000 << 12) | 3000, 3000]);
    const d = parse((await capture(() => runFees([...chain(), "--pool", POOL_ID, "--json"]))).stdout).result;
    expect(d.pool.protocolFeeText).toBe("0.3%");
  });
  it("human output keeps the rule and the chain apart", async () => {
    const r = await capture(() => runFees(chain()));
    expect(r.stdout).toContain("read from the chain");
    expect(r.stdout).toContain("not in force");
    expect(r.stdout).toContain("outside builders");
  });
});

describe("gullycore pool", () => {
  it("list uses the API and re-hashes every key", async () => {
    rpc.api("/v1/chains/485590/pools", { items: [apiPool(), { ...apiPool(), poolId: `0x${"ee".repeat(32)}` }] });
    const r = await capture(() => runPoolList([...chain(), "--json"]));
    const d = parse(r.stdout).result;
    expect(d.pools).toHaveLength(1);
    expect(d.pools[0].poolId).toBe(POOL_ID);
    expect(d.pools[0].source).toBe("api");
  });
  it("falls back to the chain's logs when the API is down", async () => {
    const r = await capture(() => runPoolList([...chain(), "--json"]));
    const d = parse(r.stdout);
    expect(d.ok).toBe(true);
    expect(d.result.total).toBe(0);
  });
  it("a wrong key from the API is not a pool", () => {
    expect(poolFromApi(apiPool({ ...KEY, fee: 500 }) as never)).toBeNull();
  });
  it("info shows key, price and fees", async () => {
    const r = await capture(() => runPoolInfo([POOL_ID, ...chain()]));
    expect(r.stdout).toContain("AAA/BBB");
    expect(r.stdout).toContain("Protocol fee");
    expect(r.stdout).toContain("0.3%");
  });
  it("never echoes what was passed as a pool id", async () => {
    const bad = `0x${"zz".repeat(31)}`;
    const e = await capture(() => runPoolInfo([bad, ...chain()])).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain(bad);
  });
  it("create: orders the pair, turns the price round, simulates, signs nothing by default", async () => {
    const r = await capture(() => runPoolCreate(["--token-a", TOKEN_B, "--token-b", TOKEN_A, "--price", "2", "--fee", "0.3", "--from", SENDER, ...chain().slice(0, 4), "--json"]));
    expect(r.code).toBe(0);
    const d = parse(r.stdout);
    expect(d.tx.to).toBe(BOOK.clPositionManager);
    expect(d.result.key.currency0).toBe(TOKEN_A);
    expect(rpc.sent).toHaveLength(0);
  });
  it("orderPair inverts exactly", () => {
    const a = { address: TOKEN_A } as never;
    const b = { address: TOKEN_B } as never;
    expect(orderPair(a, b, "2").price).toBe("2");
    expect(orderPair(b, a, "2").price).toBe("0.500000000000000000");
    expect(orderPair(b, a, "0.25").price).toBe("4.000000000000000000");
    expect(() => orderPair(a, b, "0")).toThrow(/positive/);
  });
  it("create: a dynamic fee needs a hook; a same-token pair is refused", async () => {
    await expect(capture(() => runPoolCreate(["--token-a", TOKEN_A, "--token-b", TOKEN_B, "--price", "1", "--fee", "dynamic", "--from", SENDER, ...chain().slice(0, 4)]))).rejects.toThrow(/needs a --hook/);
    await expect(capture(() => runPoolCreate(["--token-a", TOKEN_A, "--token-b", TOKEN_A, "--price", "1", "--from", SENDER, ...chain().slice(0, 4)]))).rejects.toThrow(/same token/);
  });
  it("create on a chain with no deployment is refused, exit code 3", async () => {
    await expect(capture(() => runPoolCreate(["--chain", "hyperevm", "--rpc", rpc.url, "--token-a", TOKEN_A, "--token-b", TOKEN_B, "--price", "1", "--from", SENDER]))).rejects.toMatchObject({ exitCode: EXIT.NO_DEPLOYMENT });
  });
  it("no subcommand prints help and exits 2", async () => {
    const r = await capture(() => runPool([]));
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stdout).toContain("pool create");
  });
});

describe("gullycore swap", () => {
  it("quote through the router", async () => {
    rpc.api("/v1/chains/485590/quote", QUOTE);
    const r = await capture(() => runSwapQuote([...swapArgs(), "--json"]));
    const d = parse(r.stdout).result;
    expect(d.via).toBe("router");
    expect(d.minAmountOut).toBe("985050000000000000");
    expect(d.priceImpactBps).toBe(12);
  });
  it("quote on one pool, from the chain, with its fees", async () => {
    const r = await capture(() => runSwapQuote([...swapArgs(), "--pool", POOL_ID]));
    expect(r.stdout).toContain("Minimum out");
    expect(r.stdout).toContain("Pool fee");
    expect(r.stdout).toContain("Protocol fee");
    expect(r.stdout).toContain("0.992015");
  });
  it("a router failure is a user error: no route", async () => {
    rpc.apiError("/v1/chains/485590/quote", 404, "NO_ROUTE", "no configured source can fill this trade");
    await expect(capture(() => runSwapQuote(swapArgs()))).rejects.toThrow(/router: no configured source/);
  });
  it("refuses a high price impact unless accepted", async () => {
    rpc.api("/v1/chains/485590/quote", { ...QUOTE, priceImpactBps: 900 });
    await expect(capture(() => runSwapQuote(swapArgs()))).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
    const r = await capture(() => runSwapQuote([...swapArgs(), "--accept-high-slippage"]));
    expect(r.code).toBe(0);
  });
  it("refuses a token the pool does not trade", async () => {
    const other = "0x3000000000000000000000000000000000000003";
    rpc.on(other, erc20Abi, "symbol", "CCC");
    rpc.on(other, erc20Abi, "name", "C");
    rpc.on(other, erc20Abi, "decimals", 18);
    await expect(capture(() => runSwapQuote(["--in", TOKEN_A, "--out", other, "--amount", "1", "--pool", POOL_ID, ...chain()]))).rejects.toThrow(/does not trade/);
  });
  it("exec on one pool prints an exact approval pair then the swap, simulating the first", async () => {
    stockChain(rpc, { allowance: 0n });
    const r = await capture(() => runSwapExec([...swapArgs(), "--pool", POOL_ID, "--from", SENDER, "--json"]));
    expect(r.code).toBe(0);
    const d = parse(r.stdout);
    expect(d.txs).toHaveLength(3);
    expect(d.txs[0].to).toBe(TOKEN_A);
    expect(d.txs[1].to).toBe(BOOK.permit2);
    expect(d.txs[2].to).toBe(BOOK.universalRouter);
    expect(d.result.simulations.map((s: { ok: boolean | null }) => s.ok)).toEqual([true, null, null]);
  });
  it("exec shows the fee and the minimum before anything else can happen", async () => {
    const r = await capture(() => runSwapExec([...swapArgs(), "--pool", POOL_ID, "--from", SENDER]));
    expect(r.stdout.indexOf("Minimum out")).toBeLessThan(r.stdout.indexOf("Simulated swap"));
    expect(r.stdout.indexOf("Pool fee")).toBeLessThan(r.stdout.indexOf("Simulated swap"));
    expect(r.stdout).toContain("Unsigned transaction");
  });
  it("exec refuses --min-out looser than the slippage", async () => {
    await expect(capture(() => runSwapExec([...swapArgs(), "--pool", POOL_ID, "--from", SENDER, "--min-out", "0.5"]))).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
  });
  it("exec through the router builds approvals locally and refuses an unknown spender", () => {
    const ctx = resolveChain({ chain: "485590", env: {} });
    const t = { token: TOKEN_A, amount: 5n, permit2: BOOK.permit2, targets: [BOOK.universalRouter], expiry: 10n, symbol: "AAA" };
    const steps = approvalsFrom(ctx, SENDER, [{ kind: "erc20-approve", token: TOKEN_A, spender: BOOK.permit2, to: TOKEN_A, data: "0xdead", amount: 2n ** 200n }], t);
    expect(steps[0]?.tx.data).not.toBe("0xdead");
    expect(steps[0]?.tx.data.endsWith("0005")).toBe(true);
    expect(() => approvalsFrom(ctx, SENDER, [{ kind: "erc20-approve", token: TOKEN_A, spender: SENDER, to: TOKEN_A, data: "0x", amount: 1n }], t)).toThrow(/unknown spender/);
    expect(() => approvalsFrom(ctx, SENDER, [{ kind: "erc20-approve", token: TOKEN_B, spender: BOOK.permit2, to: TOKEN_B, data: "0x", amount: 1n }], t)).toThrow(/different token/);
  });
  it("exec through the router, when it wants approvals, prints them and says to run again", async () => {
    rpc.api("/v1/chains/485590/quote", QUOTE);
    rpc.apiError("/v1/chains/485590/swap", 409, "APPROVAL_REQUIRED", "approval needed", {
      approvals: [{ kind: "erc20-approve", token: TOKEN_A, spender: BOOK.permit2, to: TOKEN_A, data: "0x", amount: "1000000000000000000" }],
    });
    const r = await capture(() => runSwapExec([...swapArgs(), "--from", SENDER, "--json"]));
    const d = parse(r.stdout);
    expect(d.needsApproval).toBe(true);
    expect(d.txs).toHaveLength(1);
    expect(rpc.sent).toHaveLength(0);
  });
  it("refuses a chain with no deployment before any read", async () => {
    await expect(capture(() => runSwapExec(["--chain", "hyperevm", "--in", TOKEN_A, "--out", TOKEN_B, "--amount", "1", "--from", SENDER]))).rejects.toMatchObject({ exitCode: EXIT.NO_DEPLOYMENT });
    await expect(capture(() => runSwapQuote(["--chain", "hyperevm", "--in", TOKEN_A, "--out", TOKEN_B, "--amount", "1"]))).rejects.toMatchObject({ exitCode: EXIT.NO_DEPLOYMENT });
  });
  it("--amount of zero and a bad subcommand are usage errors", async () => {
    await expect(capture(() => runSwapQuote(["--in", TOKEN_A, "--out", TOKEN_B, "--amount", "0", ...chain()]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(capture(() => runSwap(["bridge"]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});

describe("a gas-only chain", () => {
  it("refuses native anywhere, by name, and names the quote token", async () => {
    const ctx = resolveChain({ chain: "anubis", rpc: rpc.url, env: {} });
    expect(ctx.isMainnet).toBe(true);
    for (const t of ["native", "gasDAI", "0x0000000000000000000000000000000000000000"]) {
      await expect(resolveToken(ctx, t, "--in")).rejects.toMatchObject({ exitCode: EXIT.REFUSED, hint: expect.stringContaining("0x83fd06F0846d9D90B3016bF670Efe2E0B11cDe14") });
    }
  });
  it("still takes its ERC-20s, and native on a chain with value", async () => {
    await expect(resolveToken(resolveChain({ chain: "anubis", rpc: rpc.url, env: {} }), "DAI", "--in")).resolves.toMatchObject({ symbol: "DAI" });
    await expect(resolveToken(resolveChain({ chain: "485590", rpc: rpc.url, env: {} }), "native", "--in")).resolves.toMatchObject({ native: true });
  });
});

describe("gullycore liquidity", () => {
  it("tickRange aligns to the spacing and straddles the price", () => {
    expect(tickRange({ fullRange: true }, 0, 60)).toEqual([-887220, 887220]);
    const [lo, hi] = tickRange({ fullRange: false, rangePct: "10" }, 1000, 60);
    expect(Math.abs(lo % 60)).toBe(0);
    expect(Math.abs(hi % 60)).toBe(0);
    expect(lo).toBeLessThan(1000);
    expect(hi).toBeGreaterThan(1000);
    expect(tickRange({ fullRange: false, tickLower: "-600", tickUpper: "600" }, 0, 60)).toEqual([-600, 600]);
    expect(() => tickRange({ fullRange: false, tickLower: "-601", tickUpper: "600" }, 0, 60)).toThrow(/multiples/);
    expect(() => tickRange({ fullRange: false }, 0, 60)).toThrow(/say the range/);
  });
  it("add mints with exact approvals, the most it may pay above what it needs", async () => {
    stockChain(rpc, { allowance: 0n });
    const r = await capture(() => runLiquidityAdd(["--pool", POOL_ID, "--amount0", "1", "--amount1", "1", "--range-pct", "10", "--from", SENDER, ...chain(), "--json"]));
    expect(r.code).toBe(0);
    const d = parse(r.stdout);
    expect(d.txs).toHaveLength(5);
    expect(d.txs[4].to).toBe(BOOK.clPositionManager);
    expect(BigInt(d.result.amount0Max) > BigInt(d.result.amount0)).toBe(true);
    expect(BigInt(d.result.amount0) <= 10n ** 18n + 1n).toBe(true);
  });
  it("add refuses without an amount", async () => {
    await expect(capture(() => runLiquidityAdd(["--pool", POOL_ID, "--range-pct", "10", "--from", SENDER, ...chain()]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
  it("remove reads the position and floors what comes back", async () => {
    rpc.on(BOOK.clPositionManager, CL_POSITION_MANAGER_ABI, "ownerOf", SENDER);
    rpc.on(BOOK.clPositionManager, CL_POSITION_MANAGER_ABI, "positions", [KEY, -600, 600, 10n ** 20n, 0n, 0n, "0x0000000000000000000000000000000000000000"]);
    const r = await capture(() => runLiquidityRemove(["--token-id", "7", "--percent", "50", "--from", SENDER, ...chain(), "--json"]));
    expect(r.code).toBe(0);
    const d = parse(r.stdout);
    expect(d.tx.to).toBe(BOOK.clPositionManager);
    expect(BigInt(d.result.amount0Min) > 0n).toBe(true);
  });
  it("remove refuses someone else's position", async () => {
    rpc.on(BOOK.clPositionManager, CL_POSITION_MANAGER_ABI, "ownerOf", TOKEN_A);
    await expect(capture(() => runLiquidityRemove(["--token-id", "7", "--from", SENDER, ...chain()]))).rejects.toThrow(/belongs to/);
  });
  it("remove from bins needs what the sender holds", async () => {
    const bin = { ...KEY, poolManager: BOOK.binPoolManager };
    const { poolKeyToId, encodeBinPoolParameters } = await import("@gullylabs/core-sdk");
    const key = { ...bin, parameters: encodeBinPoolParameters(0, 10) };
    const id = poolKeyToId(key);
    rpc.api(`/v1/chains/485590/pools/${id}`, { ...apiPool(key, id), poolType: "Bin" });
    rpc.on(BOOK.binPositionManager, BIN_POSITION_MANAGER_ABI, "balanceOf", 0n);
    await expect(capture(() => runLiquidityRemove(["--pool", id, "--ids", "8388608", "--from", SENDER, ...chain()]))).rejects.toThrow(/holds nothing/);
  });
});

describe("gullycore lock", () => {
  it("status shows what is claimable", async () => {
    const lock = BOOK.tokenLock as `0x${string}`;
    rpc.on(lock, GULLYCORE_TOKEN_LOCK_ABI, "getLock", { currency: TOKEN_A, beneficiary: SENDER, start: 1, cliff: 1, end: 2, pendingBeneficiary: "0x0000000000000000000000000000000000000000", amount: 100n, claimed: 0n, creator: SENDER });
    const r = await capture(() => runLock(["status", "1", ...chain().slice(0, 4), "--json"]));
    expect(parse(r.stdout).result.claimable).toBe("100");
  });
  it("position needs a token id, and refuses a chain with no deployment", async () => {
    await expect(capture(() => runLock(["position", ...chain().slice(0, 4), "--unlock-days", "1", "--from", SENDER]))).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(capture(() => runLock(["position", "--chain", "hyperevm", "--token-id", "1", "--unlock-days", "1", "--from", SENDER]))).rejects.toMatchObject({ exitCode: EXIT.NO_DEPLOYMENT });
  });
});
