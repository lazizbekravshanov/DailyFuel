// Checks on the home page the build writes, where every part has come
// together: the paper terminal has no arrows or icons, every sparkline finds
// its line in the page's sprite, the numbers on the page are the numbers in
// the data, the your state strip and the quote table carry the hooks their
// scripts need, and the page stays inside its size budget. It builds the site
// from data/ into tmp/dist-test once (a few seconds), or reads an existing
// build when DAILYFUEL_BUILT_DIR names one.
//
// The road sign checks (arrow sprite, glyphs, map chips) went with that
// design: there are no arrows to check now, and the check is that none crept
// back. State pages are another page's tests; here only the home page, the
// about page and the 404 page are read.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { formatMove, formatPrice, formatQuote, signedCents } from "./format.ts";
import { pctOf } from "./copy.ts";
import { formatDate } from "./dates.ts";
import { getSite } from "./site.ts";

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
  about: "about/index.html",
  missing: "404.html",
} as const;

const html = (file: string) => readFileSync(resolve(dist, file), "utf8");
const doc = (file: string) => parseHTML(html(file)).document;
const gz = (s: string) => gzipSync(s, { level: 9 }).length;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const TYPED_ARROWS = /[▲▼●▴▾△▽◆⬆⬇↑↓→←]/;

