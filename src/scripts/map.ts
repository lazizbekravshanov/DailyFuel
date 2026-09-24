// The map page's one script: the Leaflet map, the legend's filters, the
// popups, the list twin of what is on screen, and the route strip's maths.
// map.astro bundles it with esbuild into one inline module that runs after
// the deferred Leaflet script, so `L` is there when init runs, or missing
// if Leaflet failed to load, in which case the list and the filters still
// work and the map box keeps its "needs JavaScript" line.
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

import { band, bboxOf, distMi, sample, shapeAt, track, undelta, type Shape } from "../components/map/geo.ts";

/** One chain: name, ink, letter, locator. */
export type ChainCfg = [string, string, string, string];
/** One state for the route strip: code, name, price, move, move class, plate, state tax. */
export type PriceRow = [string, string, string | null, string | null, string, string, string];

export interface Cfg {
  c: Record<string, ChainCfg>;
  src: Record<string, string>;
  px: PriceRow[];
  /** "EIA week of Sep 14, 2026", for the route strip's meta. */
  wk: string;
  /** maxBounds and the lower 48, [[south, west], [north, east]]. */
  mb: [[number, number], [number, number]];
  l48: [[number, number], [number, number]];
  /** the base layers the build wrote: states, roads, places */
  ly: string[];
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
  /** the Leaflet marker, once there is a map */
  m?: any;
  sel?: boolean;
}

export const BAND_MI = 25;
export const STEP_MI = 5;
const DIRS: Record<string, string> = { n: "northbound", s: "southbound", e: "eastbound", w: "westbound" };

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));

export const fmt = (n: number): string => n.toLocaleString("en-US");

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

