// Checks on the pages the build writes, where every part has come together.
// The paper terminal has no icons and no arrows: a change carries its sign
// or its words, and its colour repeats them. So, on every page: no typed
// direction glyph and no other mark (not even ‹ or ✓), no glyph or sprite
// markup left over, nothing drawn but the charts and the sparklines, every
// <use> finds its line on the same page, every coloured change starts with
// its sign or its direction word, no dashes as punctuation, nothing loaded
// from anywhere else, media queries older phones can read, the one row
// phone header and the short footer with its link row. Then the home page
// and the state pages are checked against the data and the phone layout in
// the mobile plan, and against their size budgets. It builds the site from
// data/ into tmp/dist-test once (a few seconds), and once more the way
// Vercel builds it for production (VERCEL_ENV=production, which adds the
// analytics script) into tmp/dist-test-prod, since that is the page that
// ships and its budget is the one that counts. DAILYFUEL_BUILT_DIR and
// DAILYFUEL_BUILT_PROD_DIR name existing builds instead.
//
// The road sign checks that were here (every arrow an icon, the sprite on
// every page, the map chips) went with that design. There are no arrows to
// check now, and the check is that none crept back.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { changeWords, diffWords, formatMove, formatPrice, formatQuote, signedCents, toMills } from "./format.ts";
import { pctOf, regionMates } from "./copy.ts";
import { DOE_LINE } from "./doe.ts";
import { LATE_TEXT } from "./release.ts";
import { NEIGHBORS } from "./neighbors.ts";
import { REPO_URL, getSite } from "./site.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let dist = process.env.DAILYFUEL_BUILT_DIR ? resolve(ROOT, process.env.DAILYFUEL_BUILT_DIR) : "";
// the production build: with an existing plain build named, only an existing production build counts
let prod = process.env.DAILYFUEL_BUILT_PROD_DIR ? resolve(ROOT, process.env.DAILYFUEL_BUILT_PROD_DIR) : "";

function build(outDir: string, extra: Record<string, string>): void {
  rmSync(outDir, { recursive: true, force: true });
  // a plain build, without the test runner's environment
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV" && k !== "TEST"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/astro/bin/astro.mjs"), "build", "--outDir", outDir, "--silent"], {
    cwd: ROOT,
    env: { ...env, ...extra },
    stdio: "pipe",
  });
}

beforeAll(() => {
  if (dist) return;
  dist = resolve(ROOT, "tmp/dist-test");
  build(dist, { VERCEL_ENV: "" });
  prod = resolve(ROOT, "tmp/dist-test-prod");
  build(prod, { VERCEL_ENV: "production" });
}, 180_000);

const PAGES = {
  home: "index.html",
  ohio: "state/oh/index.html",
  california: "state/ca/index.html",
  dc: "state/dc/index.html",
  minnesota: "state/mn/index.html",
  tennessee: "state/tn/index.html",
  alaska: "state/ak/index.html",
  about: "about/index.html",
  missing: "404.html",
} as const;

