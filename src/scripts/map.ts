// The map page's one script: the Leaflet map, the legend's filters, the
// popups, the list twin of what is on screen, and the route strip, whose maths
// and result load with the trip module (src/scripts/trip.ts).
// map.astro bundles it with esbuild into one inline module that runs after
// the deferred Leaflet script, so `L` is there when init runs, or missing
// if Leaflet failed to load, in which case the list, the filters and the
// route strip still work and the map box says the map didn't load.
//
// Everything the markers need is in the list's rows, which the build
// writes and which are the whole list with JS off: data-f the filter key,
// data-l "lat,lon", data-s the sources (o when missing), data-d the
// direction's first letter, data-c the chain whose locator a truck service
// point links to. The rest comes from the page's JSON block (#mapcfg): the
// chains, the sources, the 51 price rows and the bounds. The outlines, the
// roads and the places list load from /map/*.json.
//
// Pure functions are exported for src/scripts/map.test.ts.

import { undelta, type Shape } from "../components/map/geo.ts";
import { esc, fmt, lk } from "./text.ts";

export { esc, fmt };

/** One chain: name, letter, locator. */
export type ChainCfg = [string, string, string];
/** One state for the route strip: code, name, price, move, move class, plate, state tax. */
export type PriceRow = [string, string, string | null, string | null, string, string, string];

export interface Cfg {
  c: Record<string, ChainCfg>;
  px: PriceRow[];
  /** "EIA week of Sep 14, 2026", for the route strip's meta. */
  wk: string;
  /** maxBounds and the lower 48, [[south, west], [north, east]]. */
  mb: [[number, number], [number, number]];
  l48: [[number, number], [number, number]];
  /** the base layers the build wrote: states, roads, places */
  ly: string[];
  /** the base map's tile URL (see baseMap in src/components/map/page.ts) */
  tl: string;
  /** a maps search link the popup ends with lat,lon, so the phone's maps app opens the pin */
  gm: string;
}

export interface Pt {
  i: number;
  tr: HTMLTableRowElement | null;
  /** filter key: a chain, "w" or "v" */
  f: string;
  k: "s" | "w" | "v";
  lat: number;
  lon: number;
  n: string;
  t: string;
  st: string;
  s: string;
  d: string;
  c: string;
  on: boolean;
  /** off the trip's route, so not drawn while a trip is shown */
  x?: number;
  /** the Leaflet marker, once there is a map */
  m?: any;
  sel?: boolean;
  /** its name in the list is a button now */
  b?: number;
}

export const BAND_MI = 25;
/** How far off a highway route a stop may be and still be on it: an exit or two. */
export const ROAD_MI = 5;
/** The trip's route finder and result, a file of its own so the map's first load doesn't pay for it (src/scripts/trip.ts). */
const TRIP = "/map/trip.js";
export const STEP_MI = 5;
const DIRS: Record<string, string> = { n: "north", s: "south", e: "east", w: "west" };

/** A row of the list, read back into a point. */
export function readRow(tr: HTMLTableRowElement, i: number): Pt {
  const a = (k: string) => tr.getAttribute("data-" + k) || "",
    ll = a("l").split(","),
    f = a("f"),
    cells = tr.children;
  return {
    i, tr, f,
    k: f === "w" ? "w" : f === "v" ? "v" : "s",
    lat: +ll[0], lon: +ll[1],
    n: cells[0].textContent || "", t: cells[1].textContent || "", st: cells[2].textContent || "",
    s: a("s") || "o", d: a("d"), c: a("c") || (f === "w" || f === "v" ? "" : f),
    on: true,
  };
}

/** The outlines from /map/states.json, as shapes for point in polygon. */
export function decodeStates(doc: { p: number; s: [string, number[][][], Shape["bbox"]][] }): Shape[] {
  const shapes: Shape[] = [];
  for (const [code, polys, bbox] of doc.s) {
    const coordinates = polys.map((rs) => rs.map((r) => undelta(r, doc.p)));
    const geometry = { type: "MultiPolygon" as const, coordinates };
    shapes.push({ code, geometry, bbox });
  }
  return shapes;
}

/** Delta lines to Leaflet's [lat, lon] lists. */
export const decodeLines = (lines: number[][], p: number): [number, number][][] =>
  lines.map((l) => undelta(l, p).map(([x, y]) => [y, x] as [number, number]));

