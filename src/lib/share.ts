// The sentence the Share button hands to the share sheet, built from the same
// numbers the page shows: "Ohio diesel is $6.250 a gallon, up 30.4 cents this
// week. DOE Midwest weekly average." The link goes with it, so the sentence
// never needs one. The source is named the way the page's title and text name
// it, so the shared sentence and the page it opens agree.

import { changeTenths, formatPrice, spokenChange } from "./format.ts";
import { noPriceReason, shortName, sinceText } from "./copy.ts";
import type { Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";

/**
 * "this week", "since yesterday", "since Sep 15": the span a state's change
 * covers. After a skipped AAA day the states compare with the last day AAA
 * had, the way the state page's week line does.
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

/** Whose number it is, the way drivers name it and the page's title says it. */
function sourceLine(s: StateView | null, daily: boolean): string {
  if (daily) return "AAA daily average.";
  if (!s) return "DOE weekly average.";
  if (s.eia_series === "SCA") return "DOE weekly California price.";
  if (s.eia_series === "R5XCA") return "DOE weekly average for the West Coast outside California.";
  return `DOE ${s.regionName} weekly average.`;
}

/** The home page's sentence: the U.S. price its headline shows. */
export function homeShareText(site: SiteData): string {
  const us = site.national.move;
  if (!us) return "Diesel prices for every state, and which way they moved.";
  const daily = site.national.cadence === "daily";
  // AAA's national number always moves since yesterday, like the headline
  // says, even after a day the state prices skipped.
  return `${priceLine("U.S.", us, daily ? "since yesterday" : "this week")} ${sourceLine(null, daily)}`;
}

/** A state page's sentence. Alaska and Hawaii say why there's no DOE number, like their page. */
export function stateShareText(s: StateView, site: SiteData): string {
  const name = shortName(s);
  if (!s.primary) {
    if (site.mode === "eia_only" && s.eia_series === null) {
      return `EIA doesn't survey diesel prices in ${name}, so there's no DOE weekly number. The closest region EIA surveys is the West Coast.`;
    }
    return `${noPriceReason(s, site)} See the prices nearby.`;
  }
  const daily = s.cadence === "daily";
  return `${priceLine(name, s.primary, stateSpan(site, daily))} ${sourceLine(s, daily)}`;
}
