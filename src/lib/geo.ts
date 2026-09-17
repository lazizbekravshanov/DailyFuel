// Build time US map from us-atlas. The file is already projected to 975 by 610,
// so d3-geo draws it with a null projection. Nothing about the map runs in the browser.

import { geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import atlas from "us-atlas/states-albers-10m.json";

export const MAP_WIDTH = 975;
export const MAP_HEIGHT = 610;

export interface StateShape {
  fips: string;
  d: string;
  centroid: [number, number];
  area: number;
}

type Atlas = Topology<{ states: GeometryCollection<{ name: string }>; nation: GeometryCollection }>;

let shapes: Map<string, StateShape> | null = null;
let outline: string | null = null;

/**
 * Thin the shared arcs once, before building shapes, so neighbors keep matching
 * borders. Points closer than `tolerance` map units to the last kept point are
 * dropped. At the size the map renders, one unit is under a pixel.
 */
function simplify(topo: Atlas, tolerance: number): Atlas {
  const t = topo.transform!;
  const tol2 = tolerance * tolerance;
  const arcs = topo.arcs.map((arc) => {
    let qx = 0;
    let qy = 0;
    const abs = arc.map(([dx, dy]) => {
      qx += dx;
      qy += dy;
      return [qx * t.scale[0] + t.translate[0], qy * t.scale[1] + t.translate[1]] as [number, number];
    });
    const kept: [number, number][] = [abs[0]];
    for (let i = 1; i < abs.length - 1; i++) {
      const [lx, ly] = kept[kept.length - 1];
      const [x, y] = abs[i];
      if ((x - lx) ** 2 + (y - ly) ** 2 >= tol2) kept.push(abs[i]);
    }
    if (abs.length > 1) kept.push(abs[abs.length - 1]);
    return kept;
  });
  const { transform: _drop, ...rest } = topo;
  void _drop;
  return { ...rest, arcs } as Atlas;
}

/** Path data with one decimal and relative moves, which is far shorter than d3's absolute output. */
class ShortPath {
  private out: string[] = [];
  private x = 0;
  private y = 0;
  private start = true;
  private static n(v: number): string {
    const s = (Math.round(v * 10) / 10).toString();
    return s.startsWith("0.") ? s.slice(1) : s.startsWith("-0.") ? `-${s.slice(2)}` : s;
  }
  private static pair(a: number, b: number): string {
    const sb = ShortPath.n(b);
    return `${ShortPath.n(a)}${sb.startsWith("-") ? "" : " "}${sb}`;
  }
  moveTo(x: number, y: number): void {
    const rx = Math.round(x * 10) / 10;
    const ry = Math.round(y * 10) / 10;
    this.out.push(`M${ShortPath.pair(rx, ry)}`);
    this.x = rx;
    this.y = ry;
    this.start = true;
  }
  lineTo(x: number, y: number): void {
    const rx = Math.round(x * 10) / 10;
    const ry = Math.round(y * 10) / 10;
    const dx = rx - this.x;
    const dy = ry - this.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
    this.out.push(`${this.start ? "l" : " "}${ShortPath.pair(dx, dy)}`);
    this.start = false;
    this.x = rx;
    this.y = ry;
  }
  closePath(): void {
    this.out.push("z");
    this.start = true;
  }
  arc(): void {}
  result(): string {
    const r = this.out.join("");
    this.out = [];
    return r;
  }
}

function load(): void {
  if (shapes) return;
  const topo = simplify(atlas as unknown as Atlas, 0.9);
  const measure = geoPath(null);
  const fc = feature(topo, topo.objects.states);
  shapes = new Map();
  for (const f of fc.features) {
    const fips = String(f.id).padStart(2, "0");
    const ctx = new ShortPath();
    geoPath(null, ctx as unknown as CanvasRenderingContext2D)(f);
    const [cx, cy] = measure.centroid(f);
    shapes.set(fips, {
      fips,
      d: ctx.result(),
      centroid: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
      area: measure.area(f),
    });
  }
  const nctx = new ShortPath();
  geoPath(null, nctx as unknown as CanvasRenderingContext2D)(mesh(topo, topo.objects.nation));
  outline = nctx.result();
}

export function stateShape(fips: string): StateShape {
  load();
  const s = shapes!.get(fips);
  if (!s) throw new Error(`no map shape for FIPS ${fips}`);
  return s;
}

export function nationOutline(): string {
  load();
  return outline!;
}

/**
 * Small eastern states get a labeled box to the right of the map so they can be
 * seen and clicked. Order runs north to south.
 */
export const CALLOUTS = ["VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD", "DC"];
