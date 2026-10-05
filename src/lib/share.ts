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

/**
 * A state page's sentence. While EIA is the source it says whose average the
 * price is before the price, so in a group chat nobody takes it for the
 * state's own measured price: "Diesel in Ohio's region, the Midwest, averaged
 * $6.250 a gallon this week, up 30.4 cents. Weekly DOE price." Alaska and
 * Hawaii say why there's no number, like their page, and give the U.S. one.
 */
export function stateShareText(s: StateView, site: SiteData): string {
  const name = shortName(s);
  const m = s.primary;
  if (!m) {
    if (site.mode === "eia_only" && s.eia_series === null) {
      const us = site.eiaUs;
      return `The government's weekly survey does not cover ${name}, so there is no ${name} price.${us ? ` U.S. diesel averaged ${formatPrice(us.price)} a gallon this week.` : ""}`;
    }
    return `${noPriceReason(s, site)} See the prices nearby.`;
  }
  const daily = s.cadence === "daily";
  if (daily) return `${priceLine(name, m, stateSpan(site, daily))} ${sourceLine(s, daily)}`;
  const moved = m.change === null ? "" : changeTenths(m.change) === 0 ? ", no change" : `, ${spokenChange(m.change)}`;
  const who = s.eia_series === "SCA"
    ? "California diesel"
    : `Diesel in ${name}'s region, ${s.eia_series === "R5XCA" ? "the West Coast outside California" : `the ${s.regionName}`},`;
  return `${who} averaged ${formatPrice(m.price)} a gallon this week${moved}. Weekly DOE price.`;
}
