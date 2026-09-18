// Shared wording for what the EIA weekly number is and how high it is.
// Drivers call EIA's weekly on-highway diesel average "the DOE price", and
// fuel surcharge contracts are tied to it, so the site names it that way.

import type { PeakKind } from "./stats.ts";

/** Our stored history starts here (EIA methodology break). */
export const RECORDS_START = "June 2022";

export const DOE_LINE =
  "This is the DOE weekly diesel average, published by EIA. On-road diesel, federal and state taxes included. " +
  "Surcharge contracts use the national or a regional DOE number, so check which yours names.";

export const DYED_DIESEL_NOTE = "Dyed farm diesel is untaxed and usually costs less.";

export const HOME_TITLE = "Diesel prices by state, DOE weekly average";

/** One line about a single series, or null when there's nothing to say. */
export function peakSentence(kind: PeakKind, seriesLabel: string): string | null {
  if (kind === "record") return `Highest ${seriesLabel} price in our records, which start ${RECORDS_START}.`;
  if (kind === "52week") return `Highest ${seriesLabel} price in 52 weeks.`;
  return null;
}

/** Short tag for a card or chart. */
export function peakTag(kind: PeakKind): string | null {
  if (kind === "record") return "Highest in our records";
  if (kind === "52week") return "New 52 week high";
  return null;
}

/** Home page line when every region shares the same kind of peak. */
export function allRegionsSentence(kinds: PeakKind[]): string | null {
  if (!kinds.length) return null;
  if (kinds.every((k) => k === "record")) return `Every region is at its highest in our records, which start ${RECORDS_START}.`;
  const records = kinds.filter((k) => k === "record").length;
  if (records > 0) return `${records} of ${kinds.length} regions are at their highest in our records, which start ${RECORDS_START}.`;
  return null;
}
