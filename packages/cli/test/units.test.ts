import { describe, expect, it } from "vitest";

import { bpsPercent, decimalToRawFloor, formatSignificant, formatUnitsTrim, humanSeconds, parsePercentBps, parseUnitsExact, pipsPercent } from "../src/lib/amounts.js";
import { mergeDeployment, parseChain, requireFeature, resolveChain } from "../src/lib/chain.js";
import { getDeployment } from "@gullylabs/core-sdk";
import { parsePayees } from "../src/commands/utilities.js";

describe("amounts", () => {
  it("parses exactly and refuses excess precision", () => {
    expect(parseUnitsExact("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseUnitsExact("1_000,000", 0)).toBe(1_000_000n);
    expect(() => parseUnitsExact("0.0000001", 6)).toThrow(/more than 6/);
    expect(() => parseUnitsExact("-1", 18)).toThrow();
    expect(() => parseUnitsExact("1e5", 18)).toThrow();
  });

  it("reads toPrecision output, exponent form included, rounding down", () => {
    expect(decimalToRawFloor("3.5000000e-9", 18)).toBe(3_500_000_000n);
    expect(decimalToRawFloor("0.0000000035", 18)).toBe(3_500_000_000n);
    expect(decimalToRawFloor("1.2345678e+3", 6)).toBe(1_234_567_800n);
    expect(decimalToRawFloor("1.23456789", 2)).toBe(123n);
  });

  it("formats", () => {
    expect(formatUnitsTrim(1_234_500_000_000_000_000_000n, 18)).toBe("1,234.5");
    expect(formatSignificant(3_512_345_678n, 18, 3)).toBe("0.00000000351");
    expect(bpsPercent(2000)).toBe("20%");
    expect(bpsPercent(25)).toBe("0.25%");
    expect(bpsPercent(1050)).toBe("10.5%");
    expect(pipsPercent(100_000)).toBe("10%");
    expect(pipsPercent(3_000)).toBe("0.3%");
    expect(humanSeconds(300)).toBe("5 min");
    expect(humanSeconds(86_400 * 30)).toBe("30 days");
    expect(parsePercentBps("2.5%", "x", 10_000)).toBe(250);
    expect(() => parsePercentBps("11", "tax", 1_000)).toThrow(/maximum of 10%/);
  });
});

describe("chains", () => {
  it("resolves names from the address book and refuses unknown ones", () => {
    expect(parseChain("robinhood")).toBe(4663);
    expect(parseChain("Robinhood Chain")).toBe(4663);
    expect(parseChain("sepolia")).toBe(11155111);
    expect(parseChain("8453")).toBe(8453);
    expect(() => parseChain("atlantis")).toThrow(/unknown chain/);
  });

  it("merges an override, and refuses a numeric deployedAtBlock", () => {
    const base = getDeployment(999);
    const m = mergeDeployment(base, 999, { deployedAtBlock: "1", launchpadV2: { padFactory: "0x0000000000000000000000000000000000000001" } });
    expect(m.deployedAtBlock).toBe(1n);
    expect(m.launchpadV2.padFactory).toBe("0x0000000000000000000000000000000000000001");
    expect(m.launchpadV2.launchpadKitV2).toBe(base?.launchpadV2.launchpadKitV2 ?? null);
    expect(m.vault).toBe(base?.vault);
    expect(() => mergeDeployment(base, 999, { deployedAtBlock: 1 })).toThrow(/must be a string/);
    expect(() => mergeDeployment(base, 999, { chainId: 1 })).toThrow(/is for chain 1/);
  });

  it("says plainly when a chain has no deployment, and fabricates nothing", () => {
    /* Only the chains in the address book have one. Every other target resolves with no deployment. */
    expect(resolveChain({ chain: "gully-testnet", env: {} }).deployment).not.toBeNull();
    expect(resolveChain({ chain: "anubis", env: {} }).deployment).not.toBeNull();
    for (const chain of ["hyperevm", "sepolia"]) {
      const ctx = resolveChain({ chain, env: {} });
      expect(ctx.deployment).toBeNull();
      expect(() => requireFeature(ctx, "Launches", null)).toThrow(/^Gully Core has no deployment on /);
    }
  });

  it("takes RPC and addresses from the SDK's env names", () => {
    const ctx = resolveChain({ chain: "999", env: { GULLYCORE_RPC_999: "http://127.0.0.1:9", GULLYCORE_DEPLOYMENT_OVERRIDE_999: '{"deployedAtBlock":"7"}' } });
    expect(ctx.rpcUrls[0]).toBe("http://127.0.0.1:9");
    expect(ctx.overrideSource).toBe("inline JSON");
    expect(ctx.deployment?.deployedAtBlock).toBe(7n);
  });
});

describe("split payees", () => {
  it("parses address:percent and requires 100%", () => {
    const p = parsePayees("0x70997970C51812dc3A010C7d01b50e0d17dc79C8:60,0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC:40:ops");
    expect(p.map((x) => x.weight)).toEqual([6000, 4000]);
    expect(p[1]?.label).toBe("ops");
    expect(() => parsePayees("0x70997970C51812dc3A010C7d01b50e0d17dc79C8:60")).toThrow(/60%, not 100%/);
  });
});

describe("a user-supplied RPC is used alone", () => {
  it("never mixes the chain's public endpoints in when GULLYCORE_RPC_<id> or --rpc is set", () => {
    const viaEnv = resolveChain({ chain: "robinhood", env: { GULLYCORE_RPC_4663: "http://127.0.0.1:8561" } });
    expect(viaEnv.rpcUrls).toEqual(["http://127.0.0.1:8561"]);
    expect(viaEnv.rpcFromUser).toBe(true);
    const viaFlag = resolveChain({ chain: "robinhood", rpc: "http://a.local,http://b.local", env: { GULLYCORE_RPC_4663: "http://c.local" } });
    expect(viaFlag.rpcUrls).toEqual(["http://a.local", "http://b.local"]);
    const pub = resolveChain({ chain: "robinhood", env: {} });
    expect(pub.rpcFromUser).toBe(false);
    expect(pub.rpcUrls.length).toBeGreaterThan(0);
  });
});
