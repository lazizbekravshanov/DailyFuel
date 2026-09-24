// Build time loading for the map page. Reads data/map/*.json, checks each
// file against its schema in schemas/ (or against the shape the page needs
// where no schema file exists yet), and turns the sources into one list of
// points plus the outlines, the roads and the places list. Throws a
// DataError on a bad file so a broken data commit never deploys.
//
// Five files are required, the ones the map cannot do without: stations,
// the three weigh station sources and the coverage figures. Four are
// optional and the page simply has less until they land: fleet_points.json
// (more weigh stations and the truck service points), states.json (the
// outlines, also the corridor tool's point in polygon), roads_nhfn.json and
// places.json.
//
// Weigh stations come from four sources that overlap: a scale OpenStreetMap
// has is often in the NTAD table and the fleet file too. Points of the same
// kind within DEDUPE_M of each other, going the same way, become one marker
// that names every source it came from. The files themselves stay one per
// source, so each keeps its own licence.
//
// The map data is not part of the pipeline's DAILYFUEL_DATA_DIR. It lives
// in data/map by default; DAILYFUEL_MAP_DIR points the build somewhere else.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import stationsSchema from "../../schemas/map-stations.schema.json";
import weighOsmSchema from "../../schemas/map-weigh-osm.schema.json";
import weighNtadSchema from "../../schemas/map-weigh-ntad.schema.json";
import weighIaSchema from "../../schemas/map-weigh-ia.schema.json";
import coverageSchema from "../../schemas/map-coverage.schema.json";
import statesFile from "../data/states.json";
import { CHAIN_BY_KEY, SERVICES, SERVICE_KEY, WEIGH_KEY } from "../components/map/chains.ts";
import { bboxOf, delta, shapeAt, undelta, type Geometry, type Shape } from "../components/map/geo.ts";
import { DataError } from "./data.ts";

export type PointKind = "s" | "w" | "v";
/** One letter per source: o OpenStreetMap, n NTAD, i Iowa DOT, f the DailyFuel fleet file. */
export type SourceKey = "o" | "n" | "i" | "f";

export interface MapPoint {
  /** s a truck stop, w a weigh or inspection station, v a truck service point. */
  kind: PointKind;
  /** The legend's filter key: the chain for a truck stop, else "w" or "v". */
  filter: string;
  lat: number;
  lon: number;
  /** What the row and the popup print first: the site's name, or a label like "Weigh station, I 80 eastbound". */
  name: string;
  /** The chain's name, "Weigh station" or "Truck service". */
  type: string;
  /** Two letter code, or null where no outline holds the point. */
  state: string | null;
  /** Every source the point came from, in SOURCE_ORDER: "o", "nf". */
  sources: string;
  /** "eastbound" and so on, for a weigh station whose direction is known. */
  dir: string | null;
  /** The chain whose locator the popup links to, if any. */
  chain: string | null;
}

export interface MapStateShape extends Shape {
  name: string;
}

export interface MapRoad {
  interstate: boolean;
  /** [lon, lat] pairs. */
  coords: [number, number][];
}

export interface MapPlace {
  name: string;
  state: string;
  lat: number;
  lon: number;
}

export interface CoverageRow {
  brands: string[];
  osm_sites: number;
  official_sites: number | null;
  share: number | null;
}

export interface CoverageFile {
  schema: "dailyfuel/map-coverage/1";
  note: string;
  chains: { measured: string; rows: CoverageRow[] };
  weigh: {
    measured: string;
    official: number;
    matched: number;
    share: number | null;
    states: Record<string, unknown>;
    reference: { count: number; year: number; source: string; source_url: string };
  };
}

