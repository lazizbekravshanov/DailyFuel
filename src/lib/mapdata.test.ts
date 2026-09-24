// The map page's loader: the required files, the optional ones in the
// shapes the roads and fleet files come in, the weigh station merge, the
// names, and the compact files the page ships. Each case builds its own
// data folder in the system temp dir from the committed data/map files.

import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import statesInfo from "../data/states.json";
import { decodeLines, decodeStates } from "../scripts/map.ts";
import { DataError } from "./data.ts";
import {
  cleanName,
  comparePoints,
  coverageLine,
  isInterstate,
  loadMapData,
  mergeWeigh,
  parsePlaces,
  parseRoads,
  parseStates,
  roadsPayload,
  statesPayload,
  weighName,
} from "./mapdata.ts";

const DATA = resolve("data/map");
// The optional files' shapes are tested here against what the page reads.
// Their schemas come with their own branches and are tested there, so the
// fixtures below are checked against an empty schemas folder; the last case
// loads the committed data/map with the repo's schemas, as the build does.
const NO_SCHEMAS = mkdtempSync(join(tmpdir(), "dailyfuel-schemas-"));
const REQUIRED = ["stations.json", "weigh_osm.json", "weigh_ntad.json", "weigh_ia.json", "coverage.json"];
const CODES = (statesInfo as { states: { code: string; name: string }[] }).states;

function folder(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dailyfuel-map-"));
  for (const f of REQUIRED) copyFileSync(join(DATA, f), join(dir, f));
  for (const [name, doc] of Object.entries(extra)) writeFileSync(join(dir, name), JSON.stringify(doc));
  return dir;
}

const square = (w: number, s: number, size = 1) => [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]];

/** 51 outlines: Illinois and Iowa where they are, Alaska across the antimeridian, the rest as squares at sea. */
function statesDoc() {
  const features = CODES.map((st, i) => {
    let geometry: unknown = { type: "Polygon", coordinates: square(-60 + (i % 10), 20 + Math.floor(i / 10)) };
    if (st.code === "IL") geometry = { type: "Polygon", coordinates: [[[-91.5, 37], [-87.5, 37], [-87.5, 42.5], [-91.5, 42.5], [-91.5, 37]]] };
    if (st.code === "IA") geometry = { type: "Polygon", coordinates: [[[-96.6, 40.4], [-91.5, 40.4], [-91.5, 43.5], [-96.6, 43.5], [-96.6, 40.4]]] };
    if (st.code === "AK") geometry = { type: "MultiPolygon", coordinates: [square(-160, 60, 10), square(172, 52, 2)] };
    return { type: "Feature", id: String(i), properties: { code: st.code, name: st.name }, geometry };
  });
  return { type: "FeatureCollection", schema: "dailyfuel/map-states/1", features };
}

const ROADS = {
  schema: "dailyfuel/map-roads/1",
  precision: 4,
  lines: [
    { sign: "I80", code: "1", pts: [-876300, 418780, -1000, 100, -2000, 0] },
    { sign: "U30", code: "1", pts: [-900000, 410000, 5000, 5000] },
    { sign: null, code: "2", pts: [-950000, 420000, 100, 100] },
  ],
};

const PLACES = {
  schema: "dailyfuel/map-places/1",
  places: [
    { name: "Chicago", state: "IL", lat: 41.85, lon: -87.65 },
    { name: "Cheyenne", state: "WY", lat: 41.14, lon: -104.82 },
    { name: "Chicago", state: "IL", lat: 41.9, lon: -87.6 },
  ],
};

// Both sides of one scale, two truck service points, and a port of entry with no state given.
const FLEET = {
  schema: "dailyfuel/map-fleet-points/1",
  source: "Hand built fleet geofences provided by the DailyFuel owner",
  licence: "CC BY 4.0",
  points: [
    { lat: 41.1, lon: -91.0, category: "weigh", direction: "EB", state: "IA", label: "Weigh station, eastbound" },
    { lat: 41.1, lon: -91.0, category: "weigh", direction: "WB", state: "IA", label: "Weigh station, westbound" },
    { lat: 41.5, lon: -90.5, category: "speedco", direction: null, state: "IL", label: "Speedco" },
    { lat: 41.6, lon: -88.1, category: "loves_shop", direction: null, state: null, label: "Love's shop" },
    { lat: 40.2, lon: -89.0, category: "port_of_entry", direction: null, state: null, label: "Port of entry" },
  ],
};

