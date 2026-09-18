// Words and small calculations for the home page: the line above the map key,
// the region note in the map tooltip, the move list and the meta description.
// Plain functions of plain inputs, so they are easy to test.

import { directionFor, type Cadence } from "../../lib/bins.ts";
import { changeTenths, formatCents, formatPrice, spokenChange } from "../../lib/format.ts";

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
 * One line above the map key, computed from the data:
 * "All 8 regions rose, 21.2¢ to 49.1¢." or "5 regions rose, 2 fell and 1 was about the same."
 * Direction follows the map bins, so a state the map paints as about the same is counted that way.
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
 * The places that moved one way by the map bins, biggest move first, ties by
 * name. A move the map calls about the same is in neither list.
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

/** The first `count` of a movers list, plus anyone tied with the last of them, so a cut never splits a tie. */
export function topWithTies<T extends { change: number }>(sorted: T[], count: number): T[] {
  if (sorted.length <= count) return sorted.slice();
  if (count <= 0) return [];
  const edge = changeTenths(sorted[count - 1].change);
  let n = count;
  while (n < sorted.length && changeTenths(sorted[n].change) === edge) n += 1;
  return sorted.slice(0, n);
}

/** "15 states", "5 states and DC", "DC" for a list of member codes. */
export function memberCount(codes: string[]): string {
  const dc = codes.includes("DC");
  const n = codes.filter((c) => c !== "DC").length;
  if (n === 0) return dc ? "DC" : "no states";
  return `${plural(n, "state")}${dc ? " and DC" : ""}`;
}

/**
 * The tooltip line that says a price is shared: "Midwest price, shared by 15 states".
 * A region with one state keeps the plain "EIA's California price".
 */
export function regionNote(regionName: string, codes: string[]): string {
  if (codes.length <= 1) return `EIA's ${regionName} price`;
  return `${regionName} price, shared by ${memberCount(codes)}`;
}

/**
 * Swap the region note at the end of a map label for the longer one. The label
 * ends with "<note>." when it has a note, and is left alone otherwise.
 */
export function withNote(label: string, oldNote: string, newNote: string): string {
  if (!oldNote || !label.endsWith(` ${oldNote}.`)) return label;
  return `${label.slice(0, label.length - oldNote.length - 1)}${newNote}.`;
}

/** Sort for the move list: biggest rise first, biggest drop last, then by name. */
export function byChange<T extends { name: string; change: number }>(items: T[]): T[] {
  return items.slice().sort((a, b) => changeTenths(b.change) - changeTenths(a.change) || a.name.localeCompare(b.name));
}

/** "all 50 states and DC", "48 states and DC": the places that have a price. */
export function coverage(codesWithPrice: string[]): string {
  const dc = codesWithPrice.includes("DC");
  const n = codesWithPrice.filter((c) => c !== "DC").length;
  const states = n === 50 ? "all 50 states" : plural(n, "state");
  return dc ? `${states} and DC` : states;
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
  const moved = change === null ? "" : `, ${spokenChange(change).replace(" cents", "¢").replace("no change", "unchanged")}`;
  const when = change === null ? "" : daily ? " since yesterday" : " this week";
  return `U.S. diesel is ${formatPrice(price)} a gallon${moved}${when}. See ${what}.`;
}
