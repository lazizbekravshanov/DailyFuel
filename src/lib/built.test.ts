// Checks on the pages the build writes, where every part has come together:
// no typed ▲ ▼ ● anywhere, every arrow is a road sign icon, every <use> finds
// its symbol on the same page, and the words around a change still say which
// way it went without the arrow. It builds the site from data/ into
// tmp/dist-test once (a few seconds), or reads an existing build when
// DAILYFUEL_BUILT_DIR names one.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { DIRECTIONS, arrowId, arrowPath } from "./arrows.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let dist = process.env.DAILYFUEL_BUILT_DIR ? resolve(ROOT, process.env.DAILYFUEL_BUILT_DIR) : "";

beforeAll(() => {
  if (dist) return;
  dist = resolve(ROOT, "tmp/dist-test");
  rmSync(dist, { recursive: true, force: true });
  // a plain production build, without the test runner's environment
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV" && k !== "TEST"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/astro/bin/astro.mjs"), "build", "--outDir", dist, "--silent"], {
    cwd: ROOT,
    env,
    stdio: "pipe",
  });
}, 180_000);

const PAGES = {
  home: "index.html",
  ohio: "state/oh/index.html",
  alaska: "state/ak/index.html",
  about: "about/index.html",
  missing: "404.html",
} as const;

const html = (file: string) => readFileSync(resolve(dist, file), "utf8");
const doc = (file: string) => parseHTML(html(file)).document;

/** Page text as it copies: screen reader only words taken out. */
function copiedText(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const sr of Array.from(c.querySelectorAll(".sr-only"))) sr.remove();
  return (c.textContent ?? "").replace(/\s+/g, " ").trim();
}

const TYPED_ARROWS = /[▲▼●▴▾△▽◆⬆⬇↑↓]/;

describe("built pages", () => {
  for (const [name, file] of Object.entries(PAGES)) {
    it(`has no typed direction glyph anywhere in ${name}`, () => {
      const page = html(file);
      expect(page.length).toBeGreaterThan(1000);
      const hit = TYPED_ARROWS.exec(page);
      expect(hit ? page.slice(Math.max(0, hit.index - 80), hit.index + 20) : null).toBeNull();
    });

    it(`points every <use> at a symbol on ${name} itself`, () => {
      const d = doc(file);
      const ids = Array.from(d.querySelectorAll("[id]")).map((e) => e.getAttribute("id"));
      expect(new Set(ids).size).toBe(ids.length);
      for (const use of Array.from(d.querySelectorAll("use"))) {
        const ref = use.getAttribute("href") ?? "";
        expect(ref).toMatch(/^#/);
        expect(ids, ref).toContain(ref.slice(1));
      }
    });
  }

  it("puts the arrow sprite once on each page that points at it, and nowhere else", () => {
    for (const [name, file] of Object.entries(PAGES)) {
      const d = doc(file);
      // a <use>, or a chart or map whose script builds one
      const needs = Boolean(d.querySelector("use, [data-chart], [data-map]"));
      if (name === "home" || name === "ohio") expect(needs, name).toBe(true);
      if (name === "about" || name === "missing") expect(needs, name).toBe(false);
      const sprites = d.querySelectorAll("svg.arrow-sprite");
      expect(sprites.length, name).toBe(needs ? 1 : 0);
      if (!sprites.length) continue;
      for (const dir of DIRECTIONS) {
        const symbol = d.getElementById(arrowId(dir))!;
        expect(symbol.tagName.toLowerCase()).toBe("symbol");
        expect(symbol.getAttribute("viewBox")).toBe("0 0 24 24");
        expect(symbol.querySelector("path")!.getAttribute("d")).toBe(arrowPath(dir));
      }
    }
  });

  it("gives the scripts that build tooltips a sprite to point at", () => {
    for (const file of [PAGES.home, PAGES.ohio]) {
      const page = html(file);
      // the minified map and chart scripts carry the id as a string
      expect(page).toContain('<use href="#arrow-');
      expect(page).toContain('class="arrow-sprite"');
    }
  });

  it("draws every arrow on the page as the road sign icon for its direction", () => {
    for (const file of [PAGES.home, PAGES.ohio]) {
      const d = doc(file);
      const glyphs = Array.from(d.querySelectorAll("svg.glyph"));
      expect(glyphs.length).toBeGreaterThan(3);
      for (const g of glyphs) {
        const dir = /glyph-(up|down|flat)/.exec(g.getAttribute("class") ?? "")?.[1] as (typeof DIRECTIONS)[number];
        expect(dir).toBeDefined();
        expect(g.getAttribute("aria-hidden")).toBe("true");
        const use = g.querySelector("use");
        if (use) expect(use.getAttribute("href")).toBe(`#${arrowId(dir)}`);
        else {
          expect(g.getAttribute("viewBox")).toBe("0 0 24 24");
          expect(g.querySelector("path")!.getAttribute("d")).toBe(arrowPath(dir));
        }
      }
    }
  });

  it("draws the map chips' arrows from the same icons, with no dots or triangles left", () => {
    const d = doc(PAGES.home);
    const chips = Array.from(d.querySelectorAll(".us-map .callout"));
    expect(chips.length).toBeGreaterThan(5);
    for (const chip of chips) {
      expect(chip.querySelector("circle")).toBeNull();
      const dir = chip.getAttribute("data-dir");
      const arrow = chip.querySelector("path.arrow");
      if (!dir) expect(arrow).toBeNull();
      else expect(arrow!.getAttribute("d")).toBe(arrowPath(dir as (typeof DIRECTIONS)[number]));
    }
  });

  it("says the direction in words wherever there is no arrow to see", () => {
    for (const file of [PAGES.home, PAGES.ohio]) {
      const d = doc(file);
      const meta = d.querySelector('meta[name="description"]')!.getAttribute("content")!;
      expect(meta).toMatch(/\b(up|down) \d+\.\d¢|unchanged/);
      for (const el of Array.from(d.querySelectorAll("[aria-label], [title], title, [alt], meta[content]"))) {
        const text = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("alt"), el.getAttribute("content"), el.tagName === "TITLE" ? el.textContent : ""].join(" ");
        expect(text).not.toMatch(TYPED_ARROWS);
      }
      // every change a screen reader hears says up, down or no change
      for (const g of Array.from(d.querySelectorAll(".change svg.glyph, td.chg svg.glyph"))) {
        const said = g.parentElement!.querySelector(".sr-only")!.textContent!;
        expect(said).toMatch(/^(about the same, )?(up \d+\.\d cents|down \d+\.\d cents|no change)/);
      }
    }
  });

  it("keeps the direction in copied text next to every arrow", () => {
    for (const file of [PAGES.home, PAGES.ohio]) {
      const d = doc(file);
      const spots = Array.from(d.querySelectorAll(".change")).filter((c) => c.querySelector("svg.glyph"));
      expect(spots.length).toBeGreaterThan(2);
      for (const c of spots) {
        // the arrow never copies, so the change's cell or line has to carry a
        // sign: "+30.4¢", "31.8¢ (+5.3%)", or a move of exactly 0.0¢
        const around = copiedText(c.closest("td, li, p, dd") ?? c);
        expect(around, around).toMatch(/[+−]\d|(^|\s)0\.0¢/);
        // and nothing hangs where the arrow was
        expect(copiedText(c)).toMatch(/^[+−]?\d/);
      }
      for (const cell of Array.from(d.querySelectorAll("td.chg")).filter((c) => c.querySelector("svg.glyph"))) {
        expect(copiedText(cell)).toMatch(/^([+−]\d+\.\d|0\.0)¢$/);
      }
    }
  });
});
