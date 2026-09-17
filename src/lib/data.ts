// Build time data loading. Reads the JSON the pipeline commits, checks it
// against the schemas in schemas/ plus a few cross file rules, and throws on
// anything wrong so a bad data commit never deploys.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import latestSchema from "../../schemas/latest.schema.json";
import weeklySchema from "../../schemas/eia-diesel-weekly.schema.json";
import dailySchema from "../../schemas/aaa-daily.schema.json";
import statesFile from "../data/states.json";
import { weekday } from "./dates.ts";

export type Mode = "eia_only" | "aaa+eia";
export type BenchmarkKey = "R1X" | "R1Y" | "R1Z" | "R20" | "R30" | "R40" | "SCA" | "R5XCA";
export type SeriesKey = BenchmarkKey | "NUS" | "R10" | "R50";
export type Flag = "gap" | "large_move" | "eia_divergence" | "no_eia_survey" | "prev_missing";
export type Padd = "1A" | "1B" | "1C" | "2" | "3" | "4" | "5";

export interface Move {
  price: number;
  prev: number | null;
  change: number | null;
  change_pct: number | null;
  direction: "up" | "down" | "flat" | null;
}

export interface LatestState {
  code: string;
  fips: string;
  name: string;
  padd: Padd;
  eia_series: BenchmarkKey | null;
  aaa: Move | null;
  eia: Move | null;
  flags: Flag[];
}

export interface Latest {
  schema: "dailyfuel/latest/1";
  generated_at: string;
  mode: Mode;
  aaa: {
    as_of: string;
    prev_as_of: string | null;
    gap_days: number | null;
    national: Move | null;
  } | null;
  eia: {
    period: string;
    prev_period: string | null;
    release_date: string | null;
    next_release_date: string | null;
    us: Move;
  } | null;
  states: LatestState[];
}

export interface Week {
  period: string;
  values: Record<SeriesKey, number | null>;
}

export interface WeeklyFile {
  schema: "dailyfuel/eia-diesel-weekly/1";
  source: "eia_xls" | "usda_socrata" | "eia_api_v2";
  source_url: string;
  fetched_at: string;
  last_modified: string | null;
  release_date: string | null;
  next_release_date: string | null;
  weeks: Week[];
}

export interface DailyFile {
  schema: "dailyfuel/aaa-daily/1";
  as_of: string;
  as_of_raw: string;
  fetched_at: string;
  origin: "live" | "synthetic";
  source_url: string;
  national: { current: number; yesterday: number } | null;
  diesel: Record<string, number>;
}

export interface StateInfo {
  code: string;
  name: string;
  fips: string;
  padd: Padd;
  eia_series: BenchmarkKey | null;
  tile: { row: number; col: number };
}

export interface StatesFile {
  benchmarks: Record<BenchmarkKey, { label: string; padd: string }>;
  aggregates: Record<string, { label: string; padd?: string }>;
  states: StateInfo[];
}

export interface RawData {
  dir: string;
  latest: Latest;
  weekly: WeeklyFile | null;
  /** Ascending by date. Empty in eia_only mode. */
  daily: DailyFile[];
  states: StatesFile;
}

export class DataError extends Error {
  constructor(message: string) {
    super(`DailyFuel data check failed: ${message}`);
    this.name = "DataError";
  }
}

type AjvCtor = typeof import("ajv/dist/2020.js").default;
const Ajv2020 = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? Ajv2020Module) as AjvCtor;
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule) as typeof addFormatsModule;

function makeValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return {
    latest: ajv.compile(latestSchema),
    weekly: ajv.compile(weeklySchema),
    daily: ajv.compile(dailySchema),
  };
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new DataError(`could not read ${path} (${(e as Error).message}). Set DAILYFUEL_DATA_DIR to a folder with latest.json.`);
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

