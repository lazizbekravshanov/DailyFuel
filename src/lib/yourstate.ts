// Build time data for the "your state" row on the home page and the small
// region plate under the price on a state sign.

import { directionFor, type Direction } from "./bins.ts";
import { countPlaces, regionMates, sinceText } from "./copy.ts";
import type { SiteData, StateView } from "./site.ts";

/**
 * The plate under the price on a state sign, the way a guide sign carries a
 * smaller panel under its main legend: "EIA Midwest average, 15 states".
 * Only while EIA is the source and only when the price is shared, so never for
 * California (EIA prices it on its own), Alaska or Hawaii (EIA doesn't survey
 * them), or any state once AAA's per state prices are on.
 */
export function regionPlate(s: StateView, site: SiteData): string | null {
  if (site.mode !== "eia_only" || !s.primary || !s.eia_series || !s.regionName) return null;
  const members = [s, ...regionMates(s, site)];
  if (members.length < 2) return null;
  // "West Coast outside California" reads better split around "average"
  const [region, tail] = s.eia_series === "R5XCA" ? ["West Coast", " outside California"] : [s.regionName, ""];
  return `EIA ${region} average${tail}, ${countPlaces(members, false)}`;
}

/** One state in the inline JSON the home page's your state script reads. */
export interface YourStateEntry {
  code: string;
  name: string;
  /** Dollars a gallon, or null when there's no price (AK and HI while EIA is the source). */
  price: number | null;
  /** Dollars, signed, or null when there's nothing to compare with. */
  change: number | null;
  /** Follows the map bins, so a change under the about the same line is "flat". */
  direction: Direction | null;
  plate: string | null;
}

export interface YourStateData {
  /** How long the change covers, for the spoken label: "this week", "since yesterday". */
  when: string;
  /** What the mini sign says in place of a price. */
  none: string;
  states: YourStateEntry[];
}

export function yourStateData(site: SiteData): YourStateData {
  const aaa = site.mode === "aaa+eia";
  return {
    // "since yesterday", or "since Sep 15" after a skipped day
    when: aaa ? sinceText(site) : "this week",
    none: aaa ? "No price yet" : "No weekly price",
    states: site.states.map((s) => {
      const change = s.primary?.change ?? null;
      return {
        code: s.code,
        name: s.name,
        price: s.primary?.price ?? null,
        change,
        direction: change === null ? null : directionFor(change, s.cadence),
        plate: regionPlate(s, site),
      };
    }),
  };
}

/** JSON that is safe inside a <script> element. */
export function islandJson(data: YourStateData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
