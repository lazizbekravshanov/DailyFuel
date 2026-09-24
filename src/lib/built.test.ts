// Checks on the pages the build writes, where every part has come together.
// The paper terminal has no icons and no arrows: a change carries its sign
// and its colour repeats it. So: no typed direction glyph anywhere, no glyph
// or sprite markup left over, every <use> finds its symbol on the same page,
// every coloured change starts with its sign, no dashes as punctuation, and
// the state pages are built the way the mockup draws them, within their
// budget. It builds the site from data/ into tmp/dist-test once (a few
// seconds), or reads an existing build when DAILYFUEL_BUILT_DIR names one.
//
// The road sign checks that were here (every arrow an icon, the sprite on
// every page) went with the icons.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";

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
  california: "state/ca/index.html",
  dc: "state/dc/index.html",
  minnesota: "state/mn/index.html",
  alaska: "state/ak/index.html",
  about: "about/index.html",
  missing: "404.html",
} as const;

const html = (file: string) => readFileSync(resolve(dist, file), "utf8");
const doc = (file: string) => parseHTML(html(file)).document;
const gz = (s: string) => gzipSync(s, { level: 9 }).length;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const TYPED_ARROWS = /[▲▼●▴▾△▽◆⬆⬇↑↓]/;
const DASH = /[–—]| - /;