export interface MapData {
  dir: string;
  points: MapPoint[];
  /** Points per filter key, for the legend. */
  counts: Record<string, number>;
  /** Weigh station rows across the sources before overlapping ones were merged. */
  weighRows: number;
  coverage: CoverageFile;
  /** The 50 states and DC, in the order of src/data/states.json. Empty until states.json lands. */
  states: MapStateShape[];
  roads: MapRoad[];
  places: MapPlace[];
  /** Which optional files were there. */
  present: { fleet: boolean; states: boolean; roads: boolean; places: boolean };
  /** The OSM extract's date, for the attribution block. */
  osmBase: string;
}

interface StationsFile {
  osm_base: string;
  brands: Record<string, { name: string; sites: number }>;
  sites: { lat: number; lon: number; brand: string; name: string }[];
}
interface WeighOsmFile {
  sites: { lat: number; lon: number; name: string | null; state: string }[];
}
interface WeighNtadFile {
  sites: { lat: number; lon: number; name: string; state: string | null; route: string | null }[];
}
interface WeighIaFile {
  sites: { lat: number; lon: number; name: string; route: string | null; direction: string | null }[];
}
interface FleetFile {
  points: { lat: number; lon: number; category: string; direction: string | null; state: string | null; label: string }[];
}

type AjvCtor = typeof import("ajv/dist/2020.js").default;
const Ajv2020 = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? Ajv2020Module) as AjvCtor;
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule) as typeof addFormatsModule;

const STATE_INFO = (statesFile as { states: { code: string; name: string }[] }).states;
const CODE_BY_NAME = new Map(STATE_INFO.map((s) => [s.name.toLowerCase(), s.code]));
const NAME_BY_CODE = new Map(STATE_INFO.map((s) => [s.code, s.name]));

