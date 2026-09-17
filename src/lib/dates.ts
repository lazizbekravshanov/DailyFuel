// Dates in the data are ISO calendar dates ("2026-09-14") with no time zone.
// They are treated as plain calendar days. "Today" is the calendar day in
// America/New_York, which is how the pipeline decides freshness too.

export const TIME_ZONE = "America/New_York";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(iso: string): [number, number, number] {
  const m = ISO.exec(iso);
  if (!m) throw new RangeError(`not an ISO date: ${iso}`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`not a real date: ${iso}`);
  }
  return [y, mo, d];
}

/** Days since 1970-01-01 for a calendar date. */
export function dayNumber(iso: string): number {
  const [y, mo, d] = parts(iso);
  return Date.UTC(y, mo - 1, d) / 86400000;
}

export function fromDayNumber(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}

/** b minus a in whole days. */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** Today's calendar date in America/New_York. */
export function todayInNewYork(now: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Sep 14" */
export function formatShortDate(iso: string): string {
  const [, mo, d] = parts(iso);
  return `${MONTHS[mo - 1]} ${d}`;
}

/** "Sep 14, 2026" */
export function formatDate(iso: string): string {
  const [y, mo, d] = parts(iso);
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

/**
 * "Sep 14" when `iso` falls in the same year as `ref`, "Sep 14, 2025" when it
 * doesn't. A comparison date is only ambiguous when it crosses the year.
 */
export function when(iso: string, ref: string): string {
  return iso.slice(0, 4) === ref.slice(0, 4) ? formatShortDate(iso) : formatDate(iso);
}

/** "Tuesday, Sep 22" */
export function formatWeekdayDate(iso: string): string {
  const [, mo, d] = parts(iso);
  const wd = new Date(dayNumber(iso) * 86400000).getUTCDay();
  return `${WEEKDAYS[wd]}, ${MONTHS[mo - 1]} ${d}`;
}

/** "June 2022" */
export function formatMonthYear(iso: string): string {
  const [y, mo] = parts(iso);
  return `${MONTHS_LONG[mo - 1]} ${y}`;
}

/** Axis label for a month start: "Oct", or "2026" in January. */
export function formatMonthTick(iso: string, withYear = false): string {
  const [y, mo] = parts(iso);
  if (mo === 1 || withYear) return String(y);
  return MONTHS[mo - 1];
}

/** AAA's badge style: "9/17/26". */
export function formatBadgeDate(iso: string): string {
  const [y, mo, d] = parts(iso);
  return `${mo}/${d}/${String(y % 100).padStart(2, "0")}`;
}

export function weekday(iso: string): number {
  return new Date(dayNumber(iso) * 86400000).getUTCDay();
}

export const STALE_AAA_DAYS = 2;
export const STALE_EIA_DAYS = 10;

/**
 * True when the prices on the page are older than usual.
 * AAA is stale at 2 or more days old, EIA at 10 or more days.
 * The inline banner script in src/scripts/stale.js mirrors this.
 */
export function isStale(
  input: { aaaAsOf: string | null; eiaPeriod: string | null },
  today: string,
): boolean {
  if (input.aaaAsOf && daysBetween(input.aaaAsOf, today) >= STALE_AAA_DAYS) return true;
  if (input.eiaPeriod && daysBetween(input.eiaPeriod, today) >= STALE_EIA_DAYS) return true;
  return false;
}
