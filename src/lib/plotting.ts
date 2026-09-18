// Build time charts with Observable Plot. Plot draws into a linkedom document
// while Astro builds the page, and the page gets plain SVG markup. No Plot code
// ever ships to the browser.
//
// The SVG is a VIEW by VIEW box stretched to the plot area with
// preserveAspectRatio="none", and the chart CSS gives every stroke
// vector-effect: non-scaling-stroke, so lines stay 2px and the grid stays a
// hairline at any width. Text is never drawn in the SVG. Axis labels, end labels
// and dots are HTML placed by percent from the same Plot scales, so they keep
// their size on a phone and can't be stretched.

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

/** One decimal in a 1000 unit box is a hundredth of a percent, finer than any screen. */
function roundNumbers(s: string): string {
  return s.replace(/-?\d+\.\d+(e-?\d+)?/g, (n) => String(Math.round(Number(n) * 10) / 10));
}

/**
 * Tidy what Plot made for a static page: drop its inline style block, class and
 * pixel size (the plot box sets the size), hide it from assistive tech (the
 * chart wrapper carries the name, and the table twin carries the numbers), and
 * round coordinates so the markup stays small.
 */
function finish(svg: Element): string {
  for (const s of Array.from(svg.querySelectorAll("style"))) s.remove();
  for (const a of ["class", "width", "height", "font-family", "font-size", "text-anchor", "fill"]) svg.removeAttribute(a);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const g of Array.from(svg.querySelectorAll("g"))) {
    g.removeAttribute("aria-label");
    // the chart CSS owns color and width, so the tokens and dark mode apply
    g.removeAttribute("stroke");
    g.removeAttribute("stroke-width");
  }
  for (const p of Array.from(svg.querySelectorAll("path"))) {
    const d = p.getAttribute("d");
    if (d) p.setAttribute("d", roundNumbers(d));
  }
  for (const l of Array.from(svg.querySelectorAll("line"))) {
    for (const a of ["x1", "x2", "y1", "y2"]) {
      const v = l.getAttribute(a);
      if (v) l.setAttribute(a, roundNumbers(v));
    }
  }
  return svg.outerHTML;
}

/**
 * Grid rules and price lines as a static SVG string. Classes: `grid` on the
 * rules, `line line-primary` or `line line-bench` on each line. A null value
 * breaks the line, the same gap the data has.
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
  });
  return finish(svg as unknown as Element);
}
