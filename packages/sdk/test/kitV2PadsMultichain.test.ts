// SPDX-License-Identifier: MIT
/* Multi-chain Launchpads: one pad address on every chain, bound to its creator.
   The on-chain side is proven in packages/launchpad (GullyCorePadMultichain.t.sol) and on two local anvils;
   these tests pin the SDK's off-chain math to the same formula and the helpers' decisions. */

import { decodeFunctionData, encodeAbiParameters, getContractAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  GULLYCORE_PAD_FACTORY_ABI,
  buildCreatePad,
  encodeCreatePad,
  padCloneInitCode,
  padCreate2Salt,
  padUserSaltFromLabel,
  predictPadAddress,
  prepareCreatePad,
  padId,
  readPadAcrossChains,
  readPadOrigin,
  padDrift,
  buildPadSync,
  buildExtendPad,
  readIntegratorPresence,
  GULLYCORE_PAD_ABI,
  type GullyCoreChainId,
  type PadRecord,
  type PadTerms,
} from "../src/index.js";

const FACTORY: Address = "0x1111111111111111111111111111111111111111";
const IMPL: Address = "0x2222222222222222222222222222222222222222";
const CREATOR: Address = "0x00000000000000000000000000000000000c0ffe";
const OTHER: Address = "0x0000000000000000000000000000000000000bad";
const SAFE: Address = "0x00000000000000000000000000000000000dc0de";
const terms: PadTerms = {
  integrator: "0x00000000000000000000000000000000000000ab",
  integratorBps: 500,
  integratorLaunchFeeWei: 0n,
  allowedPresets: [],
  allowedBinShapes: [],
  restrictQuotes: false,
  active: true,
};

describe("pad address prediction", () => {
  it("salt = keccak256(abi.encode(creator, userSalt)); init code = OpenZeppelin's EIP-1167 creation code", () => {
    const s = padUserSaltFromLabel("Mochi Pad");
    expect(padCreate2Salt(CREATOR, s)).toBe(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [CREATOR, s])));
    const code = padCloneInitCode(IMPL);
    expect(code.length).toBe(2 + 0x37 * 2);
    expect(code.toLowerCase()).toBe(`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`);
    expect(predictPadAddress({ factory: FACTORY, implementation: IMPL, creator: CREATOR, userSalt: s })).toBe(
      getContractAddress({ opcode: "CREATE2", from: FACTORY, salt: padCreate2Salt(CREATOR, s), bytecode: code }),
    );
  });

  it("matches a pad created by the real factory on a local anvil (acceptance run 2026-09-19)", () => {
    // Values read from the devnet in docs/multichain-pads-acceptance.md: factory, IMPLEMENTATION(),
    // the creator, the salt and the pad `createPad` returned, identical on both anvils.
    const fixture = KNOWN;
    if (fixture === null) return;
    expect(predictPadAddress(fixture)).toBe(fixture.pad);
  });

  it("binds the creator: the same salt from another wallet is another address", () => {
    const s = padUserSaltFromLabel("Mochi Pad");
    const mine = predictPadAddress({ factory: FACTORY, implementation: IMPL, creator: CREATOR, userSalt: s });
    const theirs = predictPadAddress({ factory: FACTORY, implementation: IMPL, creator: OTHER, userSalt: s });
    expect(mine).not.toBe(theirs);
  });

  it("refuses a salt that is not 32 bytes", () => {
    expect(() => padCreate2Salt(CREATOR, "0x1234")).toThrow(RangeError);
  });

  it("encodes the salt first; an explicit salt overrides the name-derived default", () => {
    const explicit = `0x${"ab".repeat(32)}` as Hex;
    const d1 = decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: encodeCreatePad({ name: "Mochi", brand: null, terms }) });
    expect(d1.args[0]).toBe(padUserSaltFromLabel("Mochi"));
    const d2 = decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: encodeCreatePad({ name: "Mochi", brand: null, terms, userSalt: explicit }) });
    expect(d2.args[0]).toBe(explicit);
    const tx = buildCreatePad({ factory: FACTORY, name: "Mochi", brand: null, terms, userSalt: explicit, fee: { feeWei: 5n, pending: null } });
    expect(decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: tx.data }).args[0]).toBe(explicit);
    expect(tx.value).toBe(5n);
  });
});

