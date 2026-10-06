// The trip's route, its maths and its result, loaded by the map only when a
// trip is asked for, so the map's own inline script and its first load don't
// carry them: served as /map/trip.js by src/pages/map/trip.js.ts.

import { band, distMi, sample, shapeAt, type Shape } from "../components/map/geo.ts";
import { BAND_MI, ROAD_MI, STEP_MI, type Cfg, type Corridor, type PriceRow, type Pt, type Run } from "./map.ts";
import { esc, fmt } from "./text.ts";

type LL = [number, number];

export { graph, route } from "./route.ts";

/**
 * A test for "within w miles of the line", for the thousands of road points a
 * trip checks: the line's samples on a half degree grid, and only the cells
 * around a point measured, on a flat earth in miles like the stops. The
 * band's polygon gives the same answer far slower.
 */
export function nearLine(line: LL[], w: number): (q: number[]) => boolean {
  const g = new Map<string, LL[]>(),
    k = (y: number, x: number) => y + "," + x;
  for (const q of line) {
    const c = k(Math.floor(q[0] * 2), Math.floor(q[1] * 2));
    (g.get(c) || g.set(c, []).get(c)!).push(q);
  }
  return ([lat, lon]) => {
    const kx = Math.cos((lat * Math.PI) / 180),
      ry = Math.ceil(w / 34),
      rx = Math.ceil(w / (34 * kx)),
      cy = Math.floor(lat * 2),
      cx = Math.floor(lon * 2);
    for (let y = cy - ry; y <= cy + ry; y++)
      for (let x = cx - rx; x <= cx + rx; x++)
        for (const q of g.get(k(y, x)) || []) {
          const dy = (q[0] - lat) * 69.1, dx = (q[1] - lon) * 69.1 * kx;
          if (dx * dx + dy * dy <= w * w) return true;
        }
    return false;
  };
}

/**
 * The trip from a to b: along the freight highway route when there is one
 * (see src/scripts/route.ts), else the straight line, sampled every mile on a
 * route and every STEP_MI miles on a straight line; the states it crosses in
 * order (by point in polygon on each sample); and the truck stops and weigh
 * stations switched on in the legend that sit within ROAD_MI miles of a route
 * (BAND_MI of a straight line), in order along it, each under the state the
 * line is in at that mile. With no outlines loaded it is one run with no state.
 */
export function corridor(a: LL, b: LL, pts: Pt[], shapes: Shape[], path?: LL[] | null): Corridor {
  const road = !!path,
    w = road ? ROAD_MI : BAND_MI,
    line: LL[] = [],
    ats: number[] = [],
    runs: Run[] = [];
  let miles = 0;
  (path || [a, b]).forEach((q, i, all) => {
    if (!i) return;
    const p = all[i - 1];
    for (const s of sample(p[0], p[1], q[0], q[1], road ? 1 : STEP_MI).slice(line.length ? 1 : 0)) {
      const last = line[line.length - 1];
      if (last) miles += distMi(last[0], last[1], s[0], s[1]);
      line.push(s);
      ats.push(miles);
    }
  });
  let outside = false,
    was: Shape | undefined;
  line.forEach((q, i) => {
    // the state the line was just in is the likeliest, so it is tried before the rest
    const code = !shapes.length ? null : was && shapeAt(q[0], q[1], [was]) ? was.code : shapeAt(q[0], q[1], shapes),
      at = ats[i],
      r = runs[runs.length - 1];
    was = shapes.find((s) => s.code === code);
    if (shapes.length && !code) outside = true;
    else if (r && r.code === code) r.to = at;
    else runs.push({ code, from: at, to: at, hits: [] });
  });
  let hits = 0;
  if (runs.length) {
    const inBand: { p: Pt; at: number }[] = [];
    // the nearest sample, on a flat earth in miles, which is close enough within a few miles
    // the line's box, w miles wider, keeps the far stops from being measured at all
    const lat = line.map((q) => q[0]),
      lon = line.map((q) => q[1]),
      dy = w / 69,
      dx = w / (69.1 * Math.cos((Math.min(80, Math.max(...lat.map(Math.abs)) + dy) * Math.PI) / 180)),
      s0 = Math.min(...lat) - dy,
      n0 = Math.max(...lat) + dy,
      w0 = Math.min(...lon) - dx,
      e0 = Math.max(...lon) + dx;
    for (const p of pts) {
      if (!p.on || p.k === "v" || p.lat < s0 || p.lat > n0 || p.lon < w0 || p.lon > e0) continue;
      const k = Math.cos((p.lat * Math.PI) / 180);
      let best = w * w, at = -1;
      line.forEach((q, i) => {
        const dy = (q[0] - p.lat) * 69.1, dx = (q[1] - p.lon) * 69.1 * k, d = dx * dx + dy * dy;
        if (d <= best) (best = d), (at = ats[i]);
      });
      if (at >= 0) inBand.push({ p, at });
    }
    inBand.sort((x, y) => x.at - y.at);
    for (const h of inBand) {
      // the run the line is in at that mile, or the nearest one across a border or a stretch of water
      let best = runs[0], gap = Infinity;
      for (const r of runs) {
        const g = h.at < r.from ? r.from - h.at : h.at > r.to ? h.at - r.to : 0;
        if (g < gap) {
          gap = g;
          best = r;
        }
      }
      best.hits.push(h);
      hits++;
    }
  }
  return { miles, line, ring: band(line, w), runs, outside, hits, road };
}

