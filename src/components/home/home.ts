// Words and small calculations for the home page: the line above the map key,
// the region note in the map tooltip, the move list and the meta description.
// Plain functions of plain inputs, so they are easy to test.

import { directionFor, type Cadence } from "../../lib/bins.ts";
import { changeTenths, formatCents, formatPrice, spokenChange } from "../../lib/format.ts";

export interface Moved {
  change: number;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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
  const flat = items.length - up.length - down.length;
  const range = (group: Moved[]): string => {
    const t = group.map((i) => Math.abs(changeTenths(i.change)));
    const lo = Math.min(...t);
    const hi = Math.max(...t);
    return lo === hi ? ` ${formatCents(lo / 1000)}` : `, ${formatCents(lo / 1000)} to ${formatCents(hi / 1000)}`;
  };
  const all = items.length === 1 ? `The one ${noun}` : `All ${plural(items.length, noun)}`;
  if (up.length === items.length) return `${all} rose${range(up)}.`;
  if (down.length === items.length) return `${all} fell${range(down)}.`;
  if (flat === items.length) return `${all} ${items.length === 1 ? "was" : "were"} about the same.`;
  const parts: string[] = [];
  const lead = (n: number) => (parts.length === 0 ? plural(n, noun) : String(n));
  if (up.length) parts.push(`${lead(up.length)} rose`);
  if (down.length) parts.push(`${lead(down.length)} fell`);
  if (flat) parts.push(`${lead(flat)} ${flat === 1 ? "was" : "were"} about the same`);
  return `${list(parts)}.`;
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
}

/**
 * Home meta description with real numbers. It names only the places that have
 * a price, so it never promises Alaska and Hawaii while EIA doesn't survey them.
 */
export function homeMeta({ price, change, daily, priced }: DescriptionInput): string {
  const where = coverage(priced);
  const what = daily ? "today's price and change" : "the DOE weekly price and change";
  if (price === null) return `See ${what} for ${where}.`;
  const moved = change === null ? "" : `, ${spokenChange(change).replace(" cents", "¢").replace("no change", "unchanged")}`;
  const when = change === null ? "" : daily ? " since yesterday" : " this week";
  return `U.S. diesel is ${formatPrice(price)} a gallon${moved}${when}. See ${what} for ${where}.`;
}
