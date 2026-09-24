// Build time data for the "your state" strip on the home page and the small
// region plate under the price on a state page.

import { moveClass } from "./bins.ts";
import { countPlaces, pctOf, regionMates } from "./copy.ts";
import { formatMove, formatPrice } from "./format.ts";
import type { SiteData, StateView } from "./site.ts";

/**
 * The plate under the price on a state page, the way a guide sign carries a
 * smaller panel under its main legend: "EIA Midwest average, 15 states".
 * Only while EIA is the source and only when the price is shared, so never for
 * California (EIA prices it on its own), Alaska or Hawaii (EIA doesn't survey
 * them), or any state once AAA's per state prices are on.
 */
export function regionPlate(s: StateView, site: SiteData): string | null {
  if (site.mode !== "eia_only" || !s.primary) return null;
  return regionAverage(s, site);
}

/**
 * Whose average a shared EIA price is, in the plate's words, for any mode:
 * the share cards say it too. Null when the region is one place (California)
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
  /** "$6.250", or what the strip says with no price: "No weekly price". */
  price: string;
  /** "+30.4¢ +5.1%", or "" when there is nothing to compare with. */
  move: string;
  /** The ink the move wears: red when it rose, blue when it fell, muted when the bins call it about the same. */
  ink: "up" | "down" | "muted";
  /** Where the number comes from: the region plate, or AAA once its daily prices are on. */
  plate: string | null;
}

export function yourStateData(site: SiteData): YourStateEntry[] {
  const aaa = site.mode === "aaa+eia";
  const none = aaa ? "No price yet" : "No weekly price";
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
