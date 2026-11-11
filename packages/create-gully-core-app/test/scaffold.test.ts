// SPDX-License-Identifier: MIT
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { CLI_VERSION } from "../src/version.js";
import {
  MAX_FEE_BPS,
  SUPPORTED_CHAINS,
  UNDEPLOYED_CHAINS,
  normalizeChain,
  normalizeFeatures,
  resolveOptions,
  toAppName,
  toPackageName,
  looksLikeAddress,
} from "../src/options.js";
import { applyTokens, findUnresolvedTokens, tokensFor } from "../src/template.js";
import { scaffold, templateRoot } from "../src/scaffold.js";
import { copyTree, listFiles } from "../src/util/fsx.js";
import { parseArgs } from "../src/util/args.js";
import { GULLYCORE_CHAIN_IDS, GULLYCORE_DEPLOYMENTS, isGullyCoreChainId, type GullyCoreChainId } from "@gullylabs/core-sdk";

/* Obviously synthetic: a fixture, never anybody's wallet. */
const FEE_WALLET = "0x00000000000000000000000000000000000dC0dE";

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "create-gully-core-app-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("version", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});

describe("args", () => {
  it("reads value flags in both forms", () => {
    const a = parseArgs(["app", "--chain", "base", "--fee-bps=25", "--yes"]);
    expect(a.positionals).toEqual(["app"]);
    expect(a.flags["chain"]).toBe("base");
    expect(a.flags["fee-bps"]).toBe("25");
    expect(a.flags["yes"]).toBe(true);
  });

  it("refuses a value flag with no value", () => {
    expect(() => parseArgs(["app", "--chain", "--yes"])).toThrow(/--chain needs a value/);
  });
});