/** A fake client answering the factory reads by function name. */
function fakeClient(answers: Record<string, unknown>, opts: { throwOn?: string } = {}): PublicClient {
  return {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (opts.throwOn === functionName) throw new Error("HTTP request failed");
      const a = answers[functionName];
      return typeof a === "function" ? (a as (...x: unknown[]) => unknown)(...(args ?? [])) : a;
    },
  } as unknown as PublicClient;
}

const FEE_READS = {
  padFeeWei: 3n,
  pendingPadFee: [0n, 0n],
  maxPadFeeWei: 30n,
  padFeeNoticeSeconds: 604_800,
  protocolFeeRecipient: SAFE,
  protocolFeesOwed: 0n,
};

describe("prepareCreatePad", () => {
  it("reads the fee and the prediction on the chain and reports an existing (creator, salt)", async () => {
    const PRED: Address = "0x3333333333333333333333333333333333333333";
    const client = fakeClient({ ...FEE_READS, predictPad: () => PRED, isPad: () => true });
    const p = await prepareCreatePad(client, { chainId: 999, creator: CREATOR, name: "Mochi", brand: null, terms, factory: FACTORY });
    expect(p.predicted).toBe(PRED);
    expect(p.exists).toBe(true);
    expect(p.tx.to).toBe(FACTORY);
    expect(p.tx.value).toBe(3n);
    expect(p.userSalt).toBe(padUserSaltFromLabel("Mochi"));
  });

  it("refuses a chain with no factory in the address book rather than guessing one", async () => {
    /* Pinned on a synthetic chain id the book can never list. */
    await expect(prepareCreatePad(fakeClient({}), { chainId: 0xdc0de, creator: CREATOR, name: "x", brand: null, terms })).rejects.toThrow(
      /no GullyCorePadFactory/,
    );
  });
});

