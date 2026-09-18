// Build time US map from us-atlas. The file is already projected to 975 by 610,
// so d3-geo draws it with a null projection. Nothing about the map runs in the browser.

import { geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, GeometryObject, Topology } from "topojson-specification";
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
let topoCache: Atlas | null = null;

/**
 * The atlas puts the western Aleutians at x = -58, left of the viewBox, so on a
 * narrow screen they run off the page. Slide the Alaska inset right until its
 * ink starts inside the box, and Hawaii right with it so the two insets keep
 * their spacing. Nothing else moves. FIPS 02 is Alaska, 15 is Hawaii.
 */
export const INSET_SHIFT: Record<string, number> = { "02": 60, "15": 44 };

/** Every arc index a geometry uses, with reversed (~i) indices folded back. */
function arcsOf(g: GeometryObject): Set<number> {
  const out = new Set<number>();
  const walk = (a: unknown): void => {
    if (typeof a === "number") out.add(a < 0 ? ~a : a);
    else if (Array.isArray(a)) a.forEach(walk);
  };
  walk((g as { arcs?: unknown }).arcs);
  return out;
}

/**
 * Thin the shared arcs once, before building shapes, so neighbors keep matching
 * borders. Points closer than `tolerance` map units to the last kept point are
 * dropped. At the size the map renders, one unit is under a pixel.
 */
function simplify(topo: Atlas, tolerance: number): Atlas {
  const t = topo.transform!;
  const tol2 = tolerance * tolerance;
  // The insets share no border with any other state, so shifting their arcs
  // moves the state and its piece of the nation outline together.
  const shift = new Map<number, number>();
  for (const g of topo.objects.states.geometries) {
    const dx = INSET_SHIFT[String(g.id).padStart(2, "0")];
    if (dx) for (const i of arcsOf(g)) shift.set(i, dx);
  }
  const arcs = topo.arcs.map((arc, ai) => {
    const sx = shift.get(ai) ?? 0;
    let qx = 0;
    let qy = 0;
    const abs = arc.map(([dx, dy]) => {
      qx += dx;
      qy += dy;
      return [qx * t.scale[0] + t.translate[0] + sx, qy * t.scale[1] + t.translate[1]] as [number, number];
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

function draw(geo: Parameters<ReturnType<typeof geoPath>>[0]): string {
  const ctx = new ShortPath();
  geoPath(null, ctx as unknown as CanvasRenderingContext2D)(geo);
  return ctx.result();
}

function load(): void {
  if (shapes) return;
  const topo = simplify(atlas as unknown as Atlas, 0.9);
  topoCache = topo;
  const measure = geoPath(null);
  const fc = feature(topo, topo.objects.states);
  shapes = new Map();
  for (const f of fc.features) {
    const fips = String(f.id).padStart(2, "0");
    const [cx, cy] = measure.centroid(f);
    shapes.set(fips, {
      fips,
      d: draw(f),
      centroid: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
      area: measure.area(f),
    });
  }
  outline = draw(mesh(topo, topo.objects.nation));
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
 * The borders where two price regions meet, as one path. State lines inside a
 * region and the coast are left out, so a region reads as one block. These are
 * shared arcs of the topology, so they line up exactly with the state shapes.
 * The whole region lights up on hover in the browser by copying its member
 * shapes, which costs no page weight; a merged outline per region would repeat
 * the coastline and add about 30KB to the home page.
 * `regionOf` maps a 2 digit FIPS id to its region key, or null for none.
 */
export function regionEdges(regionOf: (fips: string) => string | null): string {
  load();
  const topo = topoCache!;
  const key = (g: GeometryObject): string | null => regionOf(String(g.id).padStart(2, "0"));
  return draw(mesh(topo, topo.objects.states, (a, b) => a !== b && key(a) !== null && key(b) !== null && key(a) !== key(b)));
}

/**
 * Small eastern states get a labeled box to the right of the map so they can be
 * seen and clicked. Order runs north to south.
 */
export const CALLOUTS = ["VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD", "DC"];
