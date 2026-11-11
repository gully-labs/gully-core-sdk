// SPDX-License-Identifier: MIT
/**
 * The resolver's logic on a DEPLOYED chain, against a synthetic address book.
 *
 * Gully Core is not deployed anywhere yet, so the real SDK book is empty and the
 * shipped config resolves to the not-deployed page (see `resolve.test.ts`). The
 * logic for a deployed chain (overrides, the router, the scan start, utility
 * warnings) is still worth proving, so `./deployments` is replaced here by one
 * chain whose every address is obviously fake (`0x000...dc0deNN`). None of these
 * is a real contract anywhere; nothing here may ever be copied into a config.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./deployments", async () => {
  const { getAddress } = await import("viem");
  const id = 8453;
  const a = (n: number) => getAddress(`0x${"dc0de".padStart(38, "0")}${n.toString(16).padStart(2, "0")}`);
  const book = {
    chainId: id,
    key: "fixture",
    name: "Fixture Chain",
    explorer: "https://explorer.invalid",
    isMainnet: false,
    deployedAtBlock: 100n,
    nativeCurrency: { name: "Fixture Ether", symbol: "FIX", decimals: 18 },
    vault: a(1),
    clPoolManager: a(2),
    binPoolManager: a(3),
    universalRouter: a(4),
    clPositionManager: a(5),
    binPositionManager: a(6),
    permit2: a(7),
    clQuoter: a(8),
    binQuoter: a(9),
    fillRouter: a(10),
    weth: a(11),
    splitFactory: null,
    positionLock: null,
    tokenLock: null,
    multisend: null,
    dropFactory: null,
  };
  return {
    GULLYCORE_DEPLOYMENTS: { [id]: book },
    NATIVE_CURRENCY: { [id]: book.nativeCurrency },
    SUPPORTED_CHAIN_IDS: [id],
    UNDEPLOYED_CHAIN_IDS: [],
    isSupportedChain: (chainId: number) => chainId === id,
    undeployedChain: () => null,
  };
});

import config from "../../gullycore.config";
import { ZERO_ADDRESS, hasBlockingProblem, resolveConfig } from "./resolve";
import type { GullyCoreDexConfig } from "./types";

/** The shipped config with one part replaced. A new object, so the cache is bypassed. */
function withConfig(patch: (c: GullyCoreDexConfig) => GullyCoreDexConfig): ReturnType<typeof resolveConfig> {
  return resolveConfig(patch({ ...config }));
}

/* Synthetic. Lowercase on purpose, so the checksum assertion means something. */
const SPLIT_FACTORY = "0x00000000000000000000000000000000000dc0de";
const SPLIT_FACTORY_CHECKSUMMED = "0x00000000000000000000000000000000000Dc0De";

describe("a config on a deployed chain (fixture book)", () => {
  it("resolves with no blocking problem and every utility feature on", () => {
    const cfg = withConfig((c) => c);
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.features).toMatchObject({ splits: true, locks: true, airdrops: true });
    expect(cfg.notDeployed).toBeNull();
    expect(cfg.core.name).toBe("Fixture Chain");
  });

  it("takes utility addresses from the address book, and warns (never blocks) where they are null", () => {
    const cfg = withConfig((c) => c);
    for (const key of ["splitFactory", "positionLock", "tokenLock", "multisend", "dropFactory"] as const) {
      expect(cfg.utilities[key]).toBe(cfg.core[key]);
    }
    const warned = cfg.problems.filter((p) => p.severity === "warning").map((p) => p.field);
    expect(warned).toEqual(expect.arrayContaining(["features.splits", "features.locks", "features.airdrops"]));
  });

  it("links to the address book's explorer by default", () => {
    const cfg = withConfig((c) => c);
    expect(cfg.explorer).toBe(cfg.core.explorer);
  });

  it("keeps routed fills off on a test network (the fixture is not a mainnet), with the reason", () => {
    const cfg = withConfig((c) => c);
    expect(cfg.routing.endpoint).toBeUndefined();
    expect(cfg.routing.reason).toMatch(/test network/);
    expect(cfg.routing.api).toBe("https://app.gullycore.xyz");
  });
});

describe("chain.contracts overrides reach the utilities", () => {
  it("checksums an override and uses it", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, contracts: { splitFactory: SPLIT_FACTORY } } }));
    expect(cfg.utilities.splitFactory).toBe(SPLIT_FACTORY_CHECKSUMMED);
    expect(cfg.problems.some((p) => p.field === "features.splits")).toBe(false);
  });

  it("names a malformed override", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, contracts: { dropFactory: "0x1234" as `0x${string}` } } }));
    expect(hasBlockingProblem(cfg)).toBe(true);
    expect(cfg.problems.find((p) => p.field === "chain.contracts.dropFactory")?.severity).toBe("error");
    expect(cfg.utilities.dropFactory).toBe(cfg.core.dropFactory);
  });
});

