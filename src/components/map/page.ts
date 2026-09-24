// Build time pieces of the map page: the list's rows (which are also where
// the script reads every marker from), the JSON block the script reads the
// rest from, the 51 price rows for the route strip, and the legend's lines.

import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { moveClass } from "../../lib/bins.ts";
import { formatDate } from "../../lib/dates.ts";
import { formatMove, formatPrice } from "../../lib/format.ts";
import { pctOf } from "../../lib/copy.ts";
import type { MapData, MapPoint } from "../../lib/mapdata.ts";
import { regionLabel } from "../../lib/og.ts";
import type { SiteData } from "../../lib/site.ts";
import { formatCpg } from "../../lib/tax.ts";
import type { Cfg, PriceRow } from "../../scripts/map.ts";
import { CHAINS, SOURCES } from "./chains.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Four decimals is 11 metres, finer than any zoom the page allows can show. */
const ll = (n: number) => String(Math.round(n * 10000) / 10000);

/**
 * One row per point, written by hand rather than by Astro so the 2,700 rows
 * stay small: the cell end tags are left out, which HTML allows. Name, type
 * and state are the cells; everything else is a data attribute the script
 * reads (see src/scripts/map.ts).
 */
export function rowsHtml(points: MapPoint[]): string {
  let h = "";
  for (const p of points) {
    h += `<tr data-f="${p.filter}" data-l="${ll(p.lat)},${ll(p.lon)}"`;
    if (p.sources !== "o") h += ` data-s="${p.sources}"`;
    if (p.dir) h += ` data-d="${p.dir[0]}"`;
    if (p.kind === "v" && p.chain) h += ` data-c="${p.chain}"`;
    h += `><td>${esc(p.name)}<td>${esc(p.type)}<td>${p.state ?? ""}`;
  }
  return h;
}

/**
 * The route strip's 51 rows, from the site's own loaders: the EIA weekly
 * price and move for the state's region (never AAA, whatever the mode, since
 * the strip says it is EIA's regional average), the region plate, and the
 * FHWA state tax, "n/a" where the table has none or it is out of date.
 */
/** Short caveats for the states whose per gallon figure isn't what every truck pays; the state pages carry the full notes. */
const TAX_CAVEAT: Record<string, string> = {
  AZ: "the truck rate",
  KY: "motor carriers also pay a surtax",
  OR: "trucks over 26,000 lb pay weight mile tax instead",
};

export function priceRows(site: SiteData): PriceRow[] {
  return site.states.map((s) => {
    const m = s.eia;
    let tax = s.tax && s.tax.state !== null && !s.tax.outOfDate ? formatCpg(s.tax.state) : "n/a";
    if (tax !== "n/a" && TAX_CAVEAT[s.code]) tax += `, ${TAX_CAVEAT[s.code]}`;
    return [
      s.code,
      s.name,
      m ? formatPrice(m.price) : null,
      m && m.change !== null ? formatMove(m.change, pctOf(m)) : null,
      m ? moveClass(m.change, "weekly") : "muted",
      s.eia_series ? regionLabel(s, site) : "EIA doesn't survey this state",
      tax,
    ];
  });
}

/** The lower 48 and the box the map may pan in: all 50 states, the far Aleutians shifted west of 180. */
export const LOWER48: [[number, number], [number, number]] = [[24.4, -124.8], [49.4, -66.9]];
export const MAX_BOUNDS: [[number, number], [number, number]] = [[15, -190], [72.5, -60]];

export function mapConfig(site: SiteData, data: MapData): Cfg {
  const c: Cfg["c"] = {};
  for (const ch of CHAINS) c[ch.key] = [ch.name, ch.ink, ch.letter, ch.locator];
  const period = site.latest.eia?.period;
  return {
    c,
    src: SOURCES,
    px: priceRows(site),
    wk: period ? `EIA week of ${formatDate(period)}` : "No EIA week",
    mb: MAX_BOUNDS,
    l48: LOWER48,
    ly: (["states", "roads", "places"] as const).filter((k) => data.present[k]),
  };
}

/** JSON for a <script type="application/json"> block: nothing in it can close the tag. */
export const jsonBlock = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

/** Every point by what it is, for the page's meta line and description. */
export function tally(data: MapData): { stops: number; weigh: number; service: number } {
  let stops = 0;
  for (const ch of CHAINS) stops += data.counts[ch.key] ?? 0;
  return { stops, weigh: data.counts.w ?? 0, service: data.counts.v ?? 0 };
}

let script: string | null = null;

/**
 * src/scripts/map.ts and the geometry it imports, bundled and minified into
 * one inline module that calls init. esbuild comes with Astro, and the
 * build runs from the project root.
 */
export function mapScript(): string {
  if (script) return script;
  const root = process.cwd();
  const out = buildSync({
    stdin: {
      contents: `import { init } from "./src/scripts/map.ts"; init(document, window);`,
      resolveDir: root,
      sourcefile: "map-entry.ts",
      loader: "ts",
    },
    absWorkingDir: resolve(root),
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2019",
    legalComments: "none",
    write: false,
  });
  script = out.outputFiles[0].text.trim();
  return script;
}