/** Miles per gallon when the driver hasn't said: a loaded tractor trailer gets about this. */
export const MPG = 6.5;

/** The miles per gallon a driver typed, or null when it isn't a truck's: 2 to 20. */
export const readMpg = (v: string): number | null => {
  const n = +v.trim();
  return n >= 2 && n <= 20 ? n : null;
};

/** "Miles 0 to 150", rounded to whole miles. */
export const milesText = (r: Run, last: number): string =>
  `Miles ${Math.round(r.from)} to ${Math.round(r.to === r.from ? Math.min(r.to + STEP_MI, last) : r.to)}`;

/**
 * The trip's miles in each state, in the order the line first enters it,
 * for the fuel table and a driver's IFTA miles. A state the line crosses back
 * into adds up. Each border sits halfway between the last mile in one state
 * and the first in the next, so the miles over water or another country are
 * shared by the states either side and the states add up to the whole trip;
 * whole miles are rounded so they still add up to the rounded total.
 */
export function stateMiles(res: Corridor): [string | null, number][] {
  const by = new Map<string | null, number>(),
    rs = res.runs;
  rs.forEach((r, i) => {
    const from = i ? (rs[i - 1].to + r.from) / 2 : 0,
      to = i < rs.length - 1 ? (r.to + rs[i + 1].from) / 2 : res.miles;
    by.set(r.code, (by.get(r.code) || 0) + to - from);
  });
  const all = [...by],
    whole = all.map(([c, m]): [string | null, number] => [c, Math.floor(m)]);
  let left = Math.round(res.miles) - whole.reduce((t, x) => t + x[1], 0);
  // the largest remainders take the miles the rounding down left over
  for (const i of all.map((_, i) => i).sort((x, y) => (all[y][1] % 1) - (all[x][1] % 1))) if (left-- > 0) whole[i][1]++;
  return whole;
}

const usd = (n: number) => "$" + fmt(Math.round(n));
const gal = (n: number) => (n < 100 ? n.toFixed(1) : fmt(Math.round(n)));

/** The name cell's button: it opens the point's popup on the map. */
// no form holds the list, the route strip's result or a popup, so a button there is a plain button
const lk = (p: Pt) => `<button class="lk" data-i="${p.i}">${esc(p.n)}</button>`;

/**
 * The trip's result: the line and the fuel it takes; the price in each state
 * it crosses (once, where the line first enters it, however often it
 * crosses back) and the lowest of them; the miles, gallons and fuel in each
 * state at the driver's miles per gallon and the state's weekly average;
 * then one table of the places along the line in order, a row for each
 * stretch's state with its miles and tax.
 * Many states share one regional average, so the lowest is named only when
 * some state on the line is above it, and a tie names every state in it.
 */
