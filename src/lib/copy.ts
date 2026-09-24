// Words shared across pages: tooltips, labels for screen readers, sentences.

import { formatDate, formatShortDate, formatWeekdayDate } from "./dates.ts";
import { changeTenths, changeVerb, formatPrice, formatSignedCents, pctFrom, spokenChange } from "./format.ts";
import type { Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";

/**
 * The percent a move shows. It comes from the raw change and previous price, so
 * it's rounded once, straight to tenths. The stored change_pct is already
 * rounded to hundredths, and rounding that again changes about 1 move in 20
 * (19.7¢ on $5.257 is +3.7474%, which would print as +3.8%). The stored value
 * is only the fallback when there's no previous price.
 */
export function pctOf(m: Move): number | null {
  if (m.change === null) return null;
  if (m.prev) return pctFrom(m.change, m.prev);
  return m.change_pct;
}

/** "since Sep 7" for weekly, "since yesterday" or "since Sep 15" for daily. */
export function sinceText(site: SiteData): string {
  if (site.mode === "aaa+eia" && site.latest.aaa) {
    const a = site.latest.aaa;
    if (a.prev_as_of === null) return "";
    return a.gap_days && a.gap_days > 1 ? `since ${formatShortDate(a.prev_as_of)}` : "since yesterday";
  }
  const prev = site.latest.eia?.prev_period;
  return prev ? `since the week of ${formatShortDate(prev)}` : "";
}

export function noPriceReason(s: StateView, site: SiteData): string {
  if (s.eia_series === null && site.mode === "eia_only") return `EIA doesn't survey diesel prices in ${s.name}.`;
  if (s.primary === null) return `There's no price for ${s.name} right now.`;
  return `This is the first price we have for ${s.name}, so there's no change yet.`;
}

/** "DC" in running text, where "District of Columbia" reads long. */
export function shortName(s: { code: string; name: string }): string {
  return s.code === "DC" ? "DC" : s.name;
}

/** "Alaska or Hawaii", "Iowa, Ohio or Utah". */
function joinOr(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Counts places with DC apart from the states, since DC isn't one:
 * "14 other Midwest states", "4 other states and DC", "5 states" (said from DC).
 */
export function countPlaces(places: { code: string }[], other: boolean, adjective = ""): string {
  const n = places.filter((p) => p.code !== "DC").length;
  const dc = places.some((p) => p.code === "DC");
  if (n === 0) return dc ? "DC" : "";
  return `${n} ${other ? "other " : ""}${adjective ? `${adjective} ` : ""}state${n === 1 ? "" : "s"}${dc ? " and DC" : ""}`;
}

/** Every other place on the same EIA series as `s`. Empty for AK and HI. */
export function regionMates(s: StateView, site: SiteData): StateView[] {
  if (s.eia_series === null) return [];
  return site.states.filter((o) => o.eia_series === s.eia_series && o.code !== s.code);
}

/**
 * The meta on the "Same price, other states" head: "15 states read $6.250
 * this week", counting the state itself and DC apart. Null with no price or
 * no region mates.
 */
export function samePriceMeta(s: StateView, site: SiteData): string | null {
  const mates = regionMates(s, site);
  if (!s.primary || !mates.length) return null;
  return `${countPlaces([s, ...mates], false)} read ${formatPrice(s.primary.price)} this week`;
}

/**
 * The caption under that table: "One EIA price covers the whole Midwest
 * region. The state tax on top of it is different in each one."
 */
export function samePriceCaption(s: StateView): string {
  const region = s.eia_series === "R5XCA" ? "West Coast outside California" : s.regionName ?? "";
  return `One EIA price covers the whole ${region} region. The state tax on top of it is different in each one.`;
}

/**
 * Why Alaska and Hawaii have no number, with the nearest number EIA does
 * print: "EIA doesn't survey diesel in Alaska, so there is no weekly number
 * for it. The nearest region EIA does survey is the West Coast, which read
 * $7.250 this week, +26.3¢ on the week." `west` is EIA's whole West Coast
 * figure (series R50), or null when the weekly file lacks it.
 */
export function noSurveyNote(s: StateView, west: Move | null): string {
  const lead = `EIA doesn't survey diesel in ${s.name}, so there is no weekly number for it.`;
  if (!west) return `${lead} The nearest region EIA does survey is the West Coast.`;
  const moved = west.change === null ? "" : `, ${formatSignedCents(west.change)} on the week`;
  return `${lead} The nearest region EIA does survey is the West Coast, which read ${formatPrice(west.price)} this week${moved}.`;
}

/** "That's the DOE Midwest average Ohio shares with 14 other states." */
function doeTail(s: StateView, site: SiteData): string {
  const name = shortName(s);
  if (s.eia_series === "SCA") return " That's the DOE weekly price for California, the one state EIA prices on its own.";
  const shared = countPlaces(regionMates(s, site), s.code !== "DC");
  if (s.eia_series === "R5XCA") {
    return ` That's the DOE average for the West Coast outside California${shared ? `, which ${name} shares with ${shared}` : ""}.`;
  }
  return ` That's the DOE ${s.regionName} average${shared ? ` ${name} shares with ${shared}` : ""}.`;
}

/** Meta description for a state page, with real numbers. */
export function stateDescription(s: StateView, site: SiteData): string {
  const name = shortName(s);
  const aaa = site.mode === "aaa+eia";
  if (!s.primary) {
    if (!aaa && s.eia_series === null) {
      const tax = s.tax ? ` and ${name}'s diesel tax` : "";
      return `EIA doesn't survey diesel prices in ${name}, so there's no DOE weekly number. See the closest region EIA surveys${tax}.`;
    }
    return `${noPriceReason(s, site)} See nearby prices and where DailyFuel's numbers come from.`;
  }
  const day = aaa ? site.latest.aaa?.as_of : site.latest.eia?.period;
  let moved = "";
  if (s.primary.change !== null) {
    const since = aaa ? sinceText(site) : "";
    if (changeTenths(s.primary.change) === 0) {
      moved = aaa ? `, unchanged ${since || "since the last price"}` : ", unchanged from the week before";
    } else {
      moved = `, ${spokenChange(s.primary.change).replace(" cents", "¢")}${since ? ` ${since}` : ""}`;
    }
  }
  const on = day ? ` on ${formatShortDate(day)}` : "";
  const lead = `Diesel in ${name} averaged ${formatPrice(s.primary.price)} a gallon${on}${moved}.`;
  return lead + (aaa ? " Daily average from AAA." : doeTail(s, site));
}

/**
 * Why the missing states are missing, so the home meta never claims them:
 * " EIA doesn't survey Alaska or Hawaii." Empty when every state has a price.
 * The home page puts it after homeMeta, which counts the places that do.
 */
export function missingNote(site: SiteData): string {
  const missing = site.states.filter((s) => !s.primary);
  if (!missing.length) return "";
  if (missing.length > 3) return " Some states have no price right now.";
  const names = joinOr(missing.map(shortName));
  const unsurveyed = site.mode === "eia_only" && missing.every((s) => s.eia_series === null);
  return unsurveyed ? ` EIA doesn't survey ${names}.` : ` There's no price for ${names} right now.`;
}

export { changeVerb, formatDate, formatShortDate, formatWeekdayDate };
