// Share cards: one 1200x630 PNG per page, drawn at build time as an SVG in
// the paper terminal look and turned into a PNG by resvg. Nothing here
// reaches the browser.
//
// A price in a picture goes stale, and chat apps cache previews by URL for a
// long time. So every card prints its week and where the number comes from,
// and the file name carries the date (/og/oh-2026-09-14-b.png). A new week is
// a new URL, so a fresh share never shows last week's price. The letter after
// the date is the card's drawing, so a redrawn card gets a new URL too.

import { resolve } from "node:path";
import type { Direction } from "./bins.ts";
import { pctOf } from "./copy.ts";
import { formatDate, when } from "./dates.ts";
import { changeClass, formatMove, formatPrice, spokenChange } from "./format.ts";
import { palettePng } from "./png.ts";
import { SITE_URL } from "./url.ts";
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
  /** Two letter code in a box before the name, none on the U.S. card. */
  shield: string | null;
  /** What the head row prints: "Ohio", "U.S. diesel average". */
  head: string;
  /** "Ohio diesel average", for the alt text. */
  legend: string;
  /** The header's subtitle: "U.S. on-highway diesel · EIA weekly". */
  kicker: string;
  /** "$6.250" */
  price: string | null;
  /** Shown in place of a price when there is none. */
  noPrice: string;
  direction: Direction | null;
  /** "+30.4¢ +5.1%" */
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

/**
 * The card's drawing. Chat apps cache a preview by its URL, so change this
 * letter whenever the card looks different ("a" was the green road sign, "b"
 * is the paper terminal), and links shared the same week pick up the new card.
 */
export const CARD_DESIGN = "b";

/** The card's file name without ".png": "oh-2026-09-14-b". */
export function cardName(key: string, date: string): string {
  return `${key}-${date}-${CARD_DESIGN}`;
}

/** "/og/oh-2026-09-14-b.png" */
export function cardPath(key: string, date: string): string {
  return `/og/${cardName(key, date)}.png`;
}

/** Which card a page shares: its own state, or the U.S. card for everything else. */
export function cardKeyFor(pathname: string, site: SiteData): string {
  const m = /^\/state\/([a-z]{2})\/?$/.exec(pathname);
  if (m && site.byCode.has(m[1].toUpperCase())) return m[1];
  return US_KEY;
}