describe("options", () => {
  it("resolves chain aliases", () => {
    expect(normalizeChain("elysium")).toBe(99901);
    expect(normalizeChain("Anubis")).toBe(6714);
    expect(normalizeChain("gully-testnet")).toBe(485590);
    expect(normalizeChain("bnb")).toBe(56);
    expect(normalizeChain("bsc")).toBe(56);
    expect(normalizeChain("robinhood")).toBe(4663);
    expect(normalizeChain("base")).toBe(8453);
    expect(normalizeChain("8453")).toBe(8453);
  });

  it("refuses a chain with no Gully Core core, naming the deployed ones and no 'coming soon' list", () => {
    /* `polygon` is one the SDK does not target at all; Sepolia and the chains the owner
       took off the rollout (Monad, Ink, Cronos, Arc) are refused the same way: nothing is
       deployed there and nothing is announced, so they are not "coming soon". */
    for (const chain of ["polygon", "sepolia", "11155111", "hyperevm", "999", "monad", "143", "ink", "57073", "cronos", "25", "arc", "5042"]) {
      expect(() => normalizeChain(chain)).toThrow(/Gully Core's shared core is deployed on: Base \(8453\), BNB Chain \(56\), Robinhood Chain \(4663\), Kinetiq Elysium \(99901\), Anubis Network \(6714\), Gully Chain Testnet \(485590\)/);
      expect(() => normalizeChain(chain)).not.toThrow(/Coming soon/);
    }
  });

  it("accepts the six deployed chains, marked deployed", () => {
    for (const [chain, id, name] of [["8453", 8453, "Base"], ["bnb", 56, "BNB Chain"], ["robinhood", 4663, "Robinhood Chain"], ["elysium", 99901, "Kinetiq Elysium"], ["anubis", 6714, "Anubis Network"], ["485590", 485590, "Gully Chain Testnet"]] as const) {
      expect(normalizeChain(chain)).toBe(id);
      const options = resolveOptions({ directory: "x", chain });
      expect(options.chainName).toBe(name);
      expect(options.chainDeployed).toBe(true);
    }
  });

  it("lists exactly the chains the SDK address book records as deployed", () => {
    /* The scaffolder has no runtime dependencies, so it restates the list; this
       is what keeps the restatement honest, name included. */
    expect([...SUPPORTED_CHAINS.keys()].sort()).toEqual([...GULLYCORE_CHAIN_IDS].map(Number).sort());
    for (const [id, name] of SUPPORTED_CHAINS) expect(GULLYCORE_DEPLOYMENTS[id as GullyCoreChainId]?.name).toBe(name);
    for (const id of UNDEPLOYED_CHAINS.keys()) {
      expect(isGullyCoreChainId(id), `chain ${id} is recorded in the SDK but listed as undeployed`).toBe(false);
    }
  });

  it("never lists a chain as both deployed and not-deployed", () => {
    for (const id of UNDEPLOYED_CHAINS.keys()) {
      expect(SUPPORTED_CHAINS.has(id), `chain ${id} is in both maps`).toBe(false);
    }
  });

  it("expands feature bundles, the utilities riding along", () => {
    expect(normalizeFeatures("dex")).toEqual(["swap", "pools", "locks", "airdrops"]);
    expect(normalizeFeatures("launchpad")).toEqual(["launchpad", "splits", "locks", "airdrops"]);
    expect(normalizeFeatures("both")).toEqual(["swap", "pools", "launchpad", "splits", "locks", "airdrops"]);
    expect(normalizeFeatures("swap,launchpad")).toEqual(["swap", "launchpad"]);
    expect(normalizeFeatures("locks,airdrops,splits")).toEqual(["locks", "airdrops", "splits"]);
  });

  it("derives names from a directory", () => {
    expect(toPackageName("Acme Swap")).toBe("acme-swap");
    expect(toAppName("acme-swap")).toBe("Acme Swap");
    expect(toPackageName("!!!")).toBe("gullycore-dex");
  });

  it("validates addresses syntactically", () => {
    expect(looksLikeAddress(FEE_WALLET)).toBe(true);
    expect(looksLikeAddress("0x123")).toBe(false);
    expect(looksLikeAddress("nope")).toBe(false);
  });

  it("refuses a fee with no destination", () => {
    expect(() =>
      resolveOptions({ directory: "x", chain: "8453", feeBps: "25" }),
    ).toThrow(/no --fee-wallet/);
  });

  it("refuses a fee paid to the zero address", () => {
    expect(() =>
      resolveOptions({
        directory: "x",
        chain: "8453",
        feeBps: "25",
        feeWallet: "0x0000000000000000000000000000000000000000",
      }),
    ).toThrow(/would be burned/);
  });

  it("refuses a fee above the widgets' ceiling", () => {
    expect(() =>
      resolveOptions({
        directory: "x",
        chain: "8453",
        feeBps: String(MAX_FEE_BPS + 1),
        feeWallet: FEE_WALLET,
      }),
    ).toThrow(/ceiling/);
  });

  it("allows a zero fee with no wallet", () => {
    const options = resolveOptions({ directory: "acme-dex", chain: "8453" });
    expect(options.feeBps).toBe(0);
    expect(options.appName).toBe("Acme Dex");
    expect(options.features).toEqual(["swap", "pools", "launchpad", "splits", "locks", "airdrops"]);
  });
});

describe("token substitution", () => {
  const options = resolveOptions({
    directory: "acme-swap",
    chain: "8453",
    feeBps: "25",
    feeWallet: FEE_WALLET,
    features: "launchpad",
  });
  const tokens = tokensFor(options);

  it("replaces a tagged numeric literal without leaving the marker", () => {
    const out = applyTokens("gullycore.config.ts", "  id: 1 /* __GULLYCORE_CHAIN_ID__ */,", tokens);
    expect(out).toBe("  id: 8453,");
    expect(findUnresolvedTokens(out)).toEqual([]);
  });

  it("replaces a tagged boolean literal", () => {
    const out = applyTokens("gullycore.config.ts", "swap: true /* __GULLYCORE_FEATURE_SWAP__ */,", tokens);
    expect(out).toBe("swap: false,");
  });

  it("replaces the tagged null fee wallet with a quoted address", () => {
    const out = applyTokens("gullycore.config.ts", "wallet: null /* __GULLYCORE_FEE_WALLET__ */,", tokens);
    expect(out).toBe(`wallet: '${FEE_WALLET}',`);
  });

  it("writes no wallet as null, never as the zero address", () => {
    const noFee = tokensFor(resolveOptions({ directory: "x", chain: "8453" }));
    const out = applyTokens("gullycore.config.ts", "wallet: null /* __GULLYCORE_FEE_WALLET__ */,", noFee);
    expect(out).toBe("wallet: null,");
    expect(out).not.toMatch(/0x0{40}/);
  });

  it("replaces a bare placeholder inside a string", () => {
    expect(applyTokens("gullycore.config.ts", "name: '__GULLYCORE_APP_NAME__',", tokens)).toBe(
      "name: 'Acme Swap',",
    );
  });

  it("escapes a quote that would otherwise terminate the literal", () => {
    const risky = tokensFor(
      resolveOptions({ directory: "x", chain: "8453", appName: "Bob's Swap" }),
    );
    const out = applyTokens("gullycore.config.ts", "name: '__GULLYCORE_APP_NAME__',", risky);
    expect(out).toBe("name: 'Bob\\'s Swap',");
  });

  it("uses JSON quoting in a .json file", () => {
    expect(applyTokens("package.json", '"name": "__GULLYCORE_PACKAGE_NAME__"', tokens)).toBe(
      '"name": "acme-swap"',
    );
  });
});

describe("the template itself", () => {
  it("compiles as it sits on disk, with defaults that are not placeholders", async () => {
    const root = templateRoot();
    const config = await readFile(join(root, "gullycore.config.ts"), "utf8");

    // Every marker in the template must be a TAGGED literal, never a bare
    // placeholder in a value position — otherwise the template does not
    // typecheck before substitution, and a template nobody can build is a
    // template nobody reviews.
    for (const marker of findUnresolvedTokens(config)) {
      const tagged = config.includes(`/* ${marker} */`);
      const inString = new RegExp(`'${marker}'`).test(config);
      expect(tagged || inString, `${marker} is neither tagged nor inside a string`).toBe(true);
    }
  });

  it("does not import GPL protocol sources anywhere", async () => {
    const root = templateRoot();
    const files = await listFiles(root);
    const sources = files.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f));
    expect(sources.length).toBeGreaterThan(10);

    for (const file of sources) {
      const text = await readFile(join(root, file), "utf8");
      // The licence boundary, enforced as a test rather than as a paragraph.
      expect(text, `${file} reaches into the GPL monorepo`).not.toMatch(
        /from ["'][^"']*packages\/(core|periphery|router|hooks|hooks-rwa|hooks-revshare|launchpad)/,
      );
      expect(text, `${file} imports a .sol file`).not.toMatch(/\.sol["']/);
    }
  });

  it("ships no .env and no lockfile", async () => {
    const files = await listFiles(templateRoot());
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
    expect(files).toContain(".env.example");
  });
});

describe("scaffold", () => {
  it("writes a project with every placeholder resolved", async () => {
    const dir = join(await tempDir(), "acme-swap");
    const options = resolveOptions({
      directory: dir,
      chain: "8453",
      feeBps: "25",
      feeWallet: FEE_WALLET,
      features: "dex",
    });

    const result = await scaffold(options);
    expect(result.filesWritten).toBeGreaterThan(15);

    const config = await readFile(join(dir, "gullycore.config.ts"), "utf8");
    expect(findUnresolvedTokens(config)).toEqual([]);
    expect(config).toContain("id: 8453,");
    expect(config).toContain(`wallet: '${FEE_WALLET}',`);
    expect(config).toContain("bps: 25,");
    expect(config).toContain("launchpad: false,");
    expect(config).toContain("swap: true,");
    expect(config).toContain("splits: false,");
    expect(config).toContain("locks: true,");
    expect(config).toContain("airdrops: true,");

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("acme-swap");
    // Dependencies must be published names. A relative path into the monorepo
    // would work here and fail for every tenant, who does not have it.
    for (const spec of Object.values(pkg.dependencies)) {
      expect(spec).not.toMatch(/^(file:|link:|workspace:|\.\.)/);
    }

    // npm strips .gitignore from a tarball, so the template carries _gitignore.
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "_gitignore"))).toBe(false);

    const html = await readFile(join(dir, "index.html"), "utf8");
    expect(html).toContain("<title>Acme Swap</title>");
  }, 60_000);

  /**
   * Regression. The copy filter used to test ABSOLUTE paths against a list of
   * directory names that includes `dist` and `node_modules`. The published
   * template lives at `node_modules/@gullylabs/create-core-app/dist/template`, so every file in it was
   * filtered out and the published scaffolder produced an empty directory while
   * reporting success. Tests passed throughout, because they ran against
   * `src/../template`, which has no excluded ancestor.
   */
  it("copies a template whose own path contains an excluded directory name", async () => {
    const parent = await tempDir();
    const nested = join(parent, "dist", "node_modules", "template");
    await copyTree(templateRoot(), nested);

    const target = join(parent, "out");
    const result = await scaffold(
      resolveOptions({ directory: target, chain: "8453" }),
      nested,
    );
    expect(result.filesWritten).toBeGreaterThan(15);
    expect(existsSync(join(target, "gullycore.config.ts"))).toBe(true);
  }, 60_000);

  it("refuses to write into a directory that already has files", async () => {
    const dir = await tempDir();
    await scaffold(resolveOptions({ directory: join(dir, "a"), chain: "8453" }));
    await expect(
      scaffold(resolveOptions({ directory: join(dir, "a"), chain: "8453" })),
    ).rejects.toThrow(/already exists and is not empty/);
  }, 60_000);
});
