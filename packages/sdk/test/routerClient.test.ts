import { describe, expect, it } from "vitest";
import { getDeployment } from "../src/deployments/index.js";
import { encodeFunctionData } from "viem";
import { approvalsOf, GULLYCORE_FILL_ROUTER_FILL_ABI, GullyCoreRouterClient, GullyCoreRouterError } from "../src/router/index.js";

const W = "0x4200000000000000000000000000000000000006";
const U = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FILL = "0x0F0B0C231dE62234a2BA8D8b265464BE30c99a0C";
const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EVIL = "0x000000000000000000000000000000000000dEaD";
/* A chain that is NOT in the address book, for the allowed-targets paths. (Once a chain is in the
   book, the book's own routers take precedence over allowedTargets.) */
const OFF_BOOK = 10;

function quoteBody(over: Record<string, unknown> = {}) {
  return {
    requestId: "r1",
    chainId: 8453,
    tokenIn: W,
    tokenOut: U,
    amountIn: "1000000000000000000",
    amountOut: "2684452348",
    minAmountOut: "2671030086",
    slippageBps: 50,
    priceImpactBps: 1,
    gasEstimate: "220000",
    gasCostNative: "2200000000000",
    gasAdjusted: true,
    protocolFee: { bps: 10, amount: "999000999000999", currency: W, budget: "999000999000999000", refund: "1", exempt: false, readFrom: FILL },
    route: { source: "UNISWAP_V3", execution: "gullycore-fill-router", to: FILL, legs: [] },
    quotedAt: 1,
    expiresAt: 31,
    blockNumber: "51805477",
    diagnostics: [],
    ...over,
  };
}

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("GullyCoreRouterClient", () => {
  it("quote: parses amounts to bigint and sends the key only as a header", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { data: quoteBody(), provenance: {} } }));
    const c = new GullyCoreRouterClient({ baseUrl: "https://api.example", apiKey: "gullycorek_x", fetch: f });
    const q = await c.quote({ chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, slippageBps: 50 });
    expect(q.amountOut).toBe(2_684_452_348n);
    expect(q.protocolFee.amount).toBe(999_000_999_000_999n);
    expect(q.protocolFee.readFrom).toBe(FILL);
    expect(q.blockNumber).toBe(51_805_477n);
    expect(calls[0]!.url).toBe(`https://api.example/v1/chains/8453/quote?tokenIn=${W}&tokenOut=${U}&amount=1000000000000000000&slippageBps=50`);
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("gullycorek_x");
    expect(calls[0]!.url).not.toContain("gullycorek_x");
  });

  it("quote: refuses a response that does not match the request or carries a non-integer amount", async () => {
    const wrongPair = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: fakeFetch(() => ({ status: 200, body: { data: quoteBody({ tokenOut: W }) } })).f });
    await expect(wrongPair.quote({ chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n })).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
    const fractional = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: fakeFetch(() => ({ status: 200, body: { data: quoteBody({ amountOut: "12.5" }) } })).f });
    await expect(fractional.quote({ chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n })).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
  });

  it("surfaces API errors with their code, and APPROVAL_REQUIRED steps via approvalsOf", async () => {
    const { f } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: "APPROVAL_REQUIRED", message: "approve first", details: { approvals: [{ kind: "erc20-approve", token: W, spender: FILL, to: W, data: "0x095ea7b3", amount: "1000000000000000000" }] } } },
    }));
    const c = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: f, allowedTargets: { 8453: [FILL] } });
    const err = await c.swap({ chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, sender: USER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GullyCoreRouterError);
    expect((err as GullyCoreRouterError).status).toBe(409);
    expect(approvalsOf(err)).toEqual([{ kind: "erc20-approve", token: W, spender: FILL, to: W, data: "0x095ea7b3", amount: 10n ** 18n }]);
  });

  /* The client decodes the calldata (audit D M-1), so the fixture is a REAL fill for the quoted trade. */
  function fillData(over: { recipient?: string; amountIn?: bigint } = {}) {
    return encodeFunctionData({
      abi: GULLYCORE_FILL_ROUTER_FILL_ABI,
      functionName: "fill",
      args: [{
        target: "0x2626664c2603336E57B271c5C0b26F421741e481",
        currencyIn: W,
        currencyOut: U,
        amountIn: over.amountIn ?? 10n ** 18n,
        minAmountOut: 2671030086n,
        maxFeeBps: 10,
        wrapInput: false,
        unwrapOutput: false,
        recipient: (over.recipient ?? USER) as `0x${string}`,
        deadline: 1234n,
        data: "0x",
      }],
    });
  }
  function swapBody(to: string, over: Record<string, unknown> = {}, chainId = 8453, data: string = fillData()) {
    return { data: { tx: { chainId, from: USER, to, data, value: "0", gas: "350000" }, minAmountOut: "2671030086", deadline: 1234, recipient: USER, simulation: { ok: true }, quote: quoteBody({ chainId }), ...over } };
  }

  it("swap: REFUSES calldata to the right router that is not the requested trade (audit D M-1)", async () => {
    const mk = (data: string) => new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: fakeFetch(() => ({ status: 200, body: swapBody(FILL, {}, OFF_BOOK, data) })).f, allowedTargets: { [OFF_BOOK]: [FILL] } });
    const ask = { chainId: OFF_BOOK, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, sender: USER } as const;
    await expect(mk(fillData({ recipient: EVIL })).swap(ask)).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
    await expect(mk(fillData({ amountIn: 10n ** 24n })).swap(ask)).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
    await expect(mk("0xabcdef").swap(ask)).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
  });

  it("swap: accepts a tx addressed to an allowed target and parses it", async () => {
    const c = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: fakeFetch(() => ({ status: 200, body: swapBody(FILL, {}, OFF_BOOK) })).f, allowedTargets: { [OFF_BOOK]: [FILL] } });
    const s = await c.swap({ chainId: OFF_BOOK, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, sender: USER });
    expect(s.tx.gas).toBe(350_000n);
    expect(s.targetVerifiedBy).toBe("allowed-targets");
  });

  it("swap: REFUSES a tx addressed anywhere else (a spoofed API cannot aim a wallet at a drainer)", async () => {
    const c = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: fakeFetch(() => ({ status: 200, body: swapBody(EVIL) })).f, allowedTargets: { 8453: [FILL] } });
    await expect(c.swap({ chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, sender: USER })).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
  });

  it("swap: refuses a mismatched sender/recipient, and refuses outright on a chain with nothing to verify against", async () => {
    const other = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    const c = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: fakeFetch(() => ({ status: 200, body: swapBody(FILL, { recipient: other }) })).f, allowedTargets: { 8453: [FILL] } });
    await expect(c.swap({ chainId: 8453, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, sender: USER })).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
    const { f, calls } = fakeFetch(() => ({ status: 200, body: swapBody(FILL, {}, OFF_BOOK) }));
    const bare = new GullyCoreRouterClient({ baseUrl: "https://api.example", fetch: f });
    await expect(bare.swap({ chainId: OFF_BOOK, tokenIn: W, tokenOut: U, amountIn: 10n ** 18n, sender: USER })).rejects.toMatchObject({ code: "UNTRUSTED_RESPONSE" });
    expect(calls).toHaveLength(0);
  });

  it("off the address book, only allowedTargets are trusted, and nothing without them", () => {
    expect(getDeployment(OFF_BOOK)).toBeUndefined();
    expect(new GullyCoreRouterClient({ baseUrl: "https://api.example" }).trustedTargets(OFF_BOOK)).toEqual({ targets: [], source: null });
    const t = new GullyCoreRouterClient({ baseUrl: "https://api.example", allowedTargets: { [OFF_BOOK]: [FILL] } }).trustedTargets(OFF_BOOK);
    expect(t).toEqual({ targets: [FILL], source: "allowed-targets" });
  });

  it("refuses a plain-http origin other than localhost; a transport failure is TRANSPORT", async () => {
    expect(() => new GullyCoreRouterClient({ baseUrl: "http://api.example" })).toThrow(/https/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = new GullyCoreRouterClient({ baseUrl: "http://127.0.0.1:4180", fetch: down });
    await expect(c.feeConfig(8453)).rejects.toMatchObject({ code: "TRANSPORT", status: null });
  });
});