describe("no arrows or icons anywhere", () => {
  for (const [name, file] of Object.entries(PAGES)) {
    it(`prints no arrow glyph in ${name}`, () => {
      const page = html(file);
      expect(page.length).toBeGreaterThan(1000);
      const hit = TYPED_ARROWS.exec(page);
      expect(hit ? page.slice(Math.max(0, hit.index - 80), hit.index + 20) : null).toBeNull();
    });

    it(`draws nothing but the chart and the sparklines in ${name}`, () => {
      const d = doc(file);
      for (const svg of Array.from(d.querySelectorAll("svg"))) {
        const cls = svg.getAttribute("class") ?? "";
        const inPlot = Boolean(svg.closest(".pa"));
        expect(inPlot || cls === "spk" || cls === "sprite", svg.outerHTML.slice(0, 80)).toBe(true);
      }
      expect(d.querySelector("img, .glyph, .arrow-sprite, .icon, [data-map], .us-map")).toBeNull();
    });

    it(`points every <use> at a line on ${name} itself`, () => {
      const d = doc(file);
      const ids = Array.from(d.querySelectorAll("[id]")).map((e) => e.getAttribute("id"));
      expect(new Set(ids).size).toBe(ids.length);
      for (const use of Array.from(d.querySelectorAll("use"))) {
        const ref = use.getAttribute("href") ?? "";
        expect(ref).toMatch(/^#spk-/);
        expect(ids, ref).toContain(ref.slice(1));
      }
    });

    it(`uses no dash as punctuation in ${name}`, () => {
      const d = doc(file);
      const words = text(d.querySelector("main")) + " " + text(d.querySelector("footer"));
      expect(words).not.toMatch(/[–—]/);
      expect(words).not.toMatch(/\s-\s/);
    });
  }
});

describe("the home page", () => {
  const site = getSite();
  const daily = site.national.cadence === "daily";
  const nm = site.national.move!;

  it("prints the U.S. number from the data, its change in the ink of its direction, and where it came from", () => {
    const d = doc(PAGES.home);
    const big = d.querySelector(".hero .big")!;
    expect(text(big.querySelector("span"))).toBe(formatPrice(nm.price));
    if (nm.change !== null) {
      const move = big.querySelector(".d")!;
      expect(text(move)).toBe(formatMove(nm.change, pctOf(nm)));
      expect(move.getAttribute("class")).toMatch(/^d (up|down|muted)$/);
      expect(text(d.querySelector(".hero .note"))).toMatch(/^(Up|Down|Unchanged) from \$\d\.\d{3} (the week of|yesterday)/);
    }
    expect(text(d.querySelector("h1"))).toMatch(daily ? /^U\.S\. diesel average · as of/ : /^U\.S\. diesel average · week of/);
    // the records phrase, whenever the page claims a record
    const note = text(d.querySelector(".hero .note"));
    if (/records/.test(note)) expect(note).toContain("in our records, which start June 2022");
  });

  it("says when the next numbers land, with the date the late notice needs", () => {
    const d = doc(PAGES.home);
    const next = d.querySelector(".hero [data-next-release]")!;
    expect(next.getAttribute("data-next-release")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(next.getAttribute("data-late")).toMatch(/late/);
    expect(text(next)).toMatch(/^(EIA posts next week's prices on|EIA's next weekly numbers land) (Mon|Tue|Wed|Thu|Fri), [A-Z][a-z]{2} \d{1,2}\.$|late/);
  });

  it("draws the U.S. line since our records start, one value a week, with a readout", () => {
    const d = doc(PAGES.home);
    const plot = d.querySelector(".plot[data-v]")!;
    expect(plot.getAttribute("tabindex")).toBe("0");
    expect(plot.getAttribute("aria-label")).toMatch(/arrow keys/);
    expect(plot.getAttribute("data-start")).toBe(site.weekly!.weeks[0].period);
    const values = plot.getAttribute("data-v")!.split(",");
    expect(values.length).toBeGreaterThan(200);
    expect(values[values.length - 1]).toBe(formatQuote(site.eiaUs!.price));
    expect(text(d.querySelector(".rdout .rd-v"))).toBe(formatPrice(site.eiaUs!.price));
    expect(text(d.querySelector(".ytag"))).toBe(formatQuote(site.eiaUs!.price));
    expect(d.querySelectorAll(".xl").length).toBeGreaterThan(2);
  });

  it("keeps the your state strip and the list ready for the script, with the same 51 states", () => {
    const d = doc(PAGES.home);
    const slot = d.querySelector("[data-ys]")!;
    expect(slot.querySelector("[data-ys-saved]")!.hasAttribute("hidden")).toBe(true);
    expect(slot.querySelector("[data-ys-none]")!.hasAttribute("hidden")).toBe(false);
    for (const hook of ["code", "name", "price", "move", "plate", "open", "change", "forget"]) expect(slot.querySelector(`[data-ys-${hook}]`), hook).not.toBeNull();
    const list = slot.querySelector("details[data-ys-find] #find-your-state[data-ys-list]")!;
    const links = Array.from(list.querySelectorAll("a[data-ys-pick]"));
    expect(links).toHaveLength(51);
    expect(links.map((a) => a.getAttribute("data-ys-pick"))).toEqual([...site.states].sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.code));
    for (const a of links) {
      const s = site.byCode.get(a.getAttribute("data-ys-pick")!)!;
      expect(a.getAttribute("href")).toBe(s.href);
      expect(a.getAttribute("data-px")).toBe(s.primary ? formatPrice(s.primary.price) : daily ? "No price yet" : "No weekly price");
    }
    // the script comes right after the list, and nothing else sits between
    const page = html(PAGES.home);
    const listAt = page.indexOf('id="find-your-state"');
    const scriptAt = page.indexOf("[data-ys-find]", listAt);
    expect(scriptAt).toBeGreaterThan(listAt);
    expect(page.slice(page.indexOf("</details>", listAt), scriptAt)).toMatch(/^<\/details><script>/);
  });

  it("lists the U.S. and 8 regions on the board, with who each price covers", () => {
    const d = doc(PAGES.home);
    const rows = Array.from(d.querySelectorAll(".board tbody tr"));
    expect(rows).toHaveLength(9);
    expect(rows[0].getAttribute("class")).toBe("us");
    expect(text(rows[0].querySelector("th"))).toBe("U.S.");
    expect(text(rows[0].querySelector("td:last-child"))).toBe("48 states and DC");
    const midwest = rows.find((r) => text(r.querySelector("th")) === "Midwest")!;
    expect(text(midwest.querySelector("td:last-child"))).toBe("15 states");
    const r20 = site.regions.find((r) => r.key === "R20")!;
    expect(text(midwest.querySelector("td"))).toBe(formatQuote(r20.move!.price));
    expect(text(d.querySelector(".board .notes"))).toMatch(/One price, many states\..*Next print\./);
    expect(text(d.querySelector(".board .notes"))).toContain("Alaska and Hawaii are not in the EIA survey");
  });

  it("quotes every state in name order, with the pinned code linking to its page", () => {
    const d = doc(PAGES.home);
    const rows = Array.from(d.querySelectorAll("#quotes tbody tr"));
    expect(rows).toHaveLength(51);
    expect(rows.map((r) => r.getAttribute("data-s"))).toEqual([...site.states].sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.code));
    for (const r of rows) {
      const s = site.byCode.get(r.getAttribute("data-s")!)!;
      const a = r.querySelector("th[scope=row] a")!;
      expect(a.getAttribute("href")).toBe(s.href);
      expect(r.getAttribute("data-h")).toBe(s.href);
      expect(text(a)).toBe(s.code);
      const chg = r.querySelector(".c-chg");
      if (s.primary && s.primary.change !== null) {
        expect(text(chg)).toBe(signedCents(s.primary.change));
        expect(chg!.getAttribute("class")).toMatch(/^num c-chg (up|down|muted)$/);
        // the sign carries the direction, and the ink agrees with it
        const cls = chg!.getAttribute("class")!;
        if (text(chg).startsWith("+")) expect(cls).not.toContain("down");
        if (text(chg).startsWith("−")) expect(cls).not.toContain("up");
      }
    }
    expect(d.querySelector('#quotes thead th[aria-sort="ascending"]')!.getAttribute("data-k")).toBe("n");
    expect(d.querySelector("#find")).not.toBeNull();
    expect(text(d.querySelector("#count"))).toBe("51 states");
  });

  it("says why Alaska and Hawaii have no weekly price, and why some taxes are n/a", () => {
    const d = doc(PAGES.home);
    for (const code of ["AK", "HI"]) {
      const r = d.querySelector(`#quotes tr[data-s="${code}"]`)!;
      expect(text(r)).toContain(daily ? "No EIA survey" : "No EIA survey");
      expect(r.querySelector("use")).toBeNull();
    }
    if (site.tax) {
      const cap = text(d.querySelector("#quotes-cap"));
      const stale = site.states.filter((s) => s.tax?.outOfDate).map((s) => s.code);
      const none = site.states.filter((s) => s.tax && s.tax.state === null).map((s) => s.code);
      for (const code of [...stale, ...none]) {
        const cells = Array.from(d.querySelectorAll(`#quotes tr[data-s="${code}"] td`)).map(text);
        expect(cells, code).toContain("n/a");
        expect(cap).toContain(code);
      }
      if (stale.length) expect(cap).toContain("out of date");
      if (none.length) expect(cap).toContain("missing");
    }
  });

  it("draws every sparkline from the sprite, one line per series", () => {
    const d = doc(PAGES.home);
    const lines = Array.from(d.querySelectorAll("svg.sprite g[id]")).map((g) => g.getAttribute("id"));
    expect(lines.sort()).toEqual(["NUS", ...site.regions.map((r) => r.key)].map((k) => `spk-${k}`).sort());
    const sparks = Array.from(d.querySelectorAll("svg.spk"));
    expect(sparks.length).toBe(9 + site.states.filter((s) => s.eia_series).length);
    for (const s of sparks) {
      expect(s.getAttribute("role")).toBe("img");
      expect(s.getAttribute("aria-label")).toMatch(/, 52 weeks, (highest in the newest week|now \$\d\.\d{3})$/);
    }
  });

  it("carries its title, description, share sentence, canonical link and site JSON-LD", () => {
    const d = doc(PAGES.home);
    expect(text(d.querySelector("title"))).toMatch(/^DailyFuel: U\.S\. diesel \$\d\.\d{3} a gallon/);
    const meta = d.querySelector('meta[name="description"]')!.getAttribute("content")!;
    expect(meta).toMatch(/U\.S\. diesel is \$\d\.\d{3} a gallon/);
    expect(meta).toMatch(/\b(up|down) \d+\.\d¢|unchanged/);
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute("href")).toBe("https://dailydiesel.vercel.app/");
    expect(d.querySelector('script[type="application/ld+json"]')).not.toBeNull();
    expect(d.querySelector('meta[property="og:image"]')!.getAttribute("content")).toMatch(/\/og\/us-\d{4}-\d{2}-\d{2}-[a-z]\.png$/);
    expect(d.querySelector("[data-share] button")!.getAttribute("data-text")).toMatch(/^U\.S\. diesel is \$\d\.\d{3} a gallon/);
  });

  it("loads nothing from anywhere else, and no analytics outside Vercel production", () => {
    const page = html(PAGES.home);
    expect(page).not.toContain("_vercel/insights");
    // what the browser fetches: scripts, sheets, preloads and images (a
    // canonical link and the footer's links are addresses, not requests)
    for (const m of page.matchAll(/<(?:script|img)[^>]*\ssrc="([^"]+)"|<link[^>]*rel="(?:stylesheet|preload|modulepreload|icon)"[^>]*\shref="([^"]+)"/g)) {
      expect(m[1] ?? m[2], m[0]).not.toMatch(/^(https?:)?\/\//);
    }
    expect(page).not.toMatch(/@import|url\((https?:)?\/\//);
  });

  it("stays inside its budget: under 20 KB gzipped, under 3 KB of inline JS", () => {
    const page = html(PAGES.home);
    expect(gz(page)).toBeLessThan(20 * 1024);
    const scripts = [...page.matchAll(/<script(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(3);
    expect(gz(scripts.join("\n"))).toBeLessThan(3 * 1024);
  });
});

describe("the 404 page", () => {
  it("shows the same Find your state list, open, saving a pick for the home page", () => {
    const d = doc(PAGES.missing);
    const find = d.querySelector("details[data-ys-find]")!;
    expect(find.hasAttribute("open")).toBe(true);
    expect(find.querySelectorAll("a[data-ys-pick]")).toHaveLength(51);
    // the strip's lines are the home page's; here the list is just links
    expect(find.querySelector("[data-px]")).toBeNull();
    expect(html(PAGES.missing)).toContain("[data-ys-list]");
  });
});
