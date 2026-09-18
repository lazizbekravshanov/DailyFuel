import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCents, priceParts, spokenChange } from "../lib/format.ts";
import { inlineCall } from "../lib/inline.ts";
import { saveState, yourState } from "./your-state.ts";

const KEY = "dailyfuel:state";

interface Entry {
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  direction: "up" | "down" | "flat" | null;
  plate: string | null;
}

const STATES: Entry[] = [
  { code: "OH", name: "Ohio", price: 6.25, change: 0.304, direction: "up", plate: "EIA Midwest average, 15 states" },
  { code: "AK", name: "Alaska", price: null, change: null, direction: null, plate: null },
  { code: "CA", name: "California", price: 8.039, change: 0.275, direction: "up", plate: null },
  { code: "FL", name: "Florida", price: 6.096, change: -0.021, direction: "down", plate: "EIA Lower Atlantic average, 6 states" },
  { code: "TX", name: "Texas", price: 6.027, change: 0.004, direction: "flat", plate: "EIA Gulf Coast average, 6 states" },
  { code: "UT", name: "Utah", price: 6.066, change: 0, direction: "flat", plate: "EIA Rocky Mountain average, 5 states" },
  { code: "DE", name: "Delaware", price: 6.312, change: null, direction: null, plate: "EIA Central Atlantic average, 5 states and DC" },
];

const ISLAND = JSON.stringify({ when: "this week", none: "No weekly price", states: STATES });

/** The same hooks YourState.astro and FindYourState.astro render. */
function page(opts: { island?: string | null; saved?: boolean; find?: boolean; forget?: boolean } = {}): string {
  const { island = ISLAND, saved = true, find = true, forget = true } = opts;
  const savedRow = saved
    ? `<div class="ys-saved" data-ys-saved hidden>
        <a class="mini" href="/#find-your-state" data-ys-link>
          <span class="mini-code" data-ys-code></span><span class="mini-name" data-ys-name></span>
          <span data-ys-price><span data-ys-main></span><span class="tenth" data-ys-tenth></span></span>
          <span data-ys-none hidden></span>
          <span data-ys-plaque>
            <span data-ys-glyph="up" hidden>▲</span><span data-ys-glyph="down" hidden>▼</span><span data-ys-glyph="flat" hidden>●</span>
            <span data-ys-cents></span>
          </span>
          <span data-ys-plate></span>
        </a>
        <div><button type="button" data-ys-change aria-controls="find-your-state" aria-expanded="false">Change state</button>
        ${forget ? `<button type="button" data-ys-forget>Forget</button>` : ""}</div>
      </div>`
    : "";
  const findList = find
    ? `<details class="find" id="find-your-state"><summary>Find your state</summary>
        <ul data-ys-list tabindex="-1"><li><a href="/state/al/">Alabama</a></li></ul></details>`
    : "";
  const json = island === null ? "" : `<script type="application/json" id="your-state-data">${island}</script>`;
  return `<!doctype html><html><body><section><div class="ys" data-ys>${savedRow}${findList}</div>${json}</section></body></html>`;
}

