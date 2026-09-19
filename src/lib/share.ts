// The sentence the Share button hands to the share sheet, built from the same
// numbers the page shows: "Ohio diesel is $6.250 a gallon, up 30.4 cents this
// week. DOE weekly Midwest average." The link goes with it, so the sentence
// never needs one.

import { changeTenths, formatPrice, spokenChange } from "./format.ts";
import { noPriceReason, shortName, sinceText } from "./copy.ts";
import type { Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";

/**
 * "this week", "since yesterday", "since Sep 15": the span a state's change
 * covers. After a skipped AAA day the states compare with the last day AAA
 * had, the way the state sign's "vs Sep 15" does.
 */
function stateSpan(site: SiteData, daily: boolean): string {
  if (!daily) return "this week";
  return (site.mode === "aaa+eia" && sinceText(site)) || "since yesterday";
}

/** "Ohio diesel is $6.250 a gallon, up 30.4 cents this week." */
function priceLine(name: string, move: Move, when: string): string {
  const moved = move.change === null
    ? ""
    : changeTenths(move.change) === 0
      ? `, unchanged ${when}`
      : `, ${spokenChange(move.change)} ${when}`;
  return `${name} diesel is ${formatPrice(move.price)} a gallon${moved}.`;
}

/** Whose number it is, the way drivers name it. */
function sourceLine(s: StateView | null, daily: boolean): string {
  if (daily) return "AAA daily average.";
  if (!s || s.eia_series === "SCA") return "DOE weekly average.";
  if (s.eia_series === "R5XCA") return "DOE weekly average for the West Coast outside California.";
  return `DOE weekly ${s.regionName} average.`;
}

/** The home page's sentence: the U.S. price the sign shows. */
export function homeShareText(site: SiteData): string {
  const us = site.national.move;
  if (!us) return "Diesel prices for every state, and which way they moved.";
  const daily = site.national.cadence === "daily";
  // AAA's national number always moves since yesterday, like the sign says,
  // even after a day the state prices skipped.
  return `${priceLine("U.S.", us, daily ? "since yesterday" : "this week")} ${sourceLine(null, daily)}`;
}

/** A state page's sentence. Alaska and Hawaii say why there's no EIA number. */
export function stateShareText(s: StateView, site: SiteData): string {
  const name = shortName(s);
  if (!s.primary) {
    if (site.mode === "eia_only" && s.eia_series === null) {
      return `EIA doesn't survey diesel prices in ${name}, so there's no EIA weekly price. See the closest region it does survey.`;
    }
    return `${noPriceReason(s, site)} See the prices nearby.`;
  }
  const daily = s.cadence === "daily";
  return `${priceLine(name, s.primary, stateSpan(site, daily))} ${sourceLine(s, daily)}`;
}