export const SOURCE_ORDER: SourceKey[] = ["o", "n", "i", "f"];
/** Weigh points closer than this, going the same way, are one station. */
export const DEDUPE_M = 300;
const DIRECTION: Record<string, string> = { EB: "eastbound", WB: "westbound", NB: "northbound", SB: "southbound" };
const WEIGH_TYPE = "Weigh station";
const SERVICE_TYPE = "Truck service";

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new DataError(`could not read ${path} (${(e as Error).message})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DataError(`${path} is not valid JSON (${(e as Error).message})`);
  }
}

function check<T>(validate: ValidateFunction, value: unknown, path: string): T {
  if (!validate(value)) {
    const errors = (validate.errors ?? [])
      .slice(0, 8)
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    throw new DataError(`${path} does not match its schema: ${errors}`);
  }
  return value as T;
}

function fail(cond: boolean, message: string): void {
  if (cond) throw new DataError(message);
}

/** A name with no dash as punctuation, the site's rule, and no run of spaces. */
export function cleanName(name: string): string {
  return name
    .replace(/\s+[-–—]+\s+|\s*[–—]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

const DIR_WORD = /[\s,(]*\b(north|south|east|west)\s*bound\b\)?/i;
const GENERIC_WEIGH = /^(truck\s+)?(weigh|weight)(t)?\s*(station|scale|scales|stations)?(\s+complex)?(,?\s*no facilities)?$/i;

/**
 * "Fremont, I 29 northbound": a weigh station's name with its road and
 * direction when the sources have them. A direction written into the name
 * ("Osceola - Northbound", "Weigh Station (Eastbound)") is lifted out and
 * used when no source gives one, and generic names read "Weigh station".
 */
export function weighName(name: string | null, route: string | null, direction: string | null): { name: string; dir: string | null } {
  let base = name ? cleanName(name) : "";
  let dir = direction ? DIRECTION[direction] ?? direction.toLowerCase() : null;
  const m = DIR_WORD.exec(base);
  if (m) {
    dir = dir ?? `${m[1].toLowerCase()}bound`;
    base = cleanName(base.replace(DIR_WORD, ""));
  }
  if (!base || GENERIC_WEIGH.test(base)) base = WEIGH_TYPE;
  const road = route ? cleanName(route) : "";
  const tail = [road, dir].filter(Boolean).join(" ");
  return { name: tail ? `${base}, ${tail}` : base, dir };
}

/** A state code from whatever a GeoJSON feature calls it: a code, a postal field, or the name. */
export function stateCodeOf(props: Record<string, unknown> | null | undefined): string | null {
  if (!props) return null;
  for (const k of ["code", "postal", "STUSPS", "abbr", "state", "c"]) {
    const v = props[k];
    if (typeof v === "string" && NAME_BY_CODE.has(v.toUpperCase())) return v.toUpperCase();
  }
  for (const k of ["name", "NAME", "n"]) {
    const v = props[k];
    if (typeof v === "string" && CODE_BY_NAME.has(v.toLowerCase())) return CODE_BY_NAME.get(v.toLowerCase())!;
  }
  return null;
}

interface Feature {
  type: "Feature";
  properties?: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

/** The features of a GeoJSON file, whether it is a bare FeatureCollection or wrapped in a schema envelope. */
export function featuresOf(doc: unknown, path: string): Feature[] {
  const d = doc as Record<string, unknown> | null;
  fail(!d || typeof d !== "object", `${path} is not a JSON object`);
  let list: unknown = null;
  if (Array.isArray(d!.features)) list = d!.features;
  else {
    for (const k of ["geojson", "data", "states", "roads", "outlines"]) {
      const inner = d![k] as Record<string, unknown> | undefined;
      if (inner && Array.isArray(inner.features)) {
        list = inner.features;
        break;
      }
    }
  }
  fail(!Array.isArray(list), `${path} has no features array (a GeoJSON FeatureCollection, bare or under a schema envelope)`);
  const out: Feature[] = [];
  for (const f of list as unknown[]) {
    const ft = f as Feature;
    fail(!ft || ft.type !== "Feature", `${path} has an entry that is not a Feature`);
    out.push(ft);
  }
  return out;
}

function isCoords(c: unknown, depth: number): boolean {
  if (depth === 0) return Array.isArray(c) && c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number";
  return Array.isArray(c) && c.length > 0 && c.every((x) => isCoords(x, depth - 1));
}

/**
 * West of the antimeridian, always: the far Aleutians sit at 172 E in a
 * true position file, and Leaflet would draw them on the other side of the
 * world. Shifted by 360 they sit next to the rest of Alaska.
 */
function west(c: unknown): unknown {
  if (typeof (c as number[])[0] === "number") {
    const [x, y] = c as number[];
    return [x > 0 ? x - 360 : x, y];
  }
  return (c as unknown[]).map(west);
}

/** The 50 states and DC from states.json, in src/data/states.json order. Anything else in the file (Puerto Rico) is left out. */
export function parseStates(doc: unknown, path: string): MapStateShape[] {
  const byCode = new Map<string, MapStateShape>();
  for (const f of featuresOf(doc, path)) {
    const code = stateCodeOf(f.properties);
    if (!code) continue;
    const g = f.geometry;
    fail(!g || (g.type !== "Polygon" && g.type !== "MultiPolygon"), `${path}: ${code} is not a Polygon or MultiPolygon`);
    fail(!isCoords(g!.coordinates, g!.type === "Polygon" ? 2 : 3), `${path}: ${code} has malformed coordinates`);
    fail(byCode.has(code), `${path} has ${code} twice`);
    const geometry = { type: g!.type, coordinates: west(g!.coordinates) } as Geometry;
    byCode.set(code, { code, name: NAME_BY_CODE.get(code)!, geometry, bbox: bboxOf(geometry) });
  }
  const missing = STATE_INFO.filter((s) => !byCode.has(s.code)).map((s) => s.code);
  fail(missing.length > 0, `${path} has no outline for ${missing.join(", ")}`);
  return STATE_INFO.map((s) => byCode.get(s.code)!);
}

/**
 * Interstate or not. The NHFN's route sign (SIGN1) starts with I on an
 * interstate; NHFN_CODE 2 is an interstate off the primary freight system.
 * Code 1 is the primary freight system, which has some US and state routes
 * in it, so it says nothing on its own.
 */
export function isInterstate(sign: unknown, code: unknown): boolean {
  if (typeof sign === "string" && /^I[- ]?\d/i.test(sign.trim())) return true;
  return code === 2 || code === "2";
}

/** Roads as the roads file writes them (quantized delta encoded lines) or as plain GeoJSON lines. */
export function parseRoads(doc: unknown, path: string): MapRoad[] {
  const d = doc as Record<string, unknown> | null;
  fail(!d || typeof d !== "object", `${path} is not a JSON object`);
  const out: MapRoad[] = [];
  if (Array.isArray(d!.lines)) {
    const p = d!.precision;
    fail(typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 7, `${path} has no whole number precision for its lines`);
    for (const line of d!.lines as Record<string, unknown>[]) {
      const pts = line?.pts;
      fail(!Array.isArray(pts) || pts.length < 4 || pts.length % 2 !== 0 || !pts.every(Number.isInteger),
        `${path} has a line whose pts is not an even list of whole numbers`);
      const coords = undelta(pts as number[], p as number);
      for (const [x, y] of coords) fail(x < -180 || x > 180 || y < 15 || y > 72, `${path} has a road point outside the United States (${x}, ${y})`);
      out.push({ interstate: isInterstate(line.sign, line.code), coords });
    }
    return out;
  }
  for (const f of featuresOf(doc, path)) {
    const g = f.geometry;
    if (!g) continue;
    fail(g.type !== "LineString" && g.type !== "MultiLineString", `${path} has a ${g.type}, expected LineString or MultiLineString`);
    fail(!isCoords(g.coordinates, g.type === "LineString" ? 1 : 2), `${path} has a road with malformed coordinates`);
    const props = f.properties ?? {};
    const interstate = isInterstate(props.SIGN1 ?? props.sign, props.NHFN_CODE ?? props.code);
    const parts = (g.type === "LineString" ? [g.coordinates] : g.coordinates) as [number, number][][];
    for (const coords of parts) out.push({ interstate, coords });
  }
  return out;
}

/** Places as {name, state, lat, lon} objects or [name, state, lat, lon] rows, bare or under an envelope. */
export function parsePlaces(doc: unknown, path: string): MapPlace[] {
  const d = doc as Record<string, unknown> | unknown[];
  const list = Array.isArray(d)
    ? d
    : (["places", "rows", "items", "data"].map((k) => (d as Record<string, unknown>)?.[k]).find(Array.isArray) as unknown[] | undefined);
  fail(!list, `${path} has no places array`);
  const out: MapPlace[] = [];
  const seen = new Set<string>();
  for (const raw of list!) {
    let p: MapPlace;
    if (Array.isArray(raw)) {
      const [name, state, lat, lon] = raw as unknown[];
      p = { name: name as string, state: state as string, lat: lat as number, lon: lon as number };
    } else {
      const r = (raw ?? {}) as Record<string, unknown>;
      p = {
        name: (r.name ?? r.n) as string,
        state: (r.state ?? r.st ?? r.code ?? r.s) as string,
        lat: (r.lat ?? r.y) as number,
        lon: (r.lon ?? r.lng ?? r.x) as number,
      };
    }
    fail(typeof p.name !== "string" || !p.name, `${path} has a place with no name`);
    fail(typeof p.state !== "string" || !NAME_BY_CODE.has(p.state), `${path}: ${p.name} has no state code`);
    fail(typeof p.lat !== "number" || typeof p.lon !== "number" || p.lat < 17 || p.lat > 72 || p.lon < -180 || p.lon > -64,
      `${path}: ${p.name}, ${p.state} has coordinates outside the United States`);
    const name = cleanName(p.name);
    // two places of one name in one state: the first, which is the larger in a population sorted file
    const key = `${name}, ${p.state}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, state: p.state, lat: p.lat, lon: p.lon });
  }
  return out;
}

