// Series math for the state pages and region charts.

import { addDays, daysBetween } from "./dates.ts";
import { toUnits } from "./format.ts";

export interface Point {
  date: string;
  value: number | null;
}

export interface Valued {
  date: string;
  value: number;
}

export interface Change {
  from: Valued;
  to: Valued;
  change: number;
  pct: number;
}

/** Points with a value, ascending by date. */
export function present(series: Point[]): Valued[] {
  return series
    .filter((p): p is Valued => p.value !== null)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function newest(series: Point[]): Valued | null {
  const v = present(series);
  return v.length ? v[v.length - 1] : null;
}

/** Newest point dated on or before `iso`, but no older than `iso` minus `toleranceDays`. */
export function onOrBefore(series: Point[], iso: string, toleranceDays: number): Valued | null {
  const v = present(series);
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i].date <= iso) {
      return daysBetween(v[i].date, iso) <= toleranceDays ? v[i] : null;
    }
  }
  return null;
}

function diff(from: Valued, to: Valued): Change {
  const c = toUnits(to.value) - toUnits(from.value);
  return { from, to, change: c / 10000, pct: (c / toUnits(from.value)) * 100 };
}

/**
 * Change from the value `days` before the newest point to the newest point.
 * Weekly data lines up exactly (28 or 364 days); daily data may have a missing
 * day, so the comparison point may be up to `toleranceDays` earlier.
 */
export function changeOver(series: Point[], days: number, toleranceDays = 6): Change | null {
  const last = newest(series);
  if (!last) return null;
  const from = onOrBefore(series, addDays(last.date, -days), toleranceDays);
  return from ? diff(from, last) : null;
}

export interface HighLow {
  high: Valued;
  low: Valued;
  since: string;
  /** True when the series covers the whole window. */
  complete: boolean;
}

/**
 * Highest and lowest value in the window ending at the newest point.
 * A 52 week window is 364 days: the newest week plus the 51 before it.
 * Ties go to the most recent date.
 */
export function highLow(series: Point[], windowDays = 364): HighLow | null {
  const last = newest(series);
  if (!last) return null;
  const since = addDays(last.date, -(windowDays - 1));
  const inWindow = present(series).filter((p) => p.date >= since);
  let high = inWindow[0];
  let low = inWindow[0];
  for (const p of inWindow) {
    if (p.value >= high.value) high = p;
    if (p.value <= low.value) low = p;
  }
  const first = present(series)[0];
  const complete = daysBetween(first.date, last.date) >= windowDays - 7;
  return { high, low, since, complete };
}

/** Points in the window ending at the newest point, nulls kept. */
export function lastDays(series: Point[], windowDays: number): Point[] {
  const last = newest(series);
  if (!last) return [];
  const since = addDays(last.date, -(windowDays - 1));
  return series.filter((p) => p.date >= since && p.date <= last.date);
}
