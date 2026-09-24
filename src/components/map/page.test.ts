// Checks on the built /map page: what it loads (Leaflet from our own
// origin, nothing from anywhere else), what it says with JS off (the
// legend, the coverage, the credits, the whole list), the route strip's
// wording, the data the script reads, and the weight of everything the page
// loads against its budget. It builds the site from data/ and data/map into
// tmp/dist-map-test once; DAILYFUEL_MAP_BUILT_DIR names an existing build.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMapData } from "../../lib/mapdata.ts";
import { getSite } from "../../lib/site.ts";
import { CHAINS } from "./chains.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
let dist = process.env.DAILYFUEL_MAP_BUILT_DIR ? resolve(ROOT, process.env.DAILYFUEL_MAP_BUILT_DIR) : "";

beforeAll(() => {
  if (dist) return;
  dist = resolve(ROOT, "tmp/dist-map-test");
  rmSync(dist, { recursive: true, force: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV" && k !== "TEST"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/astro/bin/astro.mjs"), "build", "--outDir", dist, "--silent"], {
    cwd: ROOT,
    env: { ...env, VERCEL_ENV: "" },
    stdio: "pipe",
  });
}, 180_000);

const file = (p: string) => readFileSync(resolve(dist, p));
const html = () => file("map/index.html").toString("utf8");
const doc = () => parseHTML(html()).document;
const gz = (b: Buffer | string) => gzipSync(b, { level: 9 }).length;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const KB = 1024;

