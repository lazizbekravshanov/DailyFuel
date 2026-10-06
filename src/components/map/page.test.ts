// Checks on the built /map page: what it loads (Leaflet from our own
// origin, the base map's tiles from their one host and nothing from
// anywhere else), what it says with JS off (the
// legend, the coverage, the credits, the whole list), the find row and the
// trip's wording, the data the script reads, and the weight of everything the page
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
import { baseMap } from "./page.ts";

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

  it("loads Leaflet from its own origin, the base map's tiles from their one host, and nothing from anywhere else", () => {
    const d = doc();
    expect(Array.from(d.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))).toEqual(["/vendor/leaflet/leaflet.js"]);
    expect(d.querySelector("script[src]")!.hasAttribute("defer")).toBe(true);
    expect(Array.from(d.querySelectorAll("link[rel='stylesheet']")).map((l) => l.getAttribute("href"))).toEqual(["/vendor/leaflet/leaflet.css"]);
    const page = html();
    for (const m of page.matchAll(/<(?:script|img|iframe)[^>]*\ssrc="([^"]+)"|<link[^>]*rel="(?:stylesheet|preload|modulepreload|icon)"[^>]*\shref="([^"]+)"/g)) {
      expect(m[1] ?? m[2], m[0]).not.toMatch(/^(https?:)?\/\//);
    }
    expect(page).not.toMatch(/@import|url\((https?:)?\/\/|unpkg|cdnjs|jsdelivr/);
    expect(page).not.toContain("_vercel/insights");
    // the one inline module runs after the deferred Leaflet script
    const modules = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
    expect(modules).toHaveLength(1);
    expect(page.indexOf("/vendor/leaflet/leaflet.js")).toBeLessThan(modules[0].index!);
    // the script fetches only its own files
    const fetches = [...modules[0][1].matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/^`\/map\/\$\{\w+\}\.json`$/);
    // the script names no host; the base map's tile URL comes from the config, and is the page's one other host
    expect(modules[0][1]).not.toMatch(/https?:\/\//);
    const cfg = JSON.parse(d.getElementById("mapcfg")!.textContent!);
    const origin = new URL(cfg.tl.replace(/\{\w+\}/g, "0")).origin;
    expect(["https://tile.openstreetmap.org", "https://a.basemaps.cartocdn.com"]).toContain(origin);
    expect(d.querySelector('link[rel="preconnect"]')!.getAttribute("href")).toBe(origin);
    // street level, with the freight roads hidden past 10 by the CSS
    expect(modules[0][1]).toContain("maxZoom:16");
    // the one thing the browser is asked for besides the page's own files is the phone's place, and only on Near me
    expect(modules[0][1].match(/\.locate\(/g)).toHaveLength(1);
    expect(page).not.toMatch(/aaa\.com/);
    // the popup's Open in Maps link is a pin search, never directions, and comes from the config
    expect(cfg.gm).toBe("https://www.google.com/maps/search/?api=1&query=");
    expect(modules[0][1]).toContain("Open in Maps");
    expect(modules[0][1]).not.toMatch(/maps\/dir|google\.com/);
  });

  it("lets one finger scroll the page on a phone, zooms in on a far out tap, and opens the nearest dot close in", () => {
    const script = [...html().matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0][1];
    // one finger scrolls the page; two move and zoom the map
    expect(script).toMatch(/dragging:![\w$]+\.Browser\.mobile/);
    // below zoom 6 a tap on a phone zooms in two levels on the spot, so 3 goes to 5 and 5 to 7
    expect(script).toMatch(/[\w$]+\.Browser\.mobile&&([\w$]+)<6\)return [\w$]+\.setView\([\w$]+\.latlng,\1\+2\)/);
    // from 6 the tap opens the nearest switched on dot, measured on screen from the finger: Leaflet's own
    // point for a small marker's event is the marker's spot, which would always pick the dot drawn on top
    expect(script).toMatch(/\.mouseEventToLayerPoint\([\w$]+\.originalEvent\)/);
    expect(script).toMatch(/\.on\?[\w$]+\.m\._point\.distanceTo\([\w$]+\):1e9/);
    expect(script).not.toContain(".layerPoint");
    // the dot hit, the bigger lettered one when two overlap, keeps a 1px lead
    expect(script).toMatch(/[\w$]+=[\w$]+\.layer\.p,[\w$]+=[\w$]+\([\w$]+\)-1[;,]/);
    // a found town and Near me land at zoom 9, where the stops are told apart
    expect(script).toMatch(/setView\(\[[\w$]+\.lat,[\w$]+\.lon\],9\)/);
    expect(script).toContain("locate({setView:!0,maxZoom:9})");
    // the map opens on the state in the address or the saved one, and a trip in the address comes back
    expect(script).toContain("dailyfuel:state");
    expect(script).toMatch(/replaceState\(null,"","#"\+encodeURIComponent\(/);
  });

  it("keeps a bad address, an empty box and a refused location from leaving the driver guessing", () => {
    const script = [...html().matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0][1];
    // a malformed address (#100%) can't stop the roads or a trip from loading
    expect(script).toMatch(/try\{[\w$]+=decodeURIComponent\([\w$]+\.location\.hash\.slice\(1\)\)\}catch/);
    // an anchor on the page (#credits) is not a state: the saved state is tried next
    expect(script).toMatch(/[\w$]+\([\w$]+\)\|\|[\w$]+\([\w$]+\.localStorage\.getItem\("dailyfuel:state"\)\)/);
    // Show with nothing typed asks for a town, and never quotes an empty box
    expect(script).toContain('"Type a town or state."');
    // Near me scrolls to the map only once the phone says where it is; a refusal stays by the find box
    expect(script).toMatch(/locate\(\{setView:!0,maxZoom:9\}\)\}/);
    expect(script).toMatch(/on\("locationfound",\(\)=>\w+\.scrollIntoView\(\)\)/);
    expect(script).toMatch(/on\("locationerror",\(\)=>\{\w+\("Your phone did not share where you are\. Type a town instead\."\),\w+\.scrollIntoView\(/);
  });

  it("finds a town or a state from a row above the map, with Near me, and nothing to press until the script runs", () => {
    const d = doc();
    expect(text(d.querySelector("h1.mp-h"))).toBe("Truck stops and weigh stations");
    expect(text(d.querySelector(".mp-in"))).toBe("Zoom in, then tap a dot to see what it is. Not every truck stop or scale is on the map.");
    const fd = d.getElementById("fd")!;
    expect(fd.querySelector("fieldset")!.hasAttribute("disabled")).toBe(true);
    const q = fd.querySelector('input[name="q"]')!;
    expect(q.getAttribute("placeholder")).toBe("Town or state");
    expect(q.getAttribute("list")).toBe("pl");
    // a visible name or a hidden label for every control
    expect(text(fd.querySelector("label"))).toBe("Town or state");
    expect(Array.from(fd.querySelectorAll("button")).map(text)).toEqual(["Show", "Near me"]);
    expect(fd.querySelector("[data-near]")!.getAttribute("type")).toBe("button");
    expect(d.getElementById("fd-st")!.getAttribute("role")).toBe("status");
    // the find row comes before the map, and the trip after it
    const page = html();
    expect(page.indexOf('id="fd"')).toBeLessThan(page.indexOf('id="map"'));
    expect(page.indexOf('id="map"')).toBeLessThan(page.indexOf('id="trip"'));
    expect(text(d.querySelector(".mp-tip"))).toBe("Use two fingers to move the map, or tap + and −.");
  });

  it("keeps every media query in a form older phones read", () => {
    expect(html()).not.toMatch(/\((?:width|height)\s*[<>]/);
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

  it("stays inside its budget: under 170 KB gzip for everything it loads, the script under 6.5 KB", () => {
    const page = html();
    const script = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0][1];
    expect(gz(script)).toBeLessThan(6.5 * KB);
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
    expect(Array.from(d.querySelectorAll("#ls thead th")).map(text)).toEqual(["Name", "Type", "State"]);
    // the list is in the build's order and offers no sorting
    expect(d.querySelector("#ls th[aria-sort], #ls th[data-sort]")).toBeNull();
    // a name says the highway beside it, when there is one; the script reads it from the cell
    const near = data.points.filter((p) => p.highway).length;
    expect(near).toBeGreaterThan(data.points.length / 2);
    const names = rows.map((r) => text(r.querySelector("td")));
    const want = data.points.map((p) => (p.name + (p.highway ? `, near ${p.highway.split(",")[0]}` : "")).replace(/\s+/g, " ").trim());
    expect(names.filter((n, i) => n !== want[i]).length).toBe(0);
    expect(names.filter((n) => n.includes(", near ")).length).toBe(near);
    expect(rows.some((r) => r.hasAttribute("data-h"))).toBe(false);
    expect(text(d.querySelector(".mp-ls"))).toContain("Every place on the map. With the map on, the list shows what is in view.");
    // nothing to tick, type or press until the script runs
    for (const cb of Array.from(d.querySelectorAll("input[data-k]"))) expect(cb.hasAttribute("disabled")).toBe(true);
    expect(d.querySelector("#rt fieldset")!.hasAttribute("disabled")).toBe(true);
    expect(d.querySelector("#fd fieldset")!.hasAttribute("disabled")).toBe(true);
    expect(text(d.querySelector("#map .mp-msg"))).toBe("The map needs JavaScript. Every place on it is in the list below.");
  });

  it("keys every chain and layer in the legend with its count, and says how much of each chain it has", () => {
    const d = doc();
    const items = Array.from(d.querySelectorAll(".lg-i"));
    const want = [...CHAINS.map((c) => [c.name, data.counts[c.key] ?? 0]), ["Weigh stations", data.counts.w]];
    if (data.counts.v) want.push(["Repair and lube", data.counts.v]);
    expect(items.map((i) => [text(i.querySelector("span:not(.key):not(.n)")), Number(text(i.querySelector(".n")).replace(/,/g, ""))])).toEqual(want);
    for (const ch of CHAINS) expect(text(d.querySelector(`input[data-k="${ch.key}"] + .key`))).toBe(ch.letter);
    const lg = d.querySelector(".mp-lg")!;
    // on a phone the key folds behind one button; with CSS off or on a wide screen it is all there
    expect(Array.from(lg.querySelectorAll("label.lgt-l > span")).map(text)).toEqual(["Show the key and filters", "Hide the key and filters"]);
    expect(lg.querySelector("label.lgt-l")!.getAttribute("for")).toBe("lgt");
    expect(lg.querySelector("#lgt")!.getAttribute("type")).toBe("checkbox");
    // that nothing is complete is said outside the fold, under the key
    expect(text(lg)).toContain("Not every truck stop or scale is on the map. A missing dot doesn't mean there is none.");
    const more = lg.querySelector("details.more")!;
    expect(text(more.querySelector("summary"))).toBe("How complete is this map?");
    const coverage = text(more);
    expect(coverage).toContain("How much of each chain's own list of stops is on the map: Love's 70%, Pilot and Flying J 56%, TA 25%");
    expect(coverage).toContain("Some weigh stations are missing.");
    expect(coverage).toContain("not affiliated with or endorsed by any chain");
  });

  it("credits the base map under the map, and every source in full in Map credits on the same page", () => {
    const d = doc();
    const attr = d.querySelector(".mp-mc .mp-attr")!;
    // OpenStreetMap's tiles need only OpenStreetMap's credit beside the map; CARTO's add CARTO's, first
    const links = Array.from(attr.querySelectorAll("a")).map((a) => [a.getAttribute("href"), text(a)]);
    if (baseMap().credit.name === "CARTO") expect(links[0]).toEqual(["https://carto.com/attributions", "© CARTO"]);
    expect(links.slice(-2)).toEqual([
      ["https://www.openstreetmap.org/copyright", "© OpenStreetMap contributors"],
      ["#credits", "Map credits"],
    ]);
    // the full credits, always visible (not folded), with ODbL and every CC BY source named
    const cr = d.querySelector("section.mp-cr")!;
    expect(d.getElementById("credits")!.closest("section")).toBe(cr);
    expect(text(cr.querySelector("h2"))).toBe("Map credits");
    expect(cr.closest("details")).toBeNull();
    const full = cr.querySelector("p.fine")!;
    expect(Array.from(full.querySelectorAll("a")).map((a) => [a.getAttribute("href"), text(a)])).toContainEqual([
      "https://www.openstreetmap.org/copyright",
      "© OpenStreetMap contributors, ODbL",
    ]);
    const t = text(full);
    expect(t).toMatch(/^Base map, map data and stops © OpenStreetMap contributors, ODbL/);
    expect(t).toContain("More weigh stations: U.S. DOT NTAD (public domain) and Iowa DOT (CC BY 4.0).");
    if (data.present.fleet) expect(t).toContain("Weigh station and truck service points: DailyFuel, CC BY 4.0.");
    if (data.present.roads) expect(t).toContain("Roads: NTAD National Highway Freight Network, U.S. DOT BTS, public domain.");
    if (data.present.states) expect(t).toContain("State outlines: U.S. Census Bureau, public domain.");
    if (data.present.places) {
      expect(t).toContain("Place names: GeoNames, CC BY 4.0.");
      expect(full.querySelector('a[href="https://www.geonames.org"]')).not.toBeNull();
    }
    expect(t).toContain("Drawn with Leaflet.");
  });

  it("says the weigh layer includes DailyFuel's own list, and how much of it no open source has", () => {
    const legend = text(doc().querySelector(".mp-lg"));
    if (!data.present.fleet) return expect(legend).not.toContain("DailyFuel's own list");
    const on = data.points.filter((p) => p.kind === "w" && p.sources.includes("f")).length;
    const only = data.points.filter((p) => p.kind === "w" && p.sources === "f").length;
    expect(on).toBeGreaterThan(only);
    expect(legend).toContain(
      `DailyFuel's own list adds more: ${on.toLocaleString("en-US")} of the scales on the map are on it, and ${only.toLocaleString("en-US")} of those are on no open source.`,
    );
    expect(legend).toContain("If you don't see a scale, there may still be one.");
  });

  it("puts the trip's warning right under its result, word for word, and never promises a cheapest stop or a truck route", () => {
    const d = doc();
    const section = d.querySelector("section.mp-rt#trip")!;
    expect(text(section.querySelector("h2"))).toBe("Prices along a trip");
    const cfg = JSON.parse(d.getElementById("mapcfg")!.textContent!);
    expect(text(section.querySelector(".meta"))).toMatch(new RegExp(`^${cfg.wk}( · \\d{4} state tax)?$`));
    expect(cfg.wk).toMatch(/^Week of [A-Z][a-z]{2} \d{1,2}, \d{4} prices$/);
    const note = section.querySelector(".note")!;
    expect(text(note)).toBe(
      "This follows a straight line, not the roads you will drive. Each price is the region's weekly average, and pumps in one state can differ by more than a dollar, so check the chain's website for today's price.",
    );
    // the status and the result sit under the button, where the keyboard can't cover them, and the warning follows at once, never folded
    const all = Array.from(section.children);
    const out = d.getElementById("rt-out")!;
    expect(all.indexOf(d.getElementById("rt-st")!)).toBeLessThan(all.indexOf(out));
    expect(all.indexOf(note)).toBe(all.indexOf(out) + 1);
    expect(note.closest("details")).toBeNull();
    expect(Array.from(section.querySelectorAll("#rt label span")).map(text)).toEqual(["From", "To"]);
    expect(Array.from(section.querySelectorAll("#rt input")).map((i) => i.getAttribute("placeholder"))).toEqual(["Town, like Chicago, IL", "Town, like Denver, CO"]);
    expect(text(section.querySelector('#rt button[type="submit"]'))).toBe("Show prices");
    expect(html()).not.toMatch(/cheapest|truck route/i);
  });

  it("hands the script the 51 states' EIA prices and taxes from the site's own loaders", () => {
    const cfg = JSON.parse(doc().getElementById("mapcfg")!.textContent!);
    expect(cfg.px.map((r: string[]) => r[0])).toEqual(site.states.map((s) => s.code));
    const oh = cfg.px.find((r: string[]) => r[0] === "OH");
    const s = site.byCode.get("OH")!;
    expect(oh[2]).toMatch(/^\$\d\.\d{3}$/);
    expect(oh[5]).toBe("Midwest average, same in 15 states");
    // the move in words, so the trip's prices never rest on a sign, and its colour only when it moved
    for (const r of cfg.px as (string | null)[][]) {
      if (r[3] === null) continue;
      // a move too small to colour stays in plain ink, still in words
      expect(r[3]).toMatch(r[4] === "up" ? /^up (\d+\.\d¢|\$\d\.\d{3})$/ : r[4] === "down" ? /^down (\d+\.\d¢|\$\d\.\d{3})$/ : /^((up|down) \d+\.\d¢|no change)$/);
      if (r[3] === "no change") expect(r[4]).not.toMatch(/^(up|down)$/);
    }
    if (s.eia?.change) expect(oh[3]).toMatch(/^(up|down) /);
    // the config carries no source list any more: the popup no longer prints one
    expect(cfg).not.toHaveProperty("src");
    const ak = cfg.px.find((r: string[]) => r[0] === "AK");
    expect(ak[2]).toBeNull();
    expect(ak[3]).toBeNull();
    expect(ak[4]).toBe("muted");
    expect(cfg.px.find((r: string[]) => r[0] === "HI")[2]).toBeNull();
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

describe("the base map", () => {
  it("is OpenStreetMap's own without a CARTO key, and CARTO's light map with one, the key on every tile", () => {
    expect(baseMap({})).toEqual({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      origin: "https://tile.openstreetmap.org",
      credit: { name: "OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
    });
    expect(baseMap({ CARTO_BASEMAPS_KEY: "  " }).origin).toBe("https://tile.openstreetmap.org");
    const carto = baseMap({ CARTO_BASEMAPS_KEY: "abc 123" });
    expect(carto.url).toBe("https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=abc%20123");
    expect(carto.origin).toBe("https://a.basemaps.cartocdn.com");
    expect(carto.credit.name).toBe("CARTO");
  });
});
