// Checks on the pages the build writes, where every part has come together.
// The paper terminal has no icons and no arrows: a change carries its sign
// and its colour repeats it. So, on every page: no typed direction glyph, no
// glyph or sprite markup left over, nothing drawn but the charts and the
// sparklines, every <use> finds its line on the same page, every coloured
// change starts with its sign, no dashes as punctuation, nothing loaded from
// anywhere else. Then the home page and the state pages are checked against
// the data and the mockup, and against their size budgets. It builds the site
// from data/ into tmp/dist-test once (a few seconds), or reads an existing
// build when DAILYFUEL_BUILT_DIR names one.
//
// The road sign checks that were here (every arrow an icon, the sprite on
// every page, the map chips) went with that design. There are no arrows to
// check now, and the check is that none crept back.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { formatMove, formatPrice, formatQuote, signedCents } from "./format.ts";
import { pctOf } from "./copy.ts";
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

const TYPED_ARROWS = /[▲▼●▴▾△▽◆⬆⬇↑↓→←]/;
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
      expect(d.querySelector("img, .glyph, .icon, [data-map], .us-map")).toBeNull();
    });

    it(`draws nothing but the charts and the sparklines in ${name}`, () => {
      const d = doc(file);
      for (const svg of Array.from(d.querySelectorAll("svg"))) {
        const cls = svg.getAttribute("class") ?? "";
        const inPlot = Boolean(svg.closest(".pa"));
        expect(inPlot || cls === "spk" || cls === "sprite", svg.outerHTML.slice(0, 80)).toBe(true);
      }
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

    it(`uses no dash as punctuation in what ${name} shows`, () => {
      const d = doc(file);
      const words = text(d.querySelector("main")) + " " + text(d.querySelector("footer"));
      expect(words).not.toMatch(/[–—]/);
      expect(words).not.toMatch(/\s-\s/);
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

    it(`loads nothing from anywhere else on ${name}, and no analytics outside Vercel production`, () => {
      const d = doc(file);
      expect(Array.from(d.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))).toEqual([]);
      expect(Array.from(d.querySelectorAll("link[rel='stylesheet'], link[rel='preload']"))).toEqual([]);
      const page = html(file);
      expect(page).not.toContain("_vercel/insights");
      // what the browser fetches: scripts, sheets, preloads and images (a
      // canonical link and the footer's links are addresses, not requests)
      for (const m of page.matchAll(/<(?:script|img)[^>]*\ssrc="([^"]+)"|<link[^>]*rel="(?:stylesheet|preload|modulepreload|icon)"[^>]*\shref="([^"]+)"/g)) {
        expect(m[1] ?? m[2], m[0]).not.toMatch(/^(https?:)?\/\//);
      }
      expect(page).not.toMatch(/@import|url\((https?:)?\/\//);
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
    // where a state page's "All states" link lands
    expect(d.querySelector("section#states #quotes")).not.toBeNull();
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
      expect(text(r)).toContain("No EIA survey");
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

  it("stays inside its budget: under 20 KB gzipped, under 3 KB of inline JS", () => {
    const page = html(PAGES.home);
    expect(gz(page)).toBeLessThan(20 * 1024);
    const scripts = [...page.matchAll(/<script(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(3);
    expect(gz(scripts.join("\n"))).toBeLessThan(3 * 1024);
  });
});

describe("the state page", () => {
  it("prints Ohio's quote the way the mockup does", () => {
    const d = doc(PAGES.ohio);
    expect(text(d.querySelector("h1 .sym"))).toBe("OH");
    expect(text(d.querySelector("h1 .nmbig"))).toBe("Ohio");
    expect(text(d.querySelector(".back a"))).toBe("‹ All states");
    // lands on the home page's ALL STATES table
    expect(d.querySelector(".back a")!.getAttribute("href")).toBe("/#states");
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