/** Fleet points, checked against schemas/map-fleet-points.schema.json when that file is there, else against the shape the page reads. */
function parseFleet(doc: unknown, path: string, schemaPath: string, ajv: InstanceType<AjvCtor>): FleetFile {
  if (existsSync(schemaPath)) return check<FleetFile>(ajv.compile(readJson(schemaPath) as object), doc, path);
  const d = doc as Record<string, unknown>;
  fail(!d || d.schema !== "dailyfuel/map-fleet-points/1" || !Array.isArray(d.points), `${path} is not a dailyfuel/map-fleet-points/1 file`);
  for (const p of d.points as Record<string, unknown>[]) {
    fail(typeof p.lat !== "number" || typeof p.lon !== "number" || typeof p.category !== "string" || typeof p.label !== "string",
      `${path} has a point without lat, lon, category and label`);
    fail(p.direction !== null && p.direction !== undefined && !(String(p.direction) in DIRECTION), `${path} has a point with the direction ${p.direction}`);
  }
  return d as unknown as FleetFile;
}

interface WeighIn {
  lat: number;
  lon: number;
  name: string;
  dir: string | null;
  state: string | null;
  src: SourceKey;
}

/** Metres between two points, flat earth, fine at a few hundred metres. */
function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return 6371008.8 * Math.hypot(x, y);
}