describe("chain.router — your own router on Gully Core's shared core", () => {
  /* Repeated-digit addresses on purpose: their checksum is their lowercase, so
     a failure here is a failure of the logic and never of the casing. */
  const OWN_ROUTER = "0x2222222222222222222222222222222222222222" as const;
  const shipped = withConfig((c) => c);

  it("defaults to Gully Core's router, with no configuration at all", () => {
    expect(shipped.router.address).toBe(shipped.core.universalRouter);
    expect(shipped.router.custom).toBe(false);
    expect(shipped.contracts.universalRouter).toBe(shipped.core.universalRouter);
    expect(shipped.problems.some((p) => p.field === "chain.router")).toBe(false);
  });

  it("takes a tenant's own router and folds it into the merged address book", () => {
    /* Both reads must agree: App.tsx passes cfg.router.address to the widgets,
       and anything else in the app reads cfg.contracts.universalRouter. Two
       sources for one address is how a swap ends up on the router nobody
       chose. */
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, router: OWN_ROUTER } }));
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.router).toEqual({ address: OWN_ROUTER, custom: true });
    expect(cfg.contracts.universalRouter).toBe(OWN_ROUTER);
    /* Nothing else moved: the core is still Gully Core's. */
    expect(cfg.contracts.vault).toBe(cfg.core.vault);
    expect(cfg.contracts.clPoolManager).toBe(cfg.core.clPoolManager);
  });

  it("refuses the zero address rather than encoding a swap to it", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, router: ZERO_ADDRESS } }));
    expect(cfg.problems.find((p) => p.field === "chain.router")?.severity).toBe("error");
    expect(cfg.router.address).toBe(cfg.core.universalRouter);
  });

  it("refuses a core address pasted in by mistake", () => {
    for (const address of [shipped.core.vault, shipped.core.clPoolManager, shipped.core.permit2]) {
      const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, router: address } }));
      expect(hasBlockingProblem(cfg)).toBe(true);
      expect(cfg.problems.find((p) => p.field === "chain.router")?.severity).toBe("error");
      expect(cfg.router.custom).toBe(false);
    }
  });

  it("refuses two different routers rather than ranking them", () => {
    const cfg = withConfig((c) => ({
      ...c,
      chain: { ...c.chain, router: OWN_ROUTER, contracts: { universalRouter: "0x3333333333333333333333333333333333333333" } },
    }));
    expect(hasBlockingProblem(cfg)).toBe(true);
    expect(cfg.problems.find((p) => p.field === "chain.router")?.message).toMatch(/refuses to pick|only one can be used/);
  });

  /* REGRESSION. `resolveConfig` runs at MODULE SCOPE, and viem's `getAddress` throws on a
     malformed string — so reading the raw override without checking it turned a typo into a white
     screen with no problem rendered, while the merge above had already recorded a perfectly good
     named problem for that exact field. The typo must be reported once, under the field it was
     typed in, and the app must still render. */
  it("does not throw on a malformed contracts override, and reports it once", () => {
    let cfg: ReturnType<typeof withConfig> | undefined;
    expect(() => {
      cfg = withConfig((c) => ({
        ...c,
        chain: { ...c.chain, router: OWN_ROUTER, contracts: { universalRouter: "0xnot-an-address" } },
      }));
    }).not.toThrow();
    const problems = cfg!.problems;
    expect(problems.filter((p) => p.field === "chain.contracts.universalRouter")).toHaveLength(1);
    /* A malformed override is not a second router, so it must not also be reported as a conflict. */
    expect(problems.some((p) => p.field === "chain.router")).toBe(false);
    /* The valid chain.router still wins, rather than being discarded with the bad override. */
    expect(cfg!.router.address).toBe(OWN_ROUTER);
  });

  it("accepts the same router named twice, and says the override is redundant", () => {
    const cfg = withConfig((c) => ({
      ...c,
      chain: { ...c.chain, router: OWN_ROUTER, contracts: { universalRouter: OWN_ROUTER } },
    }));
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.problems.find((p) => p.field === "chain.router")?.severity).toBe("warning");
    expect(cfg.router).toEqual({ address: OWN_ROUTER, custom: true });
  });

  it("warns when it is pointed at Gully Core's own router, because null follows a redeploy and this does not", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, router: shipped.core.universalRouter } }));
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.problems.find((p) => p.field === "chain.router")?.severity).toBe("warning");
    expect(cfg.router.custom).toBe(false);
  });

  it("a full fork's contracts.universalRouter still works, and reads as not-Gully Core's", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, contracts: { universalRouter: OWN_ROUTER } } }));
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.router).toEqual({ address: OWN_ROUTER, custom: true });
    expect(cfg.problems.some((p) => p.field === "chain.router")).toBe(false);
  });
});

describe("chain.logsFromBlock", () => {
  it("moves the scan start for a devnet or a full fork", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, logsFromBlock: 0 } }));
    expect(cfg.core.deployedAtBlock).toBe(0n);
    expect(cfg.contracts.deployedAtBlock).toBe(0n);
  });

  it("refuses a negative or fractional block", () => {
    for (const bad of [-1, 1.5]) {
      const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, logsFromBlock: bad } }));
      expect(cfg.problems.find((p) => p.field === "chain.logsFromBlock")?.severity).toBe("error");
    }
  });
});
