// State diesel tax, from FHWA table MF-121T.
//
// Tax is a separate fact from the prices DailyFuel measures. It never joins
// the price math and never shares a number with a price. All the arithmetic
// here runs on integer thousandths of a cent so a sum is exact.

import { formatMonthYear } from "./dates.ts";
import type { TaxFile } from "./data.ts";

/** Thousandths of a cent. 46.85 cents a gallon is 46850. */
export function toMils(cpg: number): number {
  return Math.round(cpg * 1000);
}

/** "30", "46.85", "32.299": whole cents plus only the decimals FHWA has. */
function centsText(mils: number): string {
  const a = Math.abs(mils);
  const frac = String(a % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${Math.floor(a / 1000)}.${frac}` : String(Math.floor(a / 1000));
}

/**
 * Cents a gallon as FHWA writes it, never rounded: "30.0¢", "74.1¢",
 * "46.85¢". Whole cents keep one decimal so the column reads evenly.
 */
export function formatCpg(cpg: number): string {
  const mils = toMils(cpg);
  const text = centsText(mils);
  return `${mils < 0 ? "−" : ""}${text.includes(".") ? text : `${text}.0`}¢`;
}

/** "30.0", "46.85": the rate in a table cell, where the column head says TAX ¢. */
export function quoteCpg(cpg: number): string {
  return formatCpg(cpg).slice(0, -1);
}

/** "30 cents a gallon" for screen readers, with decimals only when there are some. */
export function spokenCpg(cpg: number): string {
  return `${centsText(toMils(cpg))} cents a gallon`;
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st". */
export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

export interface TaxView {
  code: string;
  /** State excise in cents a gallon. Null where FHWA publishes no per gallon rate. */
  state: number | null;
  /** Federal excise in cents a gallon, the same everywhere. */
  federal: number;
  /** State plus federal. Null when there is no state figure or it's out of date. */
  total: number | null;
  /** 1 is the highest rate in the country. Ties share a rank. Null when unranked. */
  rank: number | null;
  /** The same count from the other end: 1 is the lowest rate. */
  rankFromBottom: number | null;
  /** How many jurisdictions have a current rate to rank. */
  ranked: number;
  /** ISO date the state's rate took effect, as FHWA has it. */
  since: string | null;
  /** FHWA still prints a rate here that is known to be out of date. */
  outOfDate: boolean;
  /** A note about this state's figure, when one matters. */
  note: string | null;
}

/** Rank each code by rate, ties sharing a place the way a race does: two at the same rate are both 4th and the next is 6th. */
function places(rows: { code: string; mils: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  rows.forEach((row, i) => {
    const tied = i > 0 && rows[i - 1].mils === row.mils;
    out.set(row.code, tied ? out.get(rows[i - 1].code)! : i + 1);
  });
  return out;
}

/**
 * One view per state code in the file.
 * Ranking is by state excise, highest first. A state with no rate or with a
 * rate known to be out of date isn't ranked, so it can't push anyone else's
 * rank around with a wrong number.
 */
export function taxViews(tax: TaxFile): Map<string, TaxView> {
  const stale = new Set(tax.out_of_date ?? []);
  const entries = Object.entries(tax.states);
  const rated = entries
    .filter((e): e is [string, number] => e[1] !== null && !stale.has(e[0]))
    .map(([code, cpg]) => ({ code, mils: toMils(cpg) }));
  const top = places([...rated].sort((a, b) => b.mils - a.mils || a.code.localeCompare(b.code)));
  const bottom = places([...rated].sort((a, b) => a.mils - b.mils || a.code.localeCompare(b.code)));

  const out = new Map<string, TaxView>();
  for (const [code, cpg] of entries) {
    const outOfDate = stale.has(code);
    out.set(code, {
      code,
      state: cpg,
      federal: tax.federal_cpg,
      total: cpg === null || outOfDate ? null : (toMils(cpg) + toMils(tax.federal_cpg)) / 1000,
      rank: top.get(code) ?? null,
      rankFromBottom: bottom.get(code) ?? null,
      ranked: rated.length,
      since: tax.effective?.[code] ?? null,
      outOfDate,
      note: tax.notes[code] ?? null,
    });
  }
  return out;
}

/**
 * "Highest", "7th highest", "2nd lowest", "Lowest", counted from whichever
 * end is nearer. The "of 49" goes on its own line. Null when unranked.
 */
export function rankLabel(view: TaxView): string | null {
  if (view.rank === null || view.rankFromBottom === null) return null;
  if (view.rank === 1) return "Highest";
  if (view.rankFromBottom === 1) return "Lowest";
  return view.rankFromBottom < view.rank ? `${ordinal(view.rankFromBottom)} lowest` : `${ordinal(view.rank)} highest`;
}

/** Said out loud: "the 9th highest state diesel tax of 49". */
export function spokenRank(view: TaxView): string | null {
  const label = rankLabel(view);
  if (label === null) return null;
  return `the ${label.toLowerCase()} state diesel tax of ${view.ranked}`;
}

/** Only when some aren't ranked, so the "of 49" isn't a mystery. */
export function rankedNote(tax: TaxFile): string | null {
  const views = [...taxViews(tax).values()];
  const total = views.length;
  const ranked = views.filter((v) => v.rank !== null).length;
  if (ranked === total) return null;
  return `The rank counts the ${ranked} of the ${total} with a current rate in FHWA's table.`;
}

/** "the District of Columbia" needs its article in a sentence. State names don't. */
export function inSentence(name: string): string {
  return name === "District of Columbia" ? `the ${name}` : name;
}

/** "Since July 2024": when this state's rate took effect, as FHWA has it. */
export function sinceLabel(view: TaxView): string | null {
  return view.since ? `Since ${formatMonthYear(view.since)}` : null;
}

/** The newest effective date in the table, which is how current the table really is. */
export function newestRate(tax: TaxFile): string | null {
  const dates = Object.values(tax.effective ?? {}).filter((d): d is string => d !== null);
  return dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
}

/**
 * How old the figures are, anchored on the rates themselves rather than the
 * day FHWA published the table, which is a year later.
 */
export function taxVintage(tax: TaxFile): string {
  const newest = newestRate(tax);
  const when = newest ? ` The newest rate in it took effect in ${formatMonthYear(newest)}, and many` : " Many";
  return `From FHWA's ${tax.reporting_period} table.${when} states change their rate every year, so it may be different now.`;
}
