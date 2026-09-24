// Line chart model, computed at build time. The lines are drawn by Observable
// Plot (see plotting.ts) into a stretched SVG with non scaling strokes. Every
// label is HTML placed by percent from the same Plot scales, so text never
// shrinks on a phone. The hover data feeds the crosshair script in
// src/scripts/chart.js, which is the only chart code that runs in the browser.

import { dayNumber, daysBetween, formatDate, formatMonthTick } from "./dates.ts";
import { changeTenths, formatPrice, formatTick, spokenChange } from "./format.ts";
import { frameScales } from "./plotting.ts";
import { present, type Point, type Valued } from "./stats.ts";

export interface ChartSeries {
  id: string;
  label: string;
  kind: "primary" | "bench";
  points: Point[];
  /** Draw as steps that hold each value until the next point (weekly prices under daily ones). */
  step?: boolean;
}

export interface Tick {
  value: number;
  label: string;
  /** 0 to 100 from the top for y, from the left for x. */
  pos: number;
  minor?: boolean;
  /** Also hidden on the narrowest phones, where even every other month crowds the row. */
  thin?: boolean;
  /** Where the label sits on its tick. Centered unless it says "start". */
  anchor?: "start" | "middle";
}

export interface YDomain {
  lo: number;
  hi: number;
  step: number;
}

/** One line to draw: the points inside the window, ready for Plot. */
export interface ChartLine {
  id: string;
  label: string;
  kind: ChartSeries["kind"];
  step: boolean;
  points: Point[];
}

export interface ChartModel {
  from: string;
  to: string;
  yDomain: YDomain;
  yTicks: Tick[];
  /** Values that get a hairline rule: every tick, plus the bottom edge. */
  grid: number[];
  xTicks: Tick[];
  /** One entry per line, in drawing order. */
  paths: ChartLine[];
  ends: { id: string; kind: ChartSeries["kind"]; label: string; value: number; text: string; x: number; y: number }[];
  showEndLabels: boolean;
  hover: {
    dates: string[];
    x: number[];
    /** The primary series' last value before the window, so the first week still gets a change. */
    prev: [string, number] | null;
    series: { label: string; kind: ChartSeries["kind"]; values: (number | null)[]; y: (number | null)[] }[];
  };
}

const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function niceDomain(min: number, max: number, maxTicks = 5): YDomain {
  if (!(max > min)) {
    min -= 0.1;
    max += 0.1;
  }
  for (const step of STEPS) {
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    if (Math.round((hi - lo) / step) + 1 <= maxTicks) {
      return { lo: round2(lo), hi: round2(hi), step };
    }
  }
  const step = STEPS[STEPS.length - 1];
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function r(v: number): number {
  return Math.round(v * 10) / 10;
}

function extent(series: Point[][]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s) {
      if (p.value === null) continue;
      min = Math.min(min, p.value);
      max = Math.max(max, p.value);
    }
  }
  return Number.isFinite(min) ? [min, max] : null;
}

export function yDomainFor(series: Point[][], maxTicks = 5): YDomain {
  const e = extent(series);
  if (!e) return { lo: 0, hi: 1, step: 0.25 };
  return niceDomain(e[0], e[1], maxTicks);
}

/** Value in effect on `date`: the newest point dated on or before it. */
export function valueInEffect(points: Point[], date: string): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.date > date) break;
    v = p.value;
  }
  return v;
}

export interface BuildOptions {
  from: string;
  to: string;
  maxYTicks?: number;
  /** Plot height in px, used to decide whether end labels would collide. */
  heightPx: number;
  /**
   * months: every month start, every other one minor.
   * quarters: Jan, Apr, Jul and Oct, named by month even in January (the state chart's 52 weeks).
   * years: each January.
   */
  xTicks?: "months" | "quarters" | "years" | "none";
}

function monthStarts(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split("-").map(Number);
  let y = fy;
  let m = fm;
  if (from.endsWith("-01")) m -= 1; // the first day counts as a month start
  for (;;) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    const iso = `${y}-${String(m).padStart(2, "0")}-01`;
    if (iso > to) break;
    out.push(iso);
  }
  return out;
}

