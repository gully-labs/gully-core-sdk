// SPDX-License-Identifier: MIT
import { GULLYCORE_DEPLOYMENTS, IPFS_GATEWAYS } from "@gullylabs/core-sdk";
import { describe, expect, it } from "vitest";

import config from "../../gullycore.config";
import { UNDEPLOYED_CHAIN_IDS, undeployedChain } from "./deployments";
import {
  GULLYCORE_ROUTING_API,
  hasBlockingProblem,
  resolveConfig,
  resolveExplorer,
  resolveFeatures,
  resolveIpfsGateways,
  resolveNativeLogo,
  resolveRouting,
  type ConfigProblem,
} from "./resolve";
import type { GullyCoreDexConfig } from "./types";

/** The shipped config with one part replaced. A new object, so the cache is bypassed. */
function withConfig(patch: (c: GullyCoreDexConfig) => GullyCoreDexConfig): ReturnType<typeof resolveConfig> {
  return resolveConfig(patch({ ...config }));
}

const FILL = "0x7878624417E9d69219EAdD14bA1B01459C87b578" as const;

describe("the shipped gullycore.config.ts", () => {
  /* The SDK address book records Base (8453), so the shipped config resolves
     to a working app against Gully Core's own deployment; the deployed-chain logic
     on a synthetic book is proved in resolve.fixture.test.ts. */
  it("targets Base, which is deployed: no blocking problem, the book's addresses, no not-deployed page", () => {
    const cfg = withConfig((c) => c);
    expect(config.chain.id).toBe(8453);
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.notDeployed).toBeNull();
    expect(cfg.core.vault).toBe(GULLYCORE_DEPLOYMENTS[8453].vault);
    expect(cfg.router.address).toBe(GULLYCORE_DEPLOYMENTS[8453].universalRouter);
    expect(cfg.router.custom).toBe(false);
    expect(cfg.nativeCurrency.symbol).toBe("ETH");
    expect(cfg.explorer).toBe(GULLYCORE_DEPLOYMENTS[8453].explorer);
    expect(cfg.utilities.splitFactory).toBe(GULLYCORE_DEPLOYMENTS[8453].splitFactory);
  });

  it("routes through Gully Core's API by default, against the book's fill router, because the shipped fee is 0", () => {
    const cfg = withConfig((c) => c);
    expect(cfg.fee.bps).toBe(0);
    expect(cfg.routing.api).toBe(GULLYCORE_ROUTING_API);
    expect(cfg.routing.custom).toBe(false);
    expect(cfg.routing.endpoint).toEqual({ baseUrl: `${GULLYCORE_ROUTING_API}/v1/chains`, fillRouter: GULLYCORE_DEPLOYMENTS[8453].fillRouter });
    expect(cfg.routing.reason).toBeNull();
  });

  it("proposes Gully Core's $3,500 opening market cap, the SDK's gateways and no native mark, as shipped", () => {
    const cfg = withConfig((c) => c);
    expect(cfg.launch.defaultOpeningMarketCapUsd).toBe(3500);
    expect(cfg.ipfsGateways).toEqual(IPFS_GATEWAYS);
    expect(cfg.nativeLogoUrl).toBeNull();
  });

  it("still names a malformed contracts override", () => {
    const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, contracts: { dropFactory: "0x1234" as `0x${string}` } } }));
    expect(cfg.problems.find((p) => p.field === "chain.contracts.dropFactory")?.severity).toBe("error");
  });
});

describe("utility features", () => {
  it("default to OFF, with a warning each, in a config written before they existed", () => {
    const problems: ConfigProblem[] = [];
    const f = resolveFeatures({ swap: true, pools: false, launchpad: true }, problems);
    expect(f).toEqual({ swap: true, pools: false, launchpad: true, splits: false, locks: false, airdrops: false });
    expect(problems.map((p) => p.field)).toEqual(["features.splits", "features.locks", "features.airdrops"]);
    expect(problems.every((p) => p.severity === "warning")).toBe(true);
  });

  it("refuses a non-boolean flag", () => {
    const problems: ConfigProblem[] = [];
    resolveFeatures({ swap: true, pools: true, launchpad: true, splits: "yes" as unknown as boolean, locks: true, airdrops: false }, problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: "features.splits", severity: "error" });
  });

  it("a turned-off utility is not warned about even when not deployed", () => {
    const cfg = withConfig((c) => ({ ...c, features: { ...c.features, splits: false, locks: false, airdrops: false } }));
    expect(cfg.problems.some((p) => p.field === "features.splits" || p.field === "features.locks" || p.field === "features.airdrops")).toBe(false);
  });
});

