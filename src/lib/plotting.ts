// Build time charts with Observable Plot. Plot draws into a linkedom document
// while Astro builds the page, and the page gets plain SVG markup. No Plot code
// ever ships to the browser.
//
// The SVG is a VIEW by VIEW box stretched to the plot area with
// preserveAspectRatio="none", and the chart CSS gives every stroke
// vector-effect: non-scaling-stroke, so the line stays 1.5px and the grid stays
// a hairline at any width. Text is never drawn in the SVG. Axis labels and the
// price tag are HTML placed by percent from the same Plot scales, so they keep
// their size on a phone and can't be stretched.
//
// What Plot draws is folded into three plain paths, the way the design
// mockup writes a chart: one `grid` path with every hairline rule, one `ln`
// path per line (`ln bench` for a benchmark), and a `pt` path that is a
// zero length stroke with a round cap, which is the dot on the newest week.

import * as Plot from "@observablehq/plot";
import { parseHTML } from "linkedom";

/** Size of the square viewBox the lines are drawn in. */
export const VIEW = 1000;

export interface Frame {
  /** First and last calendar day on the x axis, ISO. */
  from: string;
  to: string;
  /** Bottom and top of the y axis, dollars. */
  lo: number;
  hi: number;
}

export interface PlotLine {
  kind: "primary" | "bench";
  /** Hold each value until the next point instead of joining points with a slope. */
  step?: boolean;
  points: { date: string; value: number | null }[];
}

export interface LinesSpec extends Frame {
  lines: PlotLine[];
  /** Dollar values that get a hairline grid rule across the plot. */
  grid: number[];
  /** The newest point of the primary line, marked with a dot. Percent from the left and from the top. */
  dot?: { x: number; y: number } | null;
}

let doc: Document | null = null;

/** A detached document for Plot to build nodes in. Nothing touches globalThis. */
function plotDocument(): Document {
  if (!doc) doc = parseHTML("<!doctype html><html><body></body></html>").document as unknown as Document;
  return doc;
}

/** Midnight UTC on an ISO calendar date. Plot's utc scale then matches plain day counts. */
export function isoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** The x domain end. A one day chart still gets a one day wide axis. */
function xEnd(f: Frame): Date {
  const a = isoDate(f.from);
  const b = isoDate(f.to);
  return b > a ? b : new Date(a.getTime() + 86400000);
}

function scaleOptions(f: Frame, width: number, height: number) {
  return {
    x: { type: "utc" as const, domain: [isoDate(f.from), xEnd(f)], range: [0, width] as [number, number] },
    y: { type: "linear" as const, domain: [f.lo, f.hi], range: [height, 0] as [number, number] },
  };
}

export interface FrameScales {
  /** Percent from the left of the plot box. */
  x: (iso: string) => number;
  /** Percent from the top of the plot box. */
  y: (value: number) => number;
}

/** Plot's own position scales for a frame, in percent of the plot box. */
export function frameScales(f: Frame): FrameScales {
  const o = scaleOptions(f, 100, 100);
  const x = Plot.scale({ x: o.x });
  const y = Plot.scale({ y: o.y });
  return {
    x: (iso) => x.apply(isoDate(iso)) as number,
    y: (v) => y.apply(v) as number,
  };
}

/** A whole unit in a 1000 unit box is a tenth of a percent: about a pixel on the widest plot, a fifth of one on its height. */
function round1(n: number): string {
  return String(Math.round(n));
}

function roundNumbers(s: string): string {
  return s.replace(/-?\d+\.\d+(e-?\d+)?/g, (n) => round1(Number(n)));
}

/**
 * Plot's absolute path ("M0,500L250,400") as whole units with relative steps
 * ("M0,500l250,-100"). The steps between weekly points are small numbers that
 * repeat, which gzip likes: a four year line shrinks by almost half.
 */
function relativePath(d: string): string {
  let x = 0;
  let y = 0;
  let out = "";
  for (const seg of d.match(/[MLZ](?:-?\d+(?:\.\d+)?(?:e-?\d+)?,-?\d+(?:\.\d+)?(?:e-?\d+)?)?/g) ?? []) {
    const cmd = seg[0];
    if (cmd === "Z") {
      out += "Z";
      continue;
    }
    const [px, py] = seg.slice(1).split(",").map((n) => Math.round(Number(n)));
    out += cmd === "M" ? `M${px},${py}` : `l${px - x},${py - y}`;
    x = px;
    y = py;
  }
  return out;
}

/**
 * Grid rules and price lines as a static SVG string, folded into plain paths:
 * `grid` for the rules, `ln` (or `ln bench`) for each line, `pt` for the dot
 * on the newest week. A null value breaks the line, the same gap the data has.
 * The chart CSS owns colour and width, so the tokens and dark mode apply.
 */
export function linesSvg(spec: LinesSpec): string {
  const o = scaleOptions(spec, VIEW, VIEW);
  const marks: Plot.Markish[] = [];
  if (spec.grid.length) marks.push(Plot.ruleY(spec.grid, { className: "grid" }));
  for (const line of spec.lines) {
    marks.push(
      Plot.line(line.points, {
        x: (p: PlotLine["points"][number]) => isoDate(p.date),
        y: (p: PlotLine["points"][number]) => p.value,
        curve: line.step ? "step-after" : "linear",
        className: `line line-${line.kind}`,
      }),
    );
  }
  const svg = Plot.plot({
    document: plotDocument(),
    width: VIEW,
    height: VIEW,
    margin: 0,
    x: { ...o.x, axis: null },
    y: { ...o.y, axis: null },
    marks,
  }) as unknown as Element;

  const out: string[] = [];
  const rules = Array.from(svg.querySelectorAll("g.grid line"))
    .map((l) => `M0 ${roundNumbers(l.getAttribute("y1") ?? "0")}H${VIEW}`)
    .join("");
  if (rules) out.push(`<path class="grid" d="${rules}"/>`);
  for (const g of Array.from(svg.querySelectorAll("g.line"))) {
    const kind = /line-bench/.test(g.getAttribute("class") ?? "") ? " bench" : "";
    const d = Array.from(g.querySelectorAll("path"))
      .map((p) => relativePath(p.getAttribute("d") ?? ""))
      .join("");
    if (d) out.push(`<path class="ln${kind}" d="${d}"/>`);
  }
  if (spec.dot) {
    out.push(`<path class="pt" d="M${round1((spec.dot.x / 100) * VIEW)} ${round1((spec.dot.y / 100) * VIEW)}h0"/>`);
  }
  return `<svg viewBox="0 0 ${VIEW} ${VIEW}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${out.join("")}</svg>`;
}
