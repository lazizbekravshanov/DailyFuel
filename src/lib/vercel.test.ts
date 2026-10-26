// What vercel.json tells Vercel to do with the files the build writes. JSON
// has no comments, so the reasons live here.
//
// Caching. Vercel serves every static file with "max-age=0, must-revalidate"
// unless told otherwise, so a browser asks again for every file on every
// visit, and every ask is an edge request. The Hobby plan pauses the site at
// 1M of those a month. A file may be kept longer only when keeping it can't
// show a visitor something out of step with the page:
//   * a year, immutable: files that never change at their URL. That is
//     Leaflet, pinned below to the exact bytes of the 1.9.4 files. Changing
//     them means a new folder (say /vendor/leaflet-1.9.5/) and new links in
//     src/pages/map.astro, never new bytes at the old URL.
//   * a day: the favicon, the home screen icons and the manifest. A new icon
//     showing up a day late does no harm.
//   * nothing (Vercel's max-age=0): every page, sw.js, and the map's
//     /map/trip.js and /map/*.json, which must stay in step with the page
//     that loads them, since a new build can change both. The share card PNGs
//     too: link preview bots fetch them, not visitors, so caching them saves
//     no visitor a request, and an old dated name serves a newer card.
//
// Share cards. A card's dated name (/og/oh-2026-10-19-c.png) lasts one week:
// the next build writes the new week's name instead. Each card is also built
// as /og/oh.png, and a dated name that is no longer there is rewritten to it,
// so an old post keeps a picture. Vercel serves a file that exists before it
// looks at rewrites, so this week's dated names are served as they are.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getStaticPaths } from "../pages/og/[card].png.ts";
import { cardDate, cardKeys, cardName, CARD_DESIGN, DOE_KEY } from "./og.ts";
import { getSite } from "./site.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface Rule {
  source: string;
  destination?: string;
  headers?: { key: string; value: string }[];
}
const config = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8")) as { headers: Rule[]; rewrites: Rule[] };

/**
 * A rule's source as a RegExp, the way Vercel's path-to-regexp reads the
 * part of its syntax this file uses: literal text, and ":name(pattern)".
 * Like Vercel, it ignores case and a trailing slash.
 */
