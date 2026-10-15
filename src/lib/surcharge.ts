// A fuel surcharge from the weekly DOE diesel price: the price over the
// contract's base, over the contract's miles per gallon, never below 0, to a
// tenth of a cent a mile. The rounding is on whole numbers, the way format.ts
// does it, so float noise never flips a digit.
//
// The /surcharge/ page renders its first answer with this module, and its
// script (src/scripts/surcharge.js) does the same sums in the browser. The
// page check in src/lib/built.test.ts runs that script against this module,
// so the two never drift apart.

import { formatDate } from "./dates.ts";
import { formatPrice, toMills } from "./format.ts";
import type { SeriesKey } from "./data.ts";

/** The DOE prices a contract can name, in EIA's order: the U.S., then each region. */
export const SURCHARGE_SERIES: SeriesKey[] = ["NUS", "R10", "R1X", "R1Y", "R1Z", "R20", "R30", "R40", "R50", "R5XCA", "SCA"];

/** How many weeks the week list goes back: this week and the 52 before it. */
export const SURCHARGE_WEEKS = 53;

/** What the fields hold until a driver types their own: a common contract's $1.25 base and 6 miles per gallon. */
export const DEFAULT_BASE = "1.25";
export const DEFAULT_MPG = "6";

export const BASE_ERROR = "Type a base price from $0 to $10 a gallon, like 1.25.";
export const MPG_ERROR = "Type miles per gallon from 2 to 20, like 6.5.";

/**
 * A plain number as typed: "6", "6.5", ".5", "6." and nothing else. A phone
 * set to a region that writes 6,5 has only a comma on its number pad, so one
 * comma counts as the point.
 */
const NUMBER = /^(\d+\.?\d*|\.\d+)$/;
/** A base price has at most three decimals, like the DOE price, so it is never rounded twice. */
const BASE = /^(\d+\.?\d{0,3}|\.\d{1,3})$/;

/** The base price a driver typed, in dollars a gallon, or null when it isn't one: 0 to 10, a $ in front is fine. */
export function readBase(v: string): number | null {
  const t = v.trim().replace(/^\$\s*/, "").replace(",", ".");
  if (!BASE.test(t)) return null;
  const n = Number(t);
  return n <= 10 ? n : null;
}

/** The contract's miles per gallon, or null when it isn't a truck's: 2 to 20, the same as the map's. */
export function readMpg(v: string): number | null {
  const t = v.trim().replace(",", ".");
  if (!NUMBER.test(t)) return null;
  const n = Number(t);
  return n >= 2 && n <= 20 ? n : null;
}

const usable = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;

/**
 * The surcharge a mile in tenths of a cent, so 825 is 82.5¢: the price over
 * the base, over the miles per gallon, rounded half up. 0 when the price is
 * at or under the base. Null when there is no price, base or MPG to use.
 */
export function perMileTenths(price: number | null, base: number | null, mpg: number | null): number | null {
  if (!usable(price) || !usable(base) || !usable(mpg) || mpg === 0) return null;
  // thousandths of a dollar a gallon are tenths of a cent a gallon
  const over = toMills(price) - toMills(base);
  if (over <= 0) return 0;
  // the epsilon keeps an exact half, which a double can hold just under, rounding up
  return Math.floor(over / mpg + 0.5 + 1e-9);
}

/** "82.5¢" from 825 tenths of a cent. */
export function centsText(tenths: number): string {
  return `${Math.floor(tenths / 10)}.${tenths % 10}¢`;
}

export interface SurchargeInput {
  /** The price's name, as the page says it: "U.S.", "Midwest". */
  name: string;
  /** The DOE week, the Monday of the survey: "2026-10-12". */
  period: string;
  /** Dollars a gallon, or null when EIA has no price that week. */
  price: number | null;
  /** From readBase and readMpg: null when the field doesn't hold a usable number. */
  base: number | null;
  mpg: number | null;
}

export interface SurchargeAnswer {
  /** One plain sentence: "82.5¢ a mile, $825 on 1,000 miles." Empty while a field needs fixing. */
  answer: string;
  /** Which price and week it used, so a screenshot explains itself. Empty when there is no answer to explain. */
  used: string;
}

/**
 * The page's answer. A tenth of a cent a mile over 1,000 miles is a whole
 * dollar, so the dollar figure is exact and agrees with the cents.
 */
export function surcharge(input: SurchargeInput): SurchargeAnswer {
  const { name, period, price, base, mpg } = input;
  const week = formatDate(period);
  if (!usable(base) || !usable(mpg) || mpg === 0) return { answer: "", used: "" };
  if (!usable(price)) return { answer: `There's no ${name} DOE price for the week of ${week}. Pick another week.`, used: "" };
  const tenths = perMileTenths(price, base, mpg)!;
  const answer = toMills(price) <= toMills(base)
    ? "No surcharge, since the price is at or under your base."
    : `${centsText(tenths)} a mile, $${tenths.toLocaleString("en-US")} on 1,000 miles.`;
  return { answer, used: `${name} DOE price ${formatPrice(price)}, week of ${week}. Base ${formatPrice(base)}, ${mpg} MPG.` };
}
