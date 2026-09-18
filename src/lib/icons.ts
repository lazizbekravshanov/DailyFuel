// The road sign icon set: solid shapes cut from US road signs, drawn on a 24 by
// 24 grid with one fill in currentColor, so the page tints them. One file per
// icon in src/icons. Icon.astro inlines them at build time; the page ships no
// icon font and no sprite request.
//
// Direction data keeps its own ▲ ▼ ● glyphs (Glyph.astro). The rose, fell and
// about the same icons are here for the set, not for prices.

export const ICON_NAMES = [
  "your-state",
  "find-a-state",
  "rose",
  "fell",
  "about-the-same",
  "next-update",
  "state-tax",
  "region",
  "share",
  "about",
  "price-history",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const files = import.meta.glob<string>("../icons/*.svg", { query: "?raw", import: "default", eager: true });

/** The raw file for an icon, or undefined when there is none. */
export function iconFile(name: string): string | undefined {
  return files[`../icons/${name}.svg`];
}

/** What goes inside the <svg>: the icon's paths, without the outer tag. */
export function iconBody(name: IconName): string {
  const file = iconFile(name);
  if (!file) throw new Error(`No icon named ${name} in src/icons`);
  const m = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(file);
  if (!m) throw new Error(`src/icons/${name}.svg has no <svg> element`);
  return m[1].trim();
}
