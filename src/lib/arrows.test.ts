import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARROW_ICON, DIRECTIONS, arrowId, arrowPath, compactPath } from "./arrows.ts";
import { iconFile } from "./icons.ts";

/** Every number in a path, in order. */
const numbers = (d: string) => [...d.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)].map((m) => Number(m[0]));

describe("direction arrows", () => {
  it("draws rose, fell and about the same from the road sign icons", () => {
    expect(ARROW_ICON).toEqual({ up: "rose", down: "fell", flat: "about-the-same" });
    expect([...DIRECTIONS].sort()).toEqual(["down", "flat", "up"]);
  });

  it("names the sprite symbols the way the page scripts build them", () => {
    for (const d of DIRECTIONS) expect(arrowId(d)).toBe(`arrow-${d}`);
    for (const script of ["../scripts/chart.js", "../components/home/map.js"]) {
      const src = readFileSync(new URL(script, import.meta.url), "utf8");
      expect(src, script).toContain('<use href="#arrow-');
    }
  });

  for (const d of DIRECTIONS) {
    it(`keeps the ${ARROW_ICON[d]} icon's shape to a hundredth of a unit (${d})`, () => {
      const source = /\sd="([^"]+)"/.exec(iconFile(ARROW_ICON[d])!)![1];
      const a = numbers(source);
      const b = numbers(arrowPath(d));
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(0.005 + 1e-9);
      // the same commands in the same order
      expect(arrowPath(d).replace(/[^A-Za-z]/g, "")).toBe(source.replace(/[^A-Za-z]/g, ""));
      // inside the 24 unit grid, clear of its edges
      for (const n of b) expect(n).toBeGreaterThan(2);
      for (const n of b) expect(n).toBeLessThan(22);
    });
  }

  it("stands the up and down arrows as tall as each other, and centers them all", () => {
    // Bounds from every point the path names, curve handles included. The
    // icons use absolute M, L, H, V, C and Z only.
    const box = (d: "up" | "down" | "flat") => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [, cmd, args] of arrowPath(d).matchAll(/([MLHVCZ])([^MLHVCZ]*)/g)) {
        const n = numbers(args);
        if (cmd === "H") xs.push(...n);
        else if (cmd === "V") ys.push(...n);
        else n.forEach((v, i) => (i % 2 ? ys : xs).push(v));
      }
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    for (const d of DIRECTIONS) {
      const b = box(d);
      expect(Math.abs((b.x0 + b.x1) / 2 - 12)).toBeLessThan(0.3);
    }
    const up = box("up");
    const down = box("down");
    expect(Math.abs(up.y1 - up.y0 - (down.y1 - down.y0))).toBeLessThan(0.8);
    // about the same is a sideways arrow, shorter than the others
    const flat = box("flat");
    expect(flat.y1 - flat.y0).toBeLessThan(up.y1 - up.y0);
  });

  it("rounds path numbers to hundredths and tidies the spacing", () => {
    expect(compactPath("M9.40001 8.49998L  -0.004 .125Z")).toBe("M9.4 8.5L 0 0.13Z");
    expect(compactPath("M12.799 3.34301H5.09201")).toBe("M12.8 3.34H5.09");
  });
});
