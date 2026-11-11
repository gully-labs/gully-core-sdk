// SPDX-License-Identifier: MIT
/* ============================================================================
   THE US EQUITY CLOCK: which session the US stock market is in at an instant,
   and when a feed's session last ended.

   A premium is only honest when it says WHAT it compares against. During a live
   session a tokenised-stock price is compared with the feed's live print; when the
   market is shut it is compared with the last print before the close, and the board
   says "vs last close". Both need the exchange calendar, so it lives here.

   THE CALENDAR IS A TRANSCRIPTION, NOT A RULE. Holidays and early closes are the
   exchange's published list (https://www.nyse.com/markets/hours-calendars, read
   2026-10-13, section "Holidays and Trading Hours"), New York calendar dates. A year
   that is not listed has NO data: `calendarCovered` is false and a caller must not
   guess (the premium module refuses to compare). Add a year by reading the page,
   never by computing Easter.

   SESSIONS (New York local time, the regular ones from the exchange, the extended
   ones from Chainlink's own `us_equities_24/5` schedule, quoted in
   `rwa/marketHours.ts`):
     overnight  20:00 the evening before a trading day -> 04:00
     pre        04:00 -> 09:30
     open       09:30 -> 16:00 (13:00 on an early-close day)
     after      close -> 20:00
     closed     weekends, and the evening before a non-trading day
     holiday    a listed exchange holiday (its whole New York date)
   An early close moves the regular close only; the after-hours window still ends at
   20:00. That is an approximation stated here rather than hidden: NYSE's footnote
   says the late sessions of its other venues close at 17:00 on those days, and
   Chainlink publishes no early-close variant of the 24/5 schedule.
   ============================================================================ */

import { usEasternIsDaylight } from "../rwa/marketHours.js";

export interface UsEquityHoliday {
  readonly date: string;
  readonly name: string;
}

export interface UsEquityEarlyClose {
  readonly date: string;
  /** New York local close of the regular session, "HH:MM". */
  readonly close: string;
  readonly name: string;
}

export interface UsEquityCalendarYear {
  readonly holidays: readonly UsEquityHoliday[];
  readonly earlyCloses: readonly UsEquityEarlyClose[];
}

/** Where the dates below were read, and when. */
export const US_EQUITY_CALENDAR_SOURCE = "https://www.nyse.com/markets/hours-calendars (read 2026-10-13)";

/** NYSE holidays and early closes by year, New York dates. Only the years the exchange has published. */
export const US_EQUITY_CALENDAR: Readonly<Record<number, UsEquityCalendarYear>> = {
  2026: {
    holidays: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-01-19", name: "Martin Luther King, Jr. Day" },
      { date: "2026-02-16", name: "Washington's Birthday" },
      { date: "2026-04-03", name: "Good Friday" },
      { date: "2026-05-25", name: "Memorial Day" },
      { date: "2026-06-19", name: "Juneteenth National Independence Day" },
      { date: "2026-07-03", name: "Independence Day (observed)" },
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-11-26", name: "Thanksgiving Day" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
    earlyCloses: [
      { date: "2026-11-27", close: "13:00", name: "Day after Thanksgiving" },
      { date: "2026-12-24", close: "13:00", name: "Christmas Eve" },
    ],
  },
  2027: {
    holidays: [
      { date: "2027-01-01", name: "New Year's Day" },
      { date: "2027-01-18", name: "Martin Luther King, Jr. Day" },
      { date: "2027-02-15", name: "Washington's Birthday" },
      { date: "2027-03-26", name: "Good Friday" },
      { date: "2027-05-31", name: "Memorial Day" },
      { date: "2027-06-18", name: "Juneteenth National Independence Day (observed)" },
      { date: "2027-07-05", name: "Independence Day (observed)" },
      { date: "2027-09-06", name: "Labor Day" },
      { date: "2027-11-25", name: "Thanksgiving Day" },
      { date: "2027-12-24", name: "Christmas Day (observed)" },
    ],
    earlyCloses: [{ date: "2027-11-26", close: "13:00", name: "Day after Thanksgiving" }],
  },
};

/**
 * The last New York date the calendar covers ("YYYY-12-31" of the last listed year). Past it every
 * session reads `calendarCovered: false` and the premium tracker refuses with "calendar-unknown"
 * until the next year is transcribed from the exchange's own list. A test fails 60 days before it.
 */
export const US_EQUITY_CALENDAR_LAST_DATE: string = `${Math.max(...Object.keys(US_EQUITY_CALENDAR).map(Number))}-12-31`;

export type UsEquitySessionState = "overnight" | "pre" | "open" | "after" | "closed" | "holiday";

export interface UsEquitySession {
  readonly state: UsEquitySessionState;
  /** The New York calendar date of the instant, "YYYY-MM-DD". */
  readonly nyDate: string;
  /** New York offset from UTC in hours at the instant (-4 or -5). */
  readonly utcOffsetHours: number;
  /** False when the calendar has no data for the year(s) the answer depends on: holidays are UNKNOWN then. */
  readonly calendarCovered: boolean;
  /** The listed holiday's name when `state` is "holiday". */
  readonly holidayName: string | null;
  /** The regular close today, "HH:MM", when today is an early-close day. */
  readonly earlyClose: string | null;
}