export function stripHtml(res: Corridor, aLabel: string, bLabel: string, cfg: Cfg, withButtons: boolean, mpg = MPG): string {
  const byCode: Record<string, PriceRow> = {},
    seen: PriceRow[] = [],
    num = (r: PriceRow) => +r[2]!.slice(1);
  for (const r of cfg.px) byCode[r[0]] = r;
  // the fuel at each state's weekly average; a state with no weekly price adds miles but no dollars
  let gals = 0,
    cost = 0,
    unpriced = 0,
    fuel = "";
  for (const [code, m] of stateMiles(res)) {
    const row = code ? byCode[code] : null,
      g = m / mpg;
    gals += g;
    if (row && row[2]) cost += g * num(row);
    else unpriced += m;
    fuel += `<tr><td>${row ? esc(row[1]) : "State not known"}<td class="num">${fmt(m)}<td class="num">${gal(g)}<td class="num">${row && row[2] ? usd(g * num(row)) : "No price"}`;
  }
  let h = `<p class="rsum"><b>${esc(aLabel)}</b> to <b>${esc(bLabel)}</b>, ${fmt(Math.round(res.miles))} miles ${res.road ? "on freight highways" : "in a straight line"}</p>`,
    rest = "";
  if (cost) h += `<p class="rfuel">About ${gal(gals)} gallons of diesel, about <b>${usd(cost)}</b> at ${mpg} miles per gallon${unpriced ? `, not counting ${fmt(unpriced)} miles with no weekly price` : ""}</p>`;
  if (res.outside) h += `<p class="fine">Part of the line runs over water or outside the 50 states.</p>`;
  if (withButtons) h += `<p><button class="btn" data-clr>Show every stop</button>`;
  h += `<ul class="rp">`;
  for (const r of res.runs) {
    const row = r.code ? byCode[r.code] : null,
      k = r.hits.length;
    if (row && !seen.includes(row)) {
      seen.push(row);
      h += `<li><b>${esc(row[1])}</b> ${row[2] ? `${row[2]} <span class="${row[4]}">${row[3] || ""}</span>` : "No weekly price"}`;
    }
    rest += `<tr class="rg"><th colspan="2">${row ? esc(row[1]) : "State not known"}: ${k} ${k == 1 ? "place" : "places"}, ${milesText(r, res.miles).toLowerCase()}${row ? `, state tax ${row[6]}` : ""}`;
    for (const x of r.hits) rest += `<tr><td class="num">${Math.round(x.at)}<td>${withButtons ? lk(x.p) : esc(x.p.n)}`;
  }
  h += `</ul>`;
  // "$10.100" sorts before "$9.900" as text, so the numbers are compared
  const priced = seen.filter((r) => r[2]),
    lo = Math.min(...priced.map(num)),
    low = priced.filter((r) => num(r) == lo);
  if (low.length < priced.length)
    h += `<p>Lowest weekly average on this line: <b>${esc(low.map((r) => r[1]).join(", ").replace(/, ([^,]*)$/, " and $1"))}, ${low[0][2]}</b></p>`;
  h += `<h3 class="rh">Miles and fuel by state</h3><p class="fine">At ${mpg} miles per gallon and each state's weekly average, not any one stop's price.</p>`;
  h += `<table class="rf"><thead><tr><th>State<th class="num">Miles<th class="num">Gallons<th class="num">Fuel<tbody>${fuel}`;
  h += `<tr class="tot"><th>Total<td class="num">${fmt(Math.round(res.miles))}<td class="num">${gal(gals)}<td class="num">${cost ? usd(cost) : "No price"}</table>`;
  return h + `<h3 class="rh">${fmt(res.hits)} ${res.hits == 1 ? "place" : "places"} along the route</h3><table class="rs"><thead><tr><th class="num">Mile<th>Name<tbody>${rest}</table>`;
}
