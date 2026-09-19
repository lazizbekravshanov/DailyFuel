// Share cards: one 1200x630 PNG per page, drawn at build time as an SVG of the
// green sign and turned into a PNG by resvg. Nothing here reaches the browser.
//
// A price in a picture goes stale, and chat apps cache previews by URL for a
// long time. So every card prints its week and where the number comes from,
// and the file name carries the date (/og/oh-2026-09-14.png). A new week is a
// new URL, so a fresh share never shows last week's price.

import { resolve } from "node:path";
import { arrowPath } from "./arrows.ts";
import { directionFor, type Direction } from "./bins.ts";
import { pctOf } from "./copy.ts";
import { formatDate, when } from "./dates.ts";
import { formatChange, priceParts, spokenChange, type PriceParts } from "./format.ts";
import { palettePng } from "./png.ts";
import { regionAverage } from "./yourstate.ts";
import type { Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** The key for the U.S. card, which also stands in for pages without a state. */
export const US_KEY = "us";

export interface Card {
  /** "us" or a lowercase state code. */
  key: string;
  /** Two letter code in the white shield, none on the U.S. card. */
  shield: string | null;
  /** "Ohio diesel average" */
  legend: string;
  price: PriceParts | null;
  /** Shown in place of a price when there is none. */
  noPrice: string;
  direction: Direction | null;
  /** "30.4¢ (+5.1%)" */
  change: string | null;
  /** "up 30.4 cents" */
  spoken: string | null;
  /** "Week of Sep 14, 2026" */
  dateLine: string;
  /** "Since the week of Sep 7" */
  compareLine: string | null;
  /** Where the number comes from: "EIA Midwest average, 15 states". */
  label: string;
}

/** The date in every card URL: AAA's day when AAA leads, else EIA's survey week. */
export function cardDate(site: SiteData): string {
  if (site.mode === "aaa+eia" && site.latest.aaa) return site.latest.aaa.as_of;
  return site.latest.eia?.period ?? site.national.date;
}

/** Every card the build draws: the U.S. first, then each state. */
export function cardKeys(site: SiteData): string[] {
  return [US_KEY, ...site.states.map((s) => s.slug)];
}

/** "/og/oh-2026-09-14.png" */
export function cardPath(key: string, date: string): string {
  return `/og/${key}-${date}.png`;
}

/** Which card a page shares: its own state, or the U.S. card for everything else. */
export function cardKeyFor(pathname: string, site: SiteData): string {
  const m = /^\/state\/([a-z]{2})\/?$/.exec(pathname);
  if (m && site.byCode.has(m[1].toUpperCase())) return m[1];
  return US_KEY;
}

/**
 * "EIA Midwest average, 15 states", "EIA Central Atlantic average, 5 states
 * and DC": the same words as the plate on the state sign and the mini sign.
 */
export function regionLabel(s: StateView, site: SiteData): string {
  if (!s.eia_series || !s.regionName) return `EIA doesn't survey diesel prices in ${s.name}`;
  if (s.eia_series === "SCA") return "EIA California average";
  return regionAverage(s, site) ?? `EIA ${s.regionName} average`;
}

interface Timing {
  dateLine: string;
  compareLine: string | null;
}

function timing(site: SiteData, daily: boolean): Timing {
  const { latest } = site;
  if (daily && latest.aaa) {
    const a = latest.aaa;
    const compareLine = a.prev_as_of === null
      ? null
      : a.gap_days && a.gap_days > 1
        ? `Since ${when(a.prev_as_of, a.as_of)}`
        : "Since yesterday";
    return { dateLine: `Price as of ${formatDate(a.as_of)}`, compareLine };
  }
  if (latest.eia) {
    const e = latest.eia;
    return {
      dateLine: `Week of ${formatDate(e.period)}`,
      compareLine: e.prev_period ? `Since the week of ${when(e.prev_period, e.period)}` : null,
    };
  }
  return { dateLine: `Week of ${formatDate(site.national.date)}`, compareLine: null };
}

function moveParts(move: Move | null, daily: boolean) {
  if (!move || move.change === null) return { direction: null, change: null, spoken: null };
  const cadence = daily ? "daily" : "weekly";
  return {
    direction: directionFor(move.change, cadence),
    change: formatChange(move.change, pctOf(move)),
    spoken: spokenChange(move.change),
  };
}

/** What a card says. Pure, so the page head can build the alt text without drawing. */
export function cardFor(site: SiteData, key: string): Card {
  const aaaMode = site.mode === "aaa+eia";
  if (key === US_KEY) {
    const daily = site.national.cadence === "daily";
    const move = site.national.move;
    const t = timing(site, daily);
    const parts = moveParts(move, daily);
    // AAA's national change is its own today minus yesterday, even after a
    // missed day, so it's always "since yesterday".
    const compareLine = daily ? "Since yesterday" : t.compareLine;
    return {
      key,
      shield: null,
      legend: "U.S. diesel average",
      price: move ? priceParts(move.price) : null,
      noPrice: "No national price",
      ...parts,
      dateLine: t.dateLine,
      compareLine: parts.change ? compareLine : null,
      label: daily ? "AAA daily U.S. average, data by OPIS" : "DOE weekly average, published by EIA",
    };
  }
  const s = site.byCode.get(key.toUpperCase());
  if (!s) throw new Error(`no state for share card ${key}`);
  const daily = s.cadence === "daily";
  const move = s.primary;
  const t = timing(site, daily && aaaMode);
  const parts = moveParts(move, daily);
  // A state EIA doesn't survey has no reading for any week, so the card says
  // what its page says instead of printing a survey week.
  const unsurveyed = !aaaMode && !move && s.eia_series === null;
  return {
    key,
    shield: s.code,
    legend: move ? `${s.name} diesel average` : `Diesel in ${s.name}`,
    price: move ? priceParts(move.price) : null,
    noPrice: aaaMode ? "No price today" : "No weekly price",
    ...parts,
    dateLine: unsurveyed ? "Not in EIA's weekly survey" : t.dateLine,
    compareLine: parts.change ? t.compareLine : null,
    label: aaaMode ? "AAA daily average, data by OPIS" : regionLabel(s, site),
  };
}

/** The picture in words, for og:image:alt. */
export function cardAlt(card: Card): string {
  if (!card.price) return `${card.legend}: ${card.noPrice.toLowerCase()}. ${card.label}.`;
  const since = card.compareLine ? ` ${card.compareLine.charAt(0).toLowerCase()}${card.compareLine.slice(1)}` : "";
  const moved = card.spoken ? `, ${card.spoken}${since}` : "";
  return `${card.legend}: ${card.price.plain} a gallon${moved}. ${card.dateLine}. ${card.label}.`;
}

// Drawing

/** Ink extent of `text` set at 100px: where the ink starts and ends, from the pen position. */
export interface Ink {
  left: number;
  right: number;
}

export type Measure = (text: string, weight: 700 | 800) => Ink;

const GREEN = "#0a6640";
const WHITE = "#ffffff";
const PLAQUE_INK = "#1d2125";
// the plaque's arrow colors, the same as the sign on the page
const GLYPH: Record<Direction, string> = { up: "#c94d47", down: "#3a75bf", flat: "#51565b" };

/**
 * The fuel pump from the app icon's 32px drawing (scripts/make_app_icons.mjs),
 * the same path the site header draws, so a shared card shows the same mark.
 */
export const PUMP_32 =
  "M15.12 7.75C15.46 7.75 15.79 7.89 16.03 8.13C16.28 8.37 16.41 8.7 16.41 9.04V14.87H18.03C18.74 14.87 19.4 15.11 19.89 15.6C20.38 16.09 20.62 16.75 20.62 17.46V20.69C20.62 20.96 20.7 21.1 20.78 21.18C20.85 21.25 21 21.34 21.26 21.34C21.53 21.34 21.67 21.25 21.75 21.18C21.83 21.1 21.91 20.96 21.91 20.69V12.68L19.93 10.7C19.55 10.32 19.55 9.71 19.93 9.33C20.31 8.95 20.92 8.95 21.3 9.33L23.57 11.59C23.75 11.78 23.85 12.02 23.85 12.28V20.69C23.85 21.4 23.61 22.06 23.12 22.55C22.63 23.04 21.97 23.28 21.26 23.28C20.56 23.28 19.9 23.04 19.41 22.55C18.92 22.06 18.68 21.4 18.68 20.69V17.46C18.68 17.19 18.59 17.05 18.52 16.97C18.44 16.89 18.29 16.81 18.03 16.81H16.41V24.25H8V9.04C8 8.7 8.14 8.37 8.38 8.13C8.62 7.89 8.95 7.75 9.29 7.75H15.12ZM10.59 9.69C10.23 9.69 9.94 9.98 9.94 10.34V13.25C9.94 13.61 10.23 13.9 10.59 13.9H13.82C14.18 13.9 14.47 13.61 14.47 13.25V10.34C14.47 9.98 14.18 9.69 13.82 9.69H10.59Z";

const LEFT = 84;
const RIGHT = CARD_WIDTH - 84;
const INNER = RIGHT - LEFT;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const n = (v: number) => String(Math.round(v * 10) / 10);

function text(x: number, y: number, size: number, weight: 700 | 800, fill: string, s: string, anchor?: "middle" | "end"): string {
  return `<text x="${n(x)}" y="${n(y)}" font-family="Overpass" font-weight="${weight}" font-size="${n(size)}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ""}>${escapeXml(s)}</text>`;
}

/**
 * The road sign arrow for a direction, the same shape the page shows, in a
 * `size` box on the 24 unit icon grid with its top left corner at x, y.
 */
function arrow(direction: Direction, x: number, y: number, size: number, fill: string): string {
  return `<path transform="translate(${n(x)} ${n(y)}) scale(${Math.round((size / 24) * 1000) / 1000})" fill="${fill}" d="${arrowPath(direction)}"/>`;
}

/** Width of `s` at `size`, from the pen position to the end of the ink. */
function width(measure: Measure, s: string, size: number, weight: 700 | 800): number {
  return (measure(s, weight).right * size) / 100;
}

/** The card as SVG. `measure` sets text widths, so the plaque hugs its words and long names shrink to fit. */
export function cardSvg(card: Card, measure: Measure): string {
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`);
  // The sign fills the frame, with the white inset border a guide sign has.
  out.push(`<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${GREEN}"/>`);
  out.push(`<rect x="18" y="18" width="${CARD_WIDTH - 36}" height="${CARD_HEIGHT - 36}" rx="26" fill="none" stroke="${WHITE}" stroke-width="8"/>`);

  // Legend row: shield and name. Everything in the row scales with the name's
  // size, so a long name like District of Columbia shrinks the whole row to fit.
  const rowMid = 118;
  const shieldGap = card.shield ? 24 : 0;
  // widths at a 100px name
  const shield100 = card.shield ? Math.max(170, width(measure, card.shield, 68, 800) + 70) : 0;
  const legend100 = measure(card.legend, 800).right;
  const legendSize = Math.min(60, ((INNER - shieldGap) / (shield100 + legend100)) * 100);
  const shieldW = (shield100 * legendSize) / 100;
  if (card.shield) {
    const h = legendSize * 1.18;
    const font = legendSize * 0.68;
    out.push(`<rect x="${LEFT}" y="${n(rowMid - h / 2)}" width="${n(shieldW)}" height="${n(h)}" rx="10" fill="${WHITE}"/>`);
    out.push(text(LEFT + shieldW / 2, rowMid + font * 0.35, font, 800, GREEN, card.shield, "middle"));
  }
  out.push(text(LEFT + shieldW + shieldGap, rowMid + legendSize * 0.35, legendSize, 800, WHITE, card.legend));

  // Price row: the price on the left, the change plaque on the right, both on one baseline.
  const base = 366;
  const dateBase = 430;
  if (card.price) {
    let P = 210;
    let C = 46;
    const mainW = (s: number) => width(measure, card.price!.main, s, 800);
    const priceW = (s: number) => mainW(s) + s * 0.05 + width(measure, card.price!.tenth, s / 2, 800);
    const plaqueW = (c: number) => (card.change ? c * 0.44 + c * 1.0 + width(measure, card.change, c, 800) + c * 0.48 : 0);
    const compareW = (card.compareLine ? width(measure, card.compareLine, 30, 700) : 0);
    const blockW = (c: number) => Math.max(plaqueW(c), compareW);
    const gap = 56;
    const need = priceW(P) + (card.change ? gap + blockW(C) : 0);
    if (need > INNER) {
      const k = Math.max(0.6, INNER / need);
      P *= k;
      C *= k;
    }
    // "$6.25" then the raised tenth, its top in line with the digits
    out.push(text(LEFT, base, P, 800, WHITE, card.price.main));
    out.push(text(LEFT + mainW(P) + P * 0.05, base - P * 0.36, P / 2, 800, WHITE, card.price.tenth));
    if (card.change && card.direction) {
      const bw = blockW(C);
      const bx = RIGHT - bw;
      const ph = C * 1.62;
      const py = base - C * 0.356 - ph / 2;
      out.push(`<rect x="${n(bx)}" y="${n(py)}" width="${n(plaqueW(C))}" height="${n(ph)}" rx="12" fill="${WHITE}"/>`);
      // The arrow the way the page sets it: a 0.9em box pulled 0.094em under
      // the baseline, so an up or down arrow stands as tall as the digits.
      // It centers in the 0.7em slot before the text, which the widest arrow
      // (about the same) just fills.
      const as = C * 0.9;
      out.push(arrow(card.direction, bx + C * 0.79 - as / 2, base + C * 0.094 - as, as, GLYPH[card.direction]));
      out.push(text(bx + C * 0.44 + C * 1.0, base, C, 800, PLAQUE_INK, card.change));
      if (card.compareLine) out.push(text(bx + 2, dateBase, 30, 700, WHITE, card.compareLine));
    }
  } else {
    let size = 110;
    const w = width(measure, card.noPrice, size, 800);
    if (w > INNER) size *= INNER / w;
    out.push(text(LEFT, base - 20, size, 800, WHITE, card.noPrice));
  }
  out.push(text(LEFT, dateBase, 32, 700, WHITE, card.dateLine));

  // A rule, then where the number comes from and the site name.
  out.push(`<rect x="${LEFT}" y="484" width="${INNER}" height="3" fill="${WHITE}" fill-opacity="0.35"/>`);
  const bottom = 552;
  const brandSize = 30;
  const brandW = width(measure, "DailyFuel", brandSize, 800);
  // The header's mark: a small green sign with a white inset line and the
  // pump. On the green card its own green melts in, so the line and the pump
  // carry it, drawn a touch heavier to hold up when the card is shown small.
  const markW = 40;
  const brandX = RIGHT - brandW - markW - 10;
  const markY = bottom - brandSize * 0.35 - markW / 2;
  out.push(`<g transform="translate(${n(brandX)} ${n(markY)}) scale(${markW / 32})">`
    + `<rect x="2.5" y="2.5" width="27" height="27" rx="4.5" fill="none" stroke="${WHITE}" stroke-width="2"/>`
    + `<path fill="${WHITE}" fill-rule="evenodd" d="${PUMP_32}"/></g>`);
  out.push(text(RIGHT, bottom, brandSize, 800, WHITE, "DailyFuel", "end"));
  let labelSize = 30;
  const labelRoom = brandX - 48 - LEFT;
  const labelW = width(measure, card.label, labelSize, 700);
  if (labelW > labelRoom) labelSize *= labelRoom / labelW;
  out.push(text(LEFT, bottom, labelSize, 700, WHITE, card.label));

  out.push("</svg>");
  return out.join("");
}

// Rendering

/** The Overpass files resvg draws with. resvg reads TTF, not the site's woff2. */
export const FONT_FILES = ["Overpass-ExtraBold.ttf", "Overpass-Bold.ttf"].map((f) =>
  resolve(process.cwd(), "src/assets/fonts", f),
);

type ResvgModule = typeof import("@resvg/resvg-js");
let resvg: ResvgModule | null = null;

async function load(): Promise<ResvgModule> {
  resvg ??= await import("@resvg/resvg-js");
  return resvg;
}

const OPTIONS = {
  font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: "Overpass" },
  logLevel: "error" as const,
};