const MIN = 60;
const HOUR = 3_600;

function nyOffsetHours(atMs: number): number {
  return usEasternIsDaylight(new Date(atMs)) ? -4 : -5;
}

/** "YYYY-MM-DD" of a UTC-midnight-based date object built from New York local fields. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

function weekdayOfDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** Whether the calendar lists the year of `date`. */
export function usEquityCalendarCovers(date: string): boolean {
  return US_EQUITY_CALENDAR[yearOf(date)] !== undefined;
}

/** The listed holiday on `date` (New York), or null. Null also when the year is not covered. */
export function usEquityHoliday(date: string): UsEquityHoliday | null {
  return US_EQUITY_CALENDAR[yearOf(date)]?.holidays.find((h) => h.date === date) ?? null;
}

/** The listed early close on `date`, or null. */
export function usEquityEarlyClose(date: string): UsEquityEarlyClose | null {
  return US_EQUITY_CALENDAR[yearOf(date)]?.earlyCloses.find((h) => h.date === date) ?? null;
}

/** A weekday that is not a listed holiday. On an uncovered year this answers as if there were none: callers check coverage. */
export function isUsEquityTradingDay(date: string): boolean {
  const w = weekdayOfDate(date);
  return w >= 1 && w <= 5 && usEquityHoliday(date) === null;
}

function hhmmSeconds(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * HOUR + (m ?? 0) * MIN;
}

/** The US equity session at `at` (a Date or unix seconds). */
export function usEquitySession(at: Date | number): UsEquitySession {
  const ms = at instanceof Date ? at.getTime() : at * 1000;
  const off = nyOffsetHours(ms);
  const local = new Date(ms + off * HOUR * 1000);
  const date = ymd(local);
  const secondOfDay = local.getUTCHours() * HOUR + local.getUTCMinutes() * MIN + local.getUTCSeconds();
  const tomorrow = addDays(date, 1);
  const covered = usEquityCalendarCovers(date) && usEquityCalendarCovers(tomorrow);
  const base = { nyDate: date, utcOffsetHours: off, calendarCovered: covered };
  const holiday = usEquityHoliday(date);
  const early = usEquityEarlyClose(date);
  const eveningOpen = secondOfDay >= 20 * HOUR && isUsEquityTradingDay(tomorrow);

  if (!isUsEquityTradingDay(date)) {
    if (eveningOpen) return { ...base, state: "overnight", holidayName: null, earlyClose: null };
    if (holiday) return { ...base, state: "holiday", holidayName: holiday.name, earlyClose: null };
    return { ...base, state: "closed", holidayName: null, earlyClose: null };
  }
  const close = early ? hhmmSeconds(early.close) : 16 * HOUR;
  const earlyClose = early ? early.close : null;
  let state: UsEquitySessionState;
  if (secondOfDay < 4 * HOUR) state = "overnight";
  else if (secondOfDay < 9 * HOUR + 30 * MIN) state = "pre";
  else if (secondOfDay < close) state = "open";
  else if (secondOfDay < 20 * HOUR) state = "after";
  else state = eveningOpen ? "overnight" : "closed";
  return { ...base, state, holidayName: null, earlyClose };
}

/**
 * Whether a feed on Chainlink market-hours `profile` is in session at `at`.
 *   "us_equities_24/5"  overnight, pre, open and after
 *   "NYSE"              the regular session only
 * `null` for any other profile: this module does not guess a schedule it has not read.
 */
export function feedSessionLive(profile: string, at: Date | number): boolean | null {
  const s = usEquitySession(at).state;
  if (profile === "us_equities_24/5") return s === "overnight" || s === "pre" || s === "open" || s === "after";
  if (profile === "NYSE") return s === "open";
  return null;
}

const STEP = 15 * MIN;
/** How far back `lastFeedSessionEnd` looks. Two weeks covers every holiday run on the calendar. */
const LOOKBACK_STEPS = (14 * 86_400) / STEP;

/**
 * The instant (unix seconds) the feed's session last ENDED at or before `at`, or null when
 * the session is live at `at`, the profile is unknown, or no end lies within two weeks.
 * Every session boundary falls on a quarter hour of New York time, so a 15-minute scan
 * finds it exactly.
 */
export function lastFeedSessionEnd(profile: string, at: Date | number): number | null {
  const t = at instanceof Date ? Math.floor(at.getTime() / 1000) : Math.floor(at);
  const live = feedSessionLive(profile, t);
  if (live === null || live) return null;
  const start = Math.floor(t / STEP) * STEP;
  for (let k = 0; k <= LOOKBACK_STEPS; k++) {
    const b = start - k * STEP;
    if (feedSessionLive(profile, b) === false && feedSessionLive(profile, b - 1) === true) return b;
  }
  return null;
}
