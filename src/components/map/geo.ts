// Geometry for the map page, shared by the build (which state a point sits
// in) and the browser (the corridor tool). Spherical earth, miles, GeoJSON
// order for polygon coordinates ([lon, lat]) and lat first for points, the
// way Leaflet takes them. No dependencies, so it bundles into the page's
// inline module.

/** Mean earth radius in statute miles. */
export const EARTH_MI = 3958.7613;
const D = Math.PI / 180;

/** Great circle distance in miles. */
export function distMi(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = aLat * D, p2 = bLat * D, dp = (bLat - aLat) * D, dl = (bLon - aLon) * D;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, degrees clockwise from north, 0 to 360. */
export function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = aLat * D, p2 = bLat * D, dl = (bLon - aLon) * D;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D) + 360) % 360;
}

/** The point `mi` miles from a along `brg` degrees. */
export function destination(lat: number, lon: number, brg: number, mi: number): [number, number] {
  const p1 = lat * D, l1 = lon * D, t = brg * D, d = mi / EARTH_MI;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / D, (((l2 / D) + 540) % 360) - 180];
}

/**
 * The great circle from a to b as points every `stepMi` miles, ending on b.
 * Chicago to Cheyenne at 5 miles is about 180 points.
 */
export function sample(aLat: number, aLon: number, bLat: number, bLon: number, stepMi: number): [number, number][] {
  const total = distMi(aLat, aLon, bLat, bLon);
  const out: [number, number][] = [[aLat, aLon]];
  const brg = bearing(aLat, aLon, bLat, bLon);
  for (let m = stepMi; m < total; m += stepMi) out.push(destination(aLat, aLon, brg, m));
  if (total > 0) out.push([bLat, bLon]);
  return out;
}

/**
 * Where a point sits against the line from a to b: `xt` is the distance off
 * the line in miles (positive to the right of travel), `at` the distance
 * along it from a. A point is inside a band of half width w when |xt| <= w
 * and 0 <= at <= the line's length.
 */
export function track(aLat: number, aLon: number, bLat: number, bLon: number, pLat: number, pLon: number): { xt: number; at: number } {
  const d13 = distMi(aLat, aLon, pLat, pLon) / EARTH_MI;
  const t13 = bearing(aLat, aLon, pLat, pLon) * D, t12 = bearing(aLat, aLon, bLat, bLon) * D;
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  const c = Math.cos(d13) / Math.cos(xt);
  const at = Math.acos(Math.max(-1, Math.min(1, c)));
  // behind a, the along track distance runs the other way
  const back = Math.cos(t13 - t12) < 0;
  return { xt: xt * EARTH_MI, at: (back ? -at : at) * EARTH_MI };
}

/** A closed ring `w` miles either side of the line, from the sampled points. */
export function band(line: [number, number][], w: number): [number, number][] {
  const n = line.length;
  if (n < 2) return [];
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [p, q] = i < n - 1 ? [line[i], line[i + 1]] : [line[i - 1], line[i]];
    const brg = bearing(p[0], p[1], q[0], q[1]);
    left.push(destination(line[i][0], line[i][1], brg - 90, w));
    right.push(destination(line[i][0], line[i][1], brg + 90, w));
  }
  return left.concat(right.reverse(), [left[0]]);
}

/** Even odd test against one ring of [lon, lat] pairs. */
export function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Geometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

/** Inside a Polygon or MultiPolygon, holes respected. */
export function inGeometry(lon: number, lat: number, g: Geometry): boolean {
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
  for (const rings of polys) {
    if (!inRing(lon, lat, rings[0])) continue;
    let hole = false;
    for (let i = 1; i < rings.length && !hole; i++) hole = inRing(lon, lat, rings[i]);
    if (!hole) return true;
  }
  return false;
}

export interface Shape {
  code: string;
  geometry: Geometry;
  /** [west, south, east, north], worked out once so most states are skipped by a compare. */
  bbox: [number, number, number, number];
}

export function bboxOf(g: Geometry): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c: unknown): void => {
    if (typeof (c as number[])[0] === "number") {
      const [x, y] = c as number[];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    } else for (const k of c as unknown[]) walk(k);
  };
  walk(g.coordinates);
  return [w, s, e, n];
}

/** Which shape holds the point, or null at sea and abroad. */
export function shapeAt(lat: number, lon: number, shapes: Shape[]): string | null {
  for (const s of shapes) {
    const [w, so, e, n] = s.bbox;
    if (lon < w || lon > e || lat < so || lat > n) continue;
    if (inGeometry(lon, lat, s.geometry)) return s.code;
  }
  return null;
}

/**
 * [x0, y0, dx1, dy1, ...], integers in units of 10^-p degrees with lon
 * first and each pair added to the one before, back to [lon, lat] pairs.
 * The roads file and the page's own outline and road files use it.
 */
export function undelta(a: number[], p: number): [number, number][] {
  const s = 10 ** p, out: [number, number][] = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    x += a[i];
    y += a[i + 1];
    out.push([x / s, y / s]);
  }
  return out;
}

/** The other way: [lon, lat] pairs to a delta array at p decimals, a point that repeats the one before dropped unless `keep`. */
export function delta(pts: number[][], p: number, keep = false): number[] {
  const s = 10 ** p, out: number[] = [];
  let px = 0, py = 0, first = true;
  for (const [lon, lat] of pts) {
    const x = Math.round(lon * s), y = Math.round(lat * s);
    if (!keep && !first && x === px && y === py) continue;
    out.push(x - px, y - py);
    px = x;
    py = y;
    first = false;
  }
  return out;
}