export function buildChart(seriesIn: ChartSeries[], opt: BuildOptions): ChartModel {
  const series = seriesIn.map((s) => {
    const inRange = s.points.filter((p) => p.date >= opt.from && p.date <= opt.to);
    if (s.step) {
      // carry the value in effect at the left edge into the window
      const carry = valueInEffect(s.points, opt.from);
      if (carry !== null && (inRange.length === 0 || inRange[0].date > opt.from)) {
        inRange.unshift({ date: opt.from, value: carry });
      }
    }
    return { ...s, inRange };
  });

  const dom = yDomainFor(series.map((s) => s.inRange), opt.maxYTicks ?? 5);
  const sc = frameScales({ from: opt.from, to: opt.to, lo: dom.lo, hi: dom.hi });
  const xp = sc.x;
  const yp = sc.y;

  const tickValues: number[] = [];
  for (let v = dom.lo; v <= dom.hi + 1e-9; v += dom.step) tickValues.push(round2(v));
  const yTicks: Tick[] = tickValues.map((value) => ({
    value,
    label: formatTick(value),
    pos: r(yp(value)),
  }));
  const grid = [...tickValues];
  if (!grid.some((v) => Math.abs(v - dom.lo) < 1e-9)) grid.unshift(dom.lo);

  const xTicks: Tick[] = [];
  if (opt.xTicks === "quarters") {
    // a quarter that starts within the first days of the window still gets
    // its name, reading from the left edge instead of centred on its tick
    for (const iso of monthStarts(opt.from, opt.to)) {
      if (!/-(01|04|07|10)-01$/.test(iso)) continue;
      const pos = xp(iso);
      if (pos > 97) continue;
      xTicks.push({ value: dayNumber(iso), label: MONTHS_SHORT[Number(iso.slice(5, 7)) - 1], pos: r(pos), anchor: pos < 3 ? "start" : "middle" });
    }
  } else if (opt.xTicks !== "none") {
    const years = opt.xTicks === "years";
    let i = 0;
    for (const iso of monthStarts(opt.from, opt.to)) {
      if (iso === opt.from) continue;
      if (years && !iso.endsWith("-01-01")) continue;
      const pos = xp(iso);
      if (pos < 3 || pos > 97) continue;
      xTicks.push({ value: dayNumber(iso), label: formatMonthTick(iso), pos: r(pos), minor: !years && i % 2 === 1 });
      i += 1;
    }
    // On a 320px phone the plot is about 174px wide, and six month names run
    // together ("Nov 2026 Mar", with that Nov in 2025). Thin every other one of
    // the rest there, keeping the year and an even step from it. Two or three
    // names, as on a 90 day chart, have room already.
    const majors = xTicks.filter((t) => !t.minor);
    if (!years && majors.length > 3) {
      const year = majors.findIndex((t) => /^\d{4}$/.test(t.label));
      const keep = year >= 0 ? year % 2 : 0;
      majors.forEach((t, k) => {
        if (k % 2 !== keep) t.thin = true;
      });
    }
  }

  const paths: ChartLine[] = series.map((s) => {
    const points = [...s.inRange];
    // a step line holds its last value to the right edge
    const last = [...points].reverse().find((p) => p.value !== null);
    if (s.step && last && last.date < opt.to) points.push({ date: opt.to, value: last.value });
    return { id: s.id, label: s.label, kind: s.kind, step: Boolean(s.step), points };
  });

  const ends = series
    .map((s) => {
      const last = [...s.inRange].reverse().find((p) => p.value !== null);
      if (!last || last.value === null) return null;
      return {
        id: s.id,
        kind: s.kind,
        label: s.label,
        value: last.value,
        text: formatPrice(last.value),
        x: s.step ? 100 : r(xp(last.date)),
        y: r(yp(last.value)),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  let showEndLabels = true;
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      if ((Math.abs(ends[a].y - ends[b].y) / 100) * opt.heightPx < 20) showEndLabels = false;
    }
  }

  // hover positions follow the primary series dates
  const primary = series.find((s) => s.kind === "primary") ?? series[0];
  const dates = primary.inRange.filter((p) => !(primary.step && p.date === opt.from && !primary.points.some((q) => q.date === opt.from))).map((p) => p.date);
  const before = present(primary.points.filter((p) => p.date < opt.from)).pop();
  const hover = {
    dates,
    x: dates.map((d) => r(xp(d))),
    prev: before ? ([before.date, before.value] as [string, number]) : null,
    series: series.map((s) => {
      const values = dates.map((d) =>
        s === primary ? (s.inRange.find((p) => p.date === d)?.value ?? null) : valueInEffect(s.points, d),
      );
      return { label: s.label, kind: s.kind, values, y: values.map((v) => (v === null ? null : r(yp(v)))) };
    }),
  };

  return { from: opt.from, to: opt.to, yDomain: dom, yTicks, grid, xTicks, paths, ends, showEndLabels, hover };
}

/**
 * Where the readout script (src/scripts/chart.js) puts a date, in percent
 * from the left: days into the window over the window's days. That is the
 * same linear utc scale Plot placed the line with, so the crosshair lands on
 * the point. The script reads the dates and prices from the numbers table
 * under the chart, so the page carries every value once.
 */
export function readoutX(from: string, to: string, date: string): number {
  const span = daysBetween(from, to) || 1;
  return (daysBetween(from, date) / span) * 100;
}

/**
 * The y axis labels beside a chart: every tick, except any that would sit
 * under the tag on the newest price. `room` is the clearance in percent of
 * the plot height; 20px of a 160px phone chart is 12.5.
 */
export function yLabels(model: ChartModel, room = 12.5): Tick[] {
  const end = model.ends.find((e) => e.kind === "primary") ?? model.ends[0];
  return model.yTicks.filter((t) => !end || Math.abs(t.pos - end.y) > room);
}

/** "up 30.4 cents", or "up $2.54" once the move is a dollar or more. */
export function spokenMove(change: number): string {
  const t = changeTenths(change);
  const a = Math.abs(t);
  if (a < 1000) return spokenChange(change);
  const cents = Math.floor((a + 5) / 10);
  return `${t > 0 ? "up" : "down"} $${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export interface LabelInput {
  /** What the chart shows and over what stretch: "Midwest, last 52 weeks". */
  name: string;
  /** The points the chart draws. Nulls are fine. */
  points: Point[];
  weekly: boolean;
  /** Where every value is, when there's a table: "Every week is in the table below." */
  tableNote?: string;
}

/**
 * The accessible name for a price chart: what it is, where it ends, which way it
 * went over the stretch, and its high and low. The region cards and the state
 * chart both use this, so a screen reader hears the same shape everywhere.
 */
export function chartLabel(input: LabelInput): string {
  const v = present(input.points);
  const tail = input.tableNote ? ` ${input.tableNote}` : "";
  const lead = /[.!?]$/.test(input.name) ? input.name : `${input.name}.`;
  if (!v.length) return `${lead} No prices yet.${tail}`;
  const first = v[0];
  const last = v[v.length - 1];
  let high: Valued = v[0];
  let low: Valued = v[0];
  for (const p of v) {
    if (p.value >= high.value) high = p;
    if (p.value <= low.value) low = p;
  }
  const on = (d: string) => (input.weekly ? `week of ${formatDate(d)}` : formatDate(d));
  let move = "";
  if (v.length > 1) {
    const span = daysBetween(first.date, last.date);
    // only a true year: 52 weeks, or 365 or 366 days
    const yearAgo = span >= 364 && span <= 366;
    const start = input.weekly ? `the week of ${formatDate(first.date)}` : formatDate(first.date);
    const change = last.value - first.value;
    if (changeTenths(change) === 0) move = `, the same as ${yearAgo ? "a year ago" : start}`;
    else move = `, ${spokenMove(change)} ${yearAgo ? "from a year ago" : `since ${start}`}`;
  }
  const hl = v.length > 1 ? ` High ${formatPrice(high.value)}, ${on(high.date)}. Low ${formatPrice(low.value)}, ${on(low.date)}.` : "";
  return `${lead} Now ${formatPrice(last.value)}${move}.${hl}${tail}`;
}