describe("loading the map data", () => {
  it("works from the five required files alone, with no outlines, roads, places or fleet points", () => {
    const d = loadMapData(folder(), NO_SCHEMAS);
    expect(d.present).toEqual({ fleet: false, states: false, roads: false, places: false });
    expect(d.states).toEqual([]);
    const stops = d.points.filter((p) => p.kind === "s");
    expect(stops.length).toBe(1131);
    expect(stops.every((p) => p.state === null && p.sources === "o" && p.chain === p.filter)).toBe(true);
    const weigh = d.points.filter((p) => p.kind === "w");
    // the three weigh files overlap, so there are fewer markers than rows
    expect(d.weighRows).toBe(425 + 111 + 11);
    expect(weigh.length).toBeLessThan(d.weighRows);
    expect(weigh.length).toBeGreaterThan(400);
    expect(weigh.some((p) => p.sources.length > 1)).toBe(true);
    expect(d.points.filter((p) => p.kind === "v")).toEqual([]);
    expect(Object.values(d.counts).reduce((a, b) => a + b, 0)).toBe(d.points.length);
    for (let i = 1; i < d.points.length; i++) expect(comparePoints(d.points[i - 1], d.points[i])).toBeLessThanOrEqual(0);
    for (const p of d.points) {
      expect(p.name, p.name).not.toMatch(/[–—]|\s-\s|^\s|\s$/);
      expect(p.lat).toBeGreaterThan(17);
      expect(p.lon).toBeLessThan(-64);
    }
  });

  it("reads the outlines, the roads, the places and the fleet points when they are there", () => {
    const d = loadMapData(folder({ "states.json": statesDoc(), "roads_nhfn.json": ROADS, "places.json": PLACES, "fleet_points.json": FLEET }), NO_SCHEMAS);
    expect(d.present).toEqual({ fleet: true, states: true, roads: true, places: true });
    expect(d.states.map((s) => s.code)).toEqual(CODES.map((s) => s.code));
    // the far Aleutians are moved west of 180 so they draw next to the rest of Alaska
    const ak = d.states.find((s) => s.code === "AK")!;
    expect(ak.bbox[0]).toBe(-188);
    expect(d.roads.map((r) => r.interstate)).toEqual([true, false, true]);
    expect(d.roads[0].coords).toEqual([[-87.63, 41.878], [-87.73, 41.888], [-87.93, 41.888]]);
    // one Chicago, the larger one, which a population sorted file lists first
    expect(d.places).toEqual([
      { name: "Chicago", state: "IL", lat: 41.85, lon: -87.65 },
      { name: "Cheyenne", state: "WY", lat: 41.14, lon: -104.82 },
    ]);
    // truck stops get their state from the outlines
    const joliet = d.points.find((p) => p.kind === "s" && Math.abs(p.lat - 41.5) < 0.2 && Math.abs(p.lon + 88.1) < 0.2);
    expect(joliet?.state).toBe("IL");
    const service = d.points.filter((p) => p.kind === "v");
    expect(service.map((p) => [p.name, p.type, p.state, p.chain])).toEqual([
      ["Love's shop", "Truck service", "IL", "loves"],
      ["Speedco", "Truck service", "IL", null],
    ]);
    expect(d.counts.v).toBe(2);
    // the two sides of one scale stay two markers
    const both = d.points.filter((p) => p.kind === "w" && p.lat === 41.1 && p.lon === -91.0);
    expect(both.map((p) => p.dir).sort()).toEqual(["eastbound", "westbound"]);
    expect(both.every((p) => p.sources === "f")).toBe(true);
    expect(d.points.find((p) => p.name === "Port of entry")?.state).toBe("IL");
  });

  it("stops the build on a bad file, and says which", () => {
    const bad = (extra: Record<string, unknown>) => () => loadMapData(folder(extra), NO_SCHEMAS);
    expect(bad({ "roads_nhfn.json": { precision: 4, lines: [{ sign: "I80", pts: [1, 2, 3] }] } })).toThrow(/roads_nhfn\.json.*even list/);
    expect(bad({ "roads_nhfn.json": { lines: [] } })).toThrow(/precision/);
    expect(bad({ "places.json": { places: [{ name: "Paris", state: "TX", lat: 48.85, lon: 2.35 }] } })).toThrow(/outside the United States/);
    expect(bad({ "places.json": { places: [{ name: "Nowhere", state: "XX", lat: 40, lon: -100 }] } })).toThrow(/no state code/);
    const states = statesDoc();
    states.features = states.features.filter((f) => f.properties.code !== "DC");
    expect(bad({ "states.json": states })).toThrow(/no outline for DC/);
    expect(bad({ "fleet_points.json": { ...FLEET, points: [{ ...FLEET.points[0], direction: "UP" }] } })).toThrow(/direction/);
    try {
      bad({ "roads_nhfn.json": { precision: 4, lines: [{ pts: [0, 0, 1, 1] }] } })();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DataError);
    }
  });

  it("loads the committed data/map with the repo's schemas, as the build does", () => {
    const d = loadMapData();
    expect(d.points.filter((p) => p.kind === "s")).toHaveLength(1131);
    expect(d.counts.w).toBeGreaterThan(400);
    if (d.present.states) expect(d.points.filter((p) => p.kind === "s" && !p.state).length).toBeLessThan(10);
    if (d.present.fleet) expect(d.counts.v).toBeGreaterThan(0);
  });

  it("prints the coverage the way the legend says it", () => {
    const d = loadMapData(folder(), NO_SCHEMAS);
    const cov = coverageLine(d.coverage);
    expect(cov.measured).toBe("Love's 70%, Pilot and Flying J 56%, TA 25%, Petro 39%, Road Ranger 53%");
    expect(cov.unmeasured).toEqual(["ONE9"]);
  });
});

