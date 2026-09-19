// The direction arrows: rose, fell and about the same from the road sign icon
// set (src/icons). Every price change on the site and on the share cards shows
// one of them, so this is the one place a direction turns into a shape.
//
// Three ways onto a page:
//   Glyph.astro inlines the path, for changes the server renders once.
//   ArrowSprite.astro puts the three shapes on a page once as symbols, and
//   markup that repeats or that a script builds points at them:
//   <svg class="glyph glyph-up"><use href="#arrow-up"></use></svg>.
//   The map chips and the share cards draw the path straight into their SVG.

import type { Direction } from "./bins.ts";
import { iconBody, type IconName } from "./icons.ts";

export const DIRECTIONS: readonly Direction[] = ["up", "down", "flat"];

/** Which road sign icon draws each direction. */
export const ARROW_ICON: Record<Direction, IconName> = {
  up: "rose",
  down: "fell",
  flat: "about-the-same",
};

/**
 * The arrow's id in the page's sprite: "arrow-up". The page scripts build the
 * same id as "arrow-" plus the direction, so keep the two in step.
 */
export function arrowId(direction: Direction): string {
  return `arrow-${direction}`;
}

/**
 * Every number in a path rounded to hundredths of a grid unit. On the 24 unit
 * grid that is under a thousandth of the icon, far below a pixel at any size
 * the site draws, and it drops the design tool's 9.40001 style noise.
 */
export function compactPath(d: string): string {
  return d
    .replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, (s) => String(Math.round(Number(s) * 100) / 100))
    .replace(/\s+/g, " ")
    .trim();
}

/** The arrow's outline on the icon's 24 by 24 grid, ready for a path's d. */
export function arrowPath(direction: Direction): string {
  const icon = ARROW_ICON[direction];
  const paths = [...iconBody(icon).matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 1) throw new Error(`src/icons/${icon}.svg should be one path, found ${paths.length}`);
  return compactPath(paths[0]);
}