describe("built pages", () => {
  for (const [name, file] of Object.entries(PAGES)) {
    it(`has no typed direction glyph, icon or sprite anywhere in ${name}`, () => {
      const page = html(file);
      expect(page.length).toBeGreaterThan(1000);
      const hit = TYPED_ARROWS.exec(page);
      expect(hit ? page.slice(Math.max(0, hit.index - 80), hit.index + 20) : null).toBeNull();
      const d = doc(file);
      expect(d.querySelector("svg.glyph, .arrow-sprite, symbol[id^='arrow-'], svg.icon")).toBeNull();
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

    it(`uses no dash as punctuation in what ${name} shows`, () => {
      const d = doc(file);
      for (const el of Array.from(d.querySelectorAll("main p, main h1, main h2, main dt, main dd, main th, main td, main li, footer p"))) {
        expect(text(el), text(el)).not.toMatch(DASH);
      }
      for (const el of Array.from(d.querySelectorAll("[aria-label], title, meta[name='description']"))) {
        const t = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("content") ?? ""} ${el.tagName === "TITLE" ? el.textContent : ""}`;
        expect(t).not.toMatch(TYPED_ARROWS);
        expect(t, t).not.toMatch(DASH);
      }
    });

    it(`starts every coloured change on ${name} with its sign`, () => {
      const d = doc(file);
      for (const el of Array.from(d.querySelectorAll(".up, .down"))) {
        const t = text(el);
        if (!t) continue; // an empty readout slot
        expect(t, t).toMatch(el.classList.contains("up") ? /^\+\d/ : /^−\d/);
      }
    });

    it(`loads no script from anywhere on ${name}`, () => {
      const d = doc(file);
      expect(Array.from(d.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))).toEqual([]);
      expect(Array.from(d.querySelectorAll("link[rel='stylesheet'], link[rel='preload']"))).toEqual([]);
    });
  }
});

describe("the state page", () => {
  it("prints Ohio's quote the way the mockup does", () => {
    const d = doc(PAGES.ohio);
    expect(text(d.querySelector("h1 .sym"))).toBe("OH");
    expect(text(d.querySelector("h1 .nmbig"))).toBe("Ohio");
    expect(text(d.querySelector(".back a"))).toBe("‹ All states");
    expect(d.querySelector("[data-my-state]")).not.toBeNull();
    const big = d.querySelector("main > .big")!;
    expect(text(big.firstElementChild)).toMatch(/^\$\d\.\d{3}$/);
    const move = big.querySelector(".d");
    if (move) expect(text(move)).toMatch(/^[+−]\d+\.\d¢ [+−]?\d+\.\d%$/);
    expect(text(d.querySelector(".plate"))).toBe("EIA Midwest average, 15 states");
    const week = text(d.querySelector(".head-row.line .fine"));
    expect(week).toMatch(/^Week of \w{3} \d{1,2}, \d{4}( against \w{3} \d{1,2}(, \d{4})?)?\. (Next release \w{3}, \w{3} \d{1,2}\.|The next release is late\.)$/);
    expect(d.querySelector(".head-row.line [data-next-release][data-late]")).not.toBeNull();
    for (const note of Array.from(d.querySelectorAll("main > .note")).map(text)) {
      if (note.startsWith("Highest")) expect(note).toMatch(/^Highest Midwest price in (our records, which start June 2022|52 weeks)\.$/);
    }
    expect(text(d.querySelector("main"))).toContain("Dyed farm diesel is untaxed");
    expect(d.querySelector("a[href='https://gasprices.aaa.com/?state=OH']")).not.toBeNull();
    expect(d.querySelector("header [data-share] button")!.getAttribute("data-text")).toMatch(/^Ohio diesel is \$\d\.\d{3} a gallon/);
  });

  it("draws the two charts behind a CSS only range switch, with the numbers under them", () => {
    const d = doc(PAGES.ohio);
    const section = d.querySelector("section.ch")!;
    const kids = Array.from(section.children);
    expect(kids[0].matches("input[type=radio]#r1[checked]")).toBe(true);
    expect(kids[1].matches("input[type=radio]#r2")).toBe(true);
    expect(kids[2].matches(".sh")).toBe(true);
    expect(Array.from(section.querySelectorAll(".rng label")).map(text)).toEqual(["52 weeks", "Since June 2022"]);
    const plots = Array.from(section.querySelectorAll(".plot[data-from][data-to]"));
    expect(plots).toHaveLength(2);
    for (const p of plots) {
      expect(p.getAttribute("tabindex")).toBe("0");
      expect(p.getAttribute("aria-label")).toMatch(/^Midwest weekly diesel price\b.* Now \$\d\.\d{3}.* High \$\d\.\d{3}.* Low \$\d\.\d{3}.* Every week is in the table below\.$/);
      expect(p.querySelectorAll("path.grid, path.ln, path.pt")).toHaveLength(3);
      for (const y of Array.from(p.querySelectorAll(".yl")).map(text)) expect(y).toMatch(/^\d\.\d{3}$/);
      expect(text(p.querySelector(".ytag"))).toBe(text(d.querySelector("main > .big")!.firstElementChild).slice(1));
    }
    for (const x of Array.from(plots[0].querySelectorAll(".xl")).map(text)) expect(x).toMatch(/^(Jan|Apr|Jul|Oct)$/);
    for (const x of Array.from(plots[1].querySelectorAll(".xl")).map(text)) expect(x).toMatch(/^20\d\d$/);
    const readouts = Array.from(section.querySelectorAll(".rdout"));
    expect(readouts).toHaveLength(2);
    expect(text(readouts[0].querySelector(".rd-v"))).toMatch(/^\$\d\.\d{3}$/);
    // the table twin, which the readout script reads its numbers from
    const table = d.querySelector(".numbers table")!;
    expect(text(d.querySelector(".numbers summary"))).toBe("Show the numbers");
    expect(Array.from(table.querySelectorAll("thead th")).map(text)).toEqual(["Week of", "Last $"]);
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    expect(rows.length).toBeGreaterThan(200);
    expect(text(rows[0].querySelector("td"))).toMatch(/^\w{3} \d{1,2}, \d{4}$/);
    expect(text(rows[0].querySelector("td.v"))).toBe(text(plots[0].querySelector(".ytag")));
  });

  it("boxes the key stats and the tax", () => {
    const d = doc(PAGES.ohio);
    const stats = d.querySelectorAll("dl.stats");
    expect(stats).toHaveLength(2);
    expect(Array.from(stats[0].querySelectorAll("dt")).map(text)).toEqual(["4 week change", "52 week change", "52 week high", "52 week low"]);
    expect(Array.from(stats[1].querySelectorAll("dt")).map(text)).toEqual(["Ohio tax", "Federal tax", "Total tax", "Rank"]);
    for (const dd of Array.from(stats[1].querySelectorAll("dd:not(.s)")).slice(0, 3)) expect(text(dd)).toMatch(/^\d+\.\d+¢$/);
    expect(text(stats[1].querySelectorAll("dd:not(.s)")[3])).toMatch(/^(\d+(st|nd|rd|th) (highest|lowest)|Highest|Lowest)$/);
    expect(text(d.querySelector("h2#tax-title + .meta"))).toMatch(/^FHWA table MF-121T, \d{4}$/);
  });

  it("lists the other states at the same price with their own tax", () => {
    const d = doc(PAGES.ohio);
    const board = d.querySelector("section.peers")!;
    expect(text(board.querySelector("h2"))).toBe("Same price, other states");
    expect(text(board.querySelector(".meta"))).toMatch(/^15 states read \$\d\.\d{3} this week$/);
    expect(Array.from(board.querySelectorAll("thead th")).map(text)).toEqual(["Sym", "Name", "Tax ¢"]);
    const rows = Array.from(board.querySelectorAll("tbody tr")).map((r) => Array.from(r.querySelectorAll("th, td")).map(text));
    expect(rows).toHaveLength(14);
    for (const r of rows) expect(r[2]).toMatch(/^(\d+\.\d+|n\/a)$/);
    for (const a of Array.from(board.querySelectorAll("tbody th a"))) expect(a.getAttribute("href")).toMatch(/^\/state\/[a-z]{2}\/$/);
    expect(rows.find((r) => r[0] === "MN")![2]).toBe("n/a");
    expect(text(board.querySelector(".cap"))).toBe("One EIA price covers the whole Midwest region. The state tax on top of it is different in each one.");
  });

  it("says DC is not listed and Minnesota is out of date, with no total and no rank", () => {
    const dc = doc(PAGES.dc);
    const dcTax = dc.querySelectorAll("dl.stats")[1];
    expect(text(dcTax.querySelector("dt"))).toBe("DC tax");
    expect(Array.from(dcTax.querySelectorAll("dd.w")).map(text)).toEqual(["Not listed", "n/a", "Not ranked"]);
    const mn = doc(PAGES.minnesota);
    const mnTax = mn.querySelectorAll("dl.stats")[1];
    expect(text(mnTax.querySelector("dt"))).toBe("Minnesota tax");
    expect(Array.from(mnTax.querySelectorAll("dd.w")).map(text)).toEqual(["Out of date", "n/a", "Not ranked"]);
    expect(text(mn.querySelector("section[aria-labelledby=tax-title]"))).toContain("out of date");
  });

  it("gives California its own plate and no same price table", () => {
    const d = doc(PAGES.california);
    expect(text(d.querySelector(".plate"))).toBe("EIA California average");
    expect(d.querySelector("section.peers")).toBeNull();
  });

  it("gives Alaska the no survey page", () => {
    const d = doc(PAGES.alaska);
    expect(text(d.querySelector("main > .big"))).toBe("No EIA price");
    expect(d.querySelector(".plate")).toBeNull();
    const note = text(d.querySelector("main > .note"));
    expect(note).toMatch(/^EIA doesn't survey diesel in Alaska, so there is no weekly number for it\. The nearest region EIA does survey is the West Coast(, which read \$\d\.\d{3} this week(, [+−]\d+\.\d¢ on the week)?)?\.$/);
    expect(text(d.querySelector("main [data-next-release]"))).toMatch(/^(Next EIA release \w{3}, \w{3} \d{1,2}\.|The next release is late\.)$/);
    expect(d.querySelector(".plot, .numbers, section.peers")).toBeNull();
    const tax = d.querySelector("dl.stats")!;
    expect(text(tax.querySelector("dt"))).toBe("Alaska tax");
    expect(d.querySelectorAll("dl.stats")).toHaveLength(1);
    expect(d.querySelector("header [data-share] button")!.getAttribute("data-text")).toMatch(/^EIA doesn't survey diesel prices in Alaska/);
  });

  it("remembers the state and shows the marker, and keeps the scripts small", () => {
    for (const file of [PAGES.ohio, PAGES.alaska]) {
      const page = html(file);
      expect(page).toContain('"dailyfuel:state"');
      expect(page).toContain("data-on");
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
      expect(gz(scripts)).toBeLessThan(3 * 1024);
    }
  });

  it("stays under 12 KB gzip", () => {
    for (const file of [PAGES.ohio, PAGES.minnesota, PAGES.california, PAGES.alaska]) {
      expect(gz(html(file)), file).toBeLessThan(12 * 1024);
    }
  });
});
