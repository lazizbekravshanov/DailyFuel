// Build time data for the "your state" strip on the home page, and the plate
// that says whose number a state reads: under the price on its page, on the
// strip, and on its share card.

import { moveClass } from "./bins.ts";
import { countPlaces, pctOf, regionMates } from "./copy.ts";
import { formatMove, formatPrice } from "./format.ts";
import type { SiteData, StateView } from "./site.ts";

/** What the strip prints in the plate's slot for Alaska and Hawaii, the mockup's words. */
export const NO_SURVEY_PLATE = "EIA doesn't survey this state";

/**
 * The plate on the your state strip while EIA is the source: "EIA Midwest
 * average, 15 states", "EIA California average", or for the two states EIA
 * doesn't survey, why there is none. The state page and the share card print
 * the same words (eiaPlate), so the strip never disagrees with the page it
 * opens. Null once AAA's per state prices are on, or under a missing price.
 */
export function regionPlate(s: StateView, site: SiteData): string | null {
  if (site.mode !== "eia_only") return null;
  if (s.eia_series === null) return NO_SURVEY_PLATE;
  return s.primary ? eiaPlate(s, site) : null;
}

/**
 * Whose EIA number a state reads, in any mode: the shared region average
 * with how many read it, or California's own. Null for a state EIA doesn't
 * survey. The state page's plate and the share card's source line use it.
 */
export function eiaPlate(s: StateView, site: SiteData): string | null {
  if (!s.eia_series || !s.regionName) return null;
  if (s.eia_series === "SCA") return "EIA California average";
  return regionAverage(s, site) ?? `EIA ${s.regionName} average`;
}

/**
 * Whose average a shared EIA price is, with the count of who shares it: "EIA
 * Midwest average, 15 states". Null when the region is one place (California)
 * or none (Alaska, Hawaii).
 */
export function regionAverage(s: StateView, site: SiteData): string | null {
  if (!s.eia_series || !s.regionName) return null;
  const members = [s, ...regionMates(s, site)];
  if (members.length < 2) return null;
  // "West Coast outside California" reads better split around "average"
  const [region, tail] = s.eia_series === "R5XCA" ? ["West Coast", " outside California"] : [s.regionName, ""];
  return `EIA ${region} average${tail}, ${countPlaces(members, false)}`;
}

/** What the strip says in place of a plate once AAA's daily prices are the source. */
export const AAA_PLATE = "AAA daily average";

/**
 * One state's line on the strip, printed at build time with the same helpers
 * as the rest of the page, so the script that fills the strip only copies
 * strings. Carried on that state's link in the Find your state list.
 */
export interface YourStateEntry {
  code: string;
  name: string;
  /** "$6.250", or what the strip says with no price: "No EIA price", the state page's own words. */
  price: string;
  /** "+30.4¢ +5.1%", or "" when there is nothing to compare with. */
  move: string;
  /** The ink the move wears: red when it rose, blue when it fell, muted when the bins call it about the same. */
  ink: "up" | "down" | "muted";
  /** Where the number comes from: the plate, or AAA once its daily prices are on. */
  plate: string | null;
}

export function yourStateData(site: SiteData): YourStateEntry[] {
  const aaa = site.mode === "aaa+eia";
  const none = aaa ? "No price yet" : "No EIA price";
  return site.states.map((s) => {
    const m = s.primary;
    return {
      code: s.code,
      name: s.name,
      price: m ? formatPrice(m.price) : none,
      move: m && m.change !== null ? formatMove(m.change, pctOf(m)) : "",
      ink: m ? moveClass(m.change, s.cadence) : "muted",
      plate: regionPlate(s, site) ?? (aaa && m ? AAA_PLATE : null),
    };
  });
}
