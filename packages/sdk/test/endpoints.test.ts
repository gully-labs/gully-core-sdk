// SPDX-License-Identifier: MIT
/* Log-endpoint ordering: a REORDER of the probed list for `eth_getLogs`, never an
   addition, with private providers still first. */

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHAIN_RPCS,
  ENDPOINT_TARGET,
  LOG_RANGE_ENDPOINTS,
  LOG_RANGE_LIMITS,
  SINGLE_ENDPOINT_CHAINS,
  THIN_ENDPOINT_CHAINS,
  logSpanBoundsFor,
  resolveEndpoints,
  resolveLogEndpoints,
  type ChainKey,
} from "../src/chains/endpoints.js";

/* The endpoint TABLE's own invariants. These are not style checks: `transport.ts`
   reports `belowTarget` as `count < ENDPOINT_TARGET && THIN_ENDPOINT_CHAINS.includes(key)`,
   so a short chain missing from that list is reported as HEALTHY while it is one
   outage from having no provider. The table is hand-edited from a probe artefact, which
   is exactly the kind of edit that drifts. */
describe("the endpoint table", () => {
  const entries = Object.entries(CHAIN_RPCS) as [ChainKey, (typeof CHAIN_RPCS)[ChainKey]][];

  it("names every below-target chain in THIN_ENDPOINT_CHAINS, and no others", () => {
    const short = entries.filter(([, c]) => c.endpoints.length < ENDPOINT_TARGET).map(([k]) => k);
    expect([...THIN_ENDPOINT_CHAINS].sort()).toEqual([...short].sort());
  });

  it("names every chain with fewer than two endpoints in SINGLE_ENDPOINT_CHAINS", () => {
    const alone = entries.filter(([, c]) => c.endpoints.length < 2).map(([k]) => k);
    expect([...SINGLE_ENDPOINT_CHAINS].sort()).toEqual([...alone].sort());
  });

  it("never carries a credentialed or non-https url — this file is committed", () => {
    for (const [key, cfg] of entries) {
      for (const { url } of cfg.endpoints) {
        expect(url, `${key}: ${url}`).toMatch(/^https:\/\//);
        const parsed = new URL(url);
        expect(parsed.username, `${key}: ${url}`).toBe("");
        expect(parsed.password, `${key}: ${url}`).toBe("");
        expect(url, `${key}: ${url}`).not.toContain("${");
        // An opaque 20+ character path segment is how a provider carries an API key.
        for (const seg of parsed.pathname.split("/")) {
          const opaque = seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg);
          expect(opaque, `${key}: ${url} looks like it embeds a key`).toBe(false);
        }
      }
    }
  });

  it("lists each endpoint once per chain, and each chain id once", () => {
    for (const [key, cfg] of entries) {
      const urls = cfg.endpoints.map((e) => e.url);
      expect(new Set(urls).size, `${key} repeats an endpoint`).toBe(urls.length);
    }
    const ids = entries.map(([, c]) => c.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("LOG_RANGE_ENDPOINTS", () => {
  it("only names endpoints already in that chain's probed list", () => {
    for (const [chainId, urls] of Object.entries(LOG_RANGE_ENDPOINTS)) {
      const listed = resolveEndpoints(Number(chainId));
      for (const u of urls) expect(listed).toContain(u);
    }
  });

  it("puts HyperEVM's wide-window log endpoint first for logs", () => {
    expect(resolveLogEndpoints(999)[0]).toBe("https://rpc.purroofgroup.com");
  });

  it("puts the measured log endpoint first on BNB, Robinhood and Base, without changing their read order", () => {
    expect(resolveLogEndpoints(56)[0]).toBe("https://56.rpc.thirdweb.com");
    expect(resolveLogEndpoints(4663)[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(resolveLogEndpoints(8453)[0]).toBe("https://8453.rpc.thirdweb.com");
    for (const id of [56, 4663, 8453]) expect(resolveLogEndpoints(id)).toEqual(resolveEndpoints(id));
  });
});

describe("resolveLogEndpoints", () => {
  it("is the same SET as resolveEndpoints, reordered", () => {
    for (const cfg of Object.values(CHAIN_RPCS)) {
      const reads = resolveEndpoints(cfg.chainId);
      const logs = resolveLogEndpoints(cfg.chainId);
      expect([...logs].sort()).toEqual([...reads].sort());
      expect(logs.length).toBe(new Set(logs).size);
    }
  });

  it("leaves chains without a verified log endpoint in probed order", () => {
    expect(resolveLogEndpoints(1)).toEqual(resolveEndpoints(1));
  });

  it("keeps private providers ahead of the verified public one", () => {
    const env = { GULLYCORE_RPC_999: "https://keyed.example/a, https://keyed.example/b" };
    const logs = resolveLogEndpoints(999, env);
    expect(logs.slice(0, 3)).toEqual([
      "https://keyed.example/a",
      "https://keyed.example/b",
      "https://rpc.purroofgroup.com",
    ]);
  });

  it("does not change the read order", () => {
    expect(resolveEndpoints(999)[0]).toBe(CHAIN_RPCS.hyperevm.endpoints[0]?.url);
  });
});

/* The verified span limits are what the indexer and the keeper size their chunks from. A limit
   on an endpoint no chain lists would silently size nothing; a chain whose first log endpoint
   is not its widest would pay a refusal on every pass before reaching the one that serves. */
describe("LOG_RANGE_LIMITS", () => {
  it("only names endpoints some chain lists, each a positive whole number of blocks", () => {
    const listed = new Set<string>(Object.values(CHAIN_RPCS).flatMap((c) => c.endpoints.map((e) => e.url)));
    for (const [url, limit] of Object.entries(LOG_RANGE_LIMITS)) {
      expect(listed.has(url), `${url} is in no chain's list`).toBe(true);
      expect(Number.isInteger(limit) && limit > 0, `${url}: ${limit}`).toBe(true);
    }
  });

  it("records HyperEVM's two measured limits: 100,000 on purroofgroup, 50 on Hyperliquid's own RPC", () => {
    expect(LOG_RANGE_LIMITS["https://rpc.purroofgroup.com"]).toBe(100_000);
    expect(LOG_RANGE_LIMITS["https://rpc.hyperliquid.xyz/evm"]).toBe(50);
  });

  it("the first log endpoint of every chain with limits is the widest one", () => {
    for (const cfg of Object.values(CHAIN_RPCS)) {
      const bounds = logSpanBoundsFor(cfg.chainId);
      if (bounds === undefined) continue;
      expect(LOG_RANGE_LIMITS[resolveLogEndpoints(cfg.chainId)[0]!], cfg.name).toBe(bounds.max);
    }
  });
});

describe("logSpanBoundsFor", () => {
  it("gives HyperEVM a 100,000-block ceiling and a 50-block floor", () => {
    expect(logSpanBoundsFor(999)).toEqual({ max: 100_000, min: 50 });
  });

  it("gives BNB and Base thirdweb's 1,000 blocks and Robinhood its official RPC's 10,000,000", () => {
    expect(logSpanBoundsFor(56)).toEqual({ max: 1_000, min: 1_000 });
    expect(logSpanBoundsFor(8453)).toEqual({ max: 1_000, min: 1_000 });
    expect(logSpanBoundsFor(4663)).toEqual({ max: 10_000_000, min: 10_000_000 });
  });

  it("is undefined for a chain with no verified limit, so a scanner keeps its own default", () => {
    expect(logSpanBoundsFor(1)).toBeUndefined();
    expect(logSpanBoundsFor(424242)).toBeUndefined();
  });

  it("ignores a supplied private endpoint, whose limit was never measured", () => {
    expect(logSpanBoundsFor(999, { GULLYCORE_RPC_999: "https://keyed.example/a" })).toEqual({ max: 100_000, min: 50 });
  });

  it("follows an exclusive local endpoint: nothing verified means undefined", () => {
    expect(logSpanBoundsFor(999, { GULLYCORE_RPC_999: "http://127.0.0.1:8545" })).toBeUndefined();
  });
});

/**
 * The harvest artefact is COMMITTED as evidence of what was considered and refused, and
 * chains.json really does carry filled-in credentials (a live Alchemy key sat in its Sepolia
 * entry on 2026-09-19). Refusing to ship a credential and then printing it into a committed
 * file publishes it just the same, so the harvester redacts every key-shaped path segment
 * before recording a rejection. This asserts the artefact stayed clean.
 */
describe("rpc-harvest.json", () => {
  it("records no credential-shaped path segment, in any field", () => {
    const path = new URL("../rpc-harvest.json", import.meta.url);
    if (!existsSync(path)) return; // the artefact is optional; the rule applies when it exists
    const raw = readFileSync(path, "utf8");
    const offenders = [...raw.matchAll(/https?:\/\/[^"\s]+/g)]
      .map((m) => m[0])
      .filter((u) =>
        u
          .replace(/^https?:\/\/[^/]+/, "")
          .split(/[/?#]/)
          .some((seg) => seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)),
      );
    expect(offenders).toEqual([]);
  });
});
