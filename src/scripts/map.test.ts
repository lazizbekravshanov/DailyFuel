// The map page's script, in the parts that are plain functions: reading a
// row back into a point, the base layers' decoding, finding a place, the
// route strip's maths and markup, the popup, the marker sizes, the sort.
// Plus the chains' letters, which are all that tells their ink dots apart.

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { CHAINS, SOURCES } from "../components/map/chains.ts";
import { bearing, destination, distMi } from "../components/map/geo.ts";
import { rowsHtml } from "../components/map/page.ts";
import { placesPayload, statesPayload, type MapPoint, type MapStateShape } from "../lib/mapdata.ts";
import {
  BAND_MI,
  corridor,
  decodePlaces,
  decodeStates,
  esc,
  findPlace,
  popupHtml,
  radius,
  readRow,
  sortPts,
  stripHtml,
  type Cfg,
  type Pt,
} from "./map.ts";


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
const shapes = decodeStates(statesPayload(STATES)).shapes;

const CHICAGO: [number, number] = [41.878, -87.63];
const CHEYENNE: [number, number] = [41.14, -104.82];

function pt(i: number, f: string, lat: number, lon: number, n = "Stop", st = "IL"): Pt {
  const k = f === "w" ? "w" : f === "v" ? "v" : "s";
  return { i, tr: null, f, k, lat, lon, n, t: k === "s" ? CHAINS.find((c) => c.key === f)!.name : k === "w" ? "Weigh station" : "Truck service", st, s: "o", d: "", c: k === "s" ? f : "", h: "", on: true };
}