/** Cross file rules the JSON Schemas can't express. */
export function checkConsistency(data: Omit<RawData, "dir">): void {
  const { latest, weekly, daily, states } = data;
  const info = states.states;

  fail(latest.states.length !== info.length, `latest.json has ${latest.states.length} states, expected ${info.length}`);
  latest.states.forEach((s, i) => {
    const ref = info[i];
    fail(s.code !== ref.code, `latest.json state ${i} is ${s.code}, expected ${ref.code} (states.json order)`);
    fail(s.fips !== ref.fips || s.padd !== ref.padd || s.eia_series !== ref.eia_series,
      `latest.json row for ${s.code} disagrees with src/data/states.json`);
    fail(ref.eia_series === null && s.eia !== null, `${s.code} has an EIA price but EIA doesn't survey it`);
    // The converse. One blank cell in the newest workbook week is legal input,
    // but in eia_only it leaves a surveyed state with no price while its page
    // still dates itself to that week and anchors its stats a week earlier.
    // Stop rather than ship a page that disagrees with itself. Not checked in
    // aaa+eia, where the state price is AAA's and EIA is only a benchmark.
    fail(latest.mode === "eia_only" && ref.eia_series !== null && latest.eia !== null && s.eia === null,
      `${s.code} has no EIA price for ${latest.eia?.period}, but EIA surveys it as part of ${ref.eia_series}`);
  });

  if (latest.mode === "eia_only") {
    fail(latest.aaa !== null, "mode is eia_only but latest.aaa is not null");
    fail(latest.states.some((s) => s.aaa !== null), "mode is eia_only but some states have AAA prices");
    fail(latest.eia === null, "mode is eia_only but latest.eia is null, so there is nothing to show");
  } else {
    fail(latest.aaa === null, "mode is aaa+eia but latest.aaa is null");
    const missing = latest.states.filter((s) => s.aaa === null).map((s) => s.code);
    fail(missing.length > 0, `mode is aaa+eia but these states have no AAA price: ${missing.join(", ")}`);
    fail(daily.length === 0, "mode is aaa+eia but there are no files in aaa/daily/");
    const newest = daily[daily.length - 1];
    fail(newest.as_of !== latest.aaa!.as_of,
      `latest.aaa.as_of is ${latest.aaa!.as_of} but the newest AAA snapshot is ${newest.as_of}`);
    for (const s of latest.states) {
      fail(Math.abs(newest.diesel[s.code] - s.aaa!.price) > 0.00005,
        `${s.code} AAA price in latest.json doesn't match aaa/daily/${newest.as_of}.json`);
    }
  }

  if (latest.eia !== null) {
    fail(weekly === null, "latest.eia is set but eia/diesel_weekly.json is missing");
  }
  if (weekly) {
    const periods = weekly.weeks.map((w) => w.period);
    for (let i = 1; i < periods.length; i++) {
      fail(periods[i] <= periods[i - 1], `eia/diesel_weekly.json weeks are not sorted and unique near ${periods[i]}`);
    }
    for (const p of periods) fail(weekday(p) !== 1, `EIA period ${p} is not a Monday`);
    if (latest.eia) {
      const newest = weekly.weeks[weekly.weeks.length - 1];
      fail(newest.period !== latest.eia.period,
        `latest.eia.period is ${latest.eia.period} but the newest EIA week is ${newest.period}`);
      fail(newest.values.NUS === null || Math.abs(newest.values.NUS - latest.eia.us.price) > 0.0005,
        "latest.eia.us doesn't match the newest EIA week");
    }
  }
}

export function loadRawData(dirInput = process.env.DAILYFUEL_DATA_DIR ?? "data"): RawData {
  const dir = resolve(process.cwd(), dirInput);
  const v = makeValidators();

  const latestPath = join(dir, "latest.json");
  const latest = check<Latest>(v.latest, readJson(latestPath), latestPath);

  const weeklyPath = join(dir, "eia", "diesel_weekly.json");
  const weekly = existsSync(weeklyPath) ? check<WeeklyFile>(v.weekly, readJson(weeklyPath), weeklyPath) : null;

  const daily: DailyFile[] = [];
  const dailyDir = join(dir, "aaa", "daily");
  // AAA files only matter when the site is in AAA mode. In eia_only mode the
  // site never shows AAA numbers, even if old files are still on disk.
  if (latest.mode === "aaa+eia" && existsSync(dailyDir)) {
    const names = readdirSync(dailyDir).filter((n) => n.endsWith(".json")).sort();
    for (const name of names) {
      const p = join(dailyDir, name);
      const doc = check<DailyFile>(v.daily, readJson(p), p);
      // Made up prices must never ship credited to AAA and OPIS. A preview
      // build from fixtures has to say so out loud.
      fail(doc.origin !== "live" && process.env.DAILYFUEL_ALLOW_SYNTHETIC !== "1",
        `${p} has origin ${doc.origin}; set DAILYFUEL_ALLOW_SYNTHETIC=1 to build a preview from made up data`);
      fail(name !== `${doc.as_of}.json`, `${p} has as_of ${doc.as_of}, which doesn't match its file name`);
      daily.push(doc);
    }
  }

  const data = { latest, weekly, daily, states: statesFile as unknown as StatesFile };
  checkConsistency(data);
  return { dir, ...data };
}
