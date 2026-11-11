// SPDX-License-Identifier: MIT
/* ============================================================================
   Guards on the tokenised-stock registry.

   Nothing here reaches the network: whether 0x5b19… really is TSLAB is a
   question only BSC answers, and `docs/stocks-by-chain.md` records the reads
   that asked it. What CAN be tested is the class of mistake a human editing
   the table will make — a mis-cased address that `getAddress` would reject at
   the consumer, the same token pasted under two symbols, decimals outside the
   ERC-20 range, a record added without the date it was verified, or a
   `controls` flag that contradicts its own `notes`.
   ============================================================================ */

import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";

import { STOCK_TOKENS, STOCK_TOKEN_CHAIN_IDS, stockTokensFor, stockTokenByAddress } from "../src/deployments/stocks.js";
import * as sdk from "../src/index.js";

const ALL = Object.entries(STOCK_TOKENS).flatMap(([chainId, records]) =>
  records.map((r) => ({ chainId: Number(chainId), ...r })),
);

describe("STOCK_TOKENS", () => {
  it("is keyed by numeric chain ids and lists at least one record per chain", () => {
    for (const [key, records] of Object.entries(STOCK_TOKENS)) {
      expect(Number.isInteger(Number(key))).toBe(true);
      expect(records.length).toBeGreaterThan(0);
    }
    expect(STOCK_TOKEN_CHAIN_IDS).toEqual(Object.keys(STOCK_TOKENS).map(Number).sort((a, b) => a - b));
  });

  it("stores every address in EIP-55 checksum form", () => {
    for (const r of ALL) {
      expect(isAddress(r.address, { strict: true }), `${r.chainId} ${r.symbol}`).toBe(true);
      expect(r.address, `${r.chainId} ${r.symbol}`).toBe(getAddress(r.address));
      if (r.implementation !== null) {
        expect(r.implementation).toBe(getAddress(r.implementation));
      }
    }
  });

  it("never lists the same address twice on a chain", () => {
    for (const [chainId, records] of Object.entries(STOCK_TOKENS)) {
      const seen = new Set(records.map((r) => r.address.toLowerCase()));
      expect(seen.size, `chain ${chainId}`).toBe(records.length);
    }
  });

  it("never lists the same symbol twice on a chain", () => {
    for (const [chainId, records] of Object.entries(STOCK_TOKENS)) {
      const seen = new Set(records.map((r) => r.symbol.toLowerCase()));
      expect(seen.size, `chain ${chainId}`).toBe(records.length);
    }
  });

  it("keeps decimals inside 0..36", () => {
    for (const r of ALL) {
      expect(Number.isInteger(r.decimals), `${r.chainId} ${r.symbol}`).toBe(true);
      expect(r.decimals).toBeGreaterThanOrEqual(0);
      expect(r.decimals).toBeLessThanOrEqual(36);
    }
  });

  it("dates every record with the ISO day it was verified", () => {
    for (const r of ALL) {
      expect(r.verifiedAt, `${r.chainId} ${r.symbol}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.verifiedAt))).toBe(false);
    }
  });

  it("names an issuer, a ticker, a name and a one-line note on every record", () => {
    for (const r of ALL) {
      expect(r.issuer.length).toBeGreaterThan(0);
      expect(r.ticker.length).toBeGreaterThan(0);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.symbol.length).toBeGreaterThan(0);
      expect(r.notes.length).toBeGreaterThan(0);
      expect(r.notes.includes("\n")).toBe(false);
    }
  });

  it("keeps the proxy kind and the implementation field consistent", () => {
    for (const r of ALL) {
      if (r.proxy === "none") {
        expect(r.implementation, `${r.chainId} ${r.symbol}`).toBeNull();
        expect(r.controls.upgradeable === false || r.notes.length > 0).toBe(true);
      } else {
        expect(r.implementation, `${r.chainId} ${r.symbol}`).not.toBeNull();
        expect(r.controls.upgradeable, `${r.chainId} ${r.symbol}: a proxy is upgradeable`).toBe(true);
      }
    }
  });

  it("names the wrapped asset only on ERC-4626 wrappers, never itself, and never on a rebasing record", () => {
    for (const r of ALL) {
      if (r.wraps === undefined) continue;
      expect(r.wraps.standard, `${r.chainId} ${r.symbol}`).toBe("ERC-4626");
      expect(isAddress(r.wraps.asset, { strict: true })).toBe(true);
      expect(r.wraps.asset).toBe(getAddress(r.wraps.asset));
      expect(r.wraps.asset.toLowerCase()).not.toBe(r.address.toLowerCase());
      /* the wrapper's own balance is a fixed share count: a wrapper record is never rebasing */
      expect(r.controls.rebasing, `${r.chainId} ${r.symbol}`).toBe(false);
      expect(r.controls.uiMultiplier).toBe(false);
    }
  });

  it("lists the HyperEVM (999) families exactly as verified: five Backed wrappers, one Dinari wrapper, seven Ondo tokens", () => {
    const h = stockTokensFor(999);
    expect(h.filter((r) => r.issuer.startsWith("Backed")).map((r) => r.symbol).sort()).toEqual(["wMUx", "wNVDAx", "wQQQx", "wSKHYx", "wSPYx"]);
    expect(h.filter((r) => r.issuer.startsWith("Dinari")).map((r) => r.symbol)).toEqual(["SPCX.dw"]);
    expect(h.filter((r) => r.issuer.startsWith("Ondo")).map((r) => r.symbol).sort()).toEqual(["COINon", "CRCLon", "GOOGLon", "MUon", "NVDAon", "SPYon", "TSLAon"]);
    for (const r of h) {
      expect(r.decimals).toBe(18);
      expect(r.controls.rebasing, r.symbol).toBe(false);
      expect(r.verifiedAt).toBe("2026-09-19");
      if (r.issuer.startsWith("Ondo")) expect(r.wraps).toBeUndefined();
      else expect(r.wraps?.standard).toBe("ERC-4626");
    }
    /* the raw rebasing tokens under the wrappers are never records of their own */
    for (const r of h) if (r.wraps) expect(stockTokenByAddress(999, r.wraps.asset)).toBeUndefined();
  });

  it("uses only boolean control flags", () => {
    for (const r of ALL) {
      for (const [k, v] of Object.entries(r.controls)) {
        expect(typeof v, `${r.chainId} ${r.symbol} ${k}`).toBe("boolean");
      }
    }
  });
});

describe("stockTokensFor / stockTokenByAddress", () => {
  it("returns the chain's records and an empty list for a chain with none", () => {
    expect(stockTokensFor(56).length).toBeGreaterThanOrEqual(8);
    expect(stockTokensFor(4663).map((r) => r.symbol).sort()).toEqual(["AAPL", "AMC", "AMD", "AMZN", "ASML", "BABA", "CLSK", "COIN", "COST", "CRCL", "CRWV", "DELL", "EWY", "GME", "GOOGL", "INTC", "IONQ", "META", "MSFT", "MSTR", "MU", "NBIS", "NVDA", "ORCL", "PLTR", "QQQ", "RDDT", "RGTI", "RKLB", "SGOV", "SLV", "SNDK", "SPCX", "SPY", "TSLA", "TSM", "USAR", "USO"]);
    expect(stockTokensFor(999).length).toBe(13);
    // Ethereum gained Ondo Global Markets and Ink gained Backed's wrapped xStocks on
    // 2026-09-20; before that both read empty, which is what this line used to assert.
    expect(stockTokensFor(1).length).toBe(10);
    expect(stockTokensFor(57073).map((r) => r.symbol).sort()).toEqual(["wNVDAx", "wQQQx", "wSPYx"]);
    expect(stockTokensFor(999999)).toEqual([]);
  });

  it("finds a record by address regardless of case, and undefined otherwise", () => {
    const [first] = stockTokensFor(56);
    expect(first).toBeDefined();
    expect(stockTokenByAddress(56, first!.address.toLowerCase())).toBe(first);
    expect(stockTokenByAddress(56, first!.address.toUpperCase().replace("0X", "0x"))).toBe(first);
    expect(stockTokenByAddress(8453, first!.address)).toBeUndefined();
    expect(stockTokenByAddress(56, "0x0000000000000000000000000000000000000000")).toBeUndefined();
  });

  it("mirrors every stock token the address book lists, on every recorded chain", () => {
    const book: Readonly<Record<number, sdk.GullyCoreDeployment>> = sdk.GULLYCORE_DEPLOYMENTS;
    for (const id of sdk.GULLYCORE_CHAIN_IDS as readonly number[]) {
      for (const t of book[id]!.tokens.filter((x) => x.stock !== undefined)) {
        const rec = stockTokenByAddress(id, t.address);
        expect(rec, `${id} ${t.symbol}`).toBeDefined();
        expect(rec!.symbol).toBe(t.symbol);
        expect(rec!.decimals).toBe(t.decimals);
        expect(rec!.ticker).toBe(t.stock!.ticker);
        expect(rec!.issuer).toBe(t.stock!.issuer);
      }
    }
  });

  it("is reachable from the package root", () => {
    expect(sdk.STOCK_TOKENS).toBe(STOCK_TOKENS);
    expect(sdk.stockTokensFor).toBe(stockTokensFor);
    expect(sdk.stockTokenByAddress).toBe(stockTokenByAddress);
  });
});