describe("the /map page", () => {
  const data = loadMapData();
  const site = getSite();

  it("loads Leaflet from its own origin and nothing from anywhere else", () => {
    const d = doc();
    expect(Array.from(d.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))).toEqual(["/vendor/leaflet/leaflet.js"]);
    expect(d.querySelector("script[src]")!.hasAttribute("defer")).toBe(true);
    expect(Array.from(d.querySelectorAll("link[rel='stylesheet']")).map((l) => l.getAttribute("href"))).toEqual(["/vendor/leaflet/leaflet.css"]);
    const page = html();
    for (const m of page.matchAll(/<(?:script|img|iframe)[^>]*\ssrc="([^"]+)"|<link[^>]*rel="(?:stylesheet|preload|modulepreload|icon)"[^>]*\shref="([^"]+)"/g)) {
      expect(m[1] ?? m[2], m[0]).not.toMatch(/^(https?:)?\/\//);
    }
    expect(page).not.toMatch(/@import|url\((https?:)?\/\/|tile\.openstreetmap|unpkg|cdnjs|jsdelivr/);
    expect(page).not.toContain("_vercel/insights");
    // the one inline module runs after the deferred Leaflet script
    const modules = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
    expect(modules).toHaveLength(1);
    expect(page.indexOf("/vendor/leaflet/leaflet.js")).toBeLessThan(modules[0].index!);
    // the script fetches only its own files
    const fetches = [...modules[0][1].matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/^`\/map\/\$\{\w+\}\.json`$/);
  });

  it("ships Leaflet 1.9.4 as the pinned npm package has it, with its licence and no image rules", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(pkg.devDependencies.leaflet).toBe("1.9.4");
    expect(file("vendor/leaflet/leaflet.js").equals(readFileSync(resolve(ROOT, "node_modules/leaflet/dist/leaflet.js")))).toBe(true);
    expect(file("vendor/leaflet/LICENSE").equals(readFileSync(resolve(ROOT, "node_modules/leaflet/LICENSE")))).toBe(true);
    const css = file("vendor/leaflet/leaflet.css").toString("utf8");
    expect(css).toContain("Leaflet 1.9.4");
    // nothing it would fetch (the one url() left is old IE's VML behaviour, a fragment)
    expect(css).not.toMatch(/url\((?!#)/);
  });

  it("stays inside its budget: under 170 KB gzip for everything it loads, the script under 6 KB", () => {
    const page = html();
    const script = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0][1];
    expect(gz(script)).toBeLessThan(6 * KB);
    const cfg = JSON.parse(doc().getElementById("mapcfg")!.textContent!);
    const sizes: Record<string, number> = {
      page: gz(page),
      "leaflet.js": gz(file("vendor/leaflet/leaflet.js")),
      "leaflet.css": gz(file("vendor/leaflet/leaflet.css")),
    };
    for (const layer of cfg.ly as string[]) sizes[layer] = gz(file(`map/${layer}.json`));
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    expect(total, JSON.stringify(sizes)).toBeLessThan(170 * KB);
    expect(sizes["leaflet.js"] + sizes["leaflet.css"]).toBeLessThan(47 * KB);
    // the page carries every point in its list; the budget gives the points 45 KB and the page 10
    expect(sizes.page).toBeLessThan(55 * KB);
    if (sizes.places) expect(sizes.places).toBeLessThan(15 * KB);
    if (sizes.roads) expect(sizes.roads).toBeLessThan(45 * KB);
    if (sizes.states) expect(sizes.states).toBeLessThan(32 * KB);
  });

  it("writes only the base layers whose source files are there, and tells the script which", () => {
    const cfg = JSON.parse(doc().getElementById("mapcfg")!.textContent!);
    const want = (["states", "roads", "places"] as const).filter((k) => data.present[k]);
    expect(cfg.ly).toEqual(want);
    for (const k of ["states", "roads", "places"] as const) expect(existsSync(resolve(dist, `map/${k}.json`)), k).toBe(data.present[k]);
  });

  it("lists every point with JS off, in rows the script reads its markers from", () => {
    const d = doc();
    const rows = Array.from(d.querySelectorAll("#ls tbody tr"));
    expect(rows).toHaveLength(data.points.length);
    const keys = new Set([...CHAINS.map((c) => c.key), "w", "v"]);
    for (const r of rows) {
      expect(keys.has(r.getAttribute("data-f")!)).toBe(true);
      const [lat, lon] = r.getAttribute("data-l")!.split(",").map(Number);
      expect(lat).toBeGreaterThan(17);
      expect(lon).toBeLessThan(-64);
      expect(r.querySelectorAll("td")).toHaveLength(3);
    }
    expect(text(d.getElementById("ls-n"))).toBe(`${data.points.length.toLocaleString("en-US")} places`);
    expect(Array.from(d.querySelectorAll("#ls thead th")).map(text)).toEqual(["Name", "Type", "St"]);
    expect(d.querySelector('#ls th[aria-sort="ascending"]')!.getAttribute("data-sort")).toBe("st");
    // nothing to tick, type or press until the script runs
    for (const cb of Array.from(d.querySelectorAll("input[data-k]"))) expect(cb.hasAttribute("disabled")).toBe(true);
    expect(d.querySelector("#rt fieldset")!.hasAttribute("disabled")).toBe(true);
    expect(text(d.querySelector("#map .mp-msg"))).toBe("The map needs JavaScript. Every place on it is in the list below.");
  });

  it("keys every chain and layer in the legend with its count, and says how much of each chain it has", () => {
    const d = doc();
    const items = Array.from(d.querySelectorAll(".lg-i"));
    const want = [...CHAINS.map((c) => [c.name, data.counts[c.key] ?? 0]), ["Weigh stations", data.counts.w]];
    if (data.counts.v) want.push(["Truck service", data.counts.v]);
    expect(items.map((i) => [text(i.querySelector("span:not(.key):not(.n)")), Number(text(i.querySelector(".n")).replace(/,/g, ""))])).toEqual(want);
    for (const ch of CHAINS) expect(text(d.querySelector(`input[data-k="${ch.key}"] + .key`))).toBe(ch.letter);
    const legend = text(d.querySelector(".mp-lg"));
    expect(legend).toContain("Share of each chain's own sites on the map: Love's 70%, Pilot and Flying J 56%, TA 25%");
    expect(legend).toContain("Weigh stations are partial.");
    expect(legend).toContain("not affiliated with or endorsed by any chain");
  });

  it("credits every source under the map", () => {
    const d = doc();
    const attr = d.querySelector(".mp-mc .mp-attr")!;
    expect(attr.querySelector("a")!.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(text(attr.querySelector("a"))).toBe("© OpenStreetMap contributors, ODbL");
    const t = text(attr);
    expect(t).toContain(data.present.fleet ? "Weigh stations: OpenStreetMap, U.S. DOT, Iowa DOT and DailyFuel." : "Weigh stations: OpenStreetMap, U.S. DOT and Iowa DOT.");
    if (data.present.roads) expect(t).toContain("Roads: U.S. DOT National Highway Freight Network, public domain.");
    if (data.present.places) expect(t).toContain("Place names: GeoNames, CC BY 4.0.");
  });

  it("puts the route strip's warning above the result, word for word, and never promises a cheapest stop or a truck route", () => {
    const d = doc();
    const section = d.querySelector(".mp-rt")!;
    const note = text(section.querySelector(".note"));
    expect(note).toBe(
      "This is a straight line corridor, not a driving route. Prices are the EIA regional average from Monday; pumps in the same state can run more than a dollar apart. Check the chain's own page for today's price.",
    );
    const all = Array.from(section.children);
    expect(all.indexOf(section.querySelector(".note")!)).toBeLessThan(all.indexOf(d.getElementById("rt-out")!));
    expect(html()).not.toMatch(/cheapest|truck route/i);
  });

  it("hands the script the 51 states' EIA prices and taxes from the site's own loaders", () => {
    const cfg = JSON.parse(doc().getElementById("mapcfg")!.textContent!);
    expect(cfg.px.map((r: string[]) => r[0])).toEqual(site.states.map((s) => s.code));
    const oh = cfg.px.find((r: string[]) => r[0] === "OH");
    const s = site.byCode.get("OH")!;
    expect(oh[2]).toMatch(/^\$\d\.\d{3}$/);
    expect(oh[5]).toBe("EIA Midwest average, 15 states");
    if (s.eia?.change) expect(oh[3]).toMatch(oh[4] === "up" ? /^\+/ : oh[4] === "down" ? /^−/ : /./);
    const ak = cfg.px.find((r: string[]) => r[0] === "AK");
    expect(ak[2]).toBeNull();
    expect(Object.keys(cfg.c)).toEqual(CHAINS.map((c) => c.key));
  });

  it("uses no dash as punctuation and no typed arrow, and carries its own title and description", () => {
    const d = doc();
    const words = text(d.querySelector("main"));
    expect(words).not.toMatch(/[–—]|\s-\s/);
    expect(words).not.toMatch(/[▲▼▴▾△▽◆⬆⬇↑↓→←]/);
    expect(text(d.querySelector("title"))).toBe("Truck stop and weigh station map | DailyFuel");
    const meta = d.querySelector('meta[name="description"]')!.getAttribute("content")!;
    expect(meta).toMatch(/^[\d,]+ truck stops from seven chains and [\d,]+ weigh stations/);
    expect(meta).not.toMatch(/[–—]|\s-\s/);
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute("href")).toBe("https://dailydiesel.vercel.app/map/");
    expect(d.querySelector("h1")).not.toBeNull();
  });

  it("is linked from the header of every page, and marks itself as the page you're on", () => {
    const home = parseHTML(file("index.html").toString("utf8")).document;
    const link = home.querySelector('header a[href="/map/"]')!;
    expect(text(link)).toBe("Map");
    expect(link.hasAttribute("aria-current")).toBe(false);
    expect(doc().querySelector('header a[href="/map/"]')!.getAttribute("aria-current")).toBe("page");
    // the home page loads none of it
    expect(file("index.html").toString("utf8")).not.toMatch(/leaflet|mapcfg/);
  });
});