const CFG: Cfg = {
  c: Object.fromEntries(CHAINS.map((c) => [c.key, [c.name, c.letter, c.locator]])),
  src: SOURCES,
  px: [
    ["IL", "Illinois", "$6.250", "+30.4¢ +5.1%", "up", "EIA Midwest average, 15 states", "54.5¢"],
    ["IA", "Iowa", "$6.250", "+30.4¢ +5.1%", "up", "EIA Midwest average, 15 states", "32.5¢"],
    ["NE", "Nebraska", "$6.250", "+30.4¢ +5.1%", "up", "EIA Midwest average, 15 states", "29.6¢"],
    ["WY", "Wyoming", "$6.066", "−2.0¢ −0.3%", "down", "EIA Rocky Mountain average, 5 states", "24.0¢"],
    ["AK", "Alaska", null, null, "muted", "EIA doesn't survey this state", "8.95¢"],
  ],
  wk: "EIA week of Sep 14, 2026",
  mb: [[15, -190], [72.5, -60]],
  l48: [[24.4, -124.8], [49.4, -66.9]],
  ly: ["states"],
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

  it("prints a strip per state with the EIA price, its move, the plate and the state tax, and no dash as punctuation", () => {
    const res = corridor(CHICAGO, CHEYENNE, pts, shapes);
    const html = stripHtml(res, "Chicago, IL", "Cheyenne, WY", CFG, true);
    const d = parseHTML(`<div>${html}</div>`).document;
    const strips = Array.from(d.querySelectorAll(".rs"));
    expect(strips).toHaveLength(4);
    const il = strips[0].querySelector(".strip")!.textContent!.replace(/\s+/g, " ");
    expect(il).toContain("IL Illinois $6.250 +30.4¢ +5.1% EIA Midwest average, 15 states State tax 54.5¢ Miles 0 to");
    expect(strips[0].querySelector(".up")!.textContent).toMatch(/^\+\d/);
    expect(strips[3].querySelector(".down")!.textContent).toMatch(/^−\d/);
    expect(d.querySelector(".rsum")!.textContent).toMatch(/^Chicago, IL to Cheyenne, WY · 8\d\d miles in a straight line · 4 states · 4 places within 25 miles$/);
    const text = d.body.textContent!;
    expect(text).not.toMatch(/[–—]|\s-\s/);
    expect(text).not.toMatch(/cheapest|truck route/i);
    // each name opens its marker
    expect(d.querySelectorAll(".lk[data-i]")).toHaveLength(4);
    expect(stripHtml(res, "A", "B", CFG, false)).not.toContain("class=\"lk\"");
  });

  it("says No EIA price where EIA has none, and when a stretch has nothing", () => {
    const res = corridor([61.2, -149.9], [64.8, -147.7], [], [box("AK", -170, 51, -130, 71.5)]);
    const html = stripHtml(res, "Anchorage, AK", "Fairbanks, AK", CFG, true);
    expect(html).toContain("No EIA price");
    expect(html).toContain("Nothing on the map in this stretch of the band.");
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

  it("matches a picked label, a start, a bare name or lat, lon", () => {
    expect(findPlace("Chicago, IL", places)).toEqual({ label: "Chicago, IL", lat: 41.85, lon: -87.65 });
    expect(findPlace("  chicago, il ", places)).toMatchObject({ label: "Chicago, IL" });
    expect(findPlace("chicago", places)).toMatchObject({ label: "Chicago, IL" });
    expect(findPlace("chey", places)).toMatchObject({ label: "Cheyenne, WY" });
    expect(findPlace("Springfield, MO", places)).toMatchObject({ label: "Springfield, MO" });
    // a bare name in two states asks which, rather than picking the first state in the alphabet
    expect(findPlace("springfield", places)).toBe("Springfield, IL");
    expect(findPlace("41.878, -87.630", null)).toEqual({ label: "41.878, −87.630", lat: 41.878, lon: -87.63 });
    expect(findPlace("41.878, −87.63", null)).toEqual({ label: "41.878, −87.630", lat: 41.878, lon: -87.63 });
    expect(findPlace("Nowhere", places)).toBeNull();
    expect(findPlace("", places)).toBeNull();
    // abroad
    expect(findPlace("48.85, 2.35", places)).toBeNull();
  });
});

describe("the list's rows and the popups", () => {
  const points: MapPoint[] = [
    { kind: "s", filter: "ta", lat: 41.123456, lon: -87.98765, name: "TA <Joliet> & \"Co\"", type: "TA", state: "IL", sources: "o", dir: null, chain: "ta" },
    { kind: "w", filter: "w", lat: 41.3, lon: -95.8, name: "Weigh station, I 80 westbound", type: "Weigh station", state: "IA", sources: "nf", dir: "westbound", chain: null },
    { kind: "v", filter: "v", lat: 41.5, lon: -90.5, name: "Love's shop", type: "Truck service", state: "IL", sources: "f", dir: null, chain: "loves" },
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

  it("gives a truck stop its chain's locator and its source, and a scale its direction", () => {
    const stop = popupHtml(pts[0], CFG);
    expect(stop).toContain("TA &lt;Joliet&gt; &amp; &quot;Co&quot;");
    expect(stop).toContain("TA truck stop");
    expect(stop).toContain(`href="${CHAINS.find((c) => c.key === "ta")!.locator}"`);
    expect(stop).toContain("Source: OpenStreetMap, ODbL");
    const scale = popupHtml(pts[1], CFG);
    expect(scale).toContain("Direction: westbound");
    expect(scale).toContain("Sources: U.S. DOT NTAD 2019, public domain; DailyFuel, CC BY 4.0");
    expect(scale).not.toContain("href=");
    expect(popupHtml(pts[3], CFG)).toContain("Direction not recorded");
    expect(scale).not.toContain("highway");
    expect(popupHtml({ ...pts[1], h: "Nearest freight highway: I 80, interstate" }, CFG)).toContain("<p>Nearest freight highway: I 80, interstate");
    expect(popupHtml(pts[2], CFG)).toContain("Love's locator");
    for (const p of pts) expect(popupHtml(p, CFG)).not.toMatch(/[–—]|\s-\s/);
  });

  it("sorts by name, type or state either way, ties by name", () => {
    expect(sortPts(pts, "n", 1).map((p) => p.i)).toEqual([2, 0, 3, 1]);
    expect(sortPts(pts, "n", -1).map((p) => p.i)).toEqual([1, 3, 0, 2]);
    expect(sortPts(pts, "st", 1).map((p) => p.st)).toEqual(["", "IA", "IL", "IL"]);
    expect(sortPts(pts, "t", 1).map((p) => p.t)).toEqual(["TA", "Truck service", "Weigh station", "Weigh station"]);
  });

  it("escapes what it prints", () => {
    expect(esc(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("the markers", () => {
  it("grow with the zoom, big enough for the chain's letter from zoom 7, stops over scales over service squares", () => {
    for (const z of [3, 5, 7, 10]) {
      expect(radius("s", z)).toBeGreaterThan(radius("w", z));
      expect(radius("w", z)).toBeGreaterThan(radius("v", z));
    }
    expect(radius("s", 6.75)).toBeLessThan(8);
    expect(radius("s", 7)).toBe(8);
    expect(radius("s", 3)).toBeLessThan(radius("s", 5));
  });
});