/** The outlines from /map/states.json, as shapes for point in polygon and as Leaflet's [lat, lon] rings. */
export function decodeStates(doc: { p: number; s: [string, number[][][]][] }): { shapes: Shape[]; rings: [number, number][][][] } {
  const shapes: Shape[] = [], rings: [number, number][][][] = [];
  for (const [code, polys] of doc.s) {
    const coordinates = polys.map((rs) => rs.map((r) => undelta(r, doc.p)));
    const geometry = { type: "MultiPolygon" as const, coordinates };
    shapes.push({ code, geometry, bbox: bboxOf(geometry) });
    for (const poly of coordinates) rings.push(poly.map((r) => r.map(([x, y]) => [y, x] as [number, number])));
  }
  return { shapes, rings };
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

/**
 * What the driver typed, as a point: a place on the list (exact, then a bare
 * name in one state only, then the first that starts with it), or "lat, lon".
 * A bare name in more than one state gives the first of them as a string, to
 * ask which. Null when nothing fits.
 */
export function findPlace(q: string, pl: Places | null): { label: string; lat: number; lon: number } | string | null {
  const t = q.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  // the page prints a real minus sign; a typed hyphen works too
  const m = /^([-−]?\d{1,2}(?:\.\d+)?)\s*[, ]\s*([-−]?\d{1,3}(?:\.\d+)?)$/.exec(t);
  if (m) {
    const lat = +m[1].replace("−", "-"), lon = +m[2].replace("−", "-");
    return lat > 15 && lat < 72 && lon > -190 && lon < -60 ? { label: llText(lat, lon), lat, lon } : null;
  }
  if (!pl) return null;
  const L = pl.label.map((s) => s.toLowerCase());
  let i = L.indexOf(t);
  if (i < 0) {
    const bare = L.flatMap((s, j) => (s.split(",")[0] === t ? [j] : []));
    if (bare.length > 1) return pl.label[bare[0]];
    i = bare.length ? bare[0] : L.findIndex((s) => s.startsWith(t));
  }
  return i < 0 ? null : { label: pl.label[i], lat: pl.lat[i], lon: pl.lon[i] };
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
}

/**
 * The straight line from a to b: sampled every STEP_MI miles, the states it
 * crosses in order (by point in polygon on each sample), and the truck
 * stops and weigh stations switched on in the legend that sit within
 * BAND_MI miles of it, in order along it, each under the state the line is
 * in at that mile. With no outlines loaded it is one run with no state.
 */
export function corridor(a: [number, number], b: [number, number], pts: Pt[], shapes: Shape[]): Corridor {
  const miles = distMi(a[0], a[1], b[0], b[1]),
    line = sample(a[0], a[1], b[0], b[1], STEP_MI),
    runs: Run[] = [];
  let outside = false;
  line.forEach((q, i) => {
    const at = Math.min(i * STEP_MI, miles),
      code = shapes.length ? shapeAt(q[0], q[1], shapes) : null,
      r = runs[runs.length - 1];
    if (shapes.length && !code) outside = true;
    else if (r && r.code === code) r.to = at;
    else runs.push({ code, from: at, to: at, hits: [] });
  });
  let hits = 0;
  if (runs.length) {
    const inBand: { p: Pt; at: number }[] = [];
    for (const p of pts) {
      if (!p.on || p.k === "v") continue;
      const t = track(a[0], a[1], b[0], b[1], p.lat, p.lon);
      if (Math.abs(t.xt) <= BAND_MI && t.at >= 0 && t.at <= miles) inBand.push({ p, at: t.at });
    }
    inBand.sort((x, y) => x.at - y.at);
    for (const h of inBand) {
      // the run the line is in at that mile, or the nearest one across a border or a stretch of water
      let best = runs[0], gap = Infinity;
      for (const r of runs) {
        const g = h.at < r.from ? r.from - h.at : h.at > r.to ? h.at - r.to : 0;
        if (g < gap) {
          gap = g;
          best = r;
        }
      }
      best.hits.push(h);
      hits++;
    }
  }
  return { miles, line, ring: band(line, BAND_MI), runs, outside, hits };
}

/** "Miles 0 to 150", rounded to whole miles. */
export const milesText = (r: Run, last: number): string =>
  `Miles ${Math.round(r.from)} to ${Math.round(r.to === r.from ? Math.min(r.to + STEP_MI, last) : r.to)}`;

/** The name cell's button: it opens the point's popup on the map. */
const lk = (p: Pt) => `<button type="button" class="lk" data-i="${p.i}">${esc(p.n)}</button>`;

/** The route strip's result: a summary line, then one boxed strip per state with its stops in order. */
export function stripHtml(res: Corridor, aLabel: string, bLabel: string, cfg: Cfg, withButtons: boolean): string {
  const byCode: Record<string, PriceRow> = {};
  for (const r of cfg.px) byCode[r[0]] = r;
  const states = res.runs.filter((r) => r.code).length;
  let h = `<p class="rsum"><b>${esc(aLabel)}</b> to <b>${esc(bLabel)}</b> <span class="dot">·</span> ${fmt(Math.round(res.miles))} miles in a straight line <span class="dot">·</span> ${states} ${states === 1 ? "state" : "states"} <span class="dot">·</span> ${fmt(res.hits)} ${res.hits === 1 ? "place" : "places"} within ${BAND_MI} miles</p>`;
  if (res.outside) h += `<p class="fine">Part of the line runs over water or outside the 50 states.</p>`;
  for (const r of res.runs) {
    const row = r.code ? byCode[r.code] : null;
    h += `<div class="rs"><p class="strip">`;
    h += row
      ? `<span class="sym">${row[0]}</span> <span class="nm">${esc(row[1])}</span> ` +
        (row[2] ? `<span class="px">${row[2]}</span> ${row[3] ? `<span class="${row[4]}">${row[3]}</span> ` : ""}` : `<span class="px">No EIA price</span> `) +
        `<span class="plate">${esc(row[5])}</span> <span>State tax ${row[6]}</span> `
      : `<span class="nm">State not known</span> `;
    h += `<span class="muted">${milesText(r, res.miles)}</span></p>`;
    if (r.hits.length) {
      h += `<div class="scroll"><table><thead><tr><th class="num">Mi</th><th>Name</th><th>Type</th><th>St</th></tr></thead><tbody>`;
      for (const x of r.hits) {
        h += `<tr><td class="num">${Math.round(x.at)}</td><td>${withButtons ? lk(x.p) : esc(x.p.n)}</td><td>${esc(x.p.t)}</td><td>${x.p.st}</td></tr>`;
      }
      h += `</tbody></table></div>`;
    } else h += `<p class="fine">No truck stops or weigh stations on the map in this stretch of the band.</p>`;
    h += `</div>`;
  }
  return h;
}

/** A point's popup: its name, what it is and where, the direction for a scale, the chain's own page, and the source. */
export function popupHtml(p: Pt, cfg: Cfg): string {
  const ch = p.c ? cfg.c[p.c] : null,
    src = p.s.split("").map((k) => cfg.src[k]).filter(Boolean),
    what = p.k === "s" ? `${p.t} truck stop` : p.t;
  let h = `<div class="pp-in" tabindex="-1"><p class="pp-n"><b>${esc(p.n)}</b></p><p>${esc(what)}${p.st ? ` <span class="dot">·</span> ${p.st}` : ""}</p>`;
  if (p.k === "w") h += `<p>${p.d ? `Direction: ${DIRS[p.d] || p.d}` : "Direction not recorded"}</p>`;
  if (ch) h += `<p><a href="${esc(ch[3])}">${esc(ch[0])} locator</a> for today's price</p>`;
  h += `<p class="pp-s">${src.length > 1 ? "Sources" : "Source"}: ${esc(src.join("; "))}</p><button type="button" class="btn" data-close>Close</button></div>`;
  return h;
}

/** Marker radius by kind and zoom: bigger with a letter from zoom 7. */
export function radius(k: string, z: number): number {
  const i = z >= 7 ? 2 : z >= 5 ? 1 : 0;
  return (k === "s" ? [4, 5, 8] : k === "w" ? [3.5, 4.5, 6] : [2.5, 3.5, 4.5])[i];
}

/** Sort the points by a column: n name, t type, st state, then name, then state. */
export function sortPts(pts: Pt[], key: "n" | "t" | "st", dir: 1 | -1): Pt[] {
  return pts.slice().sort((x, y) => (x[key].localeCompare(y[key]) || x.n.localeCompare(y.n) || x.st.localeCompare(y.st)) * dir || x.i - y.i);
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
    L = win.L,
    box = doc.getElementById("map") as HTMLElement,
    out = doc.getElementById("rt-out") as HTMLElement,
    status = doc.getElementById("rt-st") as HTMLElement,
    form = doc.getElementById("rt") as HTMLFormElement,
    root = doc.documentElement;
  let map: any = null,
    shapes: Shape[] = [],
    last: { a: [number, number]; b: [number, number]; al: string; bl: string } | null = null,
    back: HTMLElement | null = null;

  // ---- the list: what is on screen, sortable, each name opening its marker
  const list = () => {
    const bounds = map && map.getBounds();
    let n = 0;
    for (const p of pts) {
      const v = p.on && (!bounds || bounds.contains([p.lat, p.lon]));
      if (p.tr && p.tr.hidden === v) p.tr.hidden = !v;
      if (v) n++;
    }
    if (count) count.textContent = `${fmt(n)} ${n === 1 ? "place" : "places"}${map ? " in view" : ""}`;
  };
  const heads = Array.from(table.querySelectorAll("th[data-sort]"));
  for (const th of heads) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "sortb";
    b.textContent = th.textContent;
    th.textContent = "";
    th.appendChild(b);
    b.addEventListener("click", () => {
      const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
      for (const h of heads) h.removeAttribute("aria-sort");
      th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      const frag = doc.createDocumentFragment();
      for (const p of sortPts(pts, th.getAttribute("data-sort") as "n" | "t" | "st", dir)) frag.appendChild(p.tr as Node);
      body.appendChild(frag);
    });
  }

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
      if (last) run(last.a, last.b, last.al, last.bl);
    });
  }
  // ---- the route strip
  const get = (f: string): Promise<any> =>
    cfg.ly.includes(f) ? fetch(`/map/${f}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null);
  let places: Places | null = null,
    loading: Promise<void> | null = null;
  const loadPlaces = () =>
    (loading = loading || get("places")
      .then((d) => {
        if (!d) return;
        places = decodePlaces(d);
        const dl = doc.getElementById("pl");
        if (dl) dl.innerHTML = places.label.map((s) => `<option value="${esc(s)}">`).join("");
      })
      .catch(() => {}));
  // a prompt or an error shows; a result's summary is only read out, the strip above says it already
  const say = (s: string, quiet?: boolean) => {
    status.textContent = s;
    status.classList.toggle("sr-only", !!quiet);
  };
  const fs = form && form.querySelector("fieldset");
  if (fs) fs.disabled = false;
  const inA = form && (form.elements.namedItem("a") as HTMLInputElement),
    inB = form && (form.elements.namedItem("b") as HTMLInputElement),
    pick = form && (form.querySelector("[data-pick]") as HTMLButtonElement);
  let step = 0,
    drawn: any[] = [];
  // a new line fits the map to its band; a rerun (a filter, the outlines arriving) leaves the view alone
  const run = (a: [number, number], b: [number, number], al: string, bl: string, refit?: boolean) => {
    last = { a, b, al, bl };
    const res = corridor(a, b, pts, shapes);
    out.innerHTML = stripHtml(res, al, bl, cfg, !!map);
    say((out.querySelector(".rsum") as Element).textContent || "", true);
    if (!map) return;
    for (const l of drawn) map.removeLayer(l);
    const ab = (ll: [number, number], t: string) =>
      L.marker(ll, { icon: L.divIcon({ className: "rab", html: t, iconSize: [20, 20] }), keyboard: false, interactive: false });
    drawn = [
      L.polygon(res.ring, { className: "rb", interactive: false }),
      L.polyline(res.line, { className: "rl", interactive: false }),
      ab(a, "A"),
      ab(b, "B"),
    ];
    for (const l of drawn) l.addTo(map);
    if (refit) map.fitBounds(drawn[0].getBounds(), { padding: [12, 12] });
  };
  const go = () =>
    loadPlaces().then(() => {
      const a = findPlace(inA.value, places),
        b = findPlace(inB.value, places),
        miss = !a || typeof a == "string" ? inA : !b || typeof b == "string" ? inB : null;
      if (miss) {
        const v = miss.value.trim(), f = miss === inA ? a : b;
        say(f
          ? `Which ${v}? Add the state, like ${f}.`
          : v
          ? `No place called ${v} on the list. Pick one from the list, type lat, lon, or use the map.`
          : `Type a place for ${miss === inA ? "A" : "B"}, or use the map.`);
        return miss.focus();
      }
      const p = a as Exclude<typeof a, string | null>, q = b as typeof p;
      if (p.lat === q.lat && p.lon === q.lon) return say("A and B are the same place.");
      run([p.lat, p.lon], [q.lat, q.lon], p.label, q.label, true);
    });
  if (form && inA && inB) {
    inA.addEventListener("focus", loadPlaces);
    inB.addEventListener("focus", loadPlaces);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      go();
    });
    if (pick) {
      pick.hidden = !L;
      pick.addEventListener("click", () => {
        step = step ? 0 : 1;
        pick.setAttribute("aria-pressed", String(!!step));
        box.classList.toggle("pick", !!step);
        say(step ? "Tap the map for A." : "");
      });
    }
  }

  if (!L || !box) return list();

  // ---- the map
  const msg = box.querySelector(".mp-msg");
  if (msg) msg.remove();
  // No tiles, and the outlines and roads are good to about a kilometre and a
  // half: past zoom 10 there is nothing more to see and the roads drift off
  // the markers, so the map stops there.
  map = L.map(box, {
    maxZoom: 10,
    zoomSnap: 0.25,
    zoomDelta: 1,
    attributionControl: false,
    maxBounds: cfg.mb,
    maxBoundsViscosity: 1,
    scrollWheelZoom: false,
    zoomControl: false,
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
  // Leaflet follows the window's size itself; the floor moves with it, so the lower 48 always fits
  map.on("resize", fit);

  // colours from the page's tokens, read again when the theme flips
  const col: Record<string, string> = { bg: "#fff", ink: "#111", ink2: "#595959", font: "monospace" };
  const readCol = () => {
    const cs = win.getComputedStyle(root);
    for (const k of ["bg", "ink", "ink2"]) col[k] = cs.getPropertyValue("--" + k).trim() || col[k];
    col.font = win.getComputedStyle(doc.body).fontFamily || col.font;
  };
  readCol();

  const cv = L.canvas({ pane: "pts", tolerance: 8, padding: 0.2 });
  map.createPane("pts").style.zIndex = "450";
  const Dot = L.CircleMarker.extend({
    _project() {
      this._radius = radius(this.p.k, map.getZoom());
      L.CircleMarker.prototype._project.call(this);
    },
    _containsPoint(q: any) {
      return this.p.on && L.CircleMarker.prototype._containsPoint.call(this, q);
    },
    _updatePath() {
      const r = this._renderer, p: Pt = this.p;
      if (!r._drawing || this._empty() || !p.on) return;
      const c = r._ctx, x = this._point.x, y = this._point.y, s = this._radius;
      c.globalAlpha = 1;
      c.beginPath();
      if (p.k === "v") c.rect(x - s, y - s, 2 * s, 2 * s);
      else c.arc(x, y, s, 0, 6.2832);
      c.fillStyle = p.k === "w" ? col.bg : p.k === "v" ? col.ink2 : cfg.c[p.f][1];
      c.fill();
      c.lineWidth = p.k === "w" ? 1.5 : 1;
      c.strokeStyle = p.k === "w" ? col.ink : col.bg;
      c.stroke();
      if (p.k === "s" && s >= 8) {
        c.fillStyle = col.bg;
        c.font = `700 10px ${col.font}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(cfg.c[p.f][2], x, y + 0.5);
      }
      if (p.sel) {
        c.beginPath();
        c.arc(x, y, s + 3.5, 0, 6.2832);
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

  // the base: state lines and the freight roads, on SVG so the page's CSS tokens colour them in both themes
  Promise.all([get("states"), get("roads")]).then(([st, rd]) => {
    const base: any[] = [];
    if (rd) {
      base.push(L.polyline(decodeLines(rd.o, rd.p), { className: "ro", interactive: false, smoothFactor: 1.5 }));
      base.push(L.polyline(decodeLines(rd.i, rd.p), { className: "ri", interactive: false, smoothFactor: 1.5 }));
    }
    if (st) {
      const d = decodeStates(st);
      shapes = d.shapes;
      base.unshift(L.polygon(d.rings, { className: "st", interactive: false, fill: false, smoothFactor: 1.5 }));
    }
    // behind whatever the route strip has drawn: roads over the state lines
    for (const l of base.reverse()) {
      l.addTo(map);
      l.bringToBack();
    }
    if (last) run(last.a, last.b, last.al, last.bl);
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
    if (from) {
      const el = pop.getElement() && pop.getElement().querySelector(".pp-in");
      if (el) el.focus();
    }
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
    if (b) b.focus();
  };
  // Leaflet stops clicks at the popup's edge, so its Close button is wired on each open
  map.on("popupopen", (e: any) => {
    const c = e.popup.getElement().querySelector("[data-close]");
    if (c) c.addEventListener("click", closeBack);
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (e.target as Element).closest(".pp")) closeBack();
  });
  grp.on("click", (e: any) => {
    if (!step) show(e.layer.p, null);
  });
  const focusPt = (e: Event) => {
    const b = (e.target as Element).closest(".lk") as HTMLElement | null;
    if (!b) return;
    const p = pts[+(b.getAttribute("data-i") || 0)];
    if (!p.on) return;
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8), { animate: false });
    show(p, b);
  };
  body.addEventListener("click", focusPt);
  out.addEventListener("click", focusPt);
  // each name in the list opens its marker
  for (const p of pts) {
    const td = p.tr && p.tr.children[0];
    if (td) td.innerHTML = lk(p);
  }

  // ---- the map as the route strip's picker
  map.on("click", (e: any) => {
    if (!step || !inA || !inB || !pick) return;
    const label = llText(e.latlng.lat, e.latlng.lng);
    if (step === 1) {
      inA.value = label;
      step = 2;
      say("Now tap the map for B.");
    } else {
      inB.value = label;
      step = 0;
      pick.setAttribute("aria-pressed", "false");
      box.classList.remove("pick");
      go();
    }
  });

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