/**
 * One marker per station. Sources come in priority order (named ones
 * first), so a merged point keeps the best name and position; it takes a
 * direction from a later source when it had none, and gathers every
 * source's letter. Two points going different ways stay apart: the two
 * sides of an interstate scale are two stations.
 */
export function mergeWeigh(input: WeighIn[], within = DEDUPE_M): (WeighIn & { sources: string })[] {
  const kept: (WeighIn & { sources: Set<SourceKey> })[] = [];
  const cell = (lat: number, lon: number) => `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;
  const grid = new Map<string, number[]>();
  for (const w of input) {
    let best = -1, bestM = Infinity;
    const cy = Math.floor(w.lat * 100), cx = Math.floor(w.lon * 100);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const i of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const k = kept[i];
          if (k.dir && w.dir && k.dir !== w.dir) continue;
          const m = metres(k, w);
          if (m <= within && m < bestM) {
            best = i;
            bestM = m;
          }
        }
      }
    }
    if (best >= 0) {
      const k = kept[best];
      k.sources.add(w.src);
      if (!k.dir && w.dir) {
        k.dir = w.dir;
        if (!k.name.includes(w.dir)) k.name = `${k.name}${k.name.includes(",") ? " " : ", "}${w.dir}`;
      }
      k.state = k.state ?? w.state;
      continue;
    }
    kept.push({ ...w, sources: new Set([w.src]) });
    const key = cell(w.lat, w.lon);
    grid.set(key, [...(grid.get(key) ?? []), kept.length - 1]);
  }
  return kept.map((k) => ({ ...k, sources: SOURCE_ORDER.filter((s) => k.sources.has(s)).join("") }));
}

/** Rows sort by state, then name, then position, so the list with JS off reads state by state. */
export function comparePoints(a: MapPoint, b: MapPoint): number {
  return (
    (a.state ?? "~").localeCompare(b.state ?? "~") ||
    a.name.localeCompare(b.name) ||
    a.lat - b.lat ||
    a.lon - b.lon
  );
}

/** "Love's 70%, Pilot and Flying J 56%, TA 25%": the measured share of each chain's real sites the map has, from coverage.json. */
export function coverageLine(cov: CoverageFile): { measured: string; unmeasured: string[] } {
  const parts: string[] = [];
  const unmeasured: string[] = [];
  for (const row of cov.chains.rows) {
    const names = row.brands.map((b) => CHAIN_BY_KEY[b]?.name ?? b);
    const who = andList(names);
    if (row.share === null) unmeasured.push(who);
    else parts.push(`${who} ${Math.round(row.share * 100)}%`);
  }
  return { measured: parts.join(", "), unmeasured };
}

/** "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The state a point sits in: the outline that holds it, or one a stone's throw away for a point on a coast the outline cut. */
export function stateAt(lat: number, lon: number, states: Shape[]): string | null {
  if (!states.length) return null;
  const hit = shapeAt(lat, lon, states);
  if (hit) return hit;
  for (const r of [0.02, 0.05]) {
    for (const [dy, dx] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [r, -r], [-r, r], [-r, -r]]) {
      const s = shapeAt(lat + dy, lon + dx, states);
      if (s) return s;
    }
  }
  return null;
}

// ------------------------------------------------------ browser payloads --

/** The outlines as the page ships them: {p, s: [[code, [[ring delta], ...] per polygon, ...]]}. */
export function statesPayload(states: MapStateShape[], p = 3): { p: number; s: [string, number[][][]][] } {
  return {
    p,
    s: states.map((st) => {
      const g = st.geometry;
      const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
      return [st.code, polys.map((rings) => rings.map((r) => delta(r, p)).filter((d) => d.length >= 8))] as [string, number[][][]];
    }),
  };
}

/** The roads as the page ships them: interstates and the rest apart, so each can wear its own line. */
export function roadsPayload(roads: MapRoad[], p = 3): { p: number; i: number[][]; o: number[][] } {
  const i: number[][] = [], o: number[][] = [];
  for (const r of roads) {
    const d = delta(r.coords, p);
    if (d.length >= 4) (r.interstate ? i : o).push(d);
  }
  return { p, i, o };
}

/**
 * The places as the page ships them, grouped by state: the names joined by
 * "|", then the coordinates in hundredths of a degree (about a kilometre),
 * south to north, lat then lon, each pair added to the one before. Grouped and sorted so
 * gzip finds the repeats: about 12 KB for 1,500 places.
 */
export function placesPayload(places: MapPlace[]): { p: number; s: Record<string, [string, number[]]> } {
  const by: Record<string, MapPlace[]> = {};
  for (const pl of places) (by[pl.state] ??= []).push(pl);
  const s: Record<string, [string, number[]]> = {};
  for (const st of Object.keys(by).sort()) {
    const list = by[st].sort((a, b) => a.lat - b.lat || a.lon - b.lon);
    s[st] = [list.map((pl) => pl.name.replace(/\|/g, " ")).join("|"), delta(list.map((pl) => [pl.lat, pl.lon]), 2, true)];
  }
  return { p: 2, s };
}

// ------------------------------------------------------------- loading --

/** The weigh station sources, in the order their points win a merge. A new source is one more entry here. */
const WEIGH_SOURCES: { key: SourceKey; file: string; required: boolean }[] = [
  { key: "i", file: "weigh_ia.json", required: true },
  { key: "n", file: "weigh_ntad.json", required: true },
  { key: "f", file: "fleet_points.json", required: false },
  { key: "o", file: "weigh_osm.json", required: true },
];

let cached: MapData | null = null;

/**
 * The map data in `dirInput`. The optional files are checked against their
 * schema in `schemas` (the repo's schemas/ folder) when that schema file
 * exists, and against the shape the page reads either way.
 */
export function loadMapData(dirInput = process.env.DAILYFUEL_MAP_DIR ?? "data/map", schemas = resolve(process.cwd(), "schemas")): MapData {
  const dir = resolve(process.cwd(), dirInput);
  if (cached && cached.dir === dir) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const read = <T>(file: string, schema: object): T => {
    const p = join(dir, file);
    return check<T>(ajv.compile(schema), readJson(p), p);
  };
  const schemaFile = (name: string) => join(schemas, name);
  const optional = <T>(file: string, schema: string | null, parse: (doc: unknown, path: string) => T): T | null => {
    const p = join(dir, file);
    if (!existsSync(p)) return null;
    const doc = readJson(p);
    if (schema && existsSync(schemaFile(schema))) check(ajv.compile(readJson(schemaFile(schema)) as object), doc, p);
    return parse(doc, p);
  };

  const stations = read<StationsFile>("stations.json", stationsSchema);
  const coverage = read<CoverageFile>("coverage.json", coverageSchema);
  for (const key of Object.keys(stations.brands)) fail(!CHAIN_BY_KEY[key], `stations.json has the brand ${key}, which src/components/map/chains.ts does not know`);

  const states = optional("states.json", "map-states.schema.json", parseStates) ?? [];
  const roads = optional("roads_nhfn.json", "map-roads.schema.json", parseRoads) ?? [];
  const places = optional("places.json", "map-places.schema.json", parsePlaces) ?? [];

  const stateOf = (lat: number, lon: number, given: string | null | undefined): string | null =>
    given && NAME_BY_CODE.has(given) ? given : stateAt(lat, lon, states);

  const points: MapPoint[] = [];
  for (const s of stations.sites) {
    const chain = CHAIN_BY_KEY[s.brand];
    fail(!chain, `stations.json has a site with the brand ${s.brand}, which the page does not know`);
    points.push({
      kind: "s", filter: chain.key, lat: s.lat, lon: s.lon, name: cleanName(s.name) || chain.name, type: chain.name,
      state: stateOf(s.lat, s.lon, null), sources: "o", dir: null, chain: chain.key,
    });
  }

  let fleet = false;
  const weighIn: WeighIn[] = [];
  const add = (src: SourceKey, lat: number, lon: number, n: { name: string; dir: string | null }, state: string | null) =>
    weighIn.push({ lat, lon, name: n.name, dir: n.dir, state: stateOf(lat, lon, state), src });
  for (const src of WEIGH_SOURCES) {
    const p = join(dir, src.file);
    if (!existsSync(p)) {
      fail(src.required, `could not read ${p}`);
      continue;
    }
    if (src.key === "o") {
      for (const w of read<WeighOsmFile>(src.file, weighOsmSchema).sites) add("o", w.lat, w.lon, weighName(w.name, null, null), w.state);
    } else if (src.key === "n") {
      for (const w of read<WeighNtadFile>(src.file, weighNtadSchema).sites) add("n", w.lat, w.lon, weighName(w.name, w.route, null), w.state);
    } else if (src.key === "i") {
      for (const w of read<WeighIaFile>(src.file, weighIaSchema).sites) add("i", w.lat, w.lon, weighName(w.name, w.route, w.direction), "IA");
    } else {
      fleet = true;
      const doc = parseFleet(readJson(p), p, schemaFile("map-fleet-points.schema.json"), ajv);
      for (const f of doc.points) {
        const service = SERVICES[f.category];
        if (service) {
          points.push({
            kind: "v", filter: SERVICE_KEY, lat: f.lat, lon: f.lon, name: service.name, type: SERVICE_TYPE,
            state: stateOf(f.lat, f.lon, f.state), sources: "f", dir: null, chain: service.chain,
          });
        } else {
          add("f", f.lat, f.lon, weighName(f.label, null, f.direction), f.state);
        }
      }
    }
  }
  for (const w of mergeWeigh(weighIn)) {
    points.push({ kind: "w", filter: WEIGH_KEY, lat: w.lat, lon: w.lon, name: w.name, type: WEIGH_TYPE, state: w.state, sources: w.sources, dir: w.dir, chain: null });
  }
  points.sort(comparePoints);

  const counts: Record<string, number> = {};
  for (const p of points) counts[p.filter] = (counts[p.filter] ?? 0) + 1;

  cached = {
    dir,
    points,
    counts,
    weighRows: weighIn.length,
    coverage,
    states,
    roads,
    places,
    present: { fleet, states: states.length > 0, roads: roads.length > 0, places: places.length > 0 },
    osmBase: stations.osm_base,
  };
  return cached;
}

