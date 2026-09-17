// Turns the raw data files into what the pages render.

import { binFor, type Cadence, type FillKey } from "./bins.ts";
import { addDays } from "./dates.ts";
import { toUnits } from "./format.ts";
import {
  loadRawData,
  type BenchmarkKey,
  type DailyFile,
  type Flag,
  type Latest,
  type Mode,
  type Move,
  type RawData,
  type SeriesKey,
  type StateInfo,
  type WeeklyFile,
} from "./data.ts";
import type { Point } from "./stats.ts";

export const SITE_NAME = "DailyFuel";
export const SITE_URL = "https://dailydiesel.vercel.app";
export const REPO_URL = "https://github.com/lazizbekravshanov/DailyFuel";

export const BENCHMARKS: BenchmarkKey[] = ["R1X", "R1Y", "R1Z", "R20", "R30", "R40", "SCA", "R5XCA"];

/** Region names the way a driver would say them. */
export const REGION_NAMES: Record<BenchmarkKey, string> = {
  R1X: "New England",
  R1Y: "Central Atlantic",
  R1Z: "Lower Atlantic",
  R20: "Midwest",
  R30: "Gulf Coast",
  R40: "Rocky Mountain",
  SCA: "California",
  R5XCA: "West Coast outside California",
};

export interface RegionView {
  key: BenchmarkKey;
  name: string;
  history: Point[];
  move: Move | null;
  states: string[];
}

export interface StateView extends StateInfo {
  slug: string;
  href: string;
  regionName: string | null;
  /** Other states that share the price source, or the same PADD when none do. */
  peers: string[];
  peerLabel: string;
  cadence: Cadence;
  /** The price the site leads with: AAA daily in aaa+eia mode, EIA weekly otherwise. */
  primary: Move | null;
  aaa: Move | null;
  eia: Move | null;
  flags: Flag[];
  fill: FillKey;
  /** Daily AAA history in aaa+eia mode, else the EIA region's weekly history. */
  history: Point[];
  /** The EIA region's weekly history, empty for AK and HI. */
  eiaHistory: Point[];
}

export interface SiteData {
  mode: Mode;
  raw: RawData;
  latest: Latest;
  weekly: WeeklyFile | null;
  daily: DailyFile[];
  states: StateView[];
  byCode: Map<string, StateView>;
  regions: RegionView[];
  national: {
    cadence: Cadence;
    /** Null only when AAA has no national figure and there is no EIA data either. */
    move: Move | null;
    /** "Week of Sep 14" style anchor date: EIA period or AAA as_of. */
    date: string;
    prevDate: string | null;
  };
  /** EIA U.S. weekly move, when EIA data exists. */
  eiaUs: Move | null;
}

export function weeklySeries(weekly: WeeklyFile | null, key: SeriesKey): Point[] {
  if (!weekly) return [];
  return weekly.weeks.map((w) => ({ date: w.period, value: w.values[key] }));
}

export function dailySeries(daily: DailyFile[], code: string): Point[] {
  return daily.map((d) => ({ date: d.as_of, value: d.diesel[code] ?? null }));
}

/** Newest week vs the week before, the same way the pipeline derives it. */
export function weeklyMove(series: Point[]): Move | null {
  const n = series.length;
  if (n === 0) return null;
  const cur = series[n - 1].value;
  if (cur === null) return null;
  const prev = n > 1 ? series[n - 2].value : null;
  if (prev === null) return { price: cur, prev: null, change: null, change_pct: null, direction: null };
  const c = toUnits(cur) - toUnits(prev);
  return {
    price: cur,
    prev,
    change: c / 10000,
    change_pct: Math.round((c / toUnits(prev)) * 10000) / 100,
    direction: c > 0 ? "up" : c < 0 ? "down" : "flat",
  };
}

export function fillFor(move: Move | null, cadence: Cadence): FillKey {
  if (!move || move.change === null) return "nodata";
  return binFor(move.change, cadence);
}

let cached: SiteData | null = null;

export function getSite(): SiteData {
  if (cached) return cached;
  const raw = loadRawData();
  const { latest, weekly, daily } = raw;
  const mode = latest.mode;
  const cadence: Cadence = mode === "aaa+eia" ? "daily" : "weekly";
  const info = raw.states.states;

  const regions: RegionView[] = BENCHMARKS.map((key) => {
    const history = weeklySeries(weekly, key);
    return {
      key,
      name: REGION_NAMES[key],
      history,
      move: weeklyMove(history),
      states: info.filter((s) => s.eia_series === key).map((s) => s.code),
    };
  });

  const states: StateView[] = latest.states.map((row, i) => {
    const s = info[i];
    const sameSeries = s.eia_series ? info.filter((o) => o.eia_series === s.eia_series && o.code !== s.code) : [];
    const samePadd = info.filter((o) => o.padd === s.padd && o.code !== s.code);
    const usePadd = sameSeries.length === 0;
    const peers = (usePadd ? samePadd : sameSeries).map((o) => o.code);
    const regionName = s.eia_series ? REGION_NAMES[s.eia_series] : null;
    const peerLabel = usePadd || s.eia_series === "R5XCA"
      ? "Other West Coast states"
      : `Other ${regionName} states`;
    const eiaHistory = s.eia_series ? weeklySeries(weekly, s.eia_series) : [];
    const primary = mode === "aaa+eia" ? row.aaa : row.eia;
    return {
      ...s,
      slug: s.code.toLowerCase(),
      href: `/state/${s.code.toLowerCase()}/`,
      regionName,
      peers,
      peerLabel,
      cadence,
      primary,
      aaa: row.aaa,
      eia: row.eia,
      flags: row.flags,
      fill: fillFor(primary, cadence),
      history: mode === "aaa+eia" ? dailySeries(daily, s.code) : eiaHistory,
      eiaHistory,
    };
  });

  let national: SiteData["national"];
  if (mode === "aaa+eia" && latest.aaa?.national) {
    national = {
      cadence: "daily",
      move: latest.aaa.national,
      date: latest.aaa.as_of,
      prevDate: addDays(latest.aaa.as_of, -1),
    };
  } else if (latest.eia) {
    national = { cadence: "weekly", move: latest.eia.us, date: latest.eia.period, prevDate: latest.eia.prev_period };
  } else {
    // aaa+eia with no national figure and no EIA data. Show no national price rather than invent one.
    national = { cadence: "daily", move: null, date: latest.aaa!.as_of, prevDate: null };
  }

  cached = {
    mode,
    raw,
    latest,
    weekly,
    daily,
    states,
    byCode: new Map(states.map((s) => [s.code, s])),
    regions,
    national,
    eiaUs: latest.eia?.us ?? null,
  };
  return cached;
}
