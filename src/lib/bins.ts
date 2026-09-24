// Fixed bins for price changes, so "about the same" means the same thing every
// week. Binning uses the change as it is shown (cents rounded to one decimal),
// so the words and the number beside them never disagree. The paper terminal
// has no map, but the bins still decide what counts as a rise or a fall: a
// weekly move under 1¢ is flat, prints as +0.3¢ in muted ink, and is never
// named as the biggest rise or drop.

import { changeTenths } from "./format.ts";

export type Cadence = "weekly" | "daily";
export type Direction = "up" | "down" | "flat";
export type BinKey = "down-3" | "down-2" | "down-1" | "flat" | "up-1" | "up-2" | "up-3";

/** Bin edges in tenths of a cent: [about the same below, small below, medium below]. */
export const EDGES: Record<Cadence, [number, number, number]> = {
  // under 1¢, 1 to 5¢, 5 to 15¢, 15¢ or more. About the same is 1¢ wide so a
  // penny of noise in a quiet week doesn't read as a move.
  weekly: [10, 50, 150],
  // under 0.2¢, 0.2 to 2¢, 2 to 6¢, 6¢ or more
  daily: [2, 20, 60],
};

export function binFor(change: number, cadence: Cadence): BinKey {
  const t = changeTenths(change);
  const a = Math.abs(t);
  const [flat, small, mid] = EDGES[cadence];
  if (a < flat) return "flat";
  const step = a < small ? 1 : a < mid ? 2 : 3;
  return `${t > 0 ? "up" : "down"}-${step}` as BinKey;
}

export function directionFor(change: number, cadence: Cadence): Direction {
  const b = binFor(change, cadence);
  return b === "flat" ? "flat" : b.startsWith("up") ? "up" : "down";
}

/**
 * The class a printed change wears on the paper terminal: red ink ("up") when
 * it rose, blue ("down") when it fell, and muted ink when the bins call it
 * about the same, so a +0.3¢ week doesn't light up. No change at all is muted too.
 */
export function moveClass(change: number | null, cadence: Cadence): "up" | "down" | "muted" {
  if (change === null) return "muted";
  const d = directionFor(change, cadence);
  return d === "flat" ? "muted" : d;
}