const html = (file: string) => readFileSync(resolve(dist, file), "utf8");
const doc = (file: string) => parseHTML(html(file)).document;
const gz = (s: string) => gzipSync(s, { level: 9 }).length;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** The inline scripts on a page, joined, the way the budget counts them. */
const inlineScripts = (page: string) =>
  [...page.matchAll(/<script(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/** A stand in for the phone's localStorage that records every write. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data,
    writes,
    store: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(`${k}=${v}`);
        data.set(k, v);
      },
      removeItem: (k: string) => {
        writes.push(`-${k}`);
        data.delete(k);
      },
    },
  };
}

/** Runs one of a page's own inline scripts against its parsed document, with a fake store and location. */
function runInline(script: string, d: Document, store: unknown) {
  const location = { href: "", reloads: 0, reload() { this.reloads += 1; } };
  new Function("document", "window", "addEventListener", "location", script)(d, { localStorage: store }, () => {}, location);
  return location;
}

const TYPED_ARROWS = /[▲▼●▴▾△▽◆⬆⬇↑↓→←]/;
// Every arrow, geometric shape, dingbat and angle quote a page could type.
// None is allowed: the ‹ on the "All states" link and the ✓ on the MY STATE
// marker went with the phone redesign, and your state's row is marked by its
// shade and weight alone.
const MARKS = /[‹›←-⇿─-➿⬀-⯿]/g;
const ALLOWED_MARKS = "";
const DASH = /[–—]| - /;
const WEEKDAY_DATE = String.raw`(Mon|Tue|Wed|Thu|Fri), [A-Z][a-z]{2} \d{1,2}`;
const NEW_PRICES = new RegExp(String.raw`^(New prices ${WEEKDAY_DATE}\.|New prices are late\.)$`);

describe("built pages", () => {
  const site = getSite();

  for (const [name, file] of Object.entries(PAGES)) {
    it(`has no typed direction glyph, icon or sprite anywhere in ${name}`, () => {
      const page = html(file);
      expect(page.length).toBeGreaterThan(1000);
      const hit = TYPED_ARROWS.exec(page);
      expect(hit ? page.slice(Math.max(0, hit.index - 80), hit.index + 20) : null).toBeNull();
      for (const m of page.matchAll(MARKS)) {
        expect(ALLOWED_MARKS, page.slice(Math.max(0, m.index - 60), m.index + 20)).toContain(m[0]);
      }
      const d = doc(file);
      expect(d.querySelector("svg.glyph, .arrow-sprite, symbol[id^='arrow-'], svg.icon")).toBeNull();
      expect(d.querySelector("img, .glyph, .icon, [data-map], .us-map, .ar")).toBeNull();
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
      const words = text(d.querySelector("header")) + " " + text(d.querySelector("main")) + " " + text(d.querySelector("footer"));
      expect(words).not.toMatch(/[–—]/);
      expect(words).not.toMatch(/\s-\s/);
      for (const el of Array.from(d.querySelectorAll("main p, main h1, main h2, main dt, main dd, main th, main td, main li, main summary, main label, main option, footer p"))) {
        expect(text(el), text(el)).not.toMatch(DASH);
      }
      for (const el of Array.from(d.querySelectorAll("[aria-label], [placeholder], [data-text], [data-late], title, meta[name='description']"))) {
        const t = ["aria-label", "content", "placeholder", "data-text", "data-late"].map((a) => el.getAttribute(a) ?? "").join(" ") + (el.tagName === "TITLE" ? ` ${el.textContent}` : "");
        expect(t).not.toMatch(TYPED_ARROWS);
        expect(t, t).not.toMatch(DASH);
      }
    });

    it(`starts every coloured change on ${name} with its sign or its direction word`, () => {
      const d = doc(file);
      for (const el of Array.from(d.querySelectorAll(".up, .down"))) {
        const t = text(el);
        if (!t) continue; // an empty readout slot
        expect(t, t).toMatch(el.classList.contains("up") ? /^(\+|Up )[\d$]/ : /^(−|Down )[\d$]/);
      }
    });

    it(`loads nothing from anywhere else on ${name}, and no analytics outside Vercel production`, () => {
      const d = doc(file);
      expect(Array.from(d.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))).toEqual([]);
      expect(Array.from(d.querySelectorAll("link[rel='stylesheet'], link[rel='preload']"))).toEqual([]);
      const page = html(file);
      expect(page).not.toContain("_vercel/insights");
      // what the browser fetches: scripts, sheets, preloads, connections and images (a
      // canonical link and the footer's links are addresses, not requests)
      for (const m of page.matchAll(/<(?:script|img|iframe|source|video|audio)[^>]*\ssrcs?e?t?="([^"]+)"|<link[^>]*rel="(?:stylesheet|preload|modulepreload|prefetch|preconnect|dns-prefetch|icon)"[^>]*\shref="([^"]+)"/g)) {
        expect(m[1] ?? m[2], m[0]).not.toMatch(/^(https?:)?\/\//);
      }
      expect(page).not.toMatch(/@import|url\((https?:)?\/\//);
      // AAA's site may be linked to, in the state page's fold, but never fetched
      expect(page).not.toMatch(/(?:src|srcset|action)="[^"]*aaa\.com|fetch\([^)]*aaa\.com/);
    });

    it(`keeps every media query in a form older phones read on ${name}`, () => {
      const page = html(file);
      // iOS before 16.4 and Chrome before 104 skip range syntax, and with it every phone rule
      expect(page).not.toMatch(/\((?:width|height)\s*[<>]/);
      expect(page).toMatch(/max-width:\s*479px/);
      expect(page).toContain("-webkit-text-size-adjust:100%");
    });

    it(`registers no offline copy and links no outside map app on ${name}`, () => {
      const page = html(file);
      expect(page).not.toMatch(/serviceWorker|\/sw\.js/);
      expect(page).not.toMatch(/Open in Maps/i);
      expect(page).not.toMatch(/href="[^"]*(google\.[a-z.]+\/maps|maps\.google|maps\.apple|waze\.com)/);
    });

    it(`puts the phone header in one row on ${name}: wordmark, the next place to go, and Night`, () => {
      const d = doc(file);
      const top = d.querySelector("header.top")!;
      const brand = top.querySelector("a.brand")!;
      expect(brand.getAttribute("href")).toBe("/");
      expect(text(brand)).toBe("DailyFuel");
      expect(text(top.querySelector(".tl"))).toBe(site.mode === "aaa+eia" ? "Diesel prices by state, new every day" : "Diesel prices by state, new every week");
      const controls = Array.from(top.querySelectorAll(".right > a.btn, .right > .share button, .right > button")).map(text);
      const shares = file === PAGES.home || file.startsWith("state/");
      expect(controls).toEqual(shares ? ["Map", "Share", "Night"] : ["Prices", "Map", "Night"]);
      if (!shares) expect(top.querySelector(".right > a.btn")!.getAttribute("href")).toBe("/");
      expect(top.querySelector("a.btn[href='/map/']")).not.toBeNull();
      // the theme button names what a tap does and is never filled
      const theme = top.querySelector("[data-theme-toggle]")!;
      expect(theme.classList.contains("on")).toBe(false);
      expect(theme.hasAttribute("aria-pressed")).toBe(false);
      // the week tag (wide screens only) says new prices the same way the page does
      const wk = top.querySelector(".wk [data-next-release]");
      if (wk) {
        expect(wk.getAttribute("data-late")).toBe("new prices are late");
        expect(text(wk)).toMatch(new RegExp(String.raw`^(new prices ${WEEKDAY_DATE}|new prices are late)$`));
      }
    });

    it(`ends ${name} with the short footer and its link row`, () => {
      const d = doc(file);
      const ps = Array.from(d.querySelectorAll("footer.foot p"));
      expect(ps).toHaveLength(4);
      if (site.weekly) {
        expect(text(ps[0])).toMatch(new RegExp(String.raw`^Prices: U\.S\. Energy Information Administration weekly survey(, released [A-Z][a-z]{2} \d{1,2}, \d{4})?\. (New prices ${WEEKDAY_DATE}\.|New prices are late\.)`));
        const next = ps[0].querySelector("[data-next-release]")!;
        expect(next.getAttribute("data-late")).toBe(LATE_TEXT);
      }
      if (site.tax) expect(text(ps[0])).toMatch(new RegExp(String.raw` Tax: Federal Highway Administration, ${site.tax.reporting_period}\.$`));
      expect(text(ps[1])).toBe("Prices include federal and state tax.");
      expect(text(ps[2]).startsWith("No ads, no cookies, no accounts. This phone keeps only the state you save and your day or night choice.")).toBe(true);
      // the next step is at the bottom of every page
      const row = ps[3];
      expect(row.getAttribute("class")).toBe("flinks");
      const compact = file === PAGES.about;
      const links = Array.from(row.querySelectorAll("a")).map((a) => [text(a), a.getAttribute("href")]);
      expect(links).toEqual([
        ["All states", "/#states"],
        ["Truck stop map", "/map/"],
        ...(compact ? [] : [["Where the numbers come from", "/about/"]]),
        ["Code on GitHub", REPO_URL],
      ]);
      expect(text(row)).toBe(links.map((l) => l[0]).join(" · "));
      // the region and Alaska sentences it repeated are gone
      expect(text(d.querySelector("footer"))).not.toMatch(/Sources\.|Alaska|Hawaii|region/);
    });

    it(`says new prices one way on ${name}, with no old release words left`, () => {
      const page = html(file);
      expect(page).not.toMatch(/Next release|Next print|next update is late|The next release is late|Next EIA release/);
      // tax is in the pump price, never "on top" of it
      expect(page).not.toMatch(/on top of it|on top\b/);
      for (const el of Array.from(doc(file).querySelectorAll("main [data-next-release], footer [data-next-release]"))) {
        expect(el.getAttribute("data-late")).toBe(LATE_TEXT);
        expect(text(el)).toMatch(NEW_PRICES);
      }
    });
  }

  it("sends a picked state without JS to its page through vercel.json, and every old list address to the picker", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8")) as {
      redirects: { source: string; destination: string; permanent: boolean; has?: { type: string; key: string; value: string }[] }[];
    };
    const d = doc(PAGES.home);
    // what /go?s=xx resolves to: the first redirect for /go whose query test passes
    const resolveGo = (query: Record<string, string>) => {
      for (const r of config.redirects) {
        if (r.source !== "/go") continue;
        let dest = r.destination;
        const ok = (r.has ?? []).every((h) => {
          if (h.type !== "query" || !(h.key in query)) return false;
          const m = new RegExp(`^${h.value}$`).exec(query[h.key]);
          if (!m) return false;
          for (const [k, v] of Object.entries(m.groups ?? {})) dest = dest.replace(`:${k}`, v);
          return true;
        });
        if (ok) return { dest, permanent: r.permanent };
      }
      return null;
    };
    const options = Array.from(d.querySelectorAll("form#find-your-state select[name=s] option")).map((o) => o.getAttribute("value")!).filter(Boolean);
    expect(options).toHaveLength(51);
    for (const v of options) {
      const to = resolveGo({ s: v })!;
      expect(to, v).toEqual({ dest: `/state/${v}/`, permanent: false });
      expect(existsSync(resolve(dist, `state/${v}/index.html`)), v).toBe(true);
    }
    // an empty pick, or anything that is not a code, lands back on the picker
    for (const q of [{}, { s: "" }, { s: "ohio" }, { s: "../x" }] as Record<string, string>[]) expect(resolveGo(q), JSON.stringify(q)).toEqual({ dest: "/#find-your-state", permanent: false });
    for (const source of ["/state", "/state/", "/states", "/states/"]) {
      expect(config.redirects.find((r) => r.source === source)?.destination, source).toBe("/#find-your-state");
    }
    expect(d.querySelector("#find-your-state")).not.toBeNull();
  });
});

describe("the home page", () => {
  const site = getSite();
  const daily = site.national.cadence === "daily";
  const nm = site.national.move!;

  it("prints the U.S. number from the data, its change in words in the ink of its direction, and the week in ink", () => {
    const d = doc(PAGES.home);
    expect(text(d.querySelector("h1"))).toBe("U.S. diesel average");
    const big = d.querySelector(".hero .big")!;
    expect(text(big.querySelector("span"))).toBe(formatPrice(nm.price));
    if (nm.change !== null) {
      // the signed move beside it (wide screens only)
      const move = big.querySelector(".d")!;
      expect(text(move)).toBe(formatMove(nm.change, pctOf(nm)));
      expect(move.getAttribute("class")).toMatch(/^d (up|down|muted)$/);
      // the words line: only the change wears red or blue
      const chw = d.querySelector(".hero .chw")!;
      expect(text(chw)).toMatch(/^(Up|Down) (\d+\.\d¢|\$\d\.\d{3}) from \$\d\.\d{3} (last week|yesterday)\.$|^No change from (last week|yesterday)\.$/);
      expect(text(chw.querySelector("b"))).toBe(changeWords(nm.change));
      expect(chw.getAttribute("class")).toBe("chw");
      expect(chw.querySelector("b")!.getAttribute("class")).toMatch(/^(up|down|muted)$/);
      expect(chw.querySelectorAll(".up, .down, .muted")).toHaveLength(1);
    }
    if (!daily) expect(text(d.querySelector(".hero .wkl"))).toMatch(new RegExp(String.raw`^Prices for the week of [A-Z][a-z]{2} \d{1,2}, \d{4}\. (New prices ${WEEKDAY_DATE}\.|New prices are late\.)$`));
    // the records phrase, whenever the page claims a record
    for (const note of Array.from(d.querySelectorAll(".hero .note")).map(text)) {
      if (/records/.test(note)) expect(note).toContain("in our records, which start June 2022");
    }
  });

  it("says when the next numbers land, with the date the late notice needs", () => {
    const d = doc(PAGES.home);
    const next = d.querySelector(".hero [data-next-release]")!;
    expect(next.getAttribute("data-next-release")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(next.getAttribute("data-late")).toMatch(/late/);
    expect(text(next)).toMatch(/^(New prices|EIA's next weekly numbers land) (Mon|Tue|Wed|Thu|Fri), [A-Z][a-z]{2} \d{1,2}\.$|late/);
  });

  it("says where the U.S. price was 4 weeks and a year ago, and keeps the chart one tap away", () => {
    const d = doc(PAGES.home);
    expect(text(d.querySelector(".hero .then"))).toMatch(/^4 weeks ago \$\d\.\d{3}\. A year ago \$\d\.\d{3}\.$/);
    const box = d.querySelector(".hero input#usc[type=checkbox]")!;
    expect(box).not.toBeNull();
    expect(box.hasAttribute("checked")).toBe(false);
    const label = d.querySelector("label.usc-l[for=usc]")!;
    expect(label.previousElementSibling).toBe(box);
    expect(text(label.querySelector(".o1"))).toBe("Show the U.S. price chart");
    expect(text(label.querySelector(".o2"))).toBe("Hide the U.S. price chart");
    // the chart follows the toggle, so the CSS sibling rule can fold it
    expect(d.querySelector("#usc ~ .us-chart .plot[data-v]")).not.toBeNull();
  });

  it("draws the U.S. line since our records start, one value a week, with a readout and a hint for a finger", () => {
    const d = doc(PAGES.home);
    const plot = d.querySelector(".plot[data-v]")!;
    expect(plot.getAttribute("tabindex")).toBe("0");
    expect(plot.getAttribute("aria-label")).toMatch(/arrow keys/);
    expect(plot.getAttribute("data-start")).toBe(site.weekly!.weeks[0].period);
    const values = plot.getAttribute("data-v")!.split(",");
    expect(values.length).toBeGreaterThan(200);
    expect(values[values.length - 1]).toBe(formatQuote(site.eiaUs!.price));
    expect(text(d.querySelector(".rdout .rd-v"))).toBe(formatPrice(site.eiaUs!.price));
    expect(text(d.querySelector(".rdout .rd-t"))).toBe("Slide a finger along the line to read a week.");
    expect(text(d.querySelector(".ytag"))).toBe(formatQuote(site.eiaUs!.price));
    const ys = Array.from(d.querySelectorAll(".us-chart .yl")).map(text);
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) expect(y).toMatch(/^\$\d\.\d{2}$/);
    expect(d.querySelectorAll(".xl").length).toBeGreaterThan(2);
  });

  it("puts your state first, with every state's line ready for the script and the same plate as its page", () => {
    const d = doc(PAGES.home);
    const main = d.querySelector("main")!;
    const slot = d.querySelector("section.ys[data-ys]")!;
    // a DOM move, not CSS order: screen readers meet it first
    expect(main.firstElementChild).toBe(slot);
    expect(slot.nextElementSibling!.matches("section.hero")).toBe(true);
    // nothing is painted until the script finds a saved state
    expect(slot.hasAttribute("data-ys-state")).toBe(false);
    for (const f of ["n", "p", "c", "f", "l"]) expect(slot.querySelector(`[data-f=${f}]`), f).not.toBeNull();
    expect(slot.querySelector("a.btn.wide[data-ys-open]")!.getAttribute("href")).toBe("/#find-your-state");
    expect(text(slot.querySelector(".ans .wkl"))).toBe(text(d.querySelector(".hero .wkl")));
    const data = JSON.parse(slot.querySelector("script#ys-data[type='application/json']")!.textContent!) as { s: Record<string, [string, string]>; l: Record<string, string[]> };
    expect(Object.keys(data.s).sort()).toEqual(site.states.map((s) => s.code).sort());
    for (const s of site.states) {
      const [nameOf, key] = data.s[s.code];
      expect(nameOf).toBe(s.name);
      const line = data.l[key];
      expect(line, s.code).toHaveLength(5);
      const [price, words, from, ink, plate] = line;
      if (!s.primary) {
        // Alaska and Hawaii: no number, and no hint of one
        expect(key).toBe("");
        expect(line).toEqual(["", "No weekly price", "", "muted", "The weekly survey does not cover this state."]);
        continue;
      }
      expect(key).toBe(daily ? s.code : s.eia_series);
      expect(price).toBe(formatPrice(s.primary.price));
      if (s.primary.change !== null) {
        expect(words).toBe(changeWords(s.primary.change));
        expect(from).toMatch(/^from (\$\d\.\d{3} )?(last week|yesterday)\.$/);
      }
      expect(ink).toMatch(/^(up|down|muted)$/);
      if (!daily) {
        // the strip never contradicts the page it opens, and always says whose average it is
        const page = doc(`state/${s.slug}/index.html`);
        expect(plate, s.code).toBe(text(page.querySelector(".plate")));
        expect(plate, s.code).toMatch(/average/);
        expect(`${words} ${from}`, s.code).toBe(text(page.querySelector("main > .chw")));
      }
    }
    // the script reads the block right before it
    const page = html(PAGES.home);
    expect(page.indexOf('id="ys-data"')).toBeLessThan(page.indexOf('[data-ys]'));
  });

  it("fills your state from the saved code and saves nothing on its own", () => {
    const d = doc(PAGES.home);
    const script = d.querySelector("section.ys > script:not([type])")!.textContent!;
    // nothing saved: the block stays hidden and nothing is written
    const empty = fakeStore();
    runInline(script, d, empty.store);
    expect(d.querySelector("[data-ys]")!.hasAttribute("data-ys-state")).toBe(false);
    expect(empty.writes).toEqual([]);
    // Ohio saved: Ohio's line, in Ohio's ink, and the button opens Ohio
    const oh = site.byCode.get("OH")!;
    const saved = fakeStore({ "dailyfuel:state": "OH" });
    const d2 = doc(PAGES.home);
    runInline(script, d2, saved.store);
    const slot = d2.querySelector("[data-ys]")!;
    expect(slot.getAttribute("data-ys-state")).toBe("OH");
    expect(text(slot.querySelector(".lbl"))).toBe("Ohio diesel");
    expect(text(slot.querySelector("[data-f=p]"))).toBe(formatPrice(oh.primary!.price));
    expect(text(slot.querySelector("[data-f=c]"))).toBe(changeWords(oh.primary!.change!));
    expect(slot.querySelector("[data-f=c]")!.getAttribute("class")).toMatch(/^(up|down|muted)$/);
    expect(slot.querySelector("[data-ys-open]")!.getAttribute("href")).toBe("/state/oh/");
    expect(text(slot.querySelector("[data-ys-open]"))).toBe("Open the Ohio page");
    expect(saved.writes).toEqual([]);
  });

  it("asks for your state with a native picker that works without JS", () => {
    const d = doc(PAGES.home);
    const form = d.querySelector(".hero form.go#find-your-state")!;
    expect(form.getAttribute("action")).toBe("/go");
    expect((form.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    expect(text(form.querySelector("label[for=go-s] .g1"))).toBe("Your state");
    expect(text(form.querySelector("label[for=go-s] .g2"))).toBe("Change your state");
    const select = form.querySelector("select#go-s[name=s][required]")!;
    const opts = Array.from(select.querySelectorAll("option"));
    expect(opts).toHaveLength(52);
    expect([opts[0].getAttribute("value"), text(opts[0])]).toEqual(["", "Pick your state"]);
    const byName = [...site.states].sort((a, b) => a.name.localeCompare(b.name));
    expect(opts.slice(1).map((o) => [o.getAttribute("value"), text(o)])).toEqual(byName.map((s) => [s.slug, s.name]));
    expect(text(form.querySelector("button.btn"))).toBe("Show price");
    expect(form.querySelector("button")!.getAttribute("type") ?? "submit").toBe("submit");
    // forgetting sits at the end of the page, far from Change
    const forget = d.querySelector("main > p.fg [data-ys-forget]")!;
    expect(text(forget)).toBe("Forget my state");
    expect(text(forget.parentElement)).toBe("This phone remembers your state. Forget my state");
    expect(d.querySelector("#states")!.compareDocumentPosition(forget) & 4).toBeTruthy();
  });

  it("lists the U.S. and 8 regions on the board, each with its states as code links, and who each price covers", () => {
    const d = doc(PAGES.home);
    const board = d.querySelector("section.board")!;
    expect(text(board.querySelector("h2"))).toBe("Prices by region");
    expect(Array.from(board.querySelectorAll("thead th")).map(text)).toEqual(["Region", "Price $", "Change ¢", "Change %", "Year low", "Year high", "Past year", "States"]);
    const rows = Array.from(board.querySelectorAll("tbody tr:not(.mr)"));
    expect(rows.length).toBe(9);
    expect(rows[0].getAttribute("class")).toBe("us");
    expect(text(rows[0].querySelector("th"))).toBe("U.S.");
    expect(text(rows[0].querySelector("td:last-child"))).toBe("48 states and DC");
    // the U.S. row has no member row: the headline shows it
    expect(rows[0].nextElementSibling!.getAttribute("class")).toBe("hm");
    const midwest = rows.find((r) => text(r.querySelector("th")) === "Midwest")!;
    expect(text(midwest.querySelector("td:last-child"))).toBe("15 states");
    const r20 = site.regions.find((r) => r.key === "R20")!;
    expect(text(midwest.querySelector("td"))).toBe(formatQuote(r20.move!.price));
    for (const row of rows.slice(1)) {
      expect(row.getAttribute("class")).toBe("hm");
      const region = site.regions.find((r) => r.name === text(row.querySelector("th")))!;
      expect(region, text(row.querySelector("th"))).toBeTruthy();
      const mem = row.nextElementSibling!;
      expect(mem.getAttribute("class")).toBe("mr");
      const cell = mem.querySelector("td.mem[colspan='8']")!;
      const links = Array.from(cell.querySelectorAll("a")).map((a) => [text(a), a.getAttribute("href")]);
      const codes = site.states.filter((s) => s.eia_series === region.key).map((s) => s.code).sort();
      expect(links).toEqual(codes.map((c) => [c, `/state/${c.toLowerCase()}/`]));
    }
    expect(text(board.querySelector("#board-cap"))).toMatch(/^Every state in a region shows the same weekly price, and California is priced on its own\. Prices are dollars a gallon for the week of [A-Z][a-z]{2} \d{1,2}, \d{4}\. Change is in cents from the week of [A-Z][a-z]{2} \d{1,2}\.$/);
    const notes = text(board.querySelector(".notes"));
    expect(notes).toMatch(/One price, many states\./);
    expect(notes).toMatch(/because the survey covers regions, not single states\./);
    const ns = board.querySelector(".notes p.ns")!;
    expect(text(ns)).toBe("No weekly survey. Alaska and Hawaii have no weekly price.");
    expect(Array.from(ns.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["/state/ak/", "/state/hi/"]);
  });

  it("quotes every state in name order behind one tap on phones, with the pinned code linking to its page", () => {
    const d = doc(PAGES.home);
    // where a state page's "All states" link lands
    const q = d.querySelector("section#states.q")!;
    expect(q.querySelector("#quotes")).not.toBeNull();
    expect(q.firstElementChild!.matches("input#qa[type=checkbox]")).toBe(true);
    const qa = q.querySelector("label.qa-l[for=qa]")!;
    expect(text(qa.querySelector(".q1"))).toBe("Show all 50 states and DC");
    expect(text(qa.querySelector(".q2"))).toBe("Hide the list");
    expect(q.querySelector("#find")!.getAttribute("placeholder")).toBe("Find a state");
    // with JS off the find box can't filter, so it is built switched off; quotes.ts switches it on
    expect(q.querySelector("#find")!.hasAttribute("disabled")).toBe(true);
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
    const heads = Array.from(d.querySelectorAll("#quotes thead th"));
    expect(heads.slice(0, 4).map(text)).toEqual(["State", "Name", "Price $", "Change ¢"]);
    for (const th of heads.filter((h) => h.hasAttribute("data-k"))) expect(th.getAttribute("data-w"), text(th)).toBeTruthy();
    expect(d.querySelector('#quotes thead th[aria-sort="ascending"]')!.getAttribute("data-k")).toBe("n");
    expect(text(d.querySelector("#count"))).toBe("50 states and DC");
  });

  it("says why Alaska and Hawaii have no weekly price, and which taxes are old or unknown", () => {
    const d = doc(PAGES.home);
    for (const code of ["AK", "HI"]) {
      const r = d.querySelector(`#quotes tr[data-s="${code}"]`)!;
      expect(text(r)).toContain("No weekly survey");
      expect(r.querySelector("use")).toBeNull();
    }
    if (site.tax) {
      const cap = text(d.querySelector("#quotes-cap"));
      const stale = site.states.filter((s) => s.tax?.outOfDate).map((s) => s.code);
      const none = site.states.filter((s) => s.tax && s.tax.state === null).map((s) => s.code);
      for (const code of stale) {
        const cells = Array.from(d.querySelectorAll(`#quotes tr[data-s="${code}"] td`)).map(text);
        expect(cells, code).toContain("old");
        expect(cap).toContain(code);
      }
      for (const code of none) {
        const cells = Array.from(d.querySelectorAll(`#quotes tr[data-s="${code}"] td`)).map(text);
        expect(cells, code).toContain("unknown");
        expect(cap).toContain(code);
      }
      if (stale.length) expect(cap).toContain("Old means our source's rate is out of date");
      if (none.length) expect(cap).toContain("Unknown means our source has no rate");
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
    const scripts = inlineScripts(page);
    expect(scripts.length).toBeGreaterThan(3);
    expect(gz(scripts.join("\n"))).toBeLessThan(3 * 1024);
  });
});

describe("the production build, the one Vercel ships", () => {
  // with an existing plain build named and no production one, there is nothing to read
  const noProd = Boolean(process.env.DAILYFUEL_BUILT_DIR) && !process.env.DAILYFUEL_BUILT_PROD_DIR;

  it.skipIf(noProd)("stays inside the same budgets with the analytics script on the page", () => {
    const page = readFileSync(resolve(prod, PAGES.home), "utf8");
    expect(gz(page)).toBeLessThan(20 * 1024);
    // the analytics tag has no body; what it adds to the inline scripts is nothing
    expect(gz(inlineScripts(page).join("\n"))).toBeLessThan(3 * 1024);
    for (const file of [PAGES.ohio, PAGES.tennessee, PAGES.alaska]) {
      const state = readFileSync(resolve(prod, file), "utf8");
      expect(gz(state), file).toBeLessThan(12 * 1024);
      expect(gz([...state.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n")), file).toBeLessThan(3 * 1024);
    }
  });

  it.skipIf(noProd)("loads Vercel's own analytics script and nothing else from anywhere, with no queue stub", () => {
    for (const file of Object.values(PAGES)) {
      const d = parseHTML(readFileSync(resolve(prod, file), "utf8")).document;
      expect(Array.from(d.querySelectorAll("script[src]")).map((s) => s.getAttribute("src")), file).toEqual(["/_vercel/insights/script.js"]);
      expect(d.querySelector("script[src]")!.hasAttribute("defer")).toBe(true);
      // the site never calls va(), so the stub Vercel's snippet starts with stays out
      for (const s of Array.from(d.querySelectorAll("script:not([src])"))) expect(s.textContent, file).not.toMatch(/window\.va\b/);
    }
  });
});

describe("the state page", () => {
  const site = getSite();

  it("prints Ohio's answer block: the price, the move in words, whose average it is and which week", () => {
    const d = doc(PAGES.ohio);
    const oh = site.byCode.get("OH")!;
    expect(text(d.querySelector("h1 .sym"))).toBe("OH");
    expect(text(d.querySelector("h1 .nmbig"))).toBe("Ohio");
    expect(text(d.querySelector(".back a"))).toBe("All states");
    // lands on the home page's ALL STATES table
    expect(d.querySelector(".back a")!.getAttribute("href")).toBe("/#states");
    // one slot for Save as my state and Your saved state, from the first paint
    const mine = d.querySelector(".head-row [data-mine]")!;
    expect(text(mine.querySelector("button.btn"))).toBe("Save as my state");
    expect(mine.querySelector("button")!.getAttribute("type")).toBe("button");
    expect(text(mine.querySelector(".saved[tabindex='-1']"))).toBe("Your saved state");
    const big = d.querySelector("main > .big")!;
    expect(text(big.firstElementChild)).toBe(formatPrice(oh.primary!.price));
    const move = big.querySelector(".d");
    if (move) expect(text(move)).toMatch(/^[+−]\d+\.\d¢ [+−]?\d+\.\d%$/);
    const chw = d.querySelector("main > .chw")!;
    expect(chw.previousElementSibling).toBe(big);
    expect(text(chw)).toMatch(/^(Up|Down) (\d+\.\d¢|\$\d\.\d{3}) from \$\d\.\d{3} last week\.$|^No change from last week\.$/);
    expect(text(chw.querySelector("b"))).toBe(changeWords(oh.primary!.change!));
    // only the change itself wears red or blue
    expect(chw.querySelectorAll(".up, .down, .muted")).toHaveLength(1);
    expect(chw.querySelector("b")!.getAttribute("class")).toMatch(/^(up|down|muted)$/);
    expect(text(d.querySelector(".plate"))).toBe("Midwest average, same in 15 states");
    const week = text(d.querySelector(".head-row.line .wkl"));
    expect(week).toMatch(/^Prices for the week of \w{3} \d{1,2}, \d{4}\. (New prices \w{3}, \w{3} \d{1,2}\.|New prices are late\.)$/);
    expect(d.querySelector(".head-row.line [data-next-release][data-late]")).not.toBeNull();
    for (const note of Array.from(d.querySelectorAll("main > .note")).map(text)) {
      if (note.startsWith("Highest")) expect(note).toMatch(/^Highest Midwest price in (our records, which start June 2022|52 weeks|the past year)\.$/);
    }
    expect(d.querySelector("header [data-share] button")!.getAttribute("data-text")).toMatch(/^Diesel in Ohio's region, the Midwest, averaged \$\d\.\d{3} a gallon this week, (down|up) \d+\.\d cents\. Weekly DOE price\.$|, no change\. Weekly DOE price\.$/);
    expect(text(d.querySelector("title"))).toMatch(/^Ohio diesel: Midwest average \$\d\.\d{3}, (down \d+\.\d¢|up \d+\.\d¢|no change) \| DailyFuel$/);
  });

  it("puts no source link above the chart, and folds the AAA link, the DOE line and the dyed diesel line into the tax section", () => {
    const d = doc(PAGES.ohio);
    const aaa = d.querySelector("a[href='https://gasprices.aaa.com/?state=OH']")!;
    expect(text(aaa)).toBe("Check today's Ohio average on AAA's website");
    const fold = aaa.closest("details.more")!;
    expect(fold).not.toBeNull();
    expect(fold.closest("section[aria-labelledby=tax-title]")).not.toBeNull();
    expect(text(fold.querySelector("summary.btn.wide"))).toBe("What the price and tax include");
    expect(fold.hasAttribute("open")).toBe(false);
    const inside = text(fold);
    expect(inside).toContain(DOE_LINE);
    expect(inside).toContain("Dyed farm diesel is untaxed");
    // nothing from aaa.com before the chart
    const chart = d.querySelector("section.ch")!;
    for (const a of Array.from(d.querySelectorAll("main a[href*='aaa.com']"))) expect(chart.compareDocumentPosition(a) & 4, a.outerHTML).toBeTruthy();
  });

  it("says the tax vintage in plain words in the fold", () => {
    // the plan: taxVintage starts "From the 2024 federal highway table." (no agency initials)
    const d = doc(PAGES.ohio);
    const fold = text(d.querySelector("section[aria-labelledby=tax-title] details.more"));
    expect(fold).toMatch(new RegExp(String.raw`From the ${site.tax!.reporting_period} federal highway table\.`));
    expect(fold).not.toMatch(/FHWA/);
  });

  it("lists the bordering states next door, lowest first, with this state and the U.S. average in place and no colour", () => {
    for (const code of ["OH", "TN", "KY", "DC", "MN", "CA"]) {
      const s = site.byCode.get(code)!;
      const d = doc(`state/${s.slug}/index.html`);
      const nd = d.querySelector("section.nd[aria-labelledby=nd-title]")!;
      expect(nd, code).not.toBeNull();
      expect(text(nd.querySelector("h2#nd-title"))).toBe("Next door");
      const short = code === "DC" ? "DC" : s.name;
      expect(text(nd.querySelector(".sh .meta"))).toBe(`Compared with ${short}, lowest first`);
      const near = (NEIGHBORS[code] ?? []).map((c) => site.byCode.get(c)!).filter((n) => n.primary);
      const order = [...near, s].sort((a, b) => toMills(a.primary!.price) - toMills(b.primary!.price) || (a === s ? -1 : b === s ? 1 : a.name.localeCompare(b.name)));
      const items = Array.from(nd.querySelectorAll("ul.nd-l > li"));
      expect(items).toHaveLength(order.length + 1);
      order.forEach((n, i) => {
        const li = items[i];
        const cells = [text(li.querySelector(".n")), text(li.querySelector("b")), text(li.querySelector(".v"))];
        if (n === s) {
          expect(li.getAttribute("class"), code).toBe("me");
          expect(li.querySelector("a")).toBeNull();
          expect(cells).toEqual([short, formatPrice(s.primary!.price), "This state"]);
        } else {
          expect(li.querySelector("a")!.getAttribute("href"), code).toBe(n.href);
          expect(cells).toEqual([n.code === "DC" ? "DC" : n.name, formatPrice(n.primary!.price), diffWords(n.primary!.price, s.primary!.price)]);
        }
      });
      const us = items[items.length - 1];
      expect(us.getAttribute("class")).toBe("us");
      expect(us.querySelector("a")!.getAttribute("href")).toBe("/");
      expect([text(us.querySelector(".n")), text(us.querySelector("b")), text(us.querySelector(".v"))]).toEqual(["U.S. average", formatPrice(site.eiaUs!.price), diffWords(site.eiaUs!.price, s.primary!.price)]);
      // places compared are not changes over time
      expect(nd.querySelector(".up, .down")).toBeNull();
      // and they are regional averages, never pump prices
      expect(text(nd.querySelector("p.cap"))).toMatch(/^Each price is the weekly average for that state's region, not a pump price\./);
      const mates = regionMates(s, site).map((m) => m.code).sort();
      const codes = nd.querySelector("p.cap.codes");
      if (mates.length) {
        expect(text(codes)).toMatch(new RegExp(`^Same price as ${short} in \\d+ (other )?states: `));
        expect(Array.from(codes!.querySelectorAll("a")).map((a) => [text(a), a.getAttribute("href")])).toEqual(mates.map((c) => [c, `/state/${c.toLowerCase()}/`]));
      } else {
        expect(codes, code).toBeNull();
      }
      const stops = nd.querySelector("a.btn.wide[href^='/map/']")!;
      expect(stops.getAttribute("href")).toBe(`/map/#${s.slug}`);
      expect(text(stops)).toBe(`Truck stops in ${short}`);
    }
    const oh = doc(PAGES.ohio);
    expect(text(oh.querySelector(".nd-l li .n"))).toBe("West Virginia");
    expect(text(oh.querySelector(".nd .cap"))).toBe("Each price is the weekly average for that state's region, not a pump price. Pennsylvania is in the Central Atlantic region and West Virginia is in the Lower Atlantic region.");
    // California is the one state EIA prices on its own: never "the California region", on its page or its neighbours'
    const az = doc("state/az/index.html");
    expect(text(az.querySelector(".nd .cap"))).toBe("Each price is the weekly average for that state's region, not a pump price. California has its own average. New Mexico is in the Gulf Coast region and Utah is in the Rocky Mountain region.");
    expect(text(doc("state/ca/index.html").querySelector(".nd .cap"))).toBe("Each price is the weekly average for that state's region, not a pump price. California has its own average. Arizona, Nevada and Oregon are in the West Coast outside California region.");
    for (const c of ["ca", "nv", "or"]) {
      const cap = text(doc(`state/${c}/index.html`).querySelector(".nd .cap"));
      expect(cap, c).toContain("California has its own average.");
      expect(cap, c).not.toContain("the California region");
    }
    expect(text(doc("state/wa/index.html").querySelector(".nd .cap"))).not.toContain("California");
    // the old 14 row same price tax table is gone
    expect(oh.querySelector("section.peers")).toBeNull();
  });

  it("draws the two charts behind a CSS only range switch, with the numbers under them", () => {
    const d = doc(PAGES.ohio);
    const section = d.querySelector("section.ch")!;
    expect(text(section.querySelector("h2"))).toBe("Midwest price history");
    const kids = Array.from(section.children);
    expect(kids[0].matches("input[type=radio]#r1[checked]")).toBe(true);
    expect(kids[1].matches("input[type=radio]#r2")).toBe(true);
    expect(kids[2].matches(".sh")).toBe(true);
    expect(kids[0].getAttribute("aria-label")).toBe("Price chart, past year");
    expect(kids[1].getAttribute("aria-label")).toMatch(/^Price chart, since /);
    expect(Array.from(section.querySelectorAll(".rng label")).map(text)).toEqual(["Past year", "Since June 2022"]);
    const plots = Array.from(section.querySelectorAll(".plot[data-from][data-to]"));
    expect(plots).toHaveLength(2);
    for (const p of plots) {
      expect(p.getAttribute("tabindex")).toBe("0");
      expect(p.getAttribute("aria-label")).toMatch(/^Midwest weekly diesel price\b.* Now \$\d\.\d{3}.* High \$\d\.\d{3}.* Low \$\d\.\d{3}.* Every week is in the table below\.$/);
      expect(p.querySelectorAll("path.grid, path.ln, path.pt")).toHaveLength(3);
      for (const y of Array.from(p.querySelectorAll(".yl")).map(text)) expect(y).toMatch(/^\$\d\.\d{2}$/);
      expect(text(p.querySelector(".ytag"))).toBe(text(d.querySelector("main > .big")!.firstElementChild).slice(1));
    }
    for (const x of Array.from(plots[0].querySelectorAll(".xl")).map(text)) expect(x).toMatch(/^(Jan|Apr|Jul|Oct)$/);
    for (const x of Array.from(plots[1].querySelectorAll(".xl")).map(text)) expect(x).toMatch(/^20\d\d$/);
    const readouts = Array.from(section.querySelectorAll(".rdout"));
    expect(readouts).toHaveLength(2);
    expect(text(readouts[0].querySelector(".rd-v"))).toMatch(/^\$\d\.\d{3}$/);
    for (const r of readouts) expect(text(r.querySelector(".rd-t"))).toBe("Slide a finger along the line to read a week.");
    // the table twin, which the readout script reads its numbers from
    const table = d.querySelector(".numbers table")!;
    expect(text(d.querySelector(".numbers summary"))).toBe("Show the numbers");
    expect(Array.from(table.querySelectorAll("thead th")).map(text)).toEqual(["Week of", "Price $"]);
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    expect(rows.length).toBeGreaterThan(200);
    expect(text(rows[0].querySelector("td"))).toMatch(/^\w{3} \d{1,2}, \d{4}$/);
    expect(text(rows[0].querySelector("td.v"))).toBe(text(plots[0].querySelector(".ytag")));
  });

  it("boxes then and now in words, and the tax with the key fact first", () => {
    const d = doc(PAGES.ohio);
    const stats = d.querySelectorAll("dl.stats");
    expect(stats).toHaveLength(2);
    expect(text(d.querySelector("h2#stats-title"))).toBe("Then and now");
    expect(text(d.querySelector("h2#stats-title + .meta"))).toBe("Midwest average, dollars a gallon");
    expect(Array.from(stats[0].querySelectorAll("dt")).map(text)).toEqual(["4 weeks ago", "A year ago", "Past year high", "Past year low"]);
    const values = Array.from(stats[0].querySelectorAll("dd:not(.s)")).map(text);
    for (const v of values) expect(v).toMatch(/^\$\d\.\d{3}$/);
    const subs = Array.from(stats[0].querySelectorAll("dd.s")).map(text);
    expect(subs[0]).toMatch(/^((Up|Down) (\d+\.\d¢|\$\d\.\d{3})|No change) since then$/);
    expect(subs[1]).toMatch(/^((Up|Down) (\d+\.\d¢|\$\d\.\d{3})|No change) since then$/);
    expect(subs[2]).toMatch(/^Week of [A-Z][a-z]{2} \d{1,2}$/);
    expect(subs[3]).toMatch(/^Week of [A-Z][a-z]{2} \d{1,2}$/);
    // the coloured words sit inside the grey line, and only on the two changes
    expect(stats[0].querySelectorAll(".up, .down, .muted").length).toBeLessThanOrEqual(2);
    for (const el of Array.from(stats[0].querySelectorAll(".up, .down"))) expect(el.parentElement!.matches("dd.s")).toBe(true);
    expect(text(d.querySelector("h2#tax-title"))).toBe("Tax");
    expect(text(d.querySelector("h2#tax-title + .meta"))).toMatch(/^Cents a gallon, \d{4} federal table$/);
    const tin = d.querySelector("section[aria-labelledby=tax-title] p.tin")!;
    expect(text(tin)).toBe("Tax is already in the pump price above.");
    expect(tin.nextElementSibling).toBe(stats[1]);
    expect(Array.from(stats[1].querySelectorAll("dt")).map(text)).toEqual(["Ohio tax", "Federal tax", "Total tax", "Rank"]);
    for (const dd of Array.from(stats[1].querySelectorAll("dd:not(.s)")).slice(0, 3)) expect(text(dd)).toMatch(/^\d+\.\d+¢$/);
    expect(text(stats[1].querySelectorAll("dd:not(.s)")[3])).toMatch(/^(\d+(st|nd|rd|th) (highest|lowest)|Highest|Lowest)$/);
    expect(Array.from(stats[1].querySelectorAll("dd.s")).map(text)).toEqual([
      expect.stringMatching(/^Rate set [A-Z][a-z]+ \d{4}$/),
      "Same in every state",
      "State plus federal",
      expect.stringMatching(/^Out of \d+ states ranked$/),
    ]);
    // no agency table codes outside the fold
    const outside = text(d.querySelector("section[aria-labelledby=tax-title]")).replace(text(d.querySelector("section[aria-labelledby=tax-title] details.more")), "");
    expect(outside).not.toMatch(/MF-121T|FHWA/);
  });

  it("says DC is not listed and Minnesota is out of date, with no total and no rank", () => {
    const dc = doc(PAGES.dc);
    const dcTax = dc.querySelectorAll("dl.stats")[1];
    expect(text(dcTax.querySelector("dt"))).toBe("DC tax");
    expect(Array.from(dcTax.querySelectorAll("dd.w")).map(text)).toEqual(["Not listed", "Unknown", "Not ranked"]);
    expect(text(dcTax.querySelector("dd.s"))).toBe("Not in our source");
    const mn = doc(PAGES.minnesota);
    const mnTax = mn.querySelectorAll("dl.stats")[1];
    expect(text(mnTax.querySelector("dt"))).toBe("Minnesota tax");
    expect(Array.from(mnTax.querySelectorAll("dd.w")).map(text)).toEqual(["Out of date", "Unknown", "Not ranked"]);
    expect(text(mnTax.querySelector("dd.s"))).toBe("Our source is out of date");
    expect(text(mn.querySelector("section[aria-labelledby=tax-title]"))).toContain("out of date");
  });

  it("gives California its own plate and no same price list", () => {
    const d = doc(PAGES.california);
    expect(text(d.querySelector(".plate"))).toBe("California's own average");
    expect(d.querySelector("section.peers, .nd .codes")).toBeNull();
    expect(d.querySelector("header [data-share] button")!.getAttribute("data-text")).toMatch(/^California diesel averaged \$\d\.\d{3} a gallon this week/);
  });

  it("gives Alaska an honest headline, a rough guide that says it is one, and somewhere to go", () => {
    const d = doc(PAGES.alaska);
    const big = d.querySelector("main > .big")!;
    expect(text(big)).toBe("No weekly price");
    expect(big.getAttribute("class")).toBe("big np");
    expect(d.querySelector(".plate, main > .chw")).toBeNull();
    // no number that reads as Alaska's
    expect(text(big)).not.toMatch(/\$/);
    const notes = Array.from(d.querySelectorAll("main > .note"));
    expect(text(notes[0])).toMatch(/^The government's weekly survey does not cover Alaska, so we have no Alaska price\. (For a rough guide only, the whole West Coast, California included, averaged \$\d\.\d{3} this week(, (up|down) \d+\.\d¢ from last week|, no change from last week)?\.|The nearest region it does cover is the West Coast\.)$/);
    const us = d.querySelector("main > .note a[href='/']")!;
    expect(text(us)).toBe(`U.S. average ${formatPrice(site.eiaUs!.price)} this week`);
    const stops = d.querySelector("main > .note a.btn.wide")!;
    expect(stops.getAttribute("href")).toBe("/map/#ak");
    expect(text(stops)).toBe("Truck stops in Alaska");
    // no release line for a state with no weekly number
    expect(d.querySelector("main [data-next-release]")).toBeNull();
    expect(d.querySelector(".plot, .numbers, section.peers, section.nd")).toBeNull();
    const tax = d.querySelector("dl.stats")!;
    expect(text(tax.querySelector("dt"))).toBe("Alaska tax");
    expect(d.querySelectorAll("dl.stats")).toHaveLength(1);
    // the save slot stays, so an Alaska driver can save Alaska
    expect(d.querySelector("[data-mine] button")).not.toBeNull();
    expect(d.querySelector("header [data-share] button")!.getAttribute("data-text")).toMatch(/^The government's weekly survey does not cover Alaska, so there is no Alaska price\./);
  });

  it("saves a state only when Save as my state is tapped, and keeps the scripts small", () => {
    for (const file of [PAGES.ohio, PAGES.alaska]) {
      const page = html(file);
      expect(page).toContain('"dailyfuel:state"');
      expect(page).toContain("data-mine");
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
      expect(gz(scripts)).toBeLessThan(3 * 1024);
    }
    const { document: d, Event } = parseHTML(html(PAGES.ohio)) as unknown as { document: Document; Event: typeof globalThis.Event };
    const slot = d.querySelector("[data-mine]")!;
    // the script sits right after the head row, so the slot is right before the price paints
    const script = slot.closest(".head-row")!.nextElementSibling!;
    expect(script.tagName).toBe("SCRIPT");
    // another state saved: opening Ohio leaves it alone and offers the button
    const other = fakeStore({ "dailyfuel:state": "WV" });
    runInline(script.textContent!, d, other.store);
    expect(other.writes).toEqual([]);
    expect(slot.getAttribute("data-mine")).toBe("n");
    // a first ever visit saves nothing either
    const fresh = fakeStore();
    const d2 = doc(PAGES.ohio);
    runInline(script.textContent!, d2, fresh.store);
    expect(fresh.writes).toEqual([]);
    // back on the page that had West Virginia saved: a tap saves Ohio, and the slot says so
    slot.querySelector("button")!.dispatchEvent(new Event("click"));
    expect(other.writes).toEqual(["dailyfuel:state=OH"]);
    expect(slot.getAttribute("data-mine")).toBe("y");
  });

  it("stays under 12 KB gzip, Tennessee with its 8 neighbours included", () => {
    for (const file of [PAGES.ohio, PAGES.minnesota, PAGES.california, PAGES.tennessee, "state/mo/index.html", PAGES.alaska]) {
      expect(gz(html(file)), file).toBeLessThan(12 * 1024);
      expect(gz([...html(file).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n")), file).toBeLessThan(3 * 1024);
    }
  });
});

describe("the 404 page", () => {
  it("says the page doesn't exist in plain words and shows the Find your state list, open, saving a pick for the home page", () => {
    const d = doc(PAGES.missing);
    const back = d.querySelector(".back a")!;
    expect(text(back)).toBe("All states");
    expect(back.getAttribute("href")).toBe("/#states");
    expect(Array.from(d.querySelectorAll("main p")).map(text)).toContain("This page doesn't exist. Pick your state below.");
    const find = d.querySelector("details[data-ys-find]")!;
    expect(find.hasAttribute("open")).toBe(true);
    expect(find.querySelectorAll("a[data-ys-pick]")).toHaveLength(51);
    // the strip's lines are the home page's; here the list is just links
    expect(find.querySelector("[data-px]")).toBeNull();
    expect(html(PAGES.missing)).toContain("[data-ys-list]");
  });
});

describe("the about page", () => {
  it("goes back to all states without a mark, and says the tax is already in the price", () => {
    const d = doc(PAGES.about);
    const back = d.querySelector(".back a")!;
    expect(text(back)).toBe("All states");
    expect(back.getAttribute("href")).toBe("/#states");
    expect(text(d.querySelector("main"))).toMatch(/Both are already in the pump price\./);
  });
});
