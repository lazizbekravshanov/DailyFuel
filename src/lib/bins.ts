// Fixed color bins for price changes, so a color means the same thing every day.
// Binning uses the change as it is shown (cents rounded to one decimal), so the
// glyph and the number beside it never disagree.

import { changeTenths } from "./format.ts";

export type Cadence = "weekly" | "daily";
export type Direction = "up" | "down" | "flat";
export type BinKey = "down-3" | "down-2" | "down-1" | "flat" | "up-1" | "up-2" | "up-3";
export type FillKey = BinKey | "nodata";

/** Bin edges in tenths of a cent: [about the same below, small below, medium below]. */
export const EDGES: Record<Cadence, [number, number, number]> = {
  // under 0.5¢, 0.5 to 5¢, 5 to 15¢, 15¢ or more
  weekly: [5, 50, 150],
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

function cents(tenths: number): string {
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

export interface LegendItem {
  key: BinKey;
  direction: Direction;
  label: string;
}

/** Legend in reading order: biggest drop, ..., about the same, ..., biggest rise. */
export function legendItems(cadence: Cadence): LegendItem[] {
  const [flat, small, mid] = EDGES[cadence];
  const ranges = [
    `${cents(flat)} to ${cents(small)}¢`,
    `${cents(small)} to ${cents(mid)}¢`,
    `${cents(mid)}¢ or more`,
  ];
  return [
    { key: "down-3", direction: "down", label: `Fell ${ranges[2]}` },
    { key: "down-2", direction: "down", label: `Fell ${ranges[1]}` },
    { key: "down-1", direction: "down", label: `Fell ${ranges[0]}` },
    { key: "flat", direction: "flat", label: `About the same, under ${cents(flat)}¢` },
    { key: "up-1", direction: "up", label: `Rose ${ranges[0]}` },
    { key: "up-2", direction: "up", label: `Rose ${ranges[1]}` },
    { key: "up-3", direction: "up", label: `Rose ${ranges[2]}` },
  ];
}

/** Fill tokens whose background is dark enough to need white text on it. */
export const DARK_FILLS: ReadonlySet<FillKey> = new Set(["up-3", "down-3"]);
