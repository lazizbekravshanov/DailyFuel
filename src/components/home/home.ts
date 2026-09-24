// Words and small calculations for the home page: the title, the sentence
// under the headline price, the line beside the REGIONS head, the notes next
// to the board and the meta description. Plain functions of plain inputs, so
// they are easy to test. Every sentence here is built from the data; nothing
// is typed by hand. No dashes as punctuation anywhere.

import { directionFor, type Cadence } from "../../lib/bins.ts";
import { allRegionsSentence, peakSentence, RECORDS_START } from "../../lib/doe.ts";
import { changeTenths, formatCents, formatPrice, formatSignedCents, spokenChange } from "../../lib/format.ts";
import type { PeakKind } from "../../lib/stats.ts";

export interface Moved {
  change: number;
  /** A state's code, so DC can be counted apart from the states. */
  code?: string;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "up 31.8¢", "down 2.1¢", "unchanged": a change in words for a title or a meta line. */
function saidChange(change: number): string {
  return spokenChange(change).replace(" cents", "¢").replace("no change", "unchanged");
}

/**
 * How many are in a group, for keyLine. States count DC apart, since DC isn't
 * one: "20 states and DC", or just "DC". Later parts of the line drop the noun
 * ("22 fell") unless DC is in them. `one` picks "was" or "were".
 */
function howMany(group: Moved[], noun: string, first: boolean): { text: string; one: boolean } {
  const dc = noun === "state" && group.some((i) => i.code === "DC");
  if (!dc) return { text: first ? plural(group.length, noun) : String(group.length), one: group.length === 1 };
  const n = group.length - 1;
  if (n === 0) return { text: "DC", one: true };
  return { text: `${plural(n, noun)} and DC`, one: false };
}

/**
 * The line beside the REGIONS head, computed from the data:
 * "All 8 regions rose, 21.2¢ to 49.1¢." or "5 regions rose, 2 fell and 1 was about the same."
 * Direction follows the bins, so a region a bin calls about the same is counted that way.
 * Null when nothing has a change to count.
 */
export function keyLine(items: Moved[], noun: string, cadence: Cadence): string | null {
  if (items.length === 0) return null;
  const up = items.filter((i) => directionFor(i.change, cadence) === "up");
  const down = items.filter((i) => directionFor(i.change, cadence) === "down");
  const flat = items.filter((i) => directionFor(i.change, cadence) === "flat");
  const range = (group: Moved[]): string => {
    const t = group.map((i) => Math.abs(changeTenths(i.change)));
    const lo = Math.min(...t);
    const hi = Math.max(...t);
    return lo === hi ? ` ${formatCents(lo / 1000)}` : `, ${formatCents(lo / 1000)} to ${formatCents(hi / 1000)}`;
  };
  const whole = howMany(items, noun, true);
  const all = items.length === 1 ? `The one ${noun}` : whole.text === "DC" ? "DC" : `All ${whole.text}`;
  if (up.length === items.length) return `${all} rose${range(up)}.`;
  if (down.length === items.length) return `${all} fell${range(down)}.`;
  if (flat.length === items.length) return `${all} ${whole.one ? "was" : "were"} about the same.`;
  const parts: string[] = [];
  const lead = (group: Moved[]) => howMany(group, noun, parts.length === 0);
  if (up.length) parts.push(`${lead(up).text} rose`);
  if (down.length) parts.push(`${lead(down).text} fell`);
  if (flat.length) {
    const f = lead(flat);
    parts.push(`${f.text} ${f.one ? "was" : "were"} about the same`);
  }
  return `${list(parts)}.`;
}

/**
 * The places that moved one way by the bins, biggest move first, ties by
 * name. A move the bins call about the same is in neither list.
 */
export function movers<T extends { name: string; change: number }>(items: T[], dir: "up" | "down", cadence: Cadence): T[] {
  const sign = dir === "up" ? 1 : -1;
  return items
    .filter((i) => directionFor(i.change, cadence) === dir)
    .sort((a, b) => sign * (changeTenths(b.change) - changeTenths(a.change)) || a.name.localeCompare(b.name));
}

/** Everyone tied for the biggest move at the top of a movers list. */
export function leaders<T extends { change: number }>(sorted: T[]): T[] {
  if (sorted.length === 0) return [];
  const top = changeTenths(sorted[0].change);
  return sorted.filter((i) => changeTenths(i.change) === top);
}

/**
 * The BIGGEST RISE note beside the board: who moved most each way, and, when
 * every region went the same way, who moved least. Ties are named together
 * up to three, then counted. Null when nothing moved by the bins.
 *   "Biggest rise. Lower Atlantic, +49.1¢. Smallest, New England, +21.2¢."
 *   "Biggest rise. Midwest, +30.4¢. Biggest fall. California, −2.5¢."
 */
export function biggestNote(items: { name: string; change: number }[], cadence: Cadence): { head: string; text: string } | null {
  const rises = movers(items, "up", cadence);
  const falls = movers(items, "down", cadence);
  if (!rises.length && !falls.length) return null;
  const who = (tied: { name: string }[]) =>
    tied.length > 3 ? `${tied.length} tied` : list(tied.map((i) => i.name));
  const say = (tied: { name: string; change: number }[]) => `${who(tied)}, ${formatSignedCents(tied[0].change)}.`;
  const parts: string[] = [];
  let head = "";
  if (rises.length) {
    head = "Biggest rise.";
    parts.push(say(leaders(rises)));
  }
  if (falls.length) {
    const fall = `${say(leaders(falls))}`;
    if (head) parts.push(`Biggest fall. ${fall}`);
    else {
      head = "Biggest fall.";
      parts.push(fall);
    }
  }
  // all one way: the smallest move too, unless one region is the whole story
  const oneWay = rises.length === items.length ? rises : falls.length === items.length ? falls : null;
  if (oneWay && oneWay.length > 1) {
    const last = changeTenths(oneWay[oneWay.length - 1].change);
    const least = oneWay.filter((i) => changeTenths(i.change) === last);
    if (least.length < oneWay.length) parts.push(`Smallest, ${say(least)}`);
  }
  return { head, text: parts.join(" ") };
}

/** "15 states", "5 states and DC", "DC" for a list of member codes. */
export function memberCount(codes: string[]): string {
  const dc = codes.includes("DC");
  const n = codes.filter((c) => c !== "DC").length;
  if (n === 0) return dc ? "DC" : "no states";
  return `${plural(n, "state")}${dc ? " and DC" : ""}`;
}

/** "all 50 states and DC", "48 states and DC": the places that have a price. */
export function coverage(codesWithPrice: string[]): string {
  const dc = codesWithPrice.includes("DC");
  const n = codesWithPrice.filter((c) => c !== "DC").length;
  const states = n === 50 ? "all 50 states" : plural(n, "state");
  return dc ? `${states} and DC` : states;
}

/**
 * The first sentence under the headline price: where it came from.
 *   "Up from $5.967 the week of Sep 7." / "Down from $6.772 yesterday." /
 *   "Unchanged from $6.285 the week of Sep 7."
 * `from` is the earlier day in words: "the week of Sep 7", "yesterday", "Sep 22".
 */
export function fromLine(change: number, prev: number, from: string): string {
  const t = changeTenths(change);
  const lead = t > 0 ? "Up" : t < 0 ? "Down" : "Unchanged";
  return `${lead} from ${formatPrice(prev)} ${from}.`;
}

/**
 * How high the U.S. price is, with the regions in the same breath when they
 * agree. The record wording is the site's one phrase for it, from doe.ts.
 *   "Highest U.S. price in our records, which start June 2022, and every region is at its own high too."
 *   "Highest U.S. price in our records, which start June 2022. 6 of 8 regions are at their own high too."
 *   "Highest U.S. price in 52 weeks. Every region is at its highest in our records, which start June 2022."
 * Null when there is nothing to say.
 */
export function recordLine(us: PeakKind, regions: PeakKind[]): string | null {
  const usPart = peakSentence(us, "U.S.");
  const records = regions.filter((k) => k === "record").length;
  if (us === "record" && records > 0) {
    const tail = records === regions.length ? "every region is at its own high too" : `${records} of ${regions.length} regions are at their own high too`;
    return records === regions.length
      ? `Highest U.S. price in our records, which start ${RECORDS_START}, and ${tail}.`
      : `${usPart} ${tail[0].toUpperCase()}${tail.slice(1)}.`;
  }
  const regionsPart = allRegionsSentence(regions);
  return [usPart, regionsPart].filter(Boolean).join(" ") || null;
}

/**
 * The ONE PRICE, MANY STATES note: why so many rows read the same, said with
 * the biggest region's real count and price.
 */
export function sharedNote(region: { name: string; codes: string[]; price: number }, daily: boolean): string {
  if (daily) {
    return `EIA surveys regions, not every state, so its weekly ${region.name} number covers ${memberCount(region.codes)}. The daily price for each state in the table below is AAA's.`;
  }
  const n = region.codes.filter((c) => c !== "DC").length;
  const dc = region.codes.includes("DC");
  // "15 Midwest states", "5 Central Atlantic states and DC"
  const who = `${n} ${region.name} state${n === 1 ? "" : "s"}${dc ? " and DC" : ""}`;
  return `EIA surveys regions, not every state, so all ${who} read ${formatPrice(region.price)} this week.`;
}

/** The browser tab and search result: "DailyFuel: U.S. diesel $6.285 a gallon, up 31.8¢". */
export function homeTitle(price: number | null, change: number | null): string {
  if (price === null) return "DailyFuel: diesel prices in every state";
  const moved = change === null ? "" : `, ${saidChange(change)}`;
  return `DailyFuel: U.S. diesel ${formatPrice(price)} a gallon${moved}`;
}

export interface DescriptionInput {
  /** U.S. price and change, or null when there is no national price. */
  price: number | null;
  change: number | null;
  daily: boolean;
  /** Codes of the states (and DC) that have a price on the page. */
  priced: string[];
  /**
   * How many EIA regions the prices come from, while EIA is the source. DOE
   * prices regions, not states, so the meta says that instead of reading like
   * 49 state prices.
   */
  regions?: number;
}

/**
 * Home meta description with real numbers. It names only the places that have
 * a price, so it never promises Alaska and Hawaii while EIA doesn't survey them.
 */
export function homeMeta({ price, change, daily, priced, regions }: DescriptionInput): string {
  const where = coverage(priced);
  const what = daily
    ? `today's price and change for ${where}`
    : regions
      ? `the DOE weekly price for the ${regions} regions that cover ${where}`
      : `the DOE weekly price and change for ${where}`;
  if (price === null) return `See ${what}.`;
  const moved = change === null ? "" : `, ${saidChange(change)}`;
  const when = change === null ? "" : daily ? " since yesterday" : " this week";
  return `U.S. diesel is ${formatPrice(price)} a gallon${moved}${when}. See ${what}.`;
}
