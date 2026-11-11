// SPDX-License-Identifier: MIT
/* More than one kit generation on one chain (2026-09-28: the quote-fee guards ship with a new kit, a
   new LaunchLegs and a new GullyCorePadFactory; the lockers and the token factory are reused). A reader
   must serve every generation, dedupe what they share, and send a NEW launch or Launchpad to the
   current generation only. */

import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_CHAIN_IDS,
  GULLYCORE_DEPLOYMENTS,
  envOfLaunch,
  launchpadV2Addresses,
  launchpadV2GenerationOf,
  launchpadV2Generations,
  mergeEarningsPlans,
  mergeLaunchScans,
  padFactoriesOn,
  padFactoryOn,
  padSlugFactoriesOn,
  assignPadSlugs,
  padUserSaltFromLabel,
  readPadAcrossChains,
  readPadNamesAcross,
  readPadsAcross,
  requireLaunchpadV2,
  scanOfLaunch,
  type GullyCoreChainId,
  type GullyCoreDeployment,
  type EarningsPlanV2,
  type KitV2Env,
  type LaunchpadV2Deployment,
  type LaunchRecordV2,
  type LaunchScanV2,
} from "../src/index.js";

/* Two synthetic chain ids, typed through the book's chain-id type (empty until a deployment is recorded). */
const CHAIN_A = 0xdc0de1 as unknown as GullyCoreChainId;
const CHAIN_B = 0xdc0de2 as unknown as GullyCoreChainId;
const clientsOf = (m: Record<number, PublicClient>) => m as Partial<Record<GullyCoreChainId, PublicClient>>;

const a = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

const CL_LOCKER = a(0x11);
const BIN_LOCKER = a(0x12);
const TOKEN_FACTORY = a(0x13);
const KIT_OLD = a(0x21);
const KIT_NEW = a(0x31);
const PADS_OLD = a(0x28);
const PADS_NEW = a(0x38);

const OLD: LaunchpadV2Deployment = {
  launchpadKitV2: KIT_OLD,
  launchLegs: a(0x22),
  launchTokenFactory: TOKEN_FACTORY,
  clLPLocker: CL_LOCKER,
  binLPLocker: BIN_LOCKER,
  clLaunchGuardHook: a(0x24),
  binLaunchGuardHook: a(0x25),
  padFactory: PADS_OLD,
};
const NEW: LaunchpadV2Deployment = {
  launchpadKitV2: KIT_NEW,
  launchLegs: a(0x32),
  launchTokenFactory: TOKEN_FACTORY,
  clLPLocker: CL_LOCKER,
  binLPLocker: BIN_LOCKER,
  clLaunchGuardHook: a(0x34),
  binLaunchGuardHook: a(0x35),
  padFactory: PADS_NEW,
};
const BOOK = { launchpadV2: NEW, launchpadV2Retired: [OLD] };

describe("launchpadV2Generations / launchpadV2Addresses / launchpadV2GenerationOf", () => {
  it("lists the current generation first, then the retired ones", () => {
    expect(launchpadV2Generations(BOOK)).toEqual([NEW, OLD]);
  });

  it("reads both kits, both guards and both pad factories, and each shared locker and token factory ONCE", () => {
    expect(launchpadV2Addresses(BOOK, "launchpadKitV2")).toEqual([KIT_NEW, KIT_OLD]);
    expect(launchpadV2Addresses(BOOK, "clLaunchGuardHook")).toEqual([a(0x34), a(0x24)]);
    expect(launchpadV2Addresses(BOOK, "padFactory")).toEqual([PADS_NEW, PADS_OLD]);
    expect(launchpadV2Addresses(BOOK, "clLPLocker")).toEqual([CL_LOCKER]);
    expect(launchpadV2Addresses(BOOK, "binLPLocker")).toEqual([BIN_LOCKER]);
    expect(launchpadV2Addresses(BOOK, "launchTokenFactory")).toEqual([TOKEN_FACTORY]);
  });

  it("dedupes case-insensitively and keeps the first spelling", () => {
    const mixed = { launchpadV2: NEW, launchpadV2Retired: [{ ...OLD, clLPLocker: CL_LOCKER.toUpperCase().replace("0X", "0x") as Address }] };
    expect(launchpadV2Addresses(mixed, "clLPLocker")).toEqual([CL_LOCKER]);
  });

  it("says which generation a kit or guard belongs to, and a shared locker belongs to the newest", () => {
    expect(launchpadV2GenerationOf(BOOK, KIT_NEW)).toEqual({ generation: NEW, current: true, index: 0 });
    expect(launchpadV2GenerationOf(BOOK, KIT_OLD.toUpperCase().replace("0X", "0x"))).toEqual({ generation: OLD, current: false, index: 1 });
    expect(launchpadV2GenerationOf(BOOK, a(0x24), "clLaunchGuardHook")?.generation).toBe(OLD);
    expect(launchpadV2GenerationOf(BOOK, CL_LOCKER, "clLPLocker")?.current).toBe(true);
    expect(launchpadV2GenerationOf(BOOK, a(0x99))).toBeNull();
  });

  it("serves a book without a retired list, and leaves out a generation with no kit", () => {
    expect(launchpadV2Generations({ launchpadV2: NEW })).toEqual([NEW]);
    const empty: LaunchpadV2Deployment = { ...NEW, launchpadKitV2: null, padFactory: null };
    expect(launchpadV2Generations({ launchpadV2: empty, launchpadV2Retired: [OLD] })).toEqual([OLD]);
    expect(launchpadV2GenerationOf({ launchpadV2: empty, launchpadV2Retired: [OLD] }, KIT_OLD)?.current).toBe(false);
  });
});