export interface Places {
  label: string[];
  lat: number[];
  lon: number[];
}

/** /map/places.json back to parallel lists: "Chicago, IL" and its lat and lon. */
export function decodePlaces(doc: { p: number; s: Record<string, [string, number[]]> }): Places {
  const out: Places = { label: [], lat: [], lon: [] };
  for (const st in doc.s) {
    const [names, d] = doc.s[st], ll = undelta(d, doc.p);
    names.split("|").forEach((n, i) => {
      out.label.push(`${n}, ${st}`);
      out.lat.push(ll[i][0]);
      out.lon.push(ll[i][1]);
    });
  }
  return out;
}

type P = { label: string; lat: number; lon: number };

/**
 * A town as typed or as listed, read one way: lowercase; no periods or
 * apostrophes (a phone types ’ for '); a hyphen as a space; single spaces;
 * "dallas,tx" as "dallas, tx" and "denver," as "denver"; and Saint, Fort and
 * Mount as St, Ft and Mt.
 */
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.'’‘ʼʻ]/g, "")
    .replace(/-/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,$/, "")
    .replace(/\b(saint|fort|mount)\b/g, (w) => (w == "saint" ? "st" : w == "fort" ? "ft" : "mt"));

/**
 * What the driver typed, as a place on the list. A state at the end, by code
 * or name, reads the list's way ("dallas texas" is "dallas, tx"), unless the
 * whole text is a listed town's name ("West New York", "Rocky Mount") or the
 * state reading finds nothing. Then the town itself; New York is New York
 * City; a bare name in one state only; then the one place whose name starts
 * with it. A bare name in more than one state, or a start that fits several
 * places ("Plant, FL": Plant City and Plantation), gives the first of them as
 * a string, to ask which. A state's name
 * or code alone is not a town: "Missouri" and "AK" find nothing, and
 * "Wyoming" asks, though Wyoming, MI is on the list. Null when nothing fits.
 */
export function findPlace(q: string, pl: Places | null, states: (string | null)[][] = []): P | string | null {
  const t0 = fold(q);
  if (!t0 || !pl) return null;
  const names = states.map((r) => [r[0]!.toLowerCase(), r[1]!.toLowerCase()]).sort((x, y) => y[1].length - x[1].length),
    state = names.some((r) => r[1] == t0 || r[0] == t0),
    L = pl.label.map(fold),
    at = (i: number) => ({ label: pl.label[i], lat: pl.lat[i], lon: pl.lon[i] }),
    look = (t: string): P | string | null => {
      const [nm, st] = t.split(", "),
        fits = (f: (s: string) => boolean) => L.map((s, i) => [s, i] as [string, number]).filter(([s]) => f(s.split(", ")[0]) && (!st || s.split(", ")[1] == st));
      let hit = fits((s) => s == nm),
        start = 0;
      if (!hit.length && nm == "new york") hit = fits((s) => s == "new york city");
      if (!hit.length && !state) (hit = fits((s) => s.startsWith(nm))), (start = 1);
      if (!hit.length) return null;
      if (state && nm != "new york") return pl.label[hit[0][1]];
      // one town and state listed twice (St. Charles and Saint Charles, MD) is one place
      if (!hit[1] || (st && !start)) return at(hit[0][1]);
      return pl.label[hit[0][1]];
    };
  let t = t0;
  // the longest name first, so "charleston west virginia" isn't read as a town called "charleston west"
  for (const [c, n] of state ? [] : names) {
    const m = t.match(new RegExp(`^(.+?),? ${n}$`));
    if (m) {
      t = `${m[1]}, ${c}`;
      break;
    }
  }
  t = t.replace(/,? ([a-z]{2})$/, ", $1");
  if (t == t0 || t0.includes(",")) return look(t);
  return L.some((s) => s.split(", ")[0] == t0) ? look(t0) : (look(t) ?? look(t0));
}

/** "41.878, −87.630": a point typed or tapped, with a real minus sign. */
export const llText = (lat: number, lon: number): string => `${lat.toFixed(3)}, ${lon.toFixed(3)}`.replace(/-/g, "−");

export interface Run {
  code: string | null;
  from: number;
  to: number;
  hits: { p: Pt; at: number }[];
}