describe("chains Gully Core is not deployed on", () => {
  it("none is 'coming soon': the rollout is settled at the four deployed chains", () => {
    expect(UNDEPLOYED_CHAIN_IDS).toEqual([]);
    expect(undeployedChain(8453)).toBeNull();
  });

  it("a chain off the rollout, or one the SDK does not list, is a blocking error that names the deployed chains", () => {
    /* Sepolia, Monad, Ink, Cronos, Arc and a local-devnet id: nothing deployed, nothing announced. */
    for (const id of [11155111, 143, 57073, 25, 5042, 1337]) {
      expect(undeployedChain(id)).toBeNull();
      const cfg = withConfig((c) => ({ ...c, chain: { ...c.chain, id: id as unknown as 8453 } }));
      expect(hasBlockingProblem(cfg)).toBe(true);
      expect(cfg.notDeployed).toBeNull();
      const msg = cfg.problems.find((p) => p.field === "chain.id")?.message ?? "";
      expect(msg).toMatch(/Deployed on: .*8453 \(Base\)/);
      expect(msg).toMatch(/8453 \(Base\)/);
      expect(msg).not.toMatch(/Coming soon/);
    }
  });
});

describe("routed fills (resolveRouting)", () => {
  const mainnet = { isMainnet: true, fillRouter: FILL };
  const noFee = { bps: 0 };

  it("is Gully Core's API against the book's fill router by default, and when `routing` is omitted", () => {
    const problems: ConfigProblem[] = [];
    const r = resolveRouting(undefined, mainnet, noFee, problems);
    expect(r.endpoint).toEqual({ baseUrl: `${GULLYCORE_ROUTING_API}/v1/chains`, fillRouter: FILL });
    expect(r.custom).toBe(false);
    expect(problems).toEqual([]);
    expect(resolveRouting({ api: "gullycore" }, mainnet, noFee, [])).toEqual(r);
  });

  it("is the tenant's own API when `api` is an origin, with the same fill router and an optional key", () => {
    const r = resolveRouting({ api: "https://router.example.com/", apiKey: " k1 " }, mainnet, noFee, []);
    expect(r.endpoint).toEqual({ baseUrl: "https://router.example.com/v1/chains", fillRouter: FILL, apiKey: "k1" });
    expect(r.custom).toBe(true);
    expect(r.customFillRouter).toBe(false);
  });

  it("is off by choice with `api: null`, with a reason and no problem", () => {
    const problems: ConfigProblem[] = [];
    const r = resolveRouting({ api: null }, mainnet, noFee, problems);
    expect(r.endpoint).toBeUndefined();
    expect(r.reason).toMatch(/routing.api is null/);
    expect(problems).toEqual([]);
  });

  it("refuses an origin with a path, http://, or nonsense, by name", () => {
    for (const api of ["https://router.example.com/v1", "http://router.example.com", "router.example.com", 42 as unknown as string]) {
      const problems: ConfigProblem[] = [];
      const r = resolveRouting({ api }, mainnet, noFee, problems);
      expect(r.endpoint).toBeUndefined();
      expect(problems.map((p) => p.field)).toEqual(["routing.api"]);
      expect(problems[0]?.severity).toBe("error");
    }
  });

  it("is off, with a WARNING naming fee.bps, while the app takes a swap fee: the widget would drop the fee", () => {
    const problems: ConfigProblem[] = [];
    const r = resolveRouting(undefined, mainnet, { bps: 25 }, problems);
    expect(r.endpoint).toBeUndefined();
    expect(r.reason).toMatch(/swap fee/);
    expect(problems).toEqual([expect.objectContaining({ field: "routing", severity: "warning" })]);
    expect(problems[0]?.message).toMatch(/fee.bps is 25/);
  });

  it("is off on a test network and where the book records no fill router, each with its reason", () => {
    expect(resolveRouting(undefined, { isMainnet: false, fillRouter: FILL }, noFee, []).reason).toMatch(/test network/);
    expect(resolveRouting(undefined, { isMainnet: true, fillRouter: null }, noFee, []).reason).toMatch(/no GullyCoreFillRouter/);
  });

  it("takes a fill-router override only as a full fork's claim, and refuses the zero address", () => {
    const own = "0x2222222222222222222222222222222222222222" as const;
    const r = resolveRouting({ api: "gullycore", fillRouter: own }, { isMainnet: true, fillRouter: null }, noFee, []);
    expect(r.endpoint?.fillRouter).toBe(own);
    expect(r.customFillRouter).toBe(true);
    const problems: ConfigProblem[] = [];
    const z = resolveRouting({ api: "gullycore", fillRouter: "0x0000000000000000000000000000000000000000" }, mainnet, noFee, problems);
    expect(z.endpoint).toBeUndefined();
    expect(problems.map((p) => p.field)).toEqual(["routing.fillRouter"]);
  });

  it("the shipped config with a fee on resolves to routing off and the warning", () => {
    const cfg = withConfig((c) => ({ ...c, fee: { wallet: "0x2222222222222222222222222222222222222222", bps: 25, mode: "take-portion" } }));
    expect(hasBlockingProblem(cfg)).toBe(false);
    expect(cfg.routing.endpoint).toBeUndefined();
    expect(cfg.problems.some((p) => p.field === "routing" && p.severity === "warning")).toBe(true);
  });
});

