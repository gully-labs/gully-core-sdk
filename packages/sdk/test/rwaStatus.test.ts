import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";

import { bandPercentEdges, readStockMarketStatus } from "../src/rwa/status.js";

/* A fake hook that implements MarketHoursModule's calendar rule (weekly window, day overrides,
   wrapping sessions) so the reader's next-open / next-close search is checked against the same
   semantics the contract enforces. */
const DAY = 86_400;
const HOOK = "0x7878f4043578584Db482009837E3eD6DBB37b978" as Address;
const ORACLE = "0x7878eC21E10614a6aB1fD4768A80D24591105578" as Address;
const POOL = `0x${"11".repeat(32)}` as Hex;

interface Cfg {
  configured: boolean;
  halted: boolean;
  sessionEnabled: boolean;
  weekdayMask: number;
  openSecondOfDay: number;
  closeSecondOfDay: number;
  oracle: Address;
  overrides: Record<number, { isSet: boolean; closed: boolean; openSecondOfDay: number; closeSecondOfDay: number }>;
}

function schedule(c: Cfg, day: number): [boolean, number, number] {
  const o = c.overrides[day];
  if (o?.isSet) return o.closed ? [false, 0, 0] : [true, o.openSecondOfDay, o.closeSecondOfDay];
  const weekday = (day + 4) % 7;
  if ((c.weekdayMask & (1 << weekday)) === 0) return [false, 0, 0];
  return [true, c.openSecondOfDay, c.closeSecondOfDay];
}
function openAt(c: Cfg, t: number): boolean {
  if (!c.sessionEnabled) return true;
  const day = Math.floor(t / DAY);
  const s = t % DAY;
  const [td, o, cl] = schedule(c, day);
  if (td && o !== cl) {
    if (o < cl) {
      if (s >= o && s < cl) return true;
    } else if (s >= o) return true;
  }
  const [yd, yo, yc] = schedule(c, day - 1);
  return yd && yo > yc && s < yc;
}

function fakeClient(c: Cfg, now: number): PublicClient {
  return {
    getBlock: async () => ({ number: 100n, timestamp: BigInt(now) }),
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      switch (functionName) {
        case "marketConfig":
          return {
            configured: c.configured,
            halted: c.halted,
            sessionEnabled: c.sessionEnabled,
            gateLiquidity: true,
            bandEnabled: true,
            weekdayMask: c.weekdayMask,
            openSecondOfDay: c.openSecondOfDay,
            closeSecondOfDay: c.closeSecondOfDay,
            issuer: HOOK,
            oracle: c.oracle,
            maxUpPpm: 100_000,
            maxDownPpm: 50_000,
            maxPriceAge: 0,
          };
        case "isTradable":
          return c.configured && !c.halted && openAt(c, now);
        case "isSessionOpenAt":
          return openAt(c, Number(args[1] as bigint));
        case "priceBand":
          return [true, 950_000n, 1_100_000n];
        case "dayOverride":
          return c.overrides[Number(args[1])] ?? { isSet: false, closed: false, openSecondOfDay: 0, closeSecondOfDay: 0 };
        case "referencePrice":
          return [79228162514264337593543950336n, BigInt(now - 60)];
        default:
          throw new Error(functionName);
      }
    },
  } as unknown as PublicClient;
}

/* 2026-10-12 is a Monday; day index 20_738. NYSE daylight window 13:30-20:00 UTC, Mon-Fri. */
const MONDAY = 20_738 * DAY;
const NYSE: Cfg = {
  configured: true,
  halted: false,
  sessionEnabled: true,
  weekdayMask: 0x3e,
  openSecondOfDay: 48_600,
  closeSecondOfDay: 72_000,
  oracle: ORACLE,
  overrides: {},
};

describe("readStockMarketStatus", () => {
  it("open now: reports the close, not an open", async () => {
    const s = await readStockMarketStatus(fakeClient(NYSE, MONDAY + 50_000), { hook: HOOK, poolId: POOL });
    expect(s.tradable).toBe(true);
    expect(s.sessionOpen).toBe(true);
    expect(s.nextClose).toBe(MONDAY + 72_000);
    expect(s.nextOpen).toBeNull();
    expect(s.reference?.updatedAt).toBe(MONDAY + 50_000 - 60);
    expect(bandPercentEdges(s.band)).toEqual({ down: 5, up: 10 });
  });

  it("Friday evening: the next open is Monday, across the weekend", async () => {
    const friday = MONDAY + 4 * DAY;
    const s = await readStockMarketStatus(fakeClient(NYSE, friday + 73_000), { hook: HOOK, poolId: POOL });
    expect(s.sessionOpen).toBe(false);
    expect(s.nextOpen).toBe(MONDAY + 7 * DAY + 48_600);
    expect(s.nextClose).toBeNull();
  });

  it("an issuer holiday on the next trading day is skipped, an early close is honoured", async () => {
    const tuesday = 20_739;
    const cfg: Cfg = {
      ...NYSE,
      overrides: {
        [tuesday]: { isSet: true, closed: true, openSecondOfDay: 0, closeSecondOfDay: 0 },
        [tuesday + 1]: { isSet: true, closed: false, openSecondOfDay: 48_600, closeSecondOfDay: 61_200 },
      },
    };
    const closedMonday = await readStockMarketStatus(fakeClient(cfg, MONDAY + 73_000), { hook: HOOK, poolId: POOL });
    expect(closedMonday.nextOpen).toBe((tuesday + 1) * DAY + 48_600);
    const openWednesday = await readStockMarketStatus(fakeClient(cfg, (tuesday + 1) * DAY + 50_000), { hook: HOOK, poolId: POOL });
    expect(openWednesday.nextClose).toBe((tuesday + 1) * DAY + 61_200);
  });

  it("a wrapping 24/5 session closes on the day boundary the next day's schedule ends it", async () => {
    /* open 00:00:01..00:00:00 next day style: open 1 s after midnight, close at midnight (wrap) */
    const cfg: Cfg = { ...NYSE, weekdayMask: 0x1f, openSecondOfDay: 3_600, closeSecondOfDay: 3_599 };
    const s = await readStockMarketStatus(fakeClient(cfg, MONDAY + 10_000), { hook: HOOK, poolId: POOL });
    expect(s.sessionOpen).toBe(true);
    expect(s.nextClose).not.toBeNull();
    expect(s.nextClose! > MONDAY + 10_000).toBe(true);
  });

  it("halted: not tradable while the calendar is open; no calendar: no next open or close", async () => {
    const halted = await readStockMarketStatus(fakeClient({ ...NYSE, halted: true }, MONDAY + 50_000), { hook: HOOK, poolId: POOL });
    expect(halted.tradable).toBe(false);
    expect(halted.sessionOpen).toBe(true);
    const allDay = await readStockMarketStatus(fakeClient({ ...NYSE, sessionEnabled: false }, MONDAY + 50_000), { hook: HOOK, poolId: POOL });
    expect(allDay.nextOpen).toBeNull();
    expect(allDay.nextClose).toBeNull();
    expect(allDay.tradable).toBe(true);
  });

  it("no oracle: reference is null", async () => {
    const s = await readStockMarketStatus(fakeClient({ ...NYSE, oracle: "0x0000000000000000000000000000000000000000" }, MONDAY + 50_000), { hook: HOOK, poolId: POOL });
    expect(s.oracle).toBeNull();
    expect(s.reference).toBeNull();
  });
});
