// SPDX-License-Identifier: MIT
/**
 * `GullyCoreCreatorVesting` helpers: the allocation cap, the fixed 30-day cliff + 180-day linear schedule, the carved
 * launch params and the calldata. The constants are the contract's (gully-ops launch-periphery).
 */

import { decodeFunctionData, toFunctionSelector, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  CREATOR_VESTING_CLIFF_SECONDS,
  CREATOR_VESTING_DURATION_SECONDS,
  CREATOR_VESTING_MAX_ALLOCATION_BPS,
  GULLYCORE_CREATOR_VESTING_ABI,
  buildCreatorVestingParams,
  creatorAllocation,
  creatorVestingSchedule,
  encodeLaunchVested,
  isCreatorVestingLock,
  withCreatorAllocation,
} from "../src/launchpad/kitV2/creatorVesting.js";

const SUPPLY = 1_000_000_000n * 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const TOKEN = "0x00000000000000000000000000000000000000ff" as Address;
const VESTING = "0x0000000000000000000000000000000000C0FFEE" as Address;

describe("creator vesting", () => {
  it("caps the allocation at 5%", () => {
    expect(CREATOR_VESTING_MAX_ALLOCATION_BPS).toBe(500);
    expect(creatorAllocation(SUPPLY, 500)).toBe(50_000_000n * 10n ** 18n);
    expect(() => creatorAllocation(SUPPLY, 0)).toThrow(RangeError);
    expect(() => creatorAllocation(SUPPLY, 501)).toThrow(RangeError);
    expect(() => buildCreatorVestingParams({ allocationBps: 1.5, maxFeesWei: 0n, expectedToken: TOKEN })).toThrow(RangeError);
  });

  it("fixes the schedule: 30 days, then 180 days linear", () => {
    expect(CREATOR_VESTING_CLIFF_SECONDS).toBe(2_592_000n);
    expect(CREATOR_VESTING_DURATION_SECONDS).toBe(15_552_000n);
    const s = creatorVestingSchedule(1_000n);
    expect(s.start).toBe(s.cliff);
    expect(s.cliff).toBe(1_000n + 2_592_000n);
    expect(s.end).toBe(s.cliff + 15_552_000n);
  });

  it("carves the allocation out of the seed and leaves the recipient to the contract", () => {
    const p = withCreatorAllocation({ totalSupply: SUPPLY, seedSupply: SUPPLY, allocationRecipient: TOKEN, name: "x" }, 250);
    expect(p.seedSupply).toBe(SUPPLY - SUPPLY / 40n);
    expect(p.allocationRecipient).toBe(ZERO);
    expect(p.name).toBe("x");
  });

  it("has the compiled contract's selectors (forge methodIdentifiers)", () => {
    const sel = (name: string) => toFunctionSelector(GULLYCORE_CREATOR_VESTING_ABI.find((e) => e.type === "function" && e.name === name) as never);
    expect(sel("launchVested")).toBe("0x9354543b");
    expect(sel("launchVestedAndBuy")).toBe("0x4bf7e8d8");
    expect(sel("predictLaunchToken")).toBe("0x19b0aa96");
  });

  it("encodes launchVested and recognises a creator lock", () => {
    const params = {
      name: "A", symbol: "A", metadataURI: "ipfs://x", userSalt: `0x${"11".repeat(32)}`, totalSupply: SUPPLY, seedSupply: SUPPLY - SUPPLY / 20n,
      allocationRecipient: ZERO, creator: ZERO, launchOperator: ZERO, launchSteward: ZERO, tenant: ZERO, integrator: ZERO, integratorBps: 0,
      integratorLaunchFeeWei: 0n, creatorBps: 5_000, protocolBps: 5_000,
      schedule: { preset: 0, initialFeeBips: 500_000, finalFeeBips: 10_000, decaySeconds: 60, enabled: true, startDelaySeconds: 0 },
      tax: { buyBps: 0, sellBps: 0, taxSeconds: 0, creatorBps: 0, protocolBps: 0, integratorBps: 0 },
      legs: [{ kind: 0, quote: ZERO, weightBps: 10_000, maxBuyPerTx: 0n, cl: { tickSpacing: 60, sqrtPriceX96: 1n << 96n, tickLower: -600, tickUpper: 0 }, bin: { binStep: 0, activeId: 0, shape: 0, binCount: 0, offsets: [], weights: [], floorBins: 0 } }],
      listing: { description: "", websiteURI: "", xHandle: "", telegramHandle: "" },
    };
    const v = buildCreatorVestingParams({ allocationBps: 500, maxFeesWei: 10n ** 16n, expectedToken: TOKEN });
    const d = decodeFunctionData({ abi: GULLYCORE_CREATOR_VESTING_ABI, data: encodeLaunchVested(params, v) });
    expect(d.functionName).toBe("launchVested");
    expect(v.beneficiary).toBe(ZERO);
    expect(isCreatorVestingLock({ creator: VESTING.toLowerCase() as Address }, VESTING)).toBe(true);
    expect(isCreatorVestingLock({ creator: TOKEN }, VESTING)).toBe(false);
  });
});
