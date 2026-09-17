// Words shared across pages: tooltips, labels for screen readers, sentences.

import { directionFor, type Direction } from "./bins.ts";
import { formatDate, formatShortDate, formatWeekdayDate } from "./dates.ts";
import { changeVerb, formatChange, formatPrice, pctFrom, spokenChange, spokenPrice } from "./format.ts";
import type { Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";

export function pctOf(m: Move): number | null {
  if (m.change === null) return null;
  if (m.change_pct !== null) return m.change_pct;
  return m.prev ? pctFrom(m.change, m.prev) : null;
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

export interface MapLabel {
  aria: string;
  price: string;
  change: string;
  dir: Direction | "";
  note: string;
  title: string;
}

export function mapLabel(s: StateView, site: SiteData): MapLabel {
  const since = sinceText(site);
  const note =
    site.mode === "eia_only" && s.regionName
      ? s.eia_series === "SCA"
        ? "EIA's California price"
        : `${s.regionName} region price`
      : "";
  if (!s.primary) {
    const reason = noPriceReason(s, site);
    return { aria: `${s.name}. ${reason}`, price: "", change: "", dir: "", note: reason, title: `${s.name}: ${reason}` };
  }
  const price = `${formatPrice(s.primary.price)} a gallon`;
  if (s.primary.change === null) {
    const reason = noPriceReason(s, site);
    return {
      aria: `${s.name}, ${spokenPrice(s.primary.price)}. ${reason}`,
      price,
      change: "",
      dir: "",
      note: reason,
      title: `${s.name}: ${price}. ${reason}`,
    };
  }
  const change = `${formatChange(s.primary.change, pctOf(s.primary))} ${since}`.trim();
  const dir = directionFor(s.primary.change, s.cadence);
  const spoken = `${dir === "flat" && spokenChange(s.primary.change) !== "no change" ? "about the same, " : ""}${spokenChange(s.primary.change)}`;
  return {
    aria: `${s.name}, ${spokenPrice(s.primary.price)}, ${spoken}${since ? ` ${since}` : ""}.${note ? ` ${note}.` : ""}`,
    price,
    change,
    dir,
    note,
    title: `${s.name}: ${price}, ${spoken}${since ? ` ${since}` : ""}`,
  };
}

/** Meta description for a state page, with real numbers. */
export function stateDescription(s: StateView, site: SiteData): string {
  if (!s.primary) {
    return `${noPriceReason(s, site)} See nearby prices and where DailyFuel's numbers come from.`;
  }
  const when = site.mode === "aaa+eia" ? "today" : "this week";
  const p = formatPrice(s.primary.price);
  if (s.primary.change === null) return `${s.name} diesel is ${p} a gallon ${when}.`;
  const moved = spokenChange(s.primary.change).replace(" cents", "¢");
  const verb = moved === "no change" ? "unchanged" : moved;
  const tail = site.mode === "eia_only" ? ` That's EIA's ${s.regionName} price.` : " Daily average from AAA.";
  return `${s.name} diesel is ${p} a gallon, ${verb} ${when}.${tail}`;
}

export function homeDescription(site: SiteData): string {
  const m = site.national.move;
  if (!m) return "Today's diesel price and change for all 50 states and DC.";
  const p = formatPrice(m.price);
  if (site.national.cadence === "daily") {
    const c = m.change === null ? "" : `, ${spokenChange(m.change).replace(" cents", "¢")} since yesterday`;
    return `U.S. diesel is ${p} a gallon today${c}. See today's price and change for all 50 states and DC.`;
  }
  const c = m.change === null ? "" : `, ${spokenChange(m.change).replace(" cents", "¢")} this week`;
  return `U.S. diesel is ${p} a gallon${c}. See the weekly price and change for all 50 states and DC.`;
}

export { changeVerb, formatDate, formatShortDate, formatWeekdayDate };
