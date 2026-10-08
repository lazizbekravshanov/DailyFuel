// The map page's script, in the parts that are plain functions: reading a
// row back into a point, the base layers' decoding, finding a place, the
// trip's maths and markup, the popup, the marker sizes, the sort.
// Plus the chains' letters, which are all that tells their ink dots apart.

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { CHAINS } from "../components/map/chains.ts";
import { bearing, destination, distMi } from "../components/map/geo.ts";
import { rowsHtml } from "../components/map/page.ts";
import { placesPayload, statesPayload, type MapPoint, type MapStateShape } from "../lib/mapdata.ts";
import {
  BAND_MI,
  decodePlaces,
  decodeStates,
  esc,
  findPlace,
  popupHtml,
  radius,
  readRow,
  sortPts,
  type Cfg,
  type PriceRow,
  type Places,
  type Pt,
} from "./map.ts";
import { corridor, END_MI, LONG_MI, LONG_X, MPG, readMpg, stateMiles, stripHtml } from "./trip.ts";


describe("the chains", () => {
  it("are seven, each with its own letter and a locator, and no colour of their own", () => {
    expect(CHAINS).toHaveLength(7);
    expect(new Set(CHAINS.map((c) => c.letter)).size).toBe(7);
    for (const ch of CHAINS) {
      expect(ch).not.toHaveProperty("ink");
      expect(ch.locator).toMatch(/^https:\/\//);
    }
  });
});

// Boxes standing in for four states on I 80, enough for the maths.
const box = (code: string, w: number, s: number, e: number, n: number): MapStateShape => ({
  code,
  name: code,
  geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  bbox: [w, s, e, n],
});
const STATES = [box("IL", -91.5, 37, -87.5, 42.5), box("IA", -96.5, 40.4, -91.5, 43.5), box("NE", -104.05, 40, -96.5, 43), box("WY", -111, 41, -104.05, 45)];
const shapes = decodeStates(statesPayload(STATES));

// the state rows of a trip's table, read as text: its end tags are left out as HTML allows, which linkedom can't nest
const groups = (html: string): string[] => Array.from(html.matchAll(/<tr class="rg"><th colspan="2">([^<]*)/g), (m) => m[1]);

const CHICAGO: [number, number] = [41.878, -87.63];
const CHEYENNE: [number, number] = [41.14, -104.82];

function pt(i: number, f: string, lat: number, lon: number, n = "Stop", st = "IL"): Pt {
  const k = f === "w" ? "w" : f === "v" ? "v" : "s";
  return { i, tr: null, f, k, lat, lon, n, t: k === "s" ? CHAINS.find((c) => c.key === f)!.name : k === "w" ? "Weigh station" : "Repair and lube", st, s: "o", d: "", c: k === "s" ? f : "", on: true };
}

const CFG: Cfg = {
  c: Object.fromEntries(CHAINS.map((c) => [c.key, [c.name, c.letter, c.locator]])),
  px: [
    ["IL", "Illinois", "$6.250", "up 30.4¢", "up", "Midwest average, same in 15 states", "54.5¢"],
    ["IA", "Iowa", "$6.250", "up 30.4¢", "up", "Midwest average, same in 15 states", "32.5¢"],
    ["NE", "Nebraska", "$6.250", "up 30.4¢", "up", "Midwest average, same in 15 states", "29.6¢"],
    ["WY", "Wyoming", "$6.066", "down 2.0¢", "down", "Rocky Mountain average, same in 5 states", "24.0¢"],
    ["AK", "Alaska", null, null, "muted", "EIA doesn't survey this state", "8.95¢"],
  ],
  wk: "Week of Sep 14, 2026 prices",
  mb: [[15, -190], [72.5, -60]],
  l48: [[24.4, -124.8], [49.4, -66.9]],
  ly: ["states"],
  tl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  gm: "https://www.google.com/maps/search/?api=1&query=",
};

/** A point `off` miles to the left (south, going west) of the Chicago to Cheyenne line, `at` miles along it. */
function along(at: number, off: number): [number, number] {
  const brg = bearing(...CHICAGO, ...CHEYENNE);
  const onLine = destination(...CHICAGO, brg, at);
  return destination(onLine[0], onLine[1], bearing(...onLine, ...CHEYENNE) - 90, off);
}

describe("the route strip", () => {
  const pts = [
    pt(0, "pilot", ...along(30, 10), "Pilot Joliet"),
    pt(1, "w", ...along(300, -20), "Weigh station, I 80 westbound", "IA"),
    pt(2, "loves", ...along(600, 24), "Love's", "NE"),
    pt(3, "loves", ...along(600, 30), "Far Love's", "NE"), // outside the band
    pt(4, "v", ...along(100, 0), "Speedco", "IL"), // service points are not listed
    pt(5, "ta", ...along(880, 3), "TA Cheyenne", "WY"),
    pt(6, "flyingj", 42.0, -80.0, "Behind A", "PA"), // east of Chicago, before the line starts
  ];

  it("walks the line west, state by state, with the stops inside the band in order", () => {
    const res = corridor(CHICAGO, CHEYENNE, pts, shapes);
    expect(Math.round(res.miles)).toBe(Math.round(distMi(...CHICAGO, ...CHEYENNE)));
    expect(res.runs.map((r) => r.code)).toEqual(["IL", "IA", "NE", "WY"]);
    expect(res.runs[0].from).toBe(0);
    expect(res.runs[3].to).toBeCloseTo(res.miles, 5);
    const names = res.runs.flatMap((r) => r.hits.map((h) => h.p.n));
    expect(names).toEqual(["Pilot Joliet", "Weigh station, I 80 westbound", "Love's", "TA Cheyenne"]);
    expect(res.runs[1].hits.map((h) => h.p.n)).toEqual(["Weigh station, I 80 westbound"]);
    const ats = res.runs.flatMap((r) => r.hits.map((h) => h.at));
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(res.hits).toBe(4);
    expect(res.outside).toBe(false);
    // a closed band around the line
    expect(res.ring[0]).toEqual(res.ring[res.ring.length - 1]);
    expect(res.line.length).toBeGreaterThan(res.miles / 5);
  });

  it("leaves out what the legend has switched off", () => {
    const off = pts.map((p) => ({ ...p, on: p.f !== "loves" }));
    const res = corridor(CHICAGO, CHEYENNE, off, shapes);
    expect(res.runs.flatMap((r) => r.hits.map((h) => h.p.n))).not.toContain("Love's");
    expect(res.hits).toBe(3);
  });

  it("says so when the line leaves the states it knows, and copes with no outlines at all", () => {
    const res = corridor(CHICAGO, [41.14, -115], pts, shapes);
    expect(res.outside).toBe(true);
    const none = corridor(CHICAGO, CHEYENNE, pts, []);
    expect(none.runs.map((r) => r.code)).toEqual([null]);
    expect(none.hits).toBe(4);
  });

  it("prints the line, each state's weekly price and its move in words, the lowest, then every place along the route, and no dash as punctuation", () => {
    const res = corridor(CHICAGO, CHEYENNE, pts, shapes);
    const html = stripHtml(res, "Chicago, IL", "Cheyenne, WY", CFG, true);
    const d = parseHTML(`<div>${html}</div>`).document;
    const t = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(t(d.querySelector(".rsum"))).toMatch(/^Chicago, IL to Cheyenne, WY, 8\d\d miles in a straight line$/);
    // one line per state: the name, the weekly price, the move in words
    const lines = Array.from(d.querySelectorAll(".rp li")).map(t);
    expect(lines).toEqual(["Illinois $6.250 up 30.4¢", "Iowa $6.250 up 30.4¢", "Nebraska $6.250 up 30.4¢", "Wyoming $6.066 down 2.0¢"]);
    // colour only on the change: the move wears up or down, the name and the price wear nothing
    const moves = Array.from(d.querySelectorAll(".rp li span"));
    expect(moves.map((m) => m.getAttribute("class"))).toEqual(["up", "up", "up", "down"]);
    expect(moves.map(t)).toEqual(["up 30.4¢", "up 30.4¢", "up 30.4¢", "down 2.0¢"]);
    expect(d.querySelectorAll(".rp li [class]")).toHaveLength(4);
    // the lowest is named as a weekly average, never as a cheapest stop
    expect(t(d.querySelector("div"))).toContain("Lowest weekly average on this line: Wyoming, $6.066");
    // then one table of every place along the line, in order, under a row for each state with its miles and tax
    expect(Array.from(d.querySelectorAll("h3.rh")).map(t)).toEqual(["Miles and fuel by state", "4 places along the route"]);
    const sums = groups(html);
    expect(sums).toHaveLength(4);
    expect(sums[0]).toMatch(/^Illinois: 1 place, miles 0 to \d+, state tax 54\.5¢$/);
    expect(sums[1]).toMatch(/^Iowa: 1 place, miles \d+ to \d+, state tax 32\.5¢$/);
    expect(sums[3]).toMatch(/^Wyoming: 1 place, miles \d+ to 8\d\d, state tax 24\.0¢$/);
    // a Mile and Name table, its end tags left out as HTML allows (which linkedom can't nest, so read as text)
    expect(html.match(/<table class="rs"><thead><tr><th class="num">Mile<th>Name<tbody>/g)).toHaveLength(1);
    expect(html).toMatch(/<tr><td class="num">\d+<td><button class="lk" data-i="0">Pilot Joliet<\/button>/);
    const text = d.querySelector("div")!.textContent!;
    expect(text).toContain("Illinois");
    expect(text).not.toMatch(/[–—]|\s-\s/);
    expect(text).not.toMatch(/[▲▼▴▾△▽◆⬆⬇↑↓→←‹›✓]/);
    expect(text).not.toMatch(/cheapest|truck route/i);
    // the move never rests on a sign
    expect(text).not.toMatch(/[+−]\d/);
    // each name opens its marker
    expect(d.querySelectorAll(".lk[data-i]")).toHaveLength(4);
    expect(stripHtml(res, "A", "B", CFG, false)).not.toContain("class=\"lk\"");
  });

  it("finds the lowest weekly average by number, names every state in a tie, and names none when nothing on the line is higher", () => {
    const res = corridor(CHICAGO, CHEYENNE, [], shapes);
    const prices = (by: Record<string, string | null>): Cfg => ({
      ...CFG,
      px: CFG.px.map((r): PriceRow => (r[0] in by ? [r[0], r[1], by[r[0]], r[3], r[4], r[5], r[6]] : r)),
    });
    // "$10.100" sorts before "$9.900" as text; the line compares the numbers
    expect(stripHtml(res, "A", "B", prices({ IL: "$10.100", IA: "$9.900", NE: "$10.000", WY: "$11.000" }), false)).toContain(
      "Lowest weekly average on this line: <b>Iowa, $9.900</b>",
    );
    // states that share the lowest regional average are named together, never the first of them alone
    expect(stripHtml(res, "A", "B", prices({ IL: "$6.000", IA: "$6.000", NE: "$6.500", WY: "$6.500" }), false)).toContain(
      "Lowest weekly average on this line: <b>Illinois and Iowa, $6.000</b>",
    );
    expect(stripHtml(res, "A", "B", prices({ IL: "$6.000", IA: "$6.000", NE: "$6.000", WY: "$6.500" }), false)).toContain(
      "<b>Illinois, Iowa and Nebraska, $6.000</b>",
    );
    // one region's average all along the line: no state is lower than another
    expect(stripHtml(res, "A", "B", prices({ IL: "$6.526", IA: "$6.526", NE: "$6.526", WY: "$6.526" }), false)).not.toContain("Lowest");
    // one state with a price has nothing to compare
    expect(stripHtml(res, "A", "B", prices({ IL: "$6.000", IA: null, NE: null, WY: null }), false)).not.toContain("Lowest");
  });

  it("prices a state once however often the line crosses back into it, and lists each stretch", () => {
    // a line along a border, like Cincinnati to Louisville: in and out of the same states
    const run = (code: string, from: number, to: number) => ({ code, from, to, hits: [] });
    const res = {
      miles: 100, line: [], ring: [], outside: false, hits: 0, road: false,
      runs: [run("IL", 0, 20), run("IA", 25, 40), run("IL", 45, 60), run("IA", 65, 80), run("WY", 85, 100)],
    };
    const d = parseHTML(`<div>${stripHtml(res, "A", "B", CFG, false)}</div>`).document;
    const t = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(Array.from(d.querySelectorAll(".rp li")).map(t)).toEqual(["Illinois $6.250 up 30.4¢", "Iowa $6.250 up 30.4¢", "Wyoming $6.066 down 2.0¢"]);
    expect(t(d.querySelector("div"))).toContain("Lowest weekly average on this line: Wyoming, $6.066");
    // the places still sit stretch by stretch, in order along the line
    expect(groups(stripHtml(res, "A", "B", CFG, false)).map((s) => s.split(":")[0])).toEqual(["Illinois", "Iowa", "Illinois", "Iowa", "Wyoming"]);
    // two states on one average, crossed five times: still no lowest
    const two = { ...res, runs: res.runs.slice(0, 4) };
    expect(stripHtml(two, "A", "B", CFG, false)).not.toContain("Lowest");
  });

  it("says No weekly price where the survey has none, and lists a stretch with nothing in it as 0 places", () => {
    const res = corridor([61.2, -149.9], [64.8, -147.7], [], [box("AK", -170, 51, -130, 71.5)]);
    const html = stripHtml(res, "Anchorage, AK", "Fairbanks, AK", CFG, true);
    const d = parseHTML(`<div>${html}</div>`).document;
    const t = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(Array.from(d.querySelectorAll(".rp li")).map(t)).toEqual(["Alaska No weekly price"]);
    // no price, so nothing to colour and nothing lowest
    expect(d.querySelectorAll(".rp li span")).toHaveLength(0);
    expect(html).not.toContain("$");
    expect(html).not.toContain("Lowest");
    expect(groups(html)).toHaveLength(1);
    expect(groups(html)[0]).toMatch(/^Alaska: 0 places, miles 0 to 2\d\d, state tax 8\.95¢$/);
    expect(t(d.querySelectorAll("h3.rh")[1])).toBe("0 places along the route");
    expect(html).not.toContain('<tr><td class="num">');
    // with no outlines the places still list, under a state not known, and no price is guessed
    const none = stripHtml(corridor(CHICAGO, CHEYENNE, pts, []), "A", "B", CFG, false);
    expect(none).toContain('<tr class="rg"><th colspan="2">State not known: 4 places, miles 0 to');
    expect(none).not.toContain("$");
  });

  it("adds up each state's miles to the whole trip, a state crossed back into counting once, and prices the fuel at each state's weekly average", () => {
    const run = (code: string, from: number, to: number) => ({ code, from, to, hits: [] });
    const res = {
      miles: 100, line: [], ring: [], outside: false, hits: 0, road: true,
      runs: [run("IL", 0, 20), run("IA", 25, 40), run("IL", 45, 60), run("IA", 65, 80), run("WY", 85, 100)],
    };
    // each border sits halfway between the two states' samples; IL and WY tie on the leftover mile and the first takes it
    expect(stateMiles(res)).toEqual([["IL", 43], ["IA", 40], ["WY", 17]]);
    const html = stripHtml(res, "A", "B", CFG, false, 10);
    const d = parseHTML(`<div>${html}</div>`).document;
    const t = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    // 4.3 gallons at $6.250, 4.0 at $6.250 and 1.7 at $6.066
    expect(t(d.querySelector(".rfuel"))).toBe("About 10.0 gallons of diesel, about $62 at 10 miles per gallon");
    expect(html).toContain('<tr><td>Illinois<td class="num">43<td class="num">4.3<td class="num">$27');
    expect(html).toContain('<tr><td>Wyoming<td class="num">17<td class="num">1.7<td class="num">$10');
    expect(html).toContain('<tr class="tot"><th>Total<td class="num">100<td class="num">10.0<td class="num">$62</table>');
    // never a stop's price
    expect(t(d.querySelector("div"))).toContain("At 10 miles per gallon and each state's weekly average, not any one stop's price.");
    // the default is a loaded truck's
    expect(MPG).toBe(6.5);
    expect(stripHtml(res, "A", "B", CFG, false)).toContain("at 6.5 miles per gallon");
  });

  it("leaves a state with no weekly price out of the fuel dollars and says so", () => {
    const run = (code: string, from: number, to: number) => ({ code, from, to, hits: [] });
    const ak = { miles: 200, line: [], ring: [], outside: false, hits: 0, road: false, runs: [run("AK", 0, 200)] };
    const html = stripHtml(ak, "A", "B", CFG, false);
    expect(html).not.toContain("rfuel");
    expect(html).toContain('<tr><td>Alaska<td class="num">200<td class="num">30.8<td class="num">No price');
    expect(html).toContain('<tr class="tot"><th>Total<td class="num">200<td class="num">30.8<td class="num">No price</table>');
    const mixed = { ...ak, runs: [run("IL", 0, 100), run("AK", 105, 200)] };
    expect(stripHtml(mixed, "A", "B", CFG, false, 10)).toContain("about <b>$64</b> at 10 miles per gallon, not counting 97 miles with no weekly price");
  });

  it("takes a truck's miles per gallon, 2 to 20, and nothing else", () => {
    expect(["6.5", " 7 ", "2", "20"].map(readMpg)).toEqual([6.5, 7, 2, 20]);
    expect(["", "0", "1.9", "21", "abc", "6,5"].map(readMpg)).toEqual([null, null, null, null, null, null]);
  });

  it("keeps the band at 25 miles", () => {
    expect(BAND_MI).toBe(25);
    const near = corridor(CHICAGO, CHEYENNE, [pt(0, "ta", ...along(400, 24.5))], []);
    const far = corridor(CHICAGO, CHEYENNE, [pt(0, "ta", ...along(400, -25.5))], []);
    expect(near.hits).toBe(1);
    expect(far.hits).toBe(0);
  });
});

describe("finding A and B", () => {
  const places = decodePlaces(
    placesPayload([
      { name: "Chicago", state: "IL", lat: 41.85, lon: -87.65 },
      { name: "Springfield", state: "IL", lat: 39.8, lon: -89.64 },
      { name: "Springfield", state: "MO", lat: 37.22, lon: -93.3 },
      { name: "Cheyenne", state: "WY", lat: 41.14, lon: -104.82 },
      { name: "Normal", state: "IL", lat: 40.51, lon: -88.99 },
      { name: "Bloomington", state: "IL", lat: 40.51, lon: -88.99 },
    ]),
  );

  it("decodes every place, two on the same spot included", () => {
    expect(places.label).toHaveLength(6);
    expect(places.label).toContain("Normal, IL");
    expect(places.label).toContain("Bloomington, IL");
  });

  it("matches a picked label, a start or a bare name, and no longer reads a typed lat, lon", () => {
    expect(findPlace("Chicago, IL", places)).toEqual({ label: "Chicago, IL", lat: 41.85, lon: -87.65 });
    expect(findPlace("  chicago, il ", places)).toMatchObject({ label: "Chicago, IL" });
    expect(findPlace("chicago", places)).toMatchObject({ label: "Chicago, IL" });
    expect(findPlace("chey", places)).toMatchObject({ label: "Cheyenne, WY" });
    expect(findPlace("Springfield, MO", places)).toMatchObject({ label: "Springfield, MO" });
    // a bare name in two states asks which, rather than picking the first state in the alphabet
    expect(findPlace("springfield", places)).toBe("Springfield, IL");
    expect(findPlace("Nowhere", places)).toBeNull();
    expect(findPlace("", places)).toBeNull();
    expect(findPlace("   ", places)).toBeNull();
    // typed coordinates were traded for the module's budget: they find nothing now, and never a wrong place
    expect(findPlace("41.878, -87.630", places)).toBeNull();
    expect(findPlace("41.878, -87.630", null)).toBeNull();
    expect(findPlace("48.85, 2.35", places)).toBeNull();
    // with no places list there is nothing to match
    expect(findPlace("Chicago, IL", null)).toBeNull();
  });

  it("reads a town and state typed without the comma, as phones type it", () => {
    expect(findPlace("chicago il", places)).toEqual({ label: "Chicago, IL", lat: 41.85, lon: -87.65 });
    expect(findPlace("Chicago IL", places)).toMatchObject({ label: "Chicago, IL" });
    expect(findPlace("  CHICAGO   IL ", places)).toMatchObject({ label: "Chicago, IL" });
    // the state settles a name two states share
    expect(findPlace("springfield mo", places)).toMatchObject({ label: "Springfield, MO" });
    expect(findPlace("springfield il", places)).toMatchObject({ label: "Springfield, IL" });
    // a state with no such town finds nothing rather than another state's
    expect(findPlace("cheyenne il", places)).toBeNull();
    expect(findPlace("normal zz", places)).toBeNull();
  });
});

describe("a route that goes the long way", () => {
  const run = (code: string, from: number, to: number) => ({ code, from, to, hits: [] });
  const trip = (miles: number, direct: number, ends: [number, number], road = true) => ({
    miles, line: [], ring: [], outside: false, hits: 0, road, direct, ends, runs: [run("IL", 0, miles)],
  });
  const t = (h: string) => parseHTML(`<div>${h}</div>`).document.querySelector("div")!.textContent!.replace(/\s+/g, " ");

  it("says so when the freight highways run far past the straight line", () => {
    expect([LONG_X, LONG_MI, END_MI]).toEqual([1.6, 30, 25]);
    // Las Vegas to Phoenix along the freight network: 543 miles for a 256 mile line
    expect(t(stripHtml(trip(543, 256, [2, 3]), "Las Vegas, NV", "Phoenix, AZ", CFG, false))).toContain(
      "The freight highways go the long way here: 543 miles, against 256 in a straight line. The roads you take may be shorter, and their miles by state may differ.",
    );
    // an ordinary route, and a straight line, say nothing
    expect(stripHtml(trip(295, 250, [2, 3]), "A", "B", CFG, false)).not.toContain("long way");
    // the edge: 1.6 times 256, plus 30, is 439.6
    expect(stripHtml(trip(439, 256, [2, 3]), "A", "B", CFG, false)).not.toContain("long way");
    expect(stripHtml(trip(440, 256, [2, 3]), "A", "B", CFG, false)).toContain("long way");
    expect(stripHtml(trip(543, 256, [0, 0], false), "A", "B", CFG, false)).not.toContain("long way");
  });

  it("says so when a town is far from the nearest freight highway", () => {
    const h = t(stripHtml(trip(400, 380, [107, 3]), "Roswell, NM", "Dallas, TX", CFG, false));
    expect(h).toContain("Roswell, NM is 107 miles from the nearest freight highway, so the line runs straight for that stretch.");
    expect(h).not.toContain("Dallas, TX is");
    expect(stripHtml(trip(400, 380, [25, 25]), "A", "B", CFG, false)).not.toContain("nearest freight highway");
    expect(t(stripHtml(trip(400, 380, [3, 40]), "A", "B <x>", CFG, false))).toContain("B <x> is 40 miles from");
    expect(stripHtml(trip(400, 380, [3, 40]), "A", "B <x>", CFG, false)).toContain("B &lt;x&gt; is 40 miles");
  });

  it("measures the straight line and each town's stretch to the network", () => {
    const a: [number, number] = [41.88, -87.63], b: [number, number] = [39.1, -84.51];
    const res = corridor(a, b, [], [], [a, [41.6, -87.4], [39.3, -84.6], b]);
    expect(res.direct).toBeGreaterThan(240);
    expect(res.direct).toBeLessThan(260);
    expect(res.ends![0]).toBeGreaterThan(15);
    expect(res.ends![0]).toBeLessThan(25);
    expect(res.ends![1]).toBeLessThan(15);
    // a straight line has no stretches to a network
    expect(corridor(a, b, [], []).ends).toEqual([0, 0]);
  });
});

describe("reading a town the way drivers type it", () => {
  const list = (labels: string[]): Places => ({ label: labels, lat: labels.map((_, i) => 30 + i), lon: labels.map((_, i) => -90 - i) });
  const pl = list([
    "St. Louis, MO", "Saint Louis Park, MN", "Saint Paul, MN", "Saint Cloud, MN", "Fort Worth, TX", "Dallas, TX", "New York City, NY", "Missouri City, TX",
    "Texas City, TX", "Iowa City, IA", "Delaware, OH", "Washington, DC", "Columbus, GA", "Columbus, OH", "Charleston, WV", "Charleston, SC",
    "St. Charles, MD", "Saint Charles, MD", "Kansas City, KS", "Kansas City, MO", "Mount Vernon, NY", "Virginia Beach, VA",
    "Rocky Mount, NC", "West New York, NJ", "Santa Fe, NM", "Sioux City, IA", "Sioux Falls, SD", "Akron, OH", "Wyoming, MI",
    "O'Fallon, MO", "Winston-Salem, NC", "Denver, CO",
  ]);
  const ST = [["MO", "Missouri"], ["MN", "Minnesota"], ["TX", "Texas"], ["NY", "New York"], ["IA", "Iowa"], ["OH", "Ohio"], ["DC", "District of Columbia"],
    ["GA", "Georgia"], ["WV", "West Virginia"], ["VA", "Virginia"], ["SC", "South Carolina"], ["MD", "Maryland"], ["KS", "Kansas"], ["DE", "Delaware"],
    ["NC", "North Carolina"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["SD", "South Dakota"], ["AK", "Alaska"], ["WY", "Wyoming"], ["MT", "Montana"],
    ["CO", "Colorado"], ["WA", "Washington"]];
  const got = (q: string) => {
    const r = findPlace(q, pl, ST);
    return r && typeof r == "object" ? r.label : r;
  };

  it("reads St and Saint, Ft and Fort, Mt and Mount, with or without a period, both ways", () => {
    for (const q of ["St Louis, MO", "St. Louis MO", "saint louis", "st louis", "Saint Louis, Missouri"]) expect(got(q), q).toBe("St. Louis, MO");
    expect(got("St Paul, MN")).toBe("Saint Paul, MN");
    expect(got("Ft Worth, TX")).toBe("Fort Worth, TX");
    expect(got("Mt Vernon NY")).toBe("Mount Vernon, NY");
    // a town the list has longer is its own place, not St. Louis
    expect(got("Saint Louis Park")).toBe("Saint Louis Park, MN");
    // one town listed twice is one place
    expect(got("St Charles, MD")).toBe("St. Charles, MD");
  });

  it("reads a state written out, the longest name first", () => {
    expect(got("Dallas, Texas")).toBe("Dallas, TX");
    expect(got("dallas texas")).toBe("Dallas, TX");
    expect(got("Charleston West Virginia")).toBe("Charleston, WV");
    expect(got("Charleston, South Carolina")).toBe("Charleston, SC");
    expect(got("kansas city missouri")).toBe("Kansas City, MO");
    expect(got("Virginia Beach")).toBe("Virginia Beach, VA");
  });

  it("finds New York City as New York, and never turns a state's name into a town", () => {
    expect(got("New York, NY")).toBe("New York City, NY");
    expect(got("new york")).toBe("New York City, NY");
    // these silently became the wrong town, with a confident fuel cost; a state's code alone too ("AK" was Akron, OH)
    for (const q of ["Missouri", "Texas", "Iowa", "Kansas", "west virginia", "AK", "ak", "TX"]) expect(got(q), q).toBeNull();
    // a town called just that asks, as the driver may mean the state
    expect(got("Delaware")).toBe("Delaware, OH");
    expect(typeof findPlace("Delaware", pl, ST)).toBe("string");
    expect(typeof findPlace("Wyoming", pl, ST)).toBe("string");
    expect(typeof findPlace("Washington", pl, ST)).toBe("string");
    // and the town itself is still found by its own name and state
    expect(findPlace("Akron", pl, ST)).toMatchObject({ label: "Akron, OH" });
    expect(findPlace("Wyoming, MI", pl, ST)).toMatchObject({ label: "Wyoming, MI" });
  });

  it("asks which when a name or a start fits several places, and never picks one silently", () => {
    expect(got("Columbus")).toBe("Columbus, GA");
    expect(got("kansas city")).toBe("Kansas City, KS");
    expect(got("Charleston")).toBe("Charleston, WV");
    // a start that fits one place is that place; several with a state given find nothing rather than the first
    expect(findPlace("fort w", pl, ST)).toMatchObject({ label: "Fort Worth, TX" });
    // a state given, and several places in it starting with the text, asks too
    expect(got("saint, mn")).toBe("Saint Louis Park, MN");
    expect(got("saint")).toBe("St. Louis, MO");
    // a start that fits an X City and another place asks too
    expect(typeof findPlace("Sioux", pl, ST)).toBe("string");
  });

  it("reads a whole town name that ends like a state as the town", () => {
    // "Rocky Mount" isn't Rocky in Montana, nor "West New York" West in New York, nor "Santa Fe" a town Santa in a state FE
    expect(findPlace("Rocky Mount", pl, ST)).toMatchObject({ label: "Rocky Mount, NC" });
    expect(findPlace("rocky mount nc", pl, ST)).toMatchObject({ label: "Rocky Mount, NC" });
    expect(findPlace("West New York", pl, ST)).toMatchObject({ label: "West New York, NJ" });
    expect(findPlace("West New York, New Jersey", pl, ST)).toMatchObject({ label: "West New York, NJ" });
    expect(findPlace("Santa Fe", pl, ST)).toMatchObject({ label: "Santa Fe, NM" });
  });

  it("reads a trailing comma, a curly apostrophe and a hyphen typed as a space", () => {
    expect(findPlace("Denver,", pl, ST)).toMatchObject({ label: "Denver, CO" });
    expect(findPlace("Denver, ", pl, ST)).toMatchObject({ label: "Denver, CO" });
    expect(typeof findPlace("Columbus,", pl, ST)).toBe("string");
    expect(findPlace("O’Fallon, MO", pl, ST)).toMatchObject({ label: "O'Fallon, MO" });
    expect(findPlace("Winston Salem", pl, ST)).toMatchObject({ label: "Winston-Salem, NC" });
    // a start with a state, as the question asks for, finds or asks rather than nothing
    expect(findPlace("Sioux, IA", pl, ST)).toMatchObject({ label: "Sioux City, IA" });
  });
});

describe("the list's rows and the popups", () => {
  const points: MapPoint[] = [
    { kind: "s", filter: "ta", lat: 41.123456, lon: -87.98765, name: "TA <Joliet> & \"Co\"", type: "TA", state: "IL", sources: "o", dir: null, chain: "ta" },
    { kind: "w", filter: "w", lat: 41.3, lon: -95.8, name: "Weigh station, I 80 westbound", type: "Weigh station", state: "IA", sources: "nf", dir: "westbound", chain: null },
    { kind: "v", filter: "v", lat: 41.5, lon: -90.5, name: "Love's shop", type: "Repair and lube", state: "IL", sources: "f", dir: null, chain: "loves" },
    { kind: "w", filter: "w", lat: 44, lon: -100, name: "Weigh station", type: "Weigh station", state: null, sources: "o", dir: null, chain: null },
  ];
  const d = parseHTML(`<table><tbody>${rowsHtml(points)}</tbody></table>`).document;
  const rows = Array.from(d.querySelectorAll("tr")) as unknown as HTMLTableRowElement[];
  const pts = rows.map(readRow);

  it("round trips every point through the build's row and back", () => {
    expect(pts).toHaveLength(4);
    expect(pts[0]).toMatchObject({ i: 0, f: "ta", k: "s", lat: 41.1235, lon: -87.9876, n: 'TA <Joliet> & "Co"', t: "TA", st: "IL", s: "o", c: "ta" });
    expect(pts[1]).toMatchObject({ k: "w", s: "nf", d: "w", c: "" });
    expect(pts[2]).toMatchObject({ k: "v", s: "f", c: "loves" });
    expect(pts[3]).toMatchObject({ st: "", d: "" });
  });

  it("gives a truck stop its region's weekly average, plainly not its own price, and its chain's website; a scale its direction", () => {
    const stop = popupHtml(pts[0], CFG);
    expect(stop).toContain("<b>TA &lt;Joliet&gt; &amp; &quot;Co&quot;</b>");
    expect(stop).toContain("TA truck stop in IL");
    // the price is the region's, and says it is not this stop's
    expect(stop).toContain(`<a href="/state/il/">Illinois's region averages $6.250</a> this week, not this stop's price.`);
    expect(stop).toContain(`<a class="btn" href="${CHAINS.find((c) => c.key === "ta")!.locator}">TA website</a>`);
    expect(stop).toContain(`<button class="btn" data-close>Close</button>`);
    // every popup opens its pin in the phone's maps app, a search, never directions
    expect(stop).toContain(`<a class="btn" href="https://www.google.com/maps/search/?api=1&query=${pts[0].lat},${pts[0].lon}">Open in Maps</a>`);
    // the source and licence line lives in Map credits now
    expect(stop).not.toMatch(/Sources?:/);
    const scale = popupHtml(pts[1], CFG);
    expect(scale).toContain("Weigh station in IA");
    expect(scale).toContain("<p>For westbound traffic");
    // a scale links only to its pin in a maps app
    expect(scale.match(/href="([^"]+)"/g)).toEqual([`href="https://www.google.com/maps/search/?api=1&query=${pts[1].lat},${pts[1].lon}"`]);
    expect(scale).toContain(">Open in Maps</a>");
    expect(scale).not.toContain("averages");
    // a scale with no direction says nothing about one, and one with no state names none
    const bare = popupHtml(pts[3], CFG);
    expect(bare).not.toMatch(/bound|Direction/);
    expect(bare).not.toMatch(/ in [A-Z]{2}\b/);
    // a repair shop links its chain's website but quotes no fuel price
    const shop = popupHtml(pts[2], CFG);
    expect(shop).toContain("Repair and lube in IL");
    expect(shop).toContain("Love's website</a>");
    expect(shop).not.toContain("averages");
    // a truck stop in a state with no weekly price quotes none
    const ak = popupHtml({ ...pts[0], st: "AK" }, CFG);
    expect(ak).toContain("TA truck stop in AK");
    expect(ak).not.toMatch(/averages|\$\d/);
    for (const p of [...pts, { ...pts[0], st: "AK" }]) {
      const h = popupHtml(p, CFG);
      expect(h).not.toMatch(/[–—]|\s-\s/);
      expect(h).not.toMatch(/[▲▼▴▾△▽◆⬆⬇↑↓→←‹›✓]/);
      expect(h).not.toMatch(/cheapest/i);
      // no colour in a popup: nothing there is a change over time
      expect(h).not.toMatch(/class="(up|down)"/);
    }
  });

  it("names a place by the highway beside it, in the list, the popup and the trip", () => {
    const near: MapPoint[] = [
      { kind: "s", filter: "pilot", lat: 39.95, lon: -82.9, name: "Pilot", type: "Pilot", state: "OH", sources: "o", dir: null, chain: "pilot", highway: "I 70, interstate" },
      { kind: "w", filter: "w", lat: 39.6, lon: -83.1, name: "Weigh station", type: "Weigh station", state: "OH", sources: "o", dir: "southbound", chain: null, highway: "I 71, interstate" },
      { kind: "v", filter: "v", lat: 40.0, lon: -83.0, name: "Love's shop", type: "Repair and lube", state: "OH", sources: "f", dir: null, chain: "loves", highway: "US 30, not an interstate" },
      { kind: "s", filter: "ta", lat: 41.0, lon: -84.0, name: "TA", type: "TA", state: "OH", sources: "o", dir: null, chain: "ta" },
    ];
    const html = rowsHtml(near);
    // the highway is in the name cell only, not in a data attribute the script would have to read
    expect(html).not.toContain("data-h");
    const dd = parseHTML(`<table><tbody>${html}</tbody></table>`).document;
    const got = (Array.from(dd.querySelectorAll("tr")) as unknown as HTMLTableRowElement[]).map(readRow);
    expect(got.map((p) => p.n)).toEqual(["Pilot, near I 70", "Weigh station, near I 71", "Love's shop, near US 30", "TA"]);
    expect(popupHtml(got[0], CFG)).toContain("<b>Pilot, near I 70</b>");
    expect(popupHtml(got[1], CFG)).toContain("<b>Weigh station, near I 71</b>");
    expect(popupHtml(got[1], CFG)).toContain("For southbound traffic");
    expect(popupHtml(got[3], CFG)).toContain("<b>TA</b>");
    // and the trip's table print the same name
    const trip = stripHtml(corridor([39.95, -83.5], [39.95, -82.3], got, []), "A", "B", CFG, false);
    expect(trip).toContain("<td>Pilot, near I 70");
    for (const p of got) expect(p.n).not.toMatch(/[–—]|\s-\s|,$/);
  });

  it("sorts by name, type or state either way, ties by name", () => {
    expect(sortPts(pts, "n", 1).map((p) => p.i)).toEqual([2, 0, 3, 1]);
    expect(sortPts(pts, "n", -1).map((p) => p.i)).toEqual([1, 3, 0, 2]);
    expect(sortPts(pts, "st", 1).map((p) => p.st)).toEqual(["", "IA", "IL", "IL"]);
    expect(sortPts(pts, "t", 1).map((p) => p.t)).toEqual(["Repair and lube", "TA", "Weigh station", "Weigh station"]);
  });

  it("escapes what it prints", () => {
    expect(esc(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("the markers", () => {
  it("grow with the zoom, big enough for the chain's letter from zoom 6, stops over scales over service squares", () => {
    for (const z of [3, 5, 7, 10]) {
      expect(radius("s", z)).toBeGreaterThan(radius("w", z));
      expect(radius("w", z)).toBeGreaterThan(radius("v", z));
    }
    // the letter is drawn at a radius of 8 or more, which a stop reaches at zoom 6, where a state fits a phone
    expect(radius("s", 5.75)).toBeLessThan(8);
    expect(radius("s", 6)).toBe(8);
    expect(radius("s", 16)).toBe(8);
    expect(radius("w", 6)).toBeLessThan(8);
    expect(radius("s", 3)).toBeLessThan(radius("s", 5));
  });
});