/**
 * "EIA Midwest average, 15 states", "EIA Central Atlantic average, 5 states
 * and DC": the same words as the plate under a state's price.
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

function moveParts(move: Move | null) {
  if (!move || move.change === null) return { direction: null, change: null, spoken: null };
  const cls = changeClass(move.change);
  return {
    direction: (cls || "flat") as Direction,
    change: formatMove(move.change, pctOf(move)),
    spoken: spokenChange(move.change),
  };
}

function kickerFor(site: SiteData): string {
  return site.mode === "aaa+eia" ? "U.S. on-highway diesel · AAA daily, EIA weekly" : "U.S. on-highway diesel · EIA weekly";
}

/** What a card says. Pure, so the page head can build the alt text without drawing. */
export function cardFor(site: SiteData, key: string): Card {
  const aaaMode = site.mode === "aaa+eia";
  const kicker = kickerFor(site);
  if (key === US_KEY) {
    const daily = site.national.cadence === "daily";
    const move = site.national.move;
    const t = timing(site, daily);
    const parts = moveParts(move);
    // AAA's national change is its own today minus yesterday, even after a
    // missed day, so it's always "since yesterday".
    const compareLine = daily ? "Since yesterday" : t.compareLine;
    return {
      key,
      shield: null,
      head: "U.S. diesel average",
      legend: "U.S. diesel average",
      kicker,
      price: move ? formatPrice(move.price) : null,
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
  const parts = moveParts(move);
  // A state EIA doesn't survey has no reading for any week, so the card says
  // what its page says instead of printing a survey week.
  const unsurveyed = !aaaMode && !move && s.eia_series === null;
  return {
    key,
    shield: s.code,
    head: s.name,
    legend: move ? `${s.name} diesel average` : `Diesel in ${s.name}`,
    kicker,
    price: move ? formatPrice(move.price) : null,
    noPrice: aaaMode ? "No price today" : "No EIA price",
    ...parts,
    dateLine: unsurveyed ? "Not in EIA's weekly survey" : t.dateLine,
    compareLine: parts.change ? t.compareLine : null,
    label: aaaMode ? "AAA daily average, data by OPIS" : regionLabel(s, site),
  };
}

/** The picture in words, for og:image:alt. */
export function cardAlt(card: Card): string {
  if (!card.price) return `${card.legend}: ${card.noPrice.charAt(0).toLowerCase()}${card.noPrice.slice(1)}. ${card.label}.`;
  const since = card.compareLine ? ` ${card.compareLine.charAt(0).toLowerCase()}${card.compareLine.slice(1)}` : "";
  const moved = card.spoken ? `, ${card.spoken}${since}` : "";
  return `${card.legend}: ${card.price} a gallon${moved}. ${card.dateLine}. ${card.label}.`;
}

// Drawing

/** Ink extent of `text` set at 100px: where the ink starts and ends, from the pen position. */
export interface Ink {
  left: number;
  right: number;
}

export type Measure = (text: string, weight: 400 | 700) => Ink;

/** The card is always the light page: white paper, near black ink. */
export const CARD_INK = {
  bg: "#ffffff",
  ink: "#111111",
  ink2: "#595959",
  hair: "#d6d6d6",
  up: "#b3151b",
  down: "#0f4fbf",
} as const;

/** The colour a change wears: red rose, blue fell, gray for exactly 0.0¢. */
const MOVE: Record<Direction, string> = { up: CARD_INK.up, down: CARD_INK.down, flat: CARD_INK.ink2 };

/** The one face on the card. Red Hat Mono stands in for the device's monospace font the page uses. */
export const CARD_FONT = "Red Hat Mono";

const LEFT = 72;
const RIGHT = CARD_WIDTH - 72;
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

interface TextOpts {
  anchor?: "middle" | "end";
  /** Letter spacing as a share of the size: 0.14 for the wordmark. */
  tracking?: number;
}

function text(x: number, y: number, size: number, weight: 400 | 700, fill: string, s: string, opts: TextOpts = {}): string {
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : "";
  const tracking = opts.tracking ? ` letter-spacing="${n(size * opts.tracking)}"` : "";
  return `<text x="${n(x)}" y="${n(y)}" font-family="${CARD_FONT}" font-weight="${weight}" font-size="${n(size)}" fill="${fill}"${anchor}${tracking}>${escapeXml(s)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
}

/** Width of `s` at `size`, from the pen position to the end of the ink, plus any tracking. */
function width(measure: Measure, s: string, size: number, weight: 400 | 700, tracking = 0): number {
  return (measure(s, weight).right * size) / 100 + Math.max(0, s.length - 1) * size * tracking;
}

/** The card as SVG. `measure` sets text widths, so long names shrink to fit and the change sits after the price. */
export function cardSvg(card: Card, measure: Measure): string {
  const { bg, ink, ink2, hair } = CARD_INK;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`);
  out.push(rect(0, 0, CARD_WIDTH, CARD_HEIGHT, bg));

  // The header: the wordmark, the subtitle, and the double rule under them.
  out.push(text(LEFT, 76, 30, 700, ink, "DAILYFUEL", { tracking: 0.14 }));
  out.push(text(RIGHT, 76, 22, 400, ink2, card.kicker, { anchor: "end" }));
  out.push(rect(LEFT, 98, INNER, 2, ink));
  out.push(rect(LEFT, 104, INNER, 2, ink));

  // The head row: the boxed code and the name in caps, shrunk to fit a long one.
  const headY = 196;
  const tracking = 0.04;
  let headSize = 40;
  const boxPad = 14;
  const boxW = (size: number) => (card.shield ? width(measure, card.shield, size * 0.8, 700) + boxPad * 2 : 0);
  const headW = (size: number) => boxW(size) + (card.shield ? 20 : 0) + width(measure, card.head.toUpperCase(), size, 700, tracking);
  // the box padding and the gap don't scale, so solve for the size that fits exactly
  const fixed = card.shield ? boxPad * 2 + 20 : 0;
  if (headW(headSize) > INNER) headSize = ((INNER - fixed) * headSize) / (headW(headSize) - fixed);
  if (card.shield) {
    const w = boxW(headSize);
    const h = headSize * 1.3;
    out.push(`<rect x="${n(LEFT + 1)}" y="${n(headY - headSize * 0.95)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="${ink}" stroke-width="2"/>`);
    out.push(text(LEFT + 1 + w / 2, headY - headSize * 0.06, headSize * 0.8, 700, ink, card.shield, { anchor: "middle" }));
  }
  out.push(text(LEFT + boxW(headSize) + (card.shield ? 20 : 0), headY, headSize, 700, ink, card.head.toUpperCase(), { tracking }));

  // The price row: the price, and the change after it on the same baseline.
  const base = 392;
  if (card.price) {
    let P = 168;
    let C = 56;
    const gap = 40;
    const need = width(measure, card.price, P, 700) + (card.change ? gap + width(measure, card.change, C, 700) : 0);
    if (need > INNER) {
      const k = INNER / need;
      P *= k;
      C *= k;
    }
    out.push(text(LEFT, base, P, 700, ink, card.price));
    if (card.change && card.direction) {
      out.push(text(LEFT + width(measure, card.price, P, 700) + gap, base, C, 700, MOVE[card.direction], card.change));
    }
  } else {
    let size = 96;
    const w = width(measure, card.noPrice, size, 700);
    if (w > INNER) size *= INNER / w;
    out.push(text(LEFT, base - 24, size, 700, ink, card.noPrice));
  }
  // The week, and what the change is measured against.
  const dateLine = card.compareLine ? `${card.dateLine} · ${card.compareLine.charAt(0).toLowerCase()}${card.compareLine.slice(1)}` : card.dateLine;
  out.push(text(LEFT, 450, 26, 400, ink2, dateLine));

  // A hairline, then where the number comes from and where to read more.
  out.push(rect(LEFT, 498, INNER, 2, hair));
  const bottom = 556;
  const host = new URL(SITE_URL).host;
  const hostSize = 24;
  const hostW = width(measure, host, hostSize, 400);
  out.push(text(RIGHT, bottom, hostSize, 400, ink2, host, { anchor: "end" }));
  let labelSize = 26;
  const labelRoom = INNER - hostW - 40;
  const labelW = width(measure, card.label, labelSize, 400);
  if (labelW > labelRoom) labelSize *= labelRoom / labelW;
  out.push(text(LEFT, bottom, labelSize, 400, ink2, card.label));

  out.push("</svg>");
  return out.join("");
}

// Rendering

/** The Red Hat Mono files resvg draws with. Build time only: the pages use the device's own monospace font. */
export const FONT_FILES = ["RedHatMono-Regular.ttf", "RedHatMono-Bold.ttf"].map((f) =>
  resolve(process.cwd(), "src/assets/fonts", f),
);

type ResvgModule = typeof import("@resvg/resvg-js");
let resvg: ResvgModule | null = null;

async function load(): Promise<ResvgModule> {
  resvg ??= await import("@resvg/resvg-js");
  return resvg;
}

const OPTIONS = {
  font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: CARD_FONT },
  logLevel: "error" as const,
};

/** Text measured by resvg itself with the same font, so the layout matches the pixels. */
export async function resvgMeasure(): Promise<Measure> {
  const { Resvg } = await load();
  const cache = new Map<string, Ink>();
  return (s, weight) => {
    const k = `${weight}|${s}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="400"><text x="100" y="200" font-family="${CARD_FONT}" font-weight="${weight}" font-size="100">${escapeXml(s)}</text></svg>`;
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