describe("the address book's generations", () => {
  /* A property of every recorded chain; vacuous until a deployment is recorded. */
  const book: Readonly<Record<number, GullyCoreDeployment>> = GULLYCORE_DEPLOYMENTS;
  for (const id of GULLYCORE_CHAIN_IDS) {
    const d = book[id]!;
    it(`${d.name}: every retired generation is complete, distinct from the current kit, and new launches use the current one`, () => {
      expect(Array.isArray(d.launchpadV2Retired)).toBe(true);
      for (const g of d.launchpadV2Retired) {
        expect(Object.values(g).every((x) => x !== null), "a retired generation must be a whole, served stack").toBe(true);
        expect(g.launchpadKitV2?.toLowerCase()).not.toBe(d.launchpadV2.launchpadKitV2?.toLowerCase());
        expect(g.padFactory?.toLowerCase()).not.toBe(d.launchpadV2.padFactory?.toLowerCase());
        expect(g.clLaunchGuardHook?.toLowerCase()).not.toBe(d.launchpadV2.clLaunchGuardHook?.toLowerCase());
      }
      /* NEW launches and NEW Launchpads: the current generation only. */
      expect(padFactoryOn(id)).toBe(d.launchpadV2.padFactory);
      if (d.launchpadV2.launchpadKitV2 !== null) expect(requireLaunchpadV2(d).launchpadKitV2).toBe(d.launchpadV2.launchpadKitV2);
      /* Reading: every generation's factory, current first. */
      const factories = padFactoriesOn(id);
      if (d.launchpadV2.padFactory !== null) expect(factories[0]).toBe(d.launchpadV2.padFactory);
      expect(factories).toHaveLength((d.launchpadV2.padFactory === null ? 0 : 1) + d.launchpadV2Retired.length);
      /* Slugs: the oldest factory first, so an existing site keeps its link. */
      expect(padSlugFactoriesOn(id)).toEqual([...factories].reverse());
      /* GullyCoreLaunchAndBuy, where recorded, rides on the CURRENT kit only; there is nothing to check on chain here. */
      if (d.launchAndBuy !== null) expect(d.launchAndBuy).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  }

  it("serves no factory for a chain the book does not list", () => {
    expect(padFactoryOn(0xdc0de)).toBeNull();
    expect(padFactoriesOn(0xdc0de)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ pads --- */

/** A client that answers `readContract` by `<address>:<functionName>`, lowercased address. */
function addressedClient(answers: Record<string, unknown>): PublicClient {
  return {
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
      const key = `${address.toLowerCase()}:${functionName}`;
      if (!(key in answers)) throw new Error(`unexpected read ${key}`);
      const v = answers[key];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown)(...(args ?? [])) : v;
    },
    multicall: async () => {
      throw new Error("no multicall here");
    },
  } as unknown as PublicClient;
}

const TENANT = {
  integrator: a(0xab),
  integratorBps: 500,
  integratorLaunchFeeWei: 0n,
  allowedPresets: 1,
  allowedBinShapes: 0,
  restrictQuotes: false,
  active: true,
  maxTaxBps: 0,
  taxIntegratorBps: 0,
};
const padReads = (pad: Address, name: string): Record<string, unknown> => ({
  [`${pad.toLowerCase()}:owner`]: a(0xc0),
  [`${pad.toLowerCase()}:pendingOwner`]: a(0),
  [`${pad.toLowerCase()}:name`]: name,
  [`${pad.toLowerCase()}:metadataURI`]: "",
  [`${pad.toLowerCase()}:tenantConfig`]: TENANT,
});
const PAD_A = a(0x51);
const PAD_B = a(0x52);
const PAD_C = a(0x53);
const factoryReads = (factory: Address, pads: readonly Address[]): Record<string, unknown> => ({
  [`${factory.toLowerCase()}:padCount`]: BigInt(pads.length),
  [`${factory.toLowerCase()}:pads`]: (start: bigint, end: bigint) => pads.slice(Number(start), Number(end)),
});

describe("Launchpads of every generation's factory", () => {
  const client = addressedClient({
    ...factoryReads(PADS_NEW, [PAD_C]),
    ...factoryReads(PADS_OLD, [PAD_A, PAD_B]),
    ...padReads(PAD_A, "Alpha"),
    ...padReads(PAD_B, "Beta"),
    ...padReads(PAD_C, "Gamma"),
  });

  it("the directory lists the Launchpads of both factories, current factory first, each with its factory", async () => {
    const pads = await readPadsAcross(client, [PADS_NEW, PADS_OLD]);
    expect(pads.map((p) => [p.name, p.factory])).toEqual([
      ["Gamma", PADS_NEW],
      ["Alpha", PADS_OLD],
      ["Beta", PADS_OLD],
    ]);
  });

  it("slug names cover both factories; a factory listed twice is read once", async () => {
    const names = await readPadNamesAcross(client, [PADS_NEW, PADS_OLD, PADS_NEW], { multicallAddress: null });
    expect(names.map((n) => n.name)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("an existing site keeps its bare slug when a newer factory's site takes the same name (oldest factory first)", async () => {
    const same = addressedClient({
      ...factoryReads(PADS_NEW, [PAD_C]),
      ...factoryReads(PADS_OLD, [PAD_A]),
      ...padReads(PAD_A, "Mochi"),
      ...padReads(PAD_C, "Mochi"),
    });
    const slugs = assignPadSlugs(await readPadNamesAcross(same, [PADS_OLD, PADS_NEW], { multicallAddress: null }));
    expect(slugs.find((e) => e.address === PAD_A)?.slug).toBe("mochi");
    expect(slugs.find((e) => e.address === PAD_C)?.slug).not.toBe("mochi");
  });

  it("finds a Launchpad on the RETIRED factory, and says an absent one would be opened on the CURRENT one", async () => {
    const identity = { creator: a(0xc0), userSalt: padUserSaltFromLabel("Alpha") as Hex };
    const FEE = { padFeeWei: 3n, pendingPadFee: [0n, 0n], maxPadFeeWei: 30n, padFeeNoticeSeconds: 604_800, protocolFeeRecipient: a(0x5afe), protocolFeesOwed: 0n };
    const fee = (f: Address) => Object.fromEntries(Object.entries(FEE).map(([k, v]) => [`${f.toLowerCase()}:${k}`, v]));
    const onOld = addressedClient({
      [`${PADS_NEW.toLowerCase()}:predictPad`]: PAD_C,
      [`${PADS_NEW.toLowerCase()}:isPad`]: false,
      [`${PADS_OLD.toLowerCase()}:predictPad`]: PAD_A,
      [`${PADS_OLD.toLowerCase()}:isPad`]: true,
      ...padReads(PAD_A, "Alpha"),
      ...fee(PADS_NEW),
    });
    const nowhere = addressedClient({
      [`${PADS_NEW.toLowerCase()}:predictPad`]: PAD_C,
      [`${PADS_NEW.toLowerCase()}:isPad`]: false,
      [`${PADS_OLD.toLowerCase()}:predictPad`]: PAD_B,
      [`${PADS_OLD.toLowerCase()}:isPad`]: false,
      ...fee(PADS_NEW),
    });
    const r = await readPadAcrossChains({
      chainIds: [CHAIN_A, CHAIN_B],
      identity,
      clients: clientsOf({ [CHAIN_A]: onOld, [CHAIN_B]: nowhere }),
      factoriesOn: () => [PADS_NEW, PADS_OLD],
    });
    expect(r[0]?.status === "live" && [r[0].factory, r[0].pad]).toEqual([PADS_OLD, PAD_A]);
    expect(r[1]?.status === "absent" && [r[1].factory, r[1].pad]).toEqual([PADS_NEW, PAD_C]);
  });

  it("resolves an identity from a Launchpad of the retired factory", async () => {
    const identity = [a(0xc0), padUserSaltFromLabel("Alpha")] as const;
    const c = addressedClient({
      [`${PADS_NEW.toLowerCase()}:padOrigin`]: [a(0), `0x${"00".repeat(32)}`],
      [`${PADS_OLD.toLowerCase()}:padOrigin`]: identity,
      [`${PADS_NEW.toLowerCase()}:predictPad`]: PAD_C,
      [`${PADS_NEW.toLowerCase()}:isPad`]: false,
      [`${PADS_OLD.toLowerCase()}:predictPad`]: PAD_A,
      [`${PADS_OLD.toLowerCase()}:isPad`]: true,
      ...padReads(PAD_A, "Alpha"),
    });
    const r = await readPadAcrossChains({ chainIds: [CHAIN_A], pad: PAD_A, fromChainId: CHAIN_A, clients: clientsOf({ [CHAIN_A]: c }), factoriesOn: () => [PADS_NEW, PADS_OLD] });
    expect(r[0]?.status).toBe("live");
  });
});

/* -------------------------------------------------------------- launches --- */

const envOf = (kit: Address, clHook: Address): KitV2Env => ({ kit, clHook, clLocker: CL_LOCKER, binLocker: BIN_LOCKER }) as unknown as KitV2Env;
const launch = (kit: Address, token: number, block: bigint): LaunchRecordV2 => ({ kit, token: a(token), createdAtBlock: block }) as unknown as LaunchRecordV2;
const scan = (env: KitV2Env, launches: LaunchRecordV2[], now: bigint): LaunchScanV2 => ({ env, launches, fromBlock: 1n, atBlock: 100n, now });

describe("mergeLaunchScans", () => {
  const newScan = scan(envOf(KIT_NEW, a(0x34)), [launch(KIT_NEW, 0x901, 90n)], 1000n);
  const oldScan = scan(envOf(KIT_OLD, a(0x24)), [launch(KIT_OLD, 0x801, 95n), launch(KIT_OLD, 0x802, 10n)], 1005n);

  it("lists the launches of both kits, newest first, each saying which kit made it", () => {
    const m = mergeLaunchScans([newScan, oldScan]);
    expect(m.launches.map((l) => [l.kit, l.token])).toEqual([
      [KIT_OLD, a(0x801)],
      [KIT_NEW, a(0x901)],
      [KIT_OLD, a(0x802)],
    ]);
    expect(m.env.kit).toBe(KIT_NEW);
    expect(m.now).toBe(1005n);
    expect(m.scans).toHaveLength(2);
  });

  it("gives each launch its OWN kit's wiring, never the current kit's", () => {
    const m = mergeLaunchScans([newScan, oldScan]);
    const old = m.launches.find((l) => l.kit === KIT_OLD)!;
    expect(envOfLaunch(m, old)?.clHook).toBe(a(0x24));
    expect(scanOfLaunch(m, old)).toBe(oldScan);
    expect(envOfLaunch(m, { kit: a(0x99) })).toBeNull();
  });

  it("refuses to merge nothing", () => {
    expect(() => mergeLaunchScans([])).toThrow();
  });
});

describe("mergeEarningsPlans", () => {
  const credit = (from: "kit" | "locker" | "guard", key: string, contract: Address, currency: Address, amount: bigint, mayBeLaunchToken = false) =>
    ({ key, from, pools: null, contract, holds: "lp-fees", generation: null, currency, meta: null, amount, mayBeLaunchToken, claim: { to: contract, data: "0x" } }) as EarningsPlanV2["credits"][number];
  const ETH = a(0);
  const plan = (kit: Address, lockerAmount: bigint, mayBe: boolean): EarningsPlanV2 => ({
    account: a(0xc0),
    credits: [credit("kit", "kit", kit, ETH, kit === KIT_NEW ? 1n : 2n), credit("locker", `locker:CL:${ETH}`, CL_LOCKER, ETH, lockerAmount, mayBe)],
    pots: [],
    locks: [],
  });

  it("keeps each kit's launch-fee balance and counts a SHARED locker's balance once", () => {
    const m = mergeEarningsPlans([plan(KIT_NEW, 7n, false), plan(KIT_OLD, 7n, true)]);
    expect(m.credits.map((c) => [c.key, c.contract, c.amount])).toEqual([
      ["kit", KIT_NEW, 1n],
      [`locker:CL:${ETH}`, CL_LOCKER, 7n],
      [`kit:${KIT_OLD.toLowerCase()}`, KIT_OLD, 2n],
    ]);
    /* The old kit's legs may have paid launch tokens into the shared locker: say so. */
    expect(m.credits[1]?.mayBeLaunchToken).toBe(true);
  });
});
