// When EIA posts its next weekly diesel number, and how to say it.
//
// EIA surveys stations on Monday and posts the numbers around 10 a.m. ET on
// Tuesday, or Wednesday when Monday is a federal holiday. The workbook states
// its own next release date, which already knows the holidays, so that wins.
// The schedule below is the fallback when the date is missing or stale.

import { addDays, daysBetween, weekday } from "./dates.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "Tue, Sep 22" */
export function formatShortWeekdayDate(date: string): string {
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${WEEKDAYS[weekday(date)]}, ${MONTHS[m - 1]} ${d}`;
}

/** The nth given weekday (0 is Sunday) of a month, month 1 to 12. */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  const first = iso(y, m, 1);
  const offset = (wd - weekday(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekday(y: number, m: number, wd: number): string {
  const next = m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1);
  const last = addDays(next, -1);
  return addDays(last, -((weekday(last) - wd + 7) % 7));
}

/** A fixed date holiday moves to Friday when it falls on Saturday, Monday when on Sunday. */
function observed(date: string): string {
  const wd = weekday(date);
  if (wd === 6) return addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

/** Federal holidays as observed for a calendar year. New Year's can land on Dec 31 of the year before. */
export function federalHolidays(year: number): string[] {
  return [
    observed(iso(year, 1, 1)),
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Washington's Birthday
    lastWeekday(year, 5, 1), // Memorial Day
    observed(iso(year, 6, 19)), // Juneteenth
    observed(iso(year, 7, 4)),
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    observed(iso(year, 11, 11)),
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(iso(year, 12, 25)),
  ];
}

export function isFederalHoliday(date: string): boolean {
  const y = Number(date.slice(0, 4));
  return federalHolidays(y).includes(date) || federalHolidays(y + 1).includes(date);
}

function isWorkday(date: string): boolean {
  const wd = weekday(date);
  return wd !== 0 && wd !== 6 && !isFederalHoliday(date);
}

/**
 * The day EIA should post the week after `period` (a survey Monday):
 * the Tuesday after the next survey, Wednesday after a Monday holiday, and one
 * more working day for each holiday that lands on the release day itself.
 */
export function expectedRelease(period: string): string {
  const survey = addDays(period, 7);
  let day = addDays(survey, isFederalHoliday(survey) ? 2 : 1);
  while (!isWorkday(day)) day = addDays(day, 1);
  return day;
}

export interface NextRelease {
  /** The day the next weekly number should land. */
  date: string;
  /** True once that day has passed in New York with no new week here. */
  late: boolean;
}

/**
 * When the next EIA week should land. Uses EIA's own next release date when it
 * points past the current week's release, otherwise the usual schedule.
 * `today` is the calendar day in America/New_York.
 */
export function nextEiaRelease(
  period: string | null,
  stated: string | null,
  today: string,
): NextRelease | null {
  if (!period) return null;
  // The current week comes out the day after its survey at the earliest, so a
  // date for the next week is at least 8 days past the survey. Anything
  // earlier is left over from the week before, as after a USDA fallback run.
  const date = stated && daysBetween(period, stated) >= 8 ? stated : expectedRelease(period);
  return { date, late: date < today };
}

/**
 * The end of a state page's week line: "Next release Tue, Sep 22." The stale
 * script (src/scripts/stale.js) swaps in LATE_TEXT once that day has passed
 * with nothing new.
 */
export const LATE_TEXT = "The next release is late.";

export function nextUpdateText(date: string): string {
  return `Next release ${formatShortWeekdayDate(date)}.`;
}