describe("the native mark and the IPFS gateways", () => {
  it("accept a root-relative path, https:// or ipfs://, and refuse anything else by name", () => {
    expect(resolveNativeLogo("/hype.svg", [])).toBe("/hype.svg");
    expect(resolveNativeLogo("https://cdn.example.com/eth.svg", [])).toBe("https://cdn.example.com/eth.svg");
    expect(resolveNativeLogo("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", [])).toMatch(/^ipfs:/);
    expect(resolveNativeLogo(undefined, [])).toBeNull();
    expect(resolveNativeLogo("  ", [])).toBeNull();
    for (const bad of ["eth.svg", "//cdn.example.com/eth.svg", "http://x/y.svg", "data:image/svg+xml,x"]) {
      const problems: ConfigProblem[] = [];
      expect(resolveNativeLogo(bad, problems)).toBeNull();
      expect(problems.map((p) => p.field)).toEqual(["brand.nativeLogoUrl"]);
    }
  });

  it("gateways default to the SDK's allow-list; a tenant's own go first; a malformed one is named", () => {
    expect(resolveIpfsGateways(undefined, [])).toEqual(IPFS_GATEWAYS);
    expect(resolveIpfsGateways(["https://ipfs.example.com/ipfs/", "https://ipfs.example.com/ipfs/"], [])).toEqual(["https://ipfs.example.com/ipfs/"]);
    const problems: ConfigProblem[] = [];
    expect(resolveIpfsGateways(["https://ipfs.example.com/ipfs", "ipfs.example.com/"], problems)).toEqual(IPFS_GATEWAYS);
    expect(problems.map((p) => p.field)).toEqual(["chain.ipfsGateways[0]", "chain.ipfsGateways[1]", "chain.ipfsGateways"]);
  });
});

describe("the opening market cap default", () => {
  it("is the tenant's whole dollars, else Gully Core's $3,500; a fraction, zero or a string is refused by name", () => {
    expect(withConfig((c) => ({ ...c, launch: { ...c.launch, defaultOpeningMarketCapUsd: 10_000 } })).launch.defaultOpeningMarketCapUsd).toBe(10_000);
    const { defaultOpeningMarketCapUsd: _omit, ...rest } = config.launch;
    expect(withConfig((c) => ({ ...c, launch: rest })).launch.defaultOpeningMarketCapUsd).toBe(3500);
    for (const bad of [0, -1, 35.5, "3500" as unknown as number]) {
      const cfg = withConfig((c) => ({ ...c, launch: { ...c.launch, defaultOpeningMarketCapUsd: bad } }));
      expect(cfg.problems.find((p) => p.field === "launch.defaultOpeningMarketCapUsd")?.severity).toBe("error");
    }
  });
});

describe("the explorer links point at", () => {
  const BOOK = "https://explorer.invalid";
  const OWN = { vault: "0x1111111111111111111111111111111111111111" as const };

  it("is the address book's by default", () => {
    expect(resolveExplorer({}, BOOK)).toBe(BOOK);
    expect(resolveExplorer({ rpcUrls: ["https://rpc.example.org"] }, BOOK)).toBe(BOOK);
  });

  it("is none for a local devnet: own contracts over loopback-only RPCs", () => {
    expect(resolveExplorer({ contracts: OWN, rpcUrls: ["http://127.0.0.1:8545"] }, BOOK)).toBeNull();
    expect(resolveExplorer({ contracts: OWN, rpcUrls: ["http://localhost:8545", "http://[::1]:8545"] }, BOOK)).toBeNull();
  });

  it("stays the book's when only some RPCs are local, or the contracts are the book's", () => {
    expect(resolveExplorer({ contracts: OWN, rpcUrls: ["http://127.0.0.1:8545", "https://rpc.example.org"] }, BOOK)).toBe(BOOK);
    expect(resolveExplorer({ rpcUrls: ["http://127.0.0.1:8545"] }, BOOK)).toBe(BOOK);
  });

  it('obeys an explicit chain.explorer: "" is none, a URL wins, trailing slashes go', () => {
    expect(resolveExplorer({ explorer: "" }, BOOK)).toBeNull();
    expect(resolveExplorer({ explorer: "   " }, BOOK)).toBeNull();
    expect(resolveExplorer({ explorer: "http://localhost:4000/", contracts: OWN, rpcUrls: ["http://127.0.0.1:8545"] }, BOOK)).toBe("http://localhost:4000");
  });
});