export interface Corridor {
  miles: number;
  line: [number, number][];
  ring: [number, number][];
  runs: Run[];
  /** part of the line runs over water or another country */
  outside: boolean;
  hits: number;
  /** the line follows the freight highways, not a straight line */
  road: boolean;
  /** the miles from a to b in a straight line */
  direct?: number;
  /** a route's straight stretches from each town to the nearest freight highway, in miles */
  ends?: [number, number];
}

type LL = [number, number];

/** A point's popup: its name, what it is and where, the road it is near, a scale's direction, and the chain's own website. */
export function popupHtml(p: Pt, cfg: Cfg): string {
  const ch = p.c ? cfg.c[p.c] : null,
    what = p.k === "s" ? `${p.t} truck stop` : p.t;
  let h = `<div class="pp-in" tabindex="-1"><p class="pp-n"><b>${esc(p.n)}</b><p>${esc(what)}${p.st ? ` in ${p.st}` : ""}`;
  if (p.d) h += `<p>For ${DIRS[p.d]}bound traffic`;
  const r = p.k == "s" && cfg.px.find((x) => x[0] == p.st);
  if (r && r[2]) h += `<p><a href="/state/${p.st.toLowerCase()}/">${esc(r[1])}'s region averages ${r[2]}</a> this week, not this stop's price.`;
  if (ch) h += `<p><a class="btn" href="${esc(ch[2])}">${esc(ch[0])} website</a>`;
  h += `<p><a class="btn" href="${cfg.gm}${p.lat},${p.lon}">Open in Maps</a>`;
  return h + `<p><button class="btn" data-close>Close</button></div>`;
}

/** Marker radius by kind and zoom: bigger with a letter from zoom 6. */
export function radius(k: string, z: number): number {
  const i = z >= 6 ? 2 : z >= 5 ? 1 : 0;
  return (k === "s" ? [4, 5, 8] : k === "w" ? [3.5, 4.5, 6] : [2.5, 3.5, 4.5])[i];
}

/** Sort the points by a column: n name, t type, st state, then name, then state. */
export function sortPts(pts: Pt[], key: "n" | "t" | "st", dir: 1 | -1): Pt[] {
  // the sort is stable and pts is always in list order, so a full tie keeps that order
  return pts.slice().sort((x, y) => (x[key].localeCompare(y[key]) || x.n.localeCompare(y.n) || x.st.localeCompare(y.st)) * dir);
}

// ----------------------------------------------------------------- page --