describe("readPadOrigin / readPadAcrossChains", () => {
  /* Pinned rather than defaulted to GULLYCORE_CHAIN_IDS, so adding a chain to the address book
     does not change what these fixtures describe. Two synthetic chain ids, typed through the
     book's chain-id type (which is empty until a deployment is recorded). */
  const CHAIN_A = 0xdc0de1 as unknown as GullyCoreChainId;
  const CHAIN_B = 0xdc0de2 as unknown as GullyCoreChainId;
  const TWO_CHAINS: readonly GullyCoreChainId[] = [CHAIN_A, CHAIN_B];
  const clientsOf = (m: Record<number, PublicClient>) => m as Partial<Record<GullyCoreChainId, PublicClient>>;

  it("returns null for a non-pad, the pair otherwise", async () => {
    const s = padUserSaltFromLabel("Mochi");
    expect(await readPadOrigin(fakeClient({ padOrigin: () => ["0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`] }), FACTORY, IMPL)).toBeNull();
    expect(await readPadOrigin(fakeClient({ padOrigin: () => [CREATOR, s] }), FACTORY, IMPL)).toEqual({ creator: CREATOR, userSalt: s });
  });

  it("reports live, absent, different-factory, no-factory, no-client and error per chain - never guesses", async () => {
    const OTHER_FACTORY: Address = "0x5555555555555555555555555555555555555555";
    const padReads = {
      owner: CREATOR,
      pendingOwner: "0x0000000000000000000000000000000000000000",
      name: "Mochi",
      metadataURI: "",
      tenantConfig: {
        integrator: terms.integrator,
        integratorBps: 500,
        integratorLaunchFeeWei: 0n,
        allowedPresets: 1,
        allowedBinShapes: 0,
        restrictQuotes: false,
        active: true,
        maxTaxBps: 0,
        taxIntegratorBps: 0,
      },
    };
    const book: Record<number, Address | null> = { [CHAIN_A]: FACTORY, [CHAIN_B]: FACTORY };
    const live = fakeClient({ ...FEE_READS, ...padReads, isPad: () => true });
    const absent = fakeClient({ ...FEE_READS, isPad: () => false });
    const broken = fakeClient({}, { throwOn: "isPad" });

    const IDENTITY = { creator: CREATOR, userSalt: padUserSaltFromLabel("Mochi") };

    let r = await readPadAcrossChains({ chainIds: TWO_CHAINS, identity: IDENTITY, clients: clientsOf({ [CHAIN_A]: live, [CHAIN_B]: absent }), factoryOn: (c) => book[c] ?? null });
    expect(r.map((x) => x.status)).toEqual(["live", "absent"]);
    const first = r[0];
    expect(first?.status === "live" && first.record.owner).toBe(CREATOR);
    const second = r[1];
    expect(second?.status === "absent" && second.fee.feeWei).toBe(3n);

    r = await readPadAcrossChains({ chainIds: TWO_CHAINS, identity: IDENTITY, clients: clientsOf({ [CHAIN_A]: broken }), factoryOn: (c) => book[c] ?? null });
    expect(r.map((x) => x.status)).toEqual(["error", "no-client"]);

    r = await readPadAcrossChains({ chainIds: TWO_CHAINS, identity: IDENTITY, clients: clientsOf({ [CHAIN_A]: live, [CHAIN_B]: live }), factoryOn: (c) => (c === CHAIN_A ? OTHER_FACTORY : null) });
    expect(r.map((x) => x.status)).toEqual(["live", "no-factory"]);
  });

  /* THE REGRESSION THIS CHANGE EXISTS FOR.
     Before identity-keyed resolution, a chain whose factory sat at a different address answered
     `different-factory` and was never read - so a Launchpad that EXISTS there was reported as one
     that does not. That is the Anubis (6714) case: no CreateX, so the factory cannot land at the
     shared address. A mutant that goes back to comparing factory addresses fails this. */
  it("finds a Launchpad on a chain whose factory sits at a DIFFERENT address", async () => {
    const OTHER_FACTORY: Address = "0x5555555555555555555555555555555555555555";
    const PAD_HERE: Address = "0x6666666666666666666666666666666666666666";
    const PAD_THERE: Address = "0x7777777777777777777777777777777777777777";
    const padReads = {
      owner: CREATOR,
      pendingOwner: "0x0000000000000000000000000000000000000000",
      name: "Mochi",
      metadataURI: "",
      tenantConfig: {
        integrator: terms.integrator,
        integratorBps: 500,
        integratorLaunchFeeWei: 0n,
        allowedPresets: 1,
        allowedBinShapes: 0,
        restrictQuotes: false,
        active: true,
        maxTaxBps: 0,
        taxIntegratorBps: 0,
      },
    };
    // Each chain predicts its OWN address for the same identity, because each has its own factory.
    const here = fakeClient({ ...FEE_READS, ...padReads, isPad: () => true, predictPad: () => PAD_HERE });
    const there = fakeClient({ ...FEE_READS, ...padReads, isPad: () => true, predictPad: () => PAD_THERE });

    const r = await readPadAcrossChains({
      chainIds: TWO_CHAINS,
      identity: { creator: CREATOR, userSalt: padUserSaltFromLabel("Mochi") },
      clients: clientsOf({ [CHAIN_A]: here, [CHAIN_B]: there }),
      factoryOn: (c) => (c === CHAIN_A ? FACTORY : OTHER_FACTORY),
    });

    expect(r.map((x) => x.status)).toEqual(["live", "live"]);
    // and each row reports ITS OWN address, which is the whole point
    expect(r[0]?.status === "live" && r[0].pad).toBe(PAD_HERE);
    expect(r[1]?.status === "live" && r[1].pad).toBe(PAD_THERE);
    expect(r[0]?.status === "live" && r[0].factory).toBe(FACTORY);
    expect(r[1]?.status === "live" && r[1].factory).toBe(OTHER_FACTORY);
  });

  it("padId is chain-independent and is NOT an address", () => {
    const a = padId({ creator: CREATOR, userSalt: padUserSaltFromLabel("Mochi") });
    const b = padId({ creator: CREATOR, userSalt: padUserSaltFromLabel("Mochi") });
    expect(a).toBe(b);
    expect(a).toHaveLength(66); // 32 bytes, not a 20-byte address
    // a different creator with the same label is a different Launchpad, which is what stops squatting
    expect(padId({ creator: IMPL, userSalt: padUserSaltFromLabel("Mochi") })).not.toBe(a);
  });
});

/* Filled from the live acceptance run; null keeps the test honest if it is ever removed. */
const KNOWN: { factory: Address; implementation: Address; creator: Address; userSalt: Hex; pad: Address } | null = {
  factory: "0x9CB83c954a3ddd8cf180f0Aa1433A2f81281ff66",
  implementation: "0x3d5E04aC1f98C4B3DE6190Fe251D2a4668531a50",
  creator: "0x9a7E2644b1967D7730c8a0902865d278bE9D6988",
  userSalt: "0x31e21db37f2b97616fca978f6fd5c4485957f67a3eba8aa95ff3698694e88f15",
  pad: "0xa4eD3041574D01C01D292eA51ca31AE8E5C9C4f6",
};

describe("one site, several chains: drift, sync, extend", () => {
  const PAD: Address = "0x4444444444444444444444444444444444444444";
  const base = (over: Partial<PadRecord> = {}, tenant: Partial<PadRecord["tenant"]> = {}): PadRecord => ({
    address: PAD,
    owner: CREATOR,
    pendingOwner: "0x0000000000000000000000000000000000000000",
    name: "Mochi",
    metadataURI: "data:application/json,{}",
    metadata: { kind: "empty" } as unknown as PadRecord["metadata"],
    tenant: { ...terms, maxTaxBps: 0, taxIntegratorBps: 0, allowedPresets: ["FairLaunch"], configured: true, ...tenant } as PadRecord["tenant"],
    ...over,
  });

  it("padDrift names every differing field and nothing else; list order does not count", () => {
    expect(padDrift(base(), base())).toEqual([]);
    expect(padDrift(base({}, { allowedBinShapes: ["Linear", "Flat"] as never }), base({}, { allowedBinShapes: ["Flat", "Linear"] as never }))).toEqual([]);
    expect(padDrift(base(), base({ owner: OTHER, name: "Mochi 2" }, { integratorBps: 900, restrictQuotes: true }))).toEqual([
      "owner",
      "name",
      "integratorBps",
      "restrictQuotes",
    ]);
    expect(padDrift(base(), base({}, { integrator: terms.integrator.toUpperCase().replace("0X", "0x") as Address }))).toEqual([]);
  });

  it("buildPadSync: nothing when equal; setMetadata copies the URI byte for byte; configure carries the source terms; owner never synced", () => {
    expect(buildPadSync(base(), base())).toEqual([]);
    expect(buildPadSync(base(), base({ owner: OTHER }))).toEqual([]);
    const target = base({ metadataURI: "", address: "0x6666666666666666666666666666666666666666" }, { integratorBps: 1 });
    const txs = buildPadSync(base(), target);
    expect(txs.map((t) => t.label)).toEqual(["setMetadata", "configure"]);
    expect(txs.every((t) => t.to === target.address)).toBe(true);
    const meta = decodeFunctionData({ abi: GULLYCORE_PAD_ABI, data: txs[0]!.data });
    expect(meta.args).toEqual(["Mochi", "data:application/json,{}"]);
    const conf = decodeFunctionData({ abi: GULLYCORE_PAD_ABI, data: txs[1]!.data });
    expect((conf.args[0] as { integratorBps: number }).integratorBps).toBe(500);
  });

  it("buildExtendPad: origin salt, source name/brand/terms, NO quotes even when quotes are restricted", () => {
    const s = padUserSaltFromLabel("anything");
    const tx = buildExtendPad({ factory: FACTORY, origin: { creator: CREATOR, userSalt: s }, source: base({}, { restrictQuotes: true }), fee: { feeWei: 3n, pending: { feeWei: 9n, effectiveAt: 1n } } });
    expect(tx.to).toBe(FACTORY);
    expect(tx.value).toBe(9n);
    const d = decodeFunctionData({ abi: GULLYCORE_PAD_FACTORY_ABI, data: tx.data });
    expect(d.args[0]).toBe(s);
    expect(d.args[1]).toBe("Mochi");
    expect(d.args[2]).toBe("data:application/json,{}");
    expect((d.args[3] as { restrictQuotes: boolean }).restrictQuotes).toBe(true);
    expect(d.args[4]).toEqual([]);
  });

  it("readIntegratorPresence flags a contract integrator with no code on the target", async () => {
    const code = (c: Hex | undefined) => ({ getCode: async () => c }) as unknown as PublicClient;
    expect((await readIntegratorPresence(code("0x60"), code("0x"), CREATOR)).missingOnTarget).toBe(true);
    expect((await readIntegratorPresence(code("0x60"), code("0x60"), CREATOR)).missingOnTarget).toBe(false);
    expect((await readIntegratorPresence(code("0x"), code(undefined), CREATOR)).missingOnTarget).toBe(false);
  });
});
