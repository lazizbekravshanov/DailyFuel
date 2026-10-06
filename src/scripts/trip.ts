// The trip's route and its result, loaded by the map only when a trip is
// asked for, so the map's own inline script and its first load don't carry
// them: served as /map/trip.js by src/pages/map/trip.js.ts.

import { STEP_MI, type Cfg, type Corridor, type PriceRow, type Pt, type Run } from "./map.ts";
import { esc, fmt } from "./text.ts";

export { route } from "./route.ts";

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