export function init(doc: Document, win: any): void {
  const cfgEl = doc.getElementById("mapcfg"),
    table = doc.getElementById("ls") as HTMLTableElement | null;
  if (!cfgEl || !table) return;
  const cfg: Cfg = JSON.parse(cfgEl.textContent || "{}"),
    body = table.tBodies[0],
    pts = Array.from(body.rows).map(readRow),
    count = doc.getElementById("ls-n"),
    fold = doc.getElementById("ls-d") as HTMLDetailsElement | null,
    L = win.L,
    box = doc.getElementById("map") as HTMLElement,
    out = doc.getElementById("rt-out") as HTMLElement,
    status = doc.getElementById("rt-st") as HTMLElement,
    form = doc.getElementById("rt") as HTMLFormElement,
    root = doc.documentElement;
  let map: any = null,
    shapes: Shape[] = [],
    // the driver has moved the map (or a find, Near me or a trip has), so the opening view stays out of the way
    moved = 0,
    // the trip shown; fit while its view is still to come, so a rerun from a filter tapped as it loads keeps it
    last: { a: [number, number]; b: [number, number]; al: string; bl: string; fit?: boolean } | null = null,
    back: HTMLElement | null = null,
    // the freight roads, by route: lines, name (empty for an unsigned one), 1 for an interstate; and their labels
    roads: [[number, number][][], string, number][] = [],
    // every freight road line plus the joins, for routing a trip
    net: LL[][] = [],
    labels: [string, number, number, number][] = [];

  // ---- the list: what is on screen, sortable, each name opening its marker
  // Names become buttons 200 rows a task, the top of the list first, so the
  // list opens at once even with every row of the lower 48 in view.
  const todo: Pt[] = [];
  let batch: any = 0;
  const buttons = () => {
    for (const p of todo.splice(0, 200)) p.tr!.cells[0].innerHTML = lk(p.i, p.n);
    batch = todo.length ? setTimeout(buttons) : 0;
  };
  const list = () => {
    const bounds = map && map.getBounds();
    // the whole zoom, for the CSS that shows the route labels by zoom
    if (map) box.setAttribute("data-z", (map.getZoom() | 0) as any); // the DOM makes it a string
    // The rows change only while the list is open, so a move of the map isn't
    // held up by 2,500 rows nobody sees. A row's name becomes a button that
    // opens its stop the first time it shows; a stop a trip hides is left
    // out, as it is from the map.
    const rows = !fold || fold.open;
    let n = 0;
    for (const p of pts) {
      const v = p.on && !p.x && (!bounds || bounds.contains([p.lat, p.lon]));
      if (rows && p.tr && p.tr.hidden === v) p.tr.hidden = !v;
      if (rows && v && map && p.tr && !p.b) todo.push(p), (p.b = 1);
      if (v) n++;
    }
    if (todo.length && !batch) batch = setTimeout(buttons);
    if (count) count.textContent = `${fmt(n)} ${n === 1 ? "place" : "places"}${map ? " in view" : ""}`;
  };
  if (fold) fold.addEventListener("toggle", () => fold.open && list());

  // ---- the legend's filters
  for (const cb of Array.from(doc.querySelectorAll<HTMLInputElement>("input[data-k]"))) {
    cb.disabled = false;
    cb.addEventListener("change", () => {
      const k = cb.getAttribute("data-k");
      for (const p of pts) {
        if (p.f !== k) continue;
        p.on = cb.checked;
        if (p.m) p.m.redraw();
      }
      if (map && !pts.some((p) => p.sel && p.on)) map.closePopup();
      list();
      if (last) run(last.a, last.b, last.al, last.bl, last.fit);
    });
  }
  // ---- the route strip
  // A file of /map/, kept once it has come. One lost on a bad signal, or one
  // that can't be read, is asked for again the next time it is wanted, so one
  // dropped request never breaks the strip for good. A layer the build didn't
  // ship counts as come: without the outlines or the roads a trip is a
  // straight line with no state prices, and without the places no town is
  // found.
  const want = (f: string, use: (d: any) => void) => {
    let p: Promise<boolean> | null = null;
    return () =>
      (p =
        p ||
        (cfg.ly.includes(f)
          ? fetch(`/map/${f}.json`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
              .then((d) => {
                try {
                  if (d) return use(d), true;
                } catch (e) {
                  console.error(e);
                }
                p = null;
                return false;
              })
          : Promise.resolve(true)));
  };
  let places: Places | null = null;
  const loadPlaces = want("places", (d) => {
    const pl = decodePlaces(d);
    // a file that came but holds no towns counts as lost, and is asked for again
    if (!pl.label.length) throw new Error("places.json has no towns");
    places = pl;
    const dl = doc.getElementById("pl");
    if (dl) dl.innerHTML = places.label.map((s) => `<option value="${esc(s)}">`).join("");
  });
  // The outlines, which are not drawn (the base map has the borders) but tell
  // the find box and the route strip which state is which, and the freight
  // roads, drawn on SVG along a trip only (see run), so the page's CSS tokens
  // colour them in both themes. Neither needs the map, so a trip is priced by
  // state even when Leaflet didn't load.
  const loadStates = want("states", (st) => (shapes = decodeStates(st)));
  const loadRoads = want("roads", (rd) => {
    roads = [[decodeLines(rd.i, rd.p), "", 1], [decodeLines(rd.o, rd.p), "", 0], ...rd.r.map(([t, w, l]: any) => [decodeLines(l, rd.p), t, w])];
    labels = rd.l;
    net = [...roads.flatMap((r) => r[0]), ...decodeLines(rd.j || [], rd.p)];
  });
  // a prompt or an error shows; a result's summary is only read out, the strip above says it already
  let wait: any;
  const say = (s: string, quiet?: boolean) => {
    clearTimeout(wait);
    status.textContent = s;
    status.classList.toggle("sr-only", !!quiet);
  };
  const fs = form && form.querySelector("fieldset");
  if (fs) fs.disabled = false;
  const inA = form && (form.elements.namedItem("a") as HTMLInputElement),
    inB = form && (form.elements.namedItem("b") as HTMLInputElement),
    inM = form && (form.elements.namedItem("m") as HTMLInputElement);
  // the truck's miles per gallon is kept on this phone for the next trip; storage can be blocked, and then 6.5 stays
  try {
    if (inM) inM.value = localStorage.getItem("dailyfuel:mpg") || inM.value;
  } catch {}
  let drawn: any[] = [],
    runs = 0,
    tries = 0;
  // a new line fits the map to its band; a rerun (a filter) leaves the view alone
  const run = (a: [number, number], b: [number, number], al: string, bl: string, fit?: boolean) => {
    last = { a, b, al, bl, fit };
    const id = ++runs;
    // The trip module loads only when a trip is asked for, and a road the
    // network can't connect falls back to the straight line. A browser keeps
    // a module that failed to load, so a retry asks for it at a new address.
    import(tries ? `${TRIP}?${tries}` : TRIP).then(async (m) => {
      // The work comes in steps, each its own task so the page can answer a
      // tap between them: the road graph (built once), the route, the
      // result, then the map. A newer run (a new trip, or a filter tapped
      // while this one loads) or Show every stop ends it.
      const next = () => new Promise((r) => setTimeout(r)).then(() => !!last && id == runs);
      if (net.length) m.graph(net);
      if (!(await next())) return;
      const path = net.length ? m.route(a, b, net) : null;
      if (!(await next())) return;
      const res = m.corridor(a, b, pts, shapes, path);
      out.innerHTML = m.stripHtml(res, al, bl, cfg, !!map, m.readMpg(inM.value) || m.MPG);
      say((out.querySelector(".rsum") as Element).textContent || "", true);
      // the map with its line comes into view over the prices
      if (fit) map ? box.scrollIntoView() : out.scrollIntoView({ block: "nearest" });
      if (!map || !(await next())) return;
      for (const l of drawn) map.removeLayer(l);
      // only the stops along the trip stay on the map, until Show every stop
      for (const p of pts) p.x = 1;
      for (const r of res.runs) for (const h of r.hits) h.p.x = 0;
      // The view goes to the trip first, with no zoom animation, which
      // redraws every stop and road on each frame; a new view redraws the
      // stops, and the trip's layers are then drawn once, at that view.
      const view = () => map.getCenter() + "" + map.getZoom(),
        was = view();
      if (fit) map.fitBounds(L.latLngBounds(res.ring), { padding: [12, 12], animate: false }), (last!.fit = false);
      if (was == view()) grp.eachLayer((m: any) => m.redraw()), list();
      drawn = [];
      if (!(await next())) return;
      const ab = (ll: [number, number], t: string) =>
        L.marker(ll, { icon: L.divIcon({ className: "rab", html: t, iconSize: [20, 20] }), keyboard: false, interactive: false });
      drawn = [
        L.polygon(res.ring, { className: "rb" }),
        L.polyline(res.line, { className: "rl" }),
        ab(a, "A"),
        ab(b, "B"),
      ];
      for (const l of drawn) l.addTo(map);
      if (!(await next())) return;
      // The freight roads show only along the trip: every road line with a
      // point in the band, under the line. A signed route is named on hover or
      // tap by an unseen twin on the markers' canvas, which is on top and takes
      // every pointer; the twin sits under the markers, and the canvas's
      // tolerance makes a thin road easy to tap.
      const inBand = m.nearLine(res.line, res.road ? ROAD_MI : BAND_MI),
        I: [number, number][][] = [],
        O: typeof I = [],
        under: any[] = [];
      for (const [ls, t, w] of roads) {
        const k = ls.filter((l) => l.some(inBand));
        if (!k.length) continue;
        (w ? I : O).push(...k);
        if (t) under.push(L.polyline(k, { renderer: cv, stroke: false }).bindTooltip(t, { sticky: true }));
      }
      under.push(L.polyline(I, { className: "ri" }), L.polyline(O, { className: "ro" }));
      // labels in the band; data-z shows interstates (h1) from zoom 6, US routes (h2) from 7 and the rest from 8
      for (const [t, y, x, w] of labels)
        if (inBand([y, x])) under.push(L.marker([y, x], { pane: "overlayPane", icon: L.divIcon({ className: "hl h" + w, html: t, iconSize: null }), keyboard: false }).addTo(map));
      for (const l of under) if (l.bringToBack) l.addTo(map).bringToBack();
      drawn.push(...under);
    }, () => {
      tries++;
      say("The trip didn't load. Check your signal and try again.");
    });
  };
  // the towns, the outlines and the roads come first, so a trip is drawn once, along the roads and priced by state
  const go = () => {
    // on a slow signal the strip says it is at work, until the answer or a message takes its place
    clearTimeout(wait);
    wait = setTimeout(() => say("Getting the towns and roads for this trip."), 400);
    return Promise.all([loadPlaces(), loadStates(), loadRoads()]).then((ok) => {
      if (!ok.every(Boolean)) return say(ok[0] ? "The map's files didn't load. Check your signal and try again." : "The town list didn't load. Check your signal and try again.");
      const a = findPlace(inA.value, places, cfg.px),
        b = findPlace(inB.value, places, cfg.px),
        miss = !(a as P)?.lat ? inA : !(b as P)?.lat ? inB : null;
      if (miss) {
        const v = miss.value.trim().replace(/[\s,]+$/, ""), f = miss === inA ? a : b;
        say(f ? `Which ${v}? Type the town and state, like ${f}.` : v ? `We can't find ${v}. Try a town and state, like Columbus, OH.` : `Type a town for ${miss === inA ? "From" : "To"}.`);
        return miss.focus();
      }
      const p = a as P, q = b as P;
      if (p.lat === q.lat && p.lon === q.lon) return say("From and To are the same place.");
      if (!(+inM.value >= 2 && +inM.value <= 20)) {
        say("Type miles per gallon from 2 to 20, like 6.5.");
        return inM.focus();
      }
      try {
        localStorage.setItem("dailyfuel:mpg", inM.value.trim());
      } catch {}
      run([p.lat, p.lon], [q.lat, q.lon], p.label, q.label, true);
      // the trip stays in the address, so a reload or a shared link brings it back
      history.replaceState(null, "", "#" + encodeURIComponent(p.label + "|" + q.label));
      // the keyboard goes away; the map comes into view once the result is in, so nothing moves under the driver
      (doc.activeElement as HTMLElement).blur();
    });
  };
  if (form && inA && inB) {
    inA.addEventListener("focus", loadPlaces);
    inB.addEventListener("focus", loadPlaces);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      go();
    });
  }

  const stP = loadStates();
  loadRoads();
  // the address: a trip "A|B", a state "#oh", or one of the page's own anchors (#credits), which is neither
  let c = "";
  try {
    c = decodeURIComponent(win.location.hash.slice(1));
  } catch (e) {}
  const ab = c.split("|");
  if (ab[1] && inA) {
    inA.value = ab[0];
    inB.value = ab[1];
    go();
  }

  if (!L || !box) {
    // the page's own script ran, so it was the map's file that didn't come; the tip on moving it goes too
    const msg = box && box.querySelector(".mp-msg"),
      tip = doc.querySelector(".mp-tip") as HTMLElement | null;
    if (msg) msg.textContent = "The map didn't load. Check your signal and reload the page. Every place on it is in the list below.";
    if (tip) tip.hidden = true;
    return list();
  }

  // ---- the map
  box.querySelector(".mp-msg")?.remove();
  // The base map (cfg.tl: CARTO's light map, or OpenStreetMap's) has every
  // road, place and border; the page's CSS turns it grey, and inverts it in
  // dark mode. Street level is zoom 16. The
  // freight roads drawn on top are good to about a kilometre, so the CSS
  // hides them past zoom 10, where the base map's own roads take over.
  map = L.map(box, {
    maxZoom: 16,
    zoomSnap: 0.25,
    zoomDelta: 1,
    attributionControl: false,
    maxBounds: cfg.mb,
    maxBoundsViscosity: 1,
    scrollWheelZoom: false,
    zoomControl: false,
    // on a phone one finger scrolls the page, two move and zoom the map
    dragging: !L.Browser.mobile,
  });
  // bottom right, where a popup, which opens above its marker, never lands on it
  L.control.zoom({ position: "bottomright" }).addTo(map);
  // the wheel zooms only once the map has focus, so the page still scrolls past it
  map.on("focus", () => map.scrollWheelZoom.enable());
  map.on("blur", () => map.scrollWheelZoom.disable());
  const fit = () => {
    map.setMinZoom(0);
    map.setMinZoom(Math.floor(map.getBoundsZoom(cfg.l48, false) * 4) / 4);
  };
  map.fitBounds(cfg.l48, { animate: false });
  fit();
  map.on("movestart", () => (moved = 1));
  L.tileLayer(cfg.tl).addTo(map);
  // Leaflet follows the window's size itself; the floor moves with it, so the lower 48 always fits
  map.on("resize", fit);

  // colours from the page's tokens, read again when the theme flips
  const col: Record<string, string> = { bg: "#fff", ink: "#111", ink2: "#595959", font: "monospace" };
  const readCol = () => {
    const cs = win.getComputedStyle(root);
    for (const k of ["bg", "ink", "ink2", "font"]) col[k] = cs.getPropertyValue("--" + k).trim() || col[k];
  };
  readCol();

  const cv = L.canvas({ pane: "pts", tolerance: 8, padding: 0.2 });
  map.createPane("pts").style.zIndex = "450";
  const Dot = L.CircleMarker.extend({
    _project() {
      // a stop off the trip isn't drawn, so it isn't placed again until it is shown
      if (this.p.x && this._point) return;
      this._radius = radius(this.p.k, map.getZoom());
      L.CircleMarker.prototype._project.call(this);
    },
    _containsPoint(q: any) {
      return this.p.on && !this.p.x && L.CircleMarker.prototype._containsPoint.call(this, q);
    },
    _updatePath() {
      const r = this._renderer, p: Pt = this.p;
      if (!r._drawing || this._empty() || !p.on || p.x) return;
      const c = r._ctx, x = this._point.x, y = this._point.y, s = this._radius;
      c.beginPath();
      if (p.k === "v") c.rect(x - s, y - s, 2 * s, 2 * s);
      else c.arc(x, y, s, 0, 7);
      c.fillStyle = p.k === "w" ? col.bg : p.k === "v" ? col.ink2 : col.ink;
      c.fill();
      c.lineWidth = p.k === "w" ? 1.5 : 1;
      c.strokeStyle = p.k === "w" ? col.ink : col.bg;
      c.stroke();
      if (p.k === "s" && s >= 8) {
        c.fillStyle = col.bg;
        c.font = `700 10px ${col.font}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(cfg.c[p.f][1], x, y + 0.5);
      }
      if (p.sel) {
        c.beginPath();
        c.arc(x, y, s + 3.5, 0, 7);
        c.lineWidth = 2;
        c.strokeStyle = col.ink;
        c.stroke();
      }
    },
  });
  const grp = L.featureGroup();
  // service squares first, then scales, then the truck stops on top
  for (const k of ["v", "w", "s"]) {
    for (const p of pts) {
      if (p.k !== k) continue;
      p.m = new Dot([p.lat, p.lon], { renderer: cv, radius: radius(p.k, 4) });
      p.m.p = p;
      grp.addLayer(p.m);
    }
  }
  grp.addTo(map);

  // A state's outline box: for #oh, the saved state, and a state typed in
  // the find box. It jumps rather than glides: Leaflet drops a new view asked
  // for while a zoom is still gliding, so a town found or a trip drawn just
  // as the opening view lands would be lost.
  const toState = (c: string) => {
    const x = shapes.find((y) => y.code == c.toUpperCase());
    if (x) map.fitBounds([[x.bbox[1], x.bbox[0]], [x.bbox[3], x.bbox[2]]], { animate: false });
    return x;
  };
  // the state in the address, else the saved one, once the outlines are in; a trip in the address has its own view
  stP.then(() => {
    if (!ab[1] && !moved)
      try {
        toState(c) || toState(win.localStorage.getItem("dailyfuel:state"));
      } catch (e) {}
  });

  // ---- popups
  const pop = L.popup({ closeButton: false, maxWidth: 260, autoPanPadding: [16, 16], className: "pp" });
  let open: Pt | null = null;
  const show = (p: Pt, from: HTMLElement | null) => {
    back = null;
    map.closePopup();
    open = p;
    p.sel = true;
    p.m.redraw();
    back = from;
    pop.setLatLng([p.lat, p.lon]).setContent(popupHtml(p, cfg)).openOn(map);
    if (from) pop.getElement()?.querySelector(".pp-in")?.focus();
  };
  map.on("popupclose", () => {
    if (open) {
      open.sel = false;
      open.m.redraw();
      open = null;
    }
    back = null;
  });
  // closed from the keyboard, focus goes back to the row that opened it
  const closeBack = () => {
    const b = back;
    map.closePopup();
    b?.focus();
  };
  // Leaflet stops clicks at the popup's edge, so its Close button is wired on each open
  map.on("popupopen", (e: any) => {
    e.popup.getElement().querySelector("[data-close]")?.addEventListener("click", closeBack);
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (e.target as Element).closest(".pp")) closeBack();
  });
  // On a phone, far out, a tap zooms in on the spot. Close in it opens the
  // dot nearest the finger, not just the one drawn on top. Leaflet gives a
  // small marker's own spot as the event's point, so this measures from the
  // pointer. The dot hit, which is the bigger, lettered one when two overlap,
  // keeps a 1px lead: two dots within a pixel of each other can't be told
  // apart by a tap, so the one that shows wins.
  grp.on("click", (e: any) => {
    const z = map.getZoom(),
      at = map.mouseEventToLayerPoint(e.originalEvent),
      far = (p: Pt) => (p.on ? p.m._point.distanceTo(at) : 1e9);
    if (L.Browser.mobile && z < 6) return map.setView(e.latlng, z + 2);
    let best: Pt = e.layer.p, bd = far(best) - 1;
    for (const p of pts) {
      const d = far(p);
      if (d < bd) (bd = d), (best = p);
    }
    show(best, null);
  });
  const focusPt = (e: Event) => {
    const b = (e.target as Element).closest(".lk") as HTMLElement | null;
    if (!b) return;
    const p = pts[+(b.getAttribute("data-i") || 0)];
    if (!p.on) return;
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8), { animate: false });
    show(p, b);
  };
  out.addEventListener("click", focusPt);
  // each name in the list opens its stop (list() makes the buttons)
  body.addEventListener("click", focusPt);
  // Show every stop: the trip goes, and every stop comes back
  out.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-clr]")) return;
    clearTimeout(wait);
    last = null;
    out.innerHTML = "";
    for (const l of drawn) map.removeLayer(l);
    drawn = [];
    for (const p of pts) p.x = 0;
    grp.eachLayer((m: any) => m.redraw());
    list();
    history.replaceState(null, "", location.pathname);
  });

  // ---- the find row: a state, a town, or Near me
  const fd = doc.getElementById("fd") as HTMLFormElement | null,
    fst = doc.getElementById("fd-st") as HTMLElement;
  if (fd) {
    const fq = fd.elements.namedItem("q") as HTMLInputElement,
      tell = (t: string) => (fst.textContent = t);
    (fd.querySelector("fieldset") as HTMLFieldSetElement).disabled = false;
    fq.addEventListener("focus", loadPlaces);
    fd.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = fq.value.trim().toLowerCase(),
        r = cfg.px.find((x) => x[0].toLowerCase() == v || x[1].toLowerCase() == v);
      if (!v) return tell("Type a town or state.");
      // what was asked for wins over the opening view, even if the outlines are still on their way
      moved = 1;
      tell("");
      Promise.all([loadStates(), loadPlaces()]).then(([sOk, ok]) => {
        const p = findPlace(fq.value, places, cfg.px) as any;
        if (r && !sOk) return tell("The map's files didn't load. Check your signal and try again.");
        if (!(r && toState(r[0]))) {
          if (!ok) return tell("The town list didn't load. Check your signal and try again.");
          const q = fq.value.trim().replace(/[\s,]+$/, "");
          if (!p || !p.lat) return tell(p ? `Which ${q}? Type the town and state, like ${p}.` : `We can't find ${q}. Try a town and state, like Columbus, OH.`);
          map.setView([p.lat, p.lon], 9);
        }
        fq.blur();
        box.scrollIntoView();
      });
    });
    (fd.querySelector("[data-near]") as HTMLElement).onclick = () => {
      tell("");
      map.locate({ setView: true, maxZoom: 9 });
    };
    // the map comes into view only once it is there; a refusal is said by the find box, kept in view
    map.on("locationfound", () => box.scrollIntoView());
    map.on("locationerror", () => {
      tell("Your phone did not share where you are. Type a town instead.");
      fst.scrollIntoView({ block: "nearest" });
    });
  }

  // ---- the theme: the canvas has no CSS, so a flip repaints the markers
  const repaint = () => {
    readCol();
    grp.eachLayer((m: any) => m.redraw());
  };
  new win.MutationObserver(repaint).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) mq.addEventListener("change", repaint);

  map.on("moveend", list);
  list();
}
