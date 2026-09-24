// The home page's charts, drawn at build time as plain SVG: the U.S. line
// since our records start, and the 52 week sparklines in the tables. Every
// line is a 1000 by 300 (or 100 by 30) box stretched to its cell with
// preserveAspectRatio="none" and non scaling strokes, so it stays a hairline
// at any width. Text is never drawn in the SVG: the axis labels and the price
// tag are HTML placed by percent, so they keep their size on a phone. No
// chart library ships to the browser; src/components/home/readout.ts is the
// only chart code that runs there.

import { addDays, daysBetween, formatDate } from "../../lib/dates.ts";
import { formatPrice, formatQuote } from "../../lib/format.ts";
import { lastDays, present, type Point, type Valued } from "../../lib/stats.ts";

/** The line box of the big chart. */
export const W = 1000;
export const H = 300;

/** Whole units: a unit is under half a pixel once the box is stretched to its cell. */
function r0(n: number): string {
  return String(Math.round(n));
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round dollar values to label between lo and hi, at most five of them. */
export function ticks(lo: number, hi: number): number[] {
  const span = hi - lo;
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2];
  const step = steps.find((s) => span / s <= 5) ?? 2;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

export interface Placed {
  /** Percent from the top (y labels) or the left (x labels). */
  at: number;
  text: string;
}

export interface Chart {
  /** The SVG path data: the grid rules, the line, and the dot on the newest week. */
  grid: string;
  line: string;
  dot: string;
  /** Axis prices beside the box, minus any that would sit under the price tag. */
  yLabels: Placed[];
  /** The newest price, printed on the axis in inverse. */
  tag: Placed;
  /** Year names under the box. */
  xLabels: Placed[];
  /** The first week's date, for the readout script, which counts weeks from it. */
  start: string;
  /** One value per week as it prints, "6.285,6.312", for the readout script. A missing week is empty. */
  values: string;
  /** What the chart says to a screen reader. */
  aria: string;
  /** The newest week: the readout's resting state. */
  last: Valued;
  low: Valued;
  high: Valued;
  count: number;
}

export interface ChartOptions {
  /** What the line is: "U.S. weekly diesel average". */
  label: string;
  /** The box's height on a phone, in px: an axis label that would sit under the tag is dropped. */
  mobileHeight: number;
}

/**
 * Points are weekly. Every week from the first price to the last gets a slot,
 * so the readout can count weeks from the start; a week with no price leaves
 * a gap in the line and an empty slot.
 */
export function chart(series: Point[], opts: ChartOptions): Chart | null {
  const p = present(series);
  if (p.length < 2) return null;
  const vals = p.map((q) => q.value);
  const rawLo = Math.min(...vals);
  const rawHi = Math.max(...vals);
  const pad = (rawHi - rawLo) * 0.12 || 0.1;
  const t = ticks(rawLo - pad, rawHi + pad);
  const lo = Math.min(t[0], rawLo - pad * 0.4);
  const hi = Math.max(t[t.length - 1], rawHi + pad * 0.4);
  const first = p[0];
  const last = p[p.length - 1];
  const byDate = new Map(p.map((q) => [q.date, q.value]));
  const weeks: (number | null)[] = [];
  for (let d = first.date; d <= last.date; d = addDays(d, 7)) weeks.push(byDate.get(d) ?? null);
  const span = (weeks.length - 1) * 7 || 1;
  const x = (q: Valued) => (daysBetween(first.date, q.date) / span) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  let line = "";
  let pen = false;
  weeks.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    line += `${pen ? "L" : "M"}${r0((i / (weeks.length - 1)) * W)} ${r0(y(v))}`;
    pen = true;
  });
  const grid = t.map((v) => `M0 ${r0(y(v))}H${W}`).join("");
  const dot = `M${W} ${r0(y(last.value))}h0`;
  // an axis label that would sit under the newest price tag is dropped
  const room = (18 / opts.mobileHeight) * H;
  const pct = (v: number) => r2((v / H) * 100);
  const yLabels = t.filter((v) => Math.abs(y(v) - y(last.value)) > room).map((v) => ({ at: pct(y(v)), text: formatQuote(v) }));
  const tag = { at: pct(y(last.value)), text: formatQuote(last.value) };

  // one label per year, at its first week; a stub first year that would run
  // into the next label is dropped
  const marks: Placed[] = [];
  let seen = "";
  for (const q of p) {
    const year = q.date.slice(0, 4);
    if (year === seen) continue;
    seen = year;
    marks.push({ at: r2((daysBetween(first.date, q.date) / span) * 100), text: year });
  }
  if (marks.length > 1 && (marks[1].at - marks[0].at) < 16) marks.shift();

  let low = p[0];
  let high = p[0];
  for (const q of p) {
    if (q.value < low.value) low = q;
    if (q.value >= high.value) high = q;
  }
  const highText = high === last ? "in the newest week" : `on ${formatDate(high.date)}`;
  const aria =
    `${opts.label}. ${p.length} weeks, ${formatDate(first.date)} to ${formatDate(last.date)}. ` +
    `Now ${formatPrice(last.value)}. Low ${formatPrice(low.value)} on ${formatDate(low.date)}, high ${formatPrice(high.value)} ${highText}. ` +
    "Use the left and right arrow keys to read a week.";
  return {
    grid,
    line,
    dot,
    yLabels,
    tag,
    xLabels: marks,
    start: first.date,
    values: weeks.map((v) => (v === null ? "" : formatQuote(v))).join(","),
    aria,
    last,
    low,
    high,
    count: p.length,
  };
}

export interface Spark {
  /** The line, in a 100 by 30 box with 1 unit of air on each side. */
  d: string;
  /** The dot on the newest week. */
  end: string;
  low: Valued;
  high: Valued;
  last: Valued;
}

/**
 * The last 52 weeks of a series as a sparkline path: the same 364 day window
 * as a state page's key stats (highLow), so the low and high beside the line
 * are the ones the state page prints even when a week is missing. Null with
 * fewer than two prices.
 */
export function spark(series: Point[]): Spark | null {
  const p = present(lastDays(series, 364));
  if (p.length < 2) return null;
  const vals = p.map((q) => q.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => 1 + (i / (p.length - 1)) * 98;
  const y = (v: number) => 27 - ((v - lo) / span) * 24;
  const d = p.map((q, i) => `${i ? "L" : "M"}${r0(x(i))} ${r0(y(q.value))}`).join("");
  const last = p[p.length - 1];
  let low = p[0];
  let high = p[0];
  for (const q of p) {
    if (q.value < low.value) low = q;
    if (q.value >= high.value) high = q;
  }
  return { d, end: `M${r0(x(p.length - 1))} ${r0(y(last.value))}h0`, low, high, last };
}

/**
 * "Midwest, 52 weeks, highest in the newest week" or "Midwest, 52 weeks, now
 * $6.100". The low and the high are in the cells beside the line, so the
 * label only adds what the shape says: where the line ends.
 */
export function sparkLabel(name: string, s: Spark): string {
  const tail = s.high === s.last ? "highest in the newest week" : `now ${formatPrice(s.last.value)}`;
  return `${name}, 52 weeks, ${tail}`;
}
