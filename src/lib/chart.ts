// Line chart geometry, computed at build time. The SVG uses a 1000 by 1000
// viewBox stretched to the plot box with non scaling strokes, and every label is
// HTML placed by percent, so text never shrinks on a phone.

import { addDays, dayNumber, formatMonthTick } from "./dates.ts";
import { formatPrice, formatTick } from "./format.ts";
import type { Point } from "./stats.ts";

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
}

export interface ChartModel {
  from: string;
  to: string;
  yTicks: Tick[];
  xTicks: Tick[];
  paths: { id: string; kind: ChartSeries["kind"]; d: string }[];
  ends: { id: string; kind: ChartSeries["kind"]; label: string; value: number; text: string; x: number; y: number }[];
  showEndLabels: boolean;
  hover: {
    dates: string[];
    x: number[];
    series: { label: string; kind: ChartSeries["kind"]; values: (number | null)[]; y: (number | null)[] }[];
  };
}

const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];

export function niceDomain(min: number, max: number, maxTicks = 5): { lo: number; hi: number; step: number } {
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
  /** Shared y domain for small multiples. */
  yDomain?: { lo: number; hi: number; step: number };
  maxYTicks?: number;
  /** Plot height in px, used to decide whether end labels would collide. */
  heightPx: number;
  xTicks?: "months" | "years" | "none";
}

export function yDomainFor(series: Point[][], maxTicks = 5): { lo: number; hi: number; step: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s) {
      if (p.value === null) continue;
      min = Math.min(min, p.value);
      max = Math.max(max, p.value);
    }
  }
  if (!Number.isFinite(min)) return { lo: 0, hi: 1, step: 0.25 };
  return niceDomain(min, max, maxTicks);
}

export function buildChart(seriesIn: ChartSeries[], opt: BuildOptions): ChartModel {
  const x0 = dayNumber(opt.from);
  const x1 = dayNumber(opt.to);
  const span = Math.max(1, x1 - x0);
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

  const dom = opt.yDomain ?? yDomainFor(series.map((s) => s.inRange), opt.maxYTicks ?? 5);
  const ySpan = dom.hi - dom.lo;
  const xp = (date: string) => ((dayNumber(date) - x0) / span) * 100;
  const yp = (v: number) => (1 - (v - dom.lo) / ySpan) * 100;

  const yTicks: Tick[] = [];
  for (let v = dom.lo; v <= dom.hi + 1e-9; v += dom.step) {
    const value = round2(v);
    yTicks.push({ value, label: formatTick(value), pos: r(yp(value)) });
  }

  const xTicks: Tick[] = [];
  if (opt.xTicks !== "none") {
    const years = opt.xTicks === "years";
    const [fy, fm] = opt.from.split("-").map(Number);
    let y = fy;
    let m = fm; // next month start after from
    let i = 0;
    for (;;) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      const iso = `${y}-${String(m).padStart(2, "0")}-01`;
      if (iso > opt.to) break;
      if (years && m !== 1) continue;
      const pos = xp(iso);
      if (pos < 3 || pos > 97) continue;
      xTicks.push({ value: dayNumber(iso), label: formatMonthTick(iso), pos: r(pos), minor: !years && i % 2 === 1 });
      i += 1;
    }
  }

  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    const pts = s.inRange;
    pts.forEach((p, idx) => {
      if (p.value === null) {
        pen = false;
        return;
      }
      const X = r(xp(p.date) * 10);
      const Y = r(yp(p.value) * 10);
      if (!pen) {
        d += `M${X} ${Y}`;
        pen = true;
      } else if (s.step) {
        d += `H${X}V${Y}`;
      } else {
        d += `L${X} ${Y}`;
      }
      if (s.step && idx === pts.length - 1) d += `H1000`;
    });
    return { id: s.id, kind: s.kind, d };
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
  const hover = {
    dates,
    x: dates.map((d) => r(xp(d))),
    series: series.map((s) => {
      const values = dates.map((d) =>
        s === primary ? (s.inRange.find((p) => p.date === d)?.value ?? null) : valueInEffect(s.points, d),
      );
      return { label: s.label, kind: s.kind, values, y: values.map((v) => (v === null ? null : r(yp(v)))) };
    }),
  };

  return { from: opt.from, to: opt.to, yTicks, xTicks, paths, ends, showEndLabels, hover };
}

/** Date `days` before `to`, for window starts. */
export function windowStart(to: string, days: number): string {
  return addDays(to, -(days - 1));
}
