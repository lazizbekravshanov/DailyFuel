// Build time data for the "your state" strip on the home page, and the plate
// that says whose number a state reads: under the price on its page, on the
// strip, and on its share card.

import { moveClass } from "./bins.ts";
import { countPlaces, pctOf, regionMates } from "./copy.ts";
import { changeTenths, changeWords, formatMove, formatPrice } from "./format.ts";
import type { SiteData, StateView } from "./site.ts";

/** What the plate's slot says for Alaska and Hawaii. */
export const NO_SURVEY_PLATE = "No weekly survey here";

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
  if (s.eia_series === "SCA") return "California's own average";
  return regionAverage(s, site) ?? `${s.regionName} average`;
}

/**
 * Whose average a shared EIA price is, with the count of who shares it:
 * "Midwest average, same in 15 states". Null when the region is one place
 * (California) or none (Alaska, Hawaii).
 */
export function regionAverage(s: StateView, site: SiteData): string | null {
  if (!s.eia_series || !s.regionName) return null;
  const members = [s, ...regionMates(s, site)];
  if (members.length < 2) return null;
  // "West Coast outside California" reads better split around "average"
  const [region, tail] = s.eia_series === "R5XCA" ? ["West Coast", " outside California"] : [s.regionName, ""];
  return `${region} average${tail}, same in ${countPlaces(members, false)}`;
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

/**
 * The home page's your state answer, for every state, as one JSON block the
 * inline script reads (src/scripts/your-state.ts): each state's name and the
 * key of the line it reads, and each line once, since a region's states
 * share it. A line is the price, the change in words, the rest of that
 * sentence, the ink of the change, and the plate:
 *   {"s":{"OH":["Ohio","R20"],...},"l":{"R20":["$6.526","Down 15.4¢","from $6.680 last week.","down","Midwest average, same in 15 states"],...}}
 * A state with no price (Alaska, Hawaii) reads the "" line: no price, "No
 * weekly price" in the change's slot, and why.
 */
export function yourStateJson(site: SiteData): { s: Record<string, [string, string]>; l: Record<string, string[]> } {
  const out = { s: {} as Record<string, [string, string]>, l: {} as Record<string, string[]> };
  const since = site.mode === "aaa+eia" ? "yesterday" : "last week";
  for (const st of site.states) {
    const m = st.primary;
    const key = m ? (site.mode === "aaa+eia" ? st.code : st.eia_series ?? st.code) : "";
    out.s[st.code] = [st.name, key];
    if (key in out.l) continue;
    if (!m) {
      out.l[key] = ["", "No weekly price", "", "muted", "The weekly survey does not cover this state."];
      continue;
    }
    const t = m.change === null ? null : changeTenths(m.change);
    out.l[key] = [
      formatPrice(m.price),
      t === null ? "" : changeWords(m.change!),
      t === null ? "" : t === 0 || m.prev === null ? `from ${since}.` : `from ${formatPrice(m.prev)} ${since}.`,
      moveClass(m.change, st.cadence),
      regionPlate(st, site) ?? (site.mode === "aaa+eia" ? AAA_PLATE : ""),
    ];
  }
  return out;
}
