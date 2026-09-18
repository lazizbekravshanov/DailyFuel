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

function paths(svg: string): string[] {
  return [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
}

describe("linesSvg", () => {
  const svg = linesSvg({ ...frame, grid: [3, 3.5, 4], lines: [{ kind: "primary", points: pts }] });

  it("is plain static SVG with no Plot leftovers", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<style/);
    expect(svg).not.toMatch(/plot-[0-9a-f]{6}/);
    expect(svg).not.toMatch(/<script/);
    expect(svg).not.toMatch(/font-family|width="|height="/);
    expect(svg).toContain(`viewBox="0 0 ${VIEW} ${VIEW}"`);
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
  });

  it("leaves color and width to the chart CSS", () => {
    expect(svg).not.toMatch(/stroke="currentColor"|stroke-width=/);
    expect(svg).toContain('class="grid"');
    expect(svg).toContain('class="line line-primary"');
  });

  it("draws one hairline rule per grid value, across the whole plot", () => {
    const lines = [...svg.matchAll(/<line ([^>]+)>/g)].map((m) => m[1]);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).toContain('x1="0"');
      expect(l).toContain(`x2="${VIEW}"`);
    }
    const ys = lines.map((l) => Number(/y1="([^"]+)"/.exec(l)![1])).sort((a, b) => a - b);
    expect(ys).toEqual([0, 500, 1000]);
  });

  it("breaks the line where a week has no price", () => {
    const [d] = paths(svg);
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("puts points where Plot's own percent scales say", () => {
    const s = frameScales(frame);
    const [d] = paths(svg);
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // first point
    expect(nums[0]).toBeCloseTo(s.x("2026-01-05") * 10, 1);
    expect(nums[1]).toBeCloseTo(s.y(3.5) * 10, 1);
    // last point
    expect(nums[nums.length - 2]).toBeCloseTo(s.x("2026-02-02") * 10, 1);
    expect(nums[nums.length - 1]).toBeCloseTo(s.y(3.9) * 10, 1);
  });

  it("rounds coordinates to one decimal", () => {
    const odd = linesSvg({ from: "2026-01-01", to: "2026-01-04", lo: 0, hi: 3, grid: [1], lines: [{ kind: "bench", points: [{ date: "2026-01-02", value: 1 }, { date: "2026-01-03", value: 2 }] }] });
    for (const n of odd.match(/\d+\.\d+/g) ?? []) expect(n.split(".")[1].length).toBe(1);
  });

  it("draws a step line as holds and jumps", () => {
    const step = linesSvg({ ...frame, grid: [], lines: [{ kind: "bench", step: true, points: [pts[0], pts[1]] }] });
    const [d] = paths(step);
    // step after: across at the old value, then up to the new one
    expect(d).toMatch(/^M0,500L250,500L250,400$/);
    expect(step).toContain('class="line line-bench"');
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