/** Text measured by resvg itself with the same fonts, so the layout matches the pixels. */
export async function resvgMeasure(): Promise<Measure> {
  const { Resvg } = await load();
  const cache = new Map<string, Ink>();
  return (s, weight) => {
    const k = `${weight}|${s}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400"><text x="100" y="200" font-family="Overpass" font-weight="${weight}" font-size="100">${escapeXml(s)}</text></svg>`;
    const b = new Resvg(svg, OPTIONS).getBBox();
    const ink = b ? { left: b.x - 100, right: b.x - 100 + b.width } : { left: 0, right: 0 };
    cache.set(k, ink);
    return ink;
  };
}

let measurer: Promise<Measure> | null = null;

/**
 * The card as a PNG. A card is opaque and uses far fewer than 256 colors, so it
 * ships as an indexed PNG with the same pixels at about 40 percent of the size.
 * resvg's own full color PNG is the fallback.
 */
export async function renderCard(card: Card): Promise<Buffer> {
  const { Resvg } = await load();
  measurer ??= resvgMeasure();
  const svg = cardSvg(card, await measurer);
  const img = new Resvg(svg, { ...OPTIONS, fitTo: { mode: "original" } }).render();
  return palettePng(img.width, img.height, img.pixels) ?? img.asPng();
}

/** What the page head needs: an absolute image URL and its alt text. */
export function cardMeta(site: SiteData, pathname: string, origin: string): { url: string; alt: string } {
  const key = cardKeyFor(pathname, site);
  return {
    url: new URL(cardPath(key, cardDate(site)), origin).href,
    alt: cardAlt(cardFor(site, key)),
  };
}