describe("names", () => {
  it("never use a dash as punctuation", () => {
    expect(cleanName("Plantation Key - Weight Station / Comfort Station")).toBe("Plantation Key, Weight Station / Comfort Station");
    expect(cleanName("  Love's  —  Joliet ")).toBe("Love's, Joliet");
    expect(cleanName("I-80 Travel Plaza")).toBe("I-80 Travel Plaza");
  });

  it("give a weigh station its road and its direction, once, and call a nameless one a weigh station", () => {
    expect(weighName("Fremont", "I 29", "NB")).toEqual({ name: "Fremont, I 29 northbound", dir: "northbound" });
    expect(weighName("Osceola - Northbound", "I 35", "NB")).toEqual({ name: "Osceola, I 35 northbound", dir: "northbound" });
    expect(weighName("Weigh Station (Eastbound)", null, null)).toEqual({ name: "Weigh station, eastbound", dir: "eastbound" });
    expect(weighName("Weight station", null, null)).toEqual({ name: "Weigh station", dir: null });
    expect(weighName("Weigh Scale Complex, No Facilities", "I-10W", null)).toEqual({ name: "Weigh station, I-10W", dir: null });
    expect(weighName(null, null, null)).toEqual({ name: "Weigh station", dir: null });
    expect(weighName("Wyoming Port of Entry", null, null).name).toBe("Wyoming Port of Entry");
  });
});

describe("merging weigh stations", () => {
  const at = (lat: number, lon: number, src: "o" | "n" | "i" | "f", dir: string | null, name = "Weigh station") => ({ lat, lon, name, dir, state: "IA", src });

  it("makes one marker of the same scale from several sources, keeping the first name and every source", () => {
    const out = mergeWeigh([at(41.5, -95.0, "i", null, "Avoca, I 80"), at(41.5005, -95.0, "f", "westbound"), at(41.501, -95.001, "o", null)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Avoca, I 80 westbound", dir: "westbound", sources: "oif", lat: 41.5 });
  });

  it("keeps the two sides of a road apart, and scales more than 300 m apart", () => {
    expect(mergeWeigh([at(41.5, -95, "f", "eastbound"), at(41.5, -95.001, "f", "westbound")])).toHaveLength(2);
    expect(mergeWeigh([at(41.5, -95, "o", null), at(41.504, -95, "o", null)])).toHaveLength(2);
  });
});

describe("interstates", () => {
  it("are an I route sign or NHFN code 2, never code 1 on its own", () => {
    expect(isInterstate("I80", "1")).toBe(true);
    expect(isInterstate("I-80", 1)).toBe(true);
    expect(isInterstate("U30", 1)).toBe(false);
    expect(isInterstate(null, 1)).toBe(false);
    expect(isInterstate(null, "2")).toBe(true);
  });

  it("come out of plain GeoJSON too", () => {
    const roads = parseRoads(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { SIGN1: "I94", NHFN_CODE: 1 }, geometry: { type: "LineString", coordinates: [[-90, 44], [-89, 44]] } },
          { type: "Feature", properties: { SIGN1: "S1", NHFN_CODE: 1 }, geometry: { type: "MultiLineString", coordinates: [[[-90, 45], [-89, 45]], [[-88, 45], [-87, 45]]] } },
        ],
      },
      "roads.json",
    );
    expect(roads.map((r) => r.interstate)).toEqual([true, false, false]);
  });
});

describe("the files the page ships", () => {
  it("carry the outlines and the roads to the browser and back, to the thousandth of a degree", () => {
    const states = parseStates(statesDoc(), "states.json");
    const back = decodeStates(statesPayload(states));
    expect(back.shapes.map((s) => s.code)).toEqual(states.map((s) => s.code));
    const il = back.shapes.find((s) => s.code === "IL")!;
    expect(il.bbox).toEqual([-91.5, 37, -87.5, 42.5]);
    // Leaflet takes [lat, lon]
    expect(back.rings.some((poly) => poly[0].some(([lat, lon]) => lat === 42.5 && lon === -91.5))).toBe(true);
    const roads = parseRoads(ROADS, "roads.json");
    const pay = roadsPayload(roads);
    expect(pay.i).toHaveLength(2);
    expect(pay.o).toHaveLength(1);
    expect(decodeLines(pay.i, pay.p)[0]).toEqual([[41.878, -87.63], [41.888, -87.73], [41.888, -87.93]]);
  });

  it("leave places whole", () => {
    expect(parsePlaces([["Omaha", "NE", 41.26, -95.94]], "p.json")).toEqual([{ name: "Omaha", state: "NE", lat: 41.26, lon: -95.94 }]);
  });
});