function sourceRe(source: string): RegExp {
  // anything else (":name" without a pattern, "*", "?", groups outside a param) would need the real parser
  expect(source, source).toMatch(/^(?:[\w./-]|:\w+\((?:[^()]|\([^()]*\))+\))+$/);
  let re = "";
  for (const m of source.matchAll(/:(\w+)\(((?:[^()]|\([^()]*\))+)\)|([^:]+?)(?=:\w+\(|$)/g)) {
    re += m[1] ? `(?<${m[1]}>${m[2]})` : m[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}/?$`, "i");
}

/** Where a request for `path` ends up after the rewrites, or null when none applies. */
function rewrite(path: string): string | null {
  for (const r of config.rewrites) {
    const m = sourceRe(r.source).exec(path);
    if (m) return r.destination!.replace(/:(\w+)/g, (_, k: string) => m.groups![k]);
  }
  return null;
}

/** The Cache-Control vercel.json sets for `path`, or null for Vercel's own max-age=0. */
function cacheFor(path: string): string | null {
  const hits = config.headers.filter((r) => sourceRe(r.source).test(path)).flatMap((r) => r.headers!.filter((h) => h.key.toLowerCase() === "cache-control"));
  // one rule a path, so no rule's order decides it
  expect(hits.length, path).toBeLessThanOrEqual(1);
  return hits[0]?.value ?? null;
}

const maxAge = (value: string | null) => (value === null ? 0 : Number(/max-age=(\d+)/.exec(value)?.[1] ?? 0));

/** Every file under public/, as the URL it is served at. */
function publicFiles(dir = resolve(ROOT, "public"), base = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? publicFiles(join(dir, e.name), `${base}/${e.name}`) : [`${base}/${e.name}`],
  );
}

const site = getSite();
const date = cardDate(site);
const cards = (getStaticPaths() as { params: { card: string }; props: { key: string } }[]).map((p) => ({ name: p.params.card, key: p.props.key }));

// The Leaflet files as the 1.9.4 package has them (the CSS without its image
// rules), served for a year. New bytes need a new folder; see the top.
const LEAFLET: Record<string, string> = {
  "/vendor/leaflet/leaflet.js": "db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a",
  "/vendor/leaflet/leaflet.css": "e0ff973d3bd41cb38ae83d52b7ac13547ec95d3087bc2f44c4b33facd9492f6a",
  "/vendor/leaflet/LICENSE": "53e8dc25862014e4324741ca18fbe3611e11d42ef69f59f86ea8c5389647d4cb",
};

describe("caching in vercel.json", () => {
  const YEAR = 31536000;
  const DAY = 86400;
  const files = publicFiles();

  it("keeps Leaflet a year, and only while its files are the exact bytes pinned here", () => {
    const vendor = files.filter((f) => f.startsWith("/vendor/"));
    expect(vendor.sort()).toEqual(Object.keys(LEAFLET).sort());
    for (const [path, sha] of Object.entries(LEAFLET)) {
      expect(cacheFor(path)).toBe(`public, max-age=${YEAR}, immutable`);
      const bytes = readFileSync(resolve(ROOT, "public", path.slice(1)));
      expect(createHash("sha256").update(bytes).digest("hex"), `${path} changed: serve it from a new folder, not the cached one`).toBe(sha);
    }
    expect(JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).devDependencies.leaflet).toBe("1.9.4");
  });

  it("keeps the favicon, the home screen icons and the manifest a day", () => {
    const icons = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/site.webmanifest"];
    for (const path of icons) {
      expect(files, path).toContain(path);
      expect(cacheFor(path), path).toBe(`public, max-age=${DAY}`);
    }
    // nothing else in public/ is kept at all but Leaflet
    for (const path of files.filter((f) => !icons.includes(f) && !(f in LEAFLET))) expect(maxAge(cacheFor(path)), path).toBe(0);
  });

  it("never keeps a page, the offline copy's worker, the map's own files or a share card", () => {
    const paths = [
      "/", "/index.html", "/about/", "/surcharge/", "/map/", "/state/oh/", "/state/oh/index.html", "/404.html",
      "/sw.js", "/map/trip.js", "/map/places.json", "/map/roads.json", "/map/states.json",
      "/robots.txt", "/sitemap-index.xml", "/sitemap-0.xml",
      `/og/${cardName("us", date)}.png`, "/og/us.png", "/og/oh.png", "/og/oh-2020-01-06-a.png",
      // a file named like a vendored one anywhere else
      "/leaflet.js", "/map/leaflet.js", "/vendor/leaflet-x/leaflet.js",
    ];
    for (const path of paths) expect(maxAge(cacheFor(path)), path).toBe(0);
    expect(cacheFor("/sw.js")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("share cards that outlive their week", () => {
  it("builds every card under its dated name and under a name that never changes", () => {
    const names = cards.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const key of cardKeys(site)) {
      expect(cards, key).toContainEqual({ name: cardName(key, date), key });
      expect(cards, key).toContainEqual({ name: key, key });
    }
    // the surcharge page's DOE card has a stable name whatever the mode: with EIA's prices alone it is the U.S. card
    expect(cards.find((c) => c.name === DOE_KEY)?.key).toBe(cardKeys(site).includes(DOE_KEY) ? DOE_KEY : "us");
  });

  it("sends a dated name a later build removed to the card's stable name", () => {
    for (const key of [...cardKeys(site), DOE_KEY]) {
      for (const old of [`${key}-2026-09-14-b`, `${key}-2025-01-06-a`, `${key}-2030-12-30-z`]) {
        const to = rewrite(`/og/${old}.png`);
        expect(to, old).toBe(`/og/${key}.png`);
        expect(cards.map((c) => c.name), old).toContain(key);
      }
    }
    // this week's own name is a real file, which Vercel serves before any rewrite
    expect(cards.map((c) => c.name)).toContain(cardName("us", date));
    expect(cardName("us", date)).toMatch(new RegExp(`-${CARD_DESIGN}$`));
  });

  it("rewrites nothing else", () => {
    for (const path of ["/og/us.png", "/og/oh.png", "/og/", "/og/ohio-2026-09-14-b.png", "/og/oh-2026-9-14-b.png", "/og/oh-2026-09-14-bb.png", "/og/oh-2026-09-14-b.jpg", "/state/oh/", "/", "/map/trip.js"]) {
      expect(rewrite(path), path).toBeNull();
    }
  });
});