class MemoryStore {
  map = new Map<string, string>();
  constructor(init?: string) {
    if (init !== undefined) this.map.set(KEY, init);
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

function run(opts: { stored?: string; store?: unknown; hash?: string; html?: string } = {}) {
  const { document } = parseHTML(opts.html ?? page());
  const store = (opts.store ?? new MemoryStore(opts.stored)) as Storage;
  const getStore = typeof opts.store === "function" ? (opts.store as () => Storage) : () => store;
  yourState(document as unknown as Document, getStore, opts.hash ?? "");
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  return { document, store, $ };
}

/** What a reader sees with no saved state: the list row, closed, and no mini sign. */
function expectDefault($: (sel: string) => HTMLElement) {
  expect($("[data-ys-saved]")?.hasAttribute("hidden") ?? true).toBe(true);
  expect($("#find-your-state").hasAttribute("hidden")).toBe(false);
}

const visibleGlyphs = ($: (sel: string) => HTMLElement, document: { querySelectorAll: (s: string) => ArrayLike<Element> }) =>
  Array.from(document.querySelectorAll("[data-ys-glyph]"))
    .filter((g) => !g.hasAttribute("hidden"))
    .map((g) => g.getAttribute("data-ys-glyph"));

describe("your state row, filled from a saved state", () => {
  it("shows the list and no mini sign when nothing is saved", () => {
    const { $ } = run();
    expectDefault($);
    expect($("#find-your-state").hasAttribute("open")).toBe(false);
  });

  it("fills the mini sign for Ohio and hides the list", () => {
    const { $, document } = run({ stored: "OH" });
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
    expect($("#find-your-state").hasAttribute("hidden")).toBe(true);
    const link = $("[data-ys-link]");
    expect(link.getAttribute("href")).toBe("/state/oh/");
    expect(link.getAttribute("aria-label")).toBe(
      "Your state, Ohio, $6.250 per gallon, up 30.4 cents this week, EIA Midwest average, 15 states",
    );
    expect($("[data-ys-code]").textContent).toBe("OH");
    expect($("[data-ys-name]").textContent).toBe("Ohio");
    expect($("[data-ys-main]").textContent).toBe("$6.25");
    expect($("[data-ys-tenth]").textContent).toBe("0");
    expect($("[data-ys-cents]").textContent).toBe("30.4¢");
    expect(visibleGlyphs($, document)).toEqual(["up"]);
    expect($("[data-ys-plate]").textContent).toBe("EIA Midwest average, 15 states");
    expect($("[data-ys-plate]").hasAttribute("hidden")).toBe(false);
    expect($("[data-ys-plaque]").hasAttribute("hidden")).toBe(false);
    expect($("[data-ys-change]").getAttribute("aria-expanded")).toBe("false");
  });

  it("never borrows a number for Alaska", () => {
    const { $ } = run({ stored: "AK" });
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
    expect($("[data-ys-link]").getAttribute("href")).toBe("/state/ak/");
    expect($("[data-ys-link]").getAttribute("aria-label")).toBe("Your state, Alaska, no weekly price");
    expect($("[data-ys-none]").textContent).toBe("No weekly price");
    expect($("[data-ys-none]").hasAttribute("hidden")).toBe(false);
    expect($("[data-ys-price]").hasAttribute("hidden")).toBe(true);
    expect($("[data-ys-plaque]").hasAttribute("hidden")).toBe(true);
    expect($("[data-ys-plate]").hasAttribute("hidden")).toBe(true);
    expect($("[data-ys-main]").textContent).toBe("");
  });

  it("gives California no plate, since EIA prices it on its own", () => {
    const { $ } = run({ stored: "CA" });
    expect($("[data-ys-plate]").hasAttribute("hidden")).toBe(true);
    expect($("[data-ys-link]").getAttribute("aria-label")).toBe("Your state, California, $8.039 per gallon, up 27.5 cents this week");
  });

  it("says fell, about the same and no change the way the site does", () => {
    let r = run({ stored: "FL" });
    expect(r.$("[data-ys-cents]").textContent).toBe("2.1¢");
    expect(visibleGlyphs(r.$, r.document)).toEqual(["down"]);
    expect(r.$("[data-ys-link]").getAttribute("aria-label")).toContain(", down 2.1 cents this week,");

    r = run({ stored: "TX" });
    expect(r.$("[data-ys-cents]").textContent).toBe("0.4¢");
    expect(visibleGlyphs(r.$, r.document)).toEqual(["flat"]);
    expect(r.$("[data-ys-link]").getAttribute("aria-label")).toContain(", about the same, up 0.4 cents this week,");

    r = run({ stored: "UT" });
    expect(r.$("[data-ys-cents]").textContent).toBe("0.0¢");
    expect(visibleGlyphs(r.$, r.document)).toEqual(["flat"]);
    expect(r.$("[data-ys-link]").getAttribute("aria-label")).toContain(", no change this week,");
  });

  it("shows the price with no plaque when there's nothing to compare with", () => {
    const { $ } = run({ stored: "DE" });
    expect($("[data-ys-main]").textContent).toBe("$6.31");
    expect($("[data-ys-plaque]").hasAttribute("hidden")).toBe(true);
    expect($("[data-ys-link]").getAttribute("aria-label")).toBe(
      "Your state, Delaware, $6.312 per gallon, EIA Central Atlantic average, 5 states and DC",
    );
  });

  it("leaves the when words out when there are none", () => {
    const island = JSON.stringify({ when: "", none: "No price yet", states: STATES });
    const { $ } = run({ stored: "OH", html: page({ island }) });
    expect($("[data-ys-link]").getAttribute("aria-label")).toContain(", up 30.4 cents, EIA");
  });
});

describe("your state row fails safe", () => {
  it("when reaching storage throws, like Safari with site data blocked", () => {
    const { $ } = run({
      store: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expectDefault($);
  });

  it("when reading storage throws", () => {
    const store = { getItem: () => { throw new Error("denied"); }, setItem() {}, removeItem() {} };
    const { $ } = run({ store });
    expectDefault($);
  });

  it("when storage is missing altogether", () => {
    const { $ } = run({ store: () => undefined });
    expectDefault($);
  });

  for (const garbage of ["", "oh", "Ohio", "ZZ", "OH ", "0", "null", "__proto__", "constructor", "toString", '<img src=x onerror="alert(1)">', '{"code":"OH"}']) {
    it(`when the saved value is ${JSON.stringify(garbage)}`, () => {
      const { $, document } = run({ stored: garbage });
      expectDefault($);
      expect(document.querySelector("img")).toBeNull();
      expect($("[data-ys-link]").getAttribute("href")).toBe("/#find-your-state");
    });
  }

  it("when the JSON island is missing", () => {
    const { $ } = run({ stored: "OH", html: page({ island: null }) });
    expectDefault($);
  });

  for (const island of ["", "{", "null", "[]", '{"states":null}', '{"states":{"OH":{}}}']) {
    it(`when the JSON island is ${JSON.stringify(island)}`, () => {
      const { $ } = run({ stored: "OH", html: page({ island }) });
      expectDefault($);
    });
  }

  it("when the page has no mini sign to fill", () => {
    const { $ } = run({ stored: "OH", html: page({ saved: false }) });
    expect($("#find-your-state").hasAttribute("hidden")).toBe(false);
  });

  it("when a button is missing", () => {
    const { $ } = run({ stored: "OH", html: page({ forget: false }) });
    expectDefault($);
  });

  it("when the page has no list or no row at all", () => {
    expect(() => run({ stored: "OH", html: page({ find: false }) })).not.toThrow();
    expect(() => run({ stored: "OH", html: "<!doctype html><html><body><p>nothing</p></body></html>" })).not.toThrow();
  });

  it("never writes to storage just by reading it", () => {
    const { store } = run({ stored: "OH" });
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    const empty = run();
    expect((empty.store as unknown as MemoryStore).map.size).toBe(0);
  });
});

describe("Change state and Forget", () => {
  it("Change state opens the list and moves focus to it", () => {
    const { $ } = run({ stored: "OH" });
    const list = $("[data-ys-list]");
    const focus = vi.spyOn(list, "focus");
    $("[data-ys-change]").click();
    expect($("#find-your-state").hasAttribute("hidden")).toBe(false);
    expect($("#find-your-state").hasAttribute("open")).toBe(true);
    expect($("[data-ys-change]").getAttribute("aria-expanded")).toBe("true");
    expect(focus).toHaveBeenCalled();
    // the mini sign stays up while the list is open
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
  });

  it("closing the list from its summary tucks it away and returns focus", () => {
    const { $, document } = run({ stored: "OH" });
    const change = $("[data-ys-change]");
    const focus = vi.spyOn(change, "focus");
    change.click();
    const find = $("#find-your-state");
    find.removeAttribute("open");
    find.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("toggle"));
    expect(find.hasAttribute("hidden")).toBe(true);
    expect(change.getAttribute("aria-expanded")).toBe("false");
    expect(focus).toHaveBeenCalled();
  });

  it("Forget clears the saved state and puts the list row back", () => {
    const { $, store, document } = run({ stored: "OH" });
    const summary = document.querySelector("summary") as unknown as HTMLElement;
    const focus = vi.spyOn(summary, "focus");
    $("[data-ys-change]").click();
    $("[data-ys-forget]").click();
    expect((store as unknown as MemoryStore).map.has(KEY)).toBe(false);
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(true);
    const find = $("#find-your-state");
    expect(find.hasAttribute("hidden")).toBe(false);
    expect(find.hasAttribute("open")).toBe(false);
    expect(focus).toHaveBeenCalled();
    // a toggle after Forget leaves the list row alone
    find.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("toggle"));
    expect(find.hasAttribute("hidden")).toBe(false);
  });

  it("Forget still works on the page when removing from storage throws", () => {
    const store = {
      getItem: () => "OH",
      setItem() {},
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const { $ } = run({ store });
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
    expect(() => $("[data-ys-forget]").click()).not.toThrow();
    expectDefault($);
  });
});

describe("a link to /#find-your-state", () => {
  it("opens the list when nothing is saved", () => {
    const { $ } = run({ hash: "#find-your-state" });
    expect($("#find-your-state").hasAttribute("open")).toBe(true);
    expect($("#find-your-state").hasAttribute("hidden")).toBe(false);
  });

  it("opens the list under the mini sign when a state is saved", () => {
    const { $ } = run({ stored: "OH", hash: "#find-your-state" });
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
    expect($("#find-your-state").hasAttribute("hidden")).toBe(false);
    expect($("#find-your-state").hasAttribute("open")).toBe(true);
    expect($("[data-ys-change]").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the list even when storage throws", () => {
    const { $ } = run({ hash: "#find-your-state", store: () => { throw new Error("blocked"); } });
    expect($("#find-your-state").hasAttribute("open")).toBe(true);
  });

  it("leaves other hashes alone", () => {
    const { $ } = run({ hash: "#every-state" });
    expect($("#find-your-state").hasAttribute("open")).toBe(false);
  });
});

describe("money on the mini sign matches the rest of the site", () => {
  // Half cent ties, float edges and ordinary values, all with at most 4 decimals like the data.
  const prices = [6.25, 6.285, 6.2855, 6.2845, 6.0005, 3.9995, 1.5, 15, 8.039, 5.1234, 4.9999, 7.0015, 2.0045];
  const changes = [0.304, -0.021, 0.0005, -0.0005, 0.0004, 0.3185, -1.2345, 0.00049, 0.995, -0.0995, 0.1, 2.5415];
  for (let i = 0; i < 40; i++) prices.push(Math.round((1.5 + ((i * 7919) % 13500) / 1000) * 10000) / 10000);

  it("prices read $6.28 with a raised 5, like priceParts", () => {
    for (const price of prices) {
      const island = JSON.stringify({ when: "", none: "", states: [{ code: "OH", name: "Ohio", price, change: null, direction: null, plate: null }] });
      const { $ } = run({ stored: "OH", html: page({ island }) });
      const p = priceParts(price);
      expect($("[data-ys-main]").textContent, String(price)).toBe(p.main);
      expect($("[data-ys-tenth]").textContent, String(price)).toBe(p.tenth);
      expect($("[data-ys-link]").getAttribute("aria-label"), String(price)).toBe(`Your state, Ohio, ${p.plain} per gallon`);
    }
  });

  it("changes read in cents with one decimal, like formatCents and spokenChange", () => {
    for (const change of changes) {
      const island = JSON.stringify({ when: "", none: "", states: [{ code: "OH", name: "Ohio", price: 6, change, direction: change > 0 ? "up" : "down", plate: null }] });
      const { $ } = run({ stored: "OH", html: page({ island }) });
      expect($("[data-ys-cents]").textContent, String(change)).toBe(formatCents(change));
      expect($("[data-ys-link]").getAttribute("aria-label"), String(change)).toBe(`Your state, Ohio, $6.000 per gallon, ${spokenChange(change)}`);
    }
  });
});

describe("saving on a state page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the state code", () => {
    const store = new MemoryStore();
    vi.stubGlobal("window", { localStorage: store });
    saveState("OH");
    expect(store.map.get(KEY)).toBe("OH");
    saveState("AK");
    expect(store.map.get(KEY)).toBe("AK");
  });

  it("shrugs off storage that throws, is full or isn't there", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(() => saveState("OH")).not.toThrow();
    vi.stubGlobal("window", {
      localStorage: { setItem: () => { throw new DOMException("full", "QuotaExceededError"); } },
    });
    expect(() => saveState("OH")).not.toThrow();
    vi.stubGlobal("window", {});
    expect(() => saveState("OH")).not.toThrow();
  });
});

describe("what ships in the page", () => {
  it("runs on its own as an inline script, with nothing from outside its body", () => {
    const { document } = parseHTML(page());
    const store = new MemoryStore("OH");
    // the same shape the page prints: (fn)(document, getStore, hash)
    const inline = new Function("document", "store", inlineCall(yourState, "document", "function(){return store}", '""'));
    inline(document, store);
    const link = document.querySelector("[data-ys-link]")!;
    expect(link.getAttribute("href")).toBe("/state/oh/");
    expect(document.querySelector("[data-ys-saved]")!.hasAttribute("hidden")).toBe(false);

    const saved = new MemoryStore();
    new Function("window", inlineCall(saveState, '"TX"'))({ localStorage: saved });
    expect(saved.map.get(KEY)).toBe("TX");
  });

  it("stays under 1.5 KB gzipped", () => {
    // what the home page and a state page print, between them
    const code =
      inlineCall(yourState, "document", "function(){return window.localStorage}", "location.hash") +
      inlineCall(saveState, '"OH"');
    expect(code).not.toMatch(/^\s*\/\//m);
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(1536);
  });

  it("uses only hooks the components render", () => {
    const row = readFileSync(new URL("../components/YourState.astro", import.meta.url), "utf8");
    const list = readFileSync(new URL("../components/FindYourState.astro", import.meta.url), "utf8");
    const src = String(yourState);
    const hooks = [...new Set([...src.matchAll(/\[(data-ys[a-z-]*)\]/g)].map((m) => m[1]))];
    expect(hooks.length).toBeGreaterThan(10);
    for (const hook of hooks) expect(row + list, hook).toContain(hook);
    expect(list).toContain('id="find-your-state"');
    expect(row).toContain('id="your-state-data"');
  });
});
