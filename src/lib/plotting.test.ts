import { describe, expect, it } from "vitest";
import { frameScales, isoDate, linesSvg, VIEW } from "./plotting.ts";

const frame = { from: "2026-01-05", to: "2026-02-02", lo: 3, hi: 4 };
const pts = [
  { date: "2026-01-05", value: 3.5 },
  { date: "2026-01-12", value: 3.6 },
  { date: "2026-01-19", value: null },
  { date: "2026-01-26", value: 3.7 },
  { date: "2026-02-02", value: 3.9 },
];

function paths(svg: string): { cls: string; d: string }[] {
  return [...svg.matchAll(/<path class="([^"]+)" d="([^"]+)"/g)].map((m) => ({ cls: m[1], d: m[2] }));
}

describe("linesSvg", () => {
  const svg = linesSvg({ ...frame, grid: [3, 3.5, 4], lines: [{ kind: "primary", points: pts }], dot: { x: 100, y: 10 } });

  it("is plain static SVG with no Plot leftovers", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<style/);
    expect(svg).not.toMatch(/plot-[0-9a-f]{6}/);
    expect(svg).not.toMatch(/<script/);
    expect(svg).not.toMatch(/<g\b|<line\b/);
    expect(svg).not.toMatch(/font-family|width="|height="/);
    expect(svg).toContain(`viewBox="0 0 ${VIEW} ${VIEW}"`);
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
  });

  it("leaves color and width to the chart CSS", () => {
    expect(svg).not.toMatch(/stroke="currentColor"|stroke-width=/);
    expect(paths(svg).map((p) => p.cls)).toEqual(["grid", "ln", "pt"]);
  });

  // The paper terminal folds the rules into one path, the way the mockup draws them.
  it("draws every grid value as one hairline path across the whole plot", () => {
    const grid = paths(svg).find((p) => p.cls === "grid")!;
    const rules = grid.d.match(/M0 -?\d+(\.\d+)?H1000/g) ?? [];
    expect(rules).toHaveLength(3);
    const ys = rules.map((r) => Number(/M0 ([^H]+)H/.exec(r)![1])).sort((a, b) => a - b);
    expect(ys).toEqual([0, 500, 1000]);
  });

  it("breaks the line where a week has no price", () => {
    const line = paths(svg).find((p) => p.cls === "ln")!;
    expect(line.d.match(/M/g)).toHaveLength(2);
  });

  it("marks the newest week with a zero length stroke, which the round cap draws as a dot", () => {
    const dot = paths(svg).find((p) => p.cls === "pt")!;
    expect(dot.d).toBe("M1000 100h0");
    expect(linesSvg({ ...frame, grid: [], lines: [] })).not.toContain('class="pt"');
  });

  /** The absolute points a path visits, from its M and relative l steps. */
  function visited(d: string): [number, number][] {
    const out: [number, number][] = [];
    let x = 0;
    let y = 0;
    for (const seg of d.match(/[Ml]-?\d+,-?\d+/g)!) {
      const [a, b] = seg.slice(1).split(",").map(Number);
      if (seg[0] === "M") [x, y] = [a, b];
      else [x, y] = [x + a, y + b];
      out.push([x, y]);
    }
    return out;
  }

  it("puts points where Plot's own percent scales say", () => {
    const s = frameScales(frame);
    const line = paths(svg).find((p) => p.cls === "ln")!;
    const pts = visited(line.d);
    expect(pts).toHaveLength(4);
    expect(pts[0][0]).toBeCloseTo(s.x("2026-01-05") * 10, 0);
    expect(pts[0][1]).toBeCloseTo(s.y(3.5) * 10, 0);
    expect(pts[3][0]).toBeCloseTo(s.x("2026-02-02") * 10, 0);
    expect(pts[3][1]).toBeCloseTo(s.y(3.9) * 10, 0);
  });

  // relative steps between the points: small repeating numbers that gzip well
  it("writes the line as a start and relative steps", () => {
    const line = paths(svg).find((p) => p.cls === "ln")!;
    expect(line.d).toMatch(/^M\d+,\d+(l-?\d+,-?\d+)+M\d+,\d+(l-?\d+,-?\d+)+$/);
  });

  // whole units of the 1000 box: the page budget is tight, and a tenth of a percent is under a pixel
  it("rounds coordinates to whole units", () => {
    const odd = linesSvg({ from: "2026-01-01", to: "2026-01-04", lo: 0, hi: 3, grid: [1], lines: [{ kind: "bench", points: [{ date: "2026-01-02", value: 1 }, { date: "2026-01-03", value: 2 }] }], dot: { x: 66.66, y: 33.33 } });
    expect(odd).not.toMatch(/\d\.\d/);
    expect(odd).toContain('class="pt" d="M667 333h0"');
  });

  it("draws a step line as holds and jumps, marked as the benchmark", () => {
    const step = linesSvg({ ...frame, grid: [], lines: [{ kind: "bench", step: true, points: [pts[0], pts[1]] }] });
    const [line] = paths(step);
    // step after: across at the old value, then up to the new one
    expect(line.cls).toBe("ln bench");
    expect(line.d).toBe("M0,500l250,0l0,-100");
  });

  it("never needs a browser document", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
  });
});

describe("frameScales", () => {
  it("maps the frame to percent of the plot box, y from the top", () => {
    const s = frameScales(frame);
    expect(s.x("2026-01-05")).toBe(0);
    expect(s.x("2026-02-02")).toBe(100);
    expect(s.x("2026-01-19")).toBe(50);
    expect(s.y(4)).toBe(0);
    expect(s.y(3)).toBe(100);
    expect(s.y(3.25)).toBeCloseTo(75, 10);
  });

  it("gives a one day chart a one day wide axis", () => {
    const s = frameScales({ from: "2026-01-05", to: "2026-01-05", lo: 0, hi: 1 });
    expect(s.x("2026-01-05")).toBe(0);
    expect(s.x("2026-01-06")).toBe(100);
  });

  it("reads ISO days as UTC midnight", () => {
    expect(isoDate("2026-03-08").toISOString()).toBe("2026-03-08T00:00:00.000Z");
  });
});
