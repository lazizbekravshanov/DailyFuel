import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { inlineCall } from "../lib/inline.ts";
import { rememberPick, saveOnView, yourState } from "./your-state.ts";

// The strip prints strings the build formatted (yourstate.test.ts checks
// those), so there is no money math in the browser to check against
// format.ts; the tests that did that went with the road sign.

const KEY = "dailyfuel:state";

interface Line {
  code: string;
  name: string;
  href?: string;
  px: string;
  ch?: string;
  ink?: string;
  pl?: string;
}

const STATES: Line[] = [
  { code: "AL", name: "Alabama", px: "$6.177", ch: "+15.0¢ +2.5%", ink: "up", pl: "EIA Gulf Coast average, 6 states" },
  { code: "OH", name: "Ohio", px: "$6.250", ch: "+30.4¢ +5.1%", ink: "up", pl: "EIA Midwest average, 15 states" },
  { code: "AK", name: "Alaska", px: "No EIA price", pl: "EIA doesn't survey this state" },
  { code: "CA", name: "California", px: "$8.039", ch: "+27.5¢ +3.5%", ink: "up", pl: "EIA California average" },
  { code: "FL", name: "Florida", px: "$6.096", ch: "−2.1¢ −0.3%", ink: "down", pl: "EIA Lower Atlantic average, 6 states" },
  // a move the bins call about the same rides with no ink
  { code: "TX", name: "Texas", px: "$6.027", ch: "+0.4¢ +0.1%", pl: "EIA Gulf Coast average, 6 states" },
  { code: "DE", name: "Delaware", px: "$6.312", pl: "EIA Central Atlantic average, 5 states and DC" },
];

const attrs = (l: Line) =>
  [["data-px", l.px], ["data-ch", l.ch], ["data-ink", l.ink], ["data-pl", l.pl]]
    .filter(([, v]) => v)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");

/** The same hooks YourState.astro and FindYourState.astro render, in the same order. */
function page(opts: { saved?: boolean; find?: boolean; forget?: boolean; strip?: boolean; open?: boolean } = {}): string {
  const { saved = true, find = true, forget = true, strip = true, open = false } = opts;
  const savedRow = saved
    ? `<div class="strip" data-ys-saved hidden>
        <p class="lbl">Your state</p>
        <span class="sym" data-ys-code></span><span class="nm" data-ys-name></span><span class="px" data-ys-price></span>
        <span class="ch muted" data-ys-move></span><span class="muted pl" data-ys-plate></span>
        <span class="acts"><a class="btn" href="/#find-your-state" data-ys-open>Open</a>
        <button type="button" class="btn" data-ys-change aria-controls="find-your-state" aria-expanded="false">Change</button>
        ${forget ? `<button type="button" class="btn" data-ys-forget>Forget</button>` : ""}</span>
      </div>`
    : "";
  const none = `<div class="strip" data-ys-none><p class="lbl">Your state</p><span class="muted">Nothing saved yet.</span></div>`;
  const list = find
    ? `<details class="pick" data-ys-find${open ? " open" : ""}><summary class="btn">Find your state</summary>
        <ul class="pick-list" id="find-your-state" data-ys-list tabindex="-1">
          ${STATES.map((l) => `<li><a href="/state/${l.code.toLowerCase()}/" data-ys-pick="${l.code}"${strip ? attrs(l) : ""}><b>${l.code}</b> ${l.name}</a></li>`).join("")}
        </ul></details>`
    : "";
  return `<!doctype html><html><body><section class="ys" data-ys>${savedRow}${none}${list}</section>
    <table id="quotes"><tbody><tr data-s="OH" class="mine"><th><a href="/state/oh/">OH</a></th></tr><tr data-s="AL"><th><a href="/state/al/">AL</a></th></tr></tbody></table></body></html>`;
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

/** The home page's strip script, right after the list. */
function run(opts: { stored?: string; store?: unknown; hash?: string; html?: string } = {}) {
  const { document } = parseHTML(opts.html ?? page());
  const store = (opts.store ?? new MemoryStore(opts.stored)) as Storage;
  const getStore = typeof opts.store === "function" ? (opts.store as () => Storage) : () => store;
  yourState(document as unknown as Document, getStore, opts.hash ?? "");
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  return { document, store, $ };
}

/** The list shows unless a saved state holds the strip and nobody asked for the list (the CSS in YourState.astro). */
function listShown($: (sel: string) => HTMLElement): boolean {
  const slot = $("[data-ys]");
  return !slot.hasAttribute("data-ys-state") || slot.hasAttribute("data-ys-list");
}

/** What a reader sees with no saved state: "Nothing saved yet" and the list's summary. */
function expectDefault($: (sel: string) => HTMLElement) {
  expect($("[data-ys-saved]")?.hasAttribute("hidden") ?? true).toBe(true);
  expect($("[data-ys-none]").hasAttribute("hidden")).toBe(false);
  expect($("[data-ys]").hasAttribute("data-ys-state")).toBe(false);
  expect(listShown($)).toBe(true);
}

describe("the your state strip, filled from a saved state", () => {
  it("shows nothing saved and the list when nothing is saved", () => {
    const { $ } = run();
    expectDefault($);
    expect($("[data-ys-find]").hasAttribute("open")).toBe(false);
  });

  it("fills the strip for Ohio, hides the list and marks the slot with the code", () => {
    const { $ } = run({ stored: "OH" });
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
    expect($("[data-ys-none]").hasAttribute("hidden")).toBe(true);
    expect($("[data-ys]").getAttribute("data-ys-state")).toBe("OH");
    expect(listShown($)).toBe(false);
    expect($("[data-ys-code]").textContent).toBe("OH");
    expect($("[data-ys-name]").textContent).toBe("Ohio");
    expect($("[data-ys-price]").textContent).toBe("$6.250");
    expect($("[data-ys-move]").textContent).toBe("+30.4¢ +5.1%");
    expect($("[data-ys-move]").getAttribute("class")).toBe("ch up");
    expect($("[data-ys-plate]").textContent).toBe("EIA Midwest average, 15 states");
    // OPEN goes to the state, and says which state for a screen reader
    expect($("[data-ys-open]").getAttribute("href")).toBe("/state/oh/");
    expect($("[data-ys-open]").getAttribute("aria-label")).toBe("Open Ohio");
    expect($("[data-ys-change]").getAttribute("aria-expanded")).toBe("false");
  });

  it("never borrows a number for Alaska", () => {
    const { $ } = run({ stored: "AK" });
    expect($("[data-ys-price]").textContent).toBe("No EIA price");
    expect($("[data-ys-move]").textContent).toBe("");
    expect($("[data-ys-move]").getAttribute("class")).toBe("ch muted");
    expect($("[data-ys-plate]").textContent).toBe("EIA doesn't survey this state");
    expect($("[data-ys-open]").getAttribute("href")).toBe("/state/ak/");
  });

  it("wears blue for a fall and muted ink for about the same or no change", () => {
    expect(run({ stored: "FL" }).$("[data-ys-move]").getAttribute("class")).toBe("ch down");
    let r = run({ stored: "TX" });
    expect(r.$("[data-ys-move]").textContent).toBe("+0.4¢ +0.1%");
    expect(r.$("[data-ys-move]").getAttribute("class")).toBe("ch muted");
    r = run({ stored: "DE" });
    expect(r.$("[data-ys-move]").textContent).toBe("");
    expect(r.$("[data-ys-move]").getAttribute("class")).toBe("ch muted");
    expect(r.$("[data-ys-plate]").textContent).toBe("EIA Central Atlantic average, 5 states and DC");
  });

  it("gives California its own plate, the one its page and its card print", () => {
    expect(run({ stored: "CA" }).$("[data-ys-plate]").textContent).toBe("EIA California average");
  });
});

describe("the strip fails safe", () => {
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
    expectDefault(run({ store }).$);
  });

  it("when storage is missing altogether", () => {
    expectDefault(run({ store: () => undefined }).$);
  });

  for (const garbage of ["", "oh", "Ohio", "ZZ", "OH ", "0", "null", "__proto__", "constructor", "toString", '<img src=x onerror="alert(1)">', '{"code":"OH"}', "OH\"]", "*", "[data-ys-pick]"]) {
    it(`when the saved value is ${JSON.stringify(garbage)}`, () => {
      const { $, document } = run({ stored: garbage });
      expectDefault($);
      expect(document.querySelector("img")).toBeNull();
      expect($("[data-ys-open]").getAttribute("href")).toBe("/#find-your-state");
    });
  }

  it("shows only a state that is really in the list, whatever the saved value spells", () => {
    // a value that happens to select a real link shows that link's state and nothing else
    const { $ } = run({ stored: 'AL"], [data-ys-pick="OH' });
    expect($("[data-ys]").getAttribute("data-ys-state")).toBe("AL");
    expect($("[data-ys-name]").textContent).toBe("Alabama");
    expect($("[data-ys-open]").getAttribute("href")).toBe("/state/al/");
  });

  it("when the list carries no lines, as on the 404 page", () => {
    // no data-px on the links: the strip would print empty, so it stays hidden? No: the
    // saved state is real, so the strip fills with what there is, blank price and all.
    // That page has no strip at all, so nothing shows.
    const { $ } = run({ stored: "OH", html: page({ strip: false, saved: false }) });
    expect($("[data-ys]").hasAttribute("data-ys-state")).toBe(false);
    expect(listShown($)).toBe(true);
  });

  it("when a hook is missing", () => {
    expectDefault(run({ stored: "OH", html: page({ forget: false }) }).$);
    expectDefault(run({ stored: "OH", html: page({ saved: false }) }).$);
  });

  it("when the page has no list or no slot at all", () => {
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

describe("the script sits right after the list in the page", () => {
  it("YourState.astro renders both strips, then the list with the lines on it, then the script", () => {
    const row = readFileSync(new URL("../components/YourState.astro", import.meta.url), "utf8");
    const markup = row.slice(row.indexOf("<section"));
    const saved = markup.indexOf("data-ys-saved");
    const none = markup.indexOf("data-ys-none");
    const list = markup.indexOf("<FindYourState strip");
    const wire = markup.indexOf("set:html={wire}");
    expect(saved).toBeGreaterThan(-1);
    expect(none).toBeGreaterThan(saved);
    expect(list).toBeGreaterThan(none);
    expect(wire).toBeGreaterThan(list);
    // no JSON island any more: the lines ride on the links
    expect(row).not.toContain("your-state-data");
  });
});

describe("CHANGE and FORGET", () => {
  it("CHANGE opens the list under the strip and moves focus to it", () => {
    const { $ } = run({ stored: "OH" });
    const list = $("[data-ys-list]");
    const focus = vi.spyOn(list, "focus");
    $("[data-ys-change]").click();
    expect(listShown($)).toBe(true);
    expect($("[data-ys-find]").hasAttribute("open")).toBe(true);
    expect($("[data-ys-change]").getAttribute("aria-expanded")).toBe("true");
    expect(focus).toHaveBeenCalled();
    // the strip stays up while the list is open
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
  });

  it("a second press of CHANGE closes the list again", () => {
    const { $ } = run({ stored: "OH" });
    const change = $("[data-ys-change]");
    change.click();
    change.click();
    expect(listShown($)).toBe(false);
    expect($("[data-ys-find]").hasAttribute("open")).toBe(false);
    expect(change.getAttribute("aria-expanded")).toBe("false");
    change.click();
    expect(listShown($)).toBe(true);
    expect(change.getAttribute("aria-expanded")).toBe("true");
  });

  it("closing the list from its summary tucks it away and returns focus to CHANGE", () => {
    const { $, document } = run({ stored: "OH" });
    const change = $("[data-ys-change]");
    const focus = vi.spyOn(change, "focus");
    change.click();
    const find = $("[data-ys-find]");
    find.removeAttribute("open");
    find.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("toggle"));
    expect(listShown($)).toBe(false);
    expect(change.getAttribute("aria-expanded")).toBe("false");
    expect(focus).toHaveBeenCalled();
  });

  it("FORGET clears the saved state, puts nothing saved back and unmarks the quote row", () => {
    const { $, store, document } = run({ stored: "OH" });
    const summary = document.querySelector("summary") as unknown as HTMLElement;
    const focus = vi.spyOn(summary, "focus");
    $("[data-ys-change]").click();
    $("[data-ys-forget]").click();
    expect((store as unknown as MemoryStore).map.has(KEY)).toBe(false);
    expectDefault($);
    expect($("[data-ys-find]").hasAttribute("open")).toBe(false);
    expect(document.querySelector("tr.mine")).toBeNull();
    expect(focus).toHaveBeenCalled();
    // a toggle after FORGET leaves the strip alone
    const change = $("[data-ys-change]");
    const back = vi.spyOn(change, "focus");
    $("[data-ys-find]").dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("toggle"));
    expect(listShown($)).toBe(true);
    expect(back).not.toHaveBeenCalled();
  });

  it("FORGET still works on the page when removing from storage throws", () => {
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
    expect($("[data-ys-find]").hasAttribute("open")).toBe(true);
    expect(listShown($)).toBe(true);
  });

  it("opens the list under the strip when a state is saved", () => {
    const { $ } = run({ stored: "OH", hash: "#find-your-state" });
    expect($("[data-ys-saved]").hasAttribute("hidden")).toBe(false);
    expect(listShown($)).toBe(true);
    expect($("[data-ys-find]").hasAttribute("open")).toBe(true);
    expect($("[data-ys-change]").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the list even when storage throws", () => {
    const { $ } = run({ hash: "#find-your-state", store: () => { throw new Error("blocked"); } });
    expect($("[data-ys-find]").hasAttribute("open")).toBe(true);
  });

  it("leaves other hashes alone", () => {
    expect(run({ hash: "#regions-title" }).$("[data-ys-find]").hasAttribute("open")).toBe(false);
  });

  it("lands on the list inside the <details>, which Chrome opens even with JS off", () => {
    const { document } = parseHTML(page());
    const target = document.getElementById("find-your-state")!;
    expect(target.hasAttribute("data-ys-list")).toBe(true);
    expect(target.closest("details")).not.toBeNull();
  });
});

describe("picking a state from the list", () => {
  it("saves the state tapped on the home page, from the link or anything inside it", () => {
    const { $, store } = run();
    $('[data-ys-pick="OH"]').click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    ($('[data-ys-pick="AL"] b') as HTMLElement).click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("AL");
  });

  it("saves a pick even while a saved state holds the strip", () => {
    const { $, store } = run({ stored: "OH" });
    $("[data-ys-change]").click();
    $('[data-ys-pick="AL"]').click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("AL");
  });

  it("replaces a saved state only on a pick", () => {
    const { $, store } = run({ stored: "AL" });
    ($("[data-ys-list]") as HTMLElement).click();
    ($("summary") as HTMLElement).click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("AL");
  });

  it("shrugs off storage that throws, is full or isn't there", () => {
    for (const store of [
      () => { throw new DOMException("The operation is insecure.", "SecurityError"); },
      { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); } },
      () => undefined,
    ]) {
      const { $ } = run({ store });
      expect(() => $('[data-ys-pick="OH"]').click()).not.toThrow();
    }
  });

  describe("on the 404 page, with rememberPick", () => {
    function pick(opts: { store?: unknown; stored?: string } = {}) {
      const { document } = parseHTML(page({ saved: false, strip: false, open: true }));
      const store = (opts.store ?? new MemoryStore(opts.stored)) as Storage;
      const getStore = typeof opts.store === "function" ? (opts.store as () => Storage) : () => store;
      rememberPick(document as unknown as Document, getStore);
      const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
      return { document, store, $ };
    }

    it("saves the state tapped", () => {
      const { $, store } = pick();
      $('[data-ys-pick="OH"]').click();
      expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
      ($('[data-ys-pick="AL"] b') as HTMLElement).click();
      expect((store as unknown as MemoryStore).map.get(KEY)).toBe("AL");
    });

    it("shrugs off storage that throws and a page with no list", () => {
      const { $ } = pick({ store: () => { throw new Error("blocked"); } });
      expect(() => $('[data-ys-pick="OH"]').click()).not.toThrow();
      const { document } = parseHTML("<!doctype html><html><body><p>nothing</p></body></html>");
      expect(() => rememberPick(document as unknown as Document, () => new MemoryStore() as unknown as Storage)).not.toThrow();
    });
  });

  it("state pages save the state being viewed", () => {
    const statePage = readFileSync(new URL("../pages/state/[code].astro", import.meta.url), "utf8");
    expect(statePage).toMatch(/inlineCall\(saveOnView/);
  });
});

describe("saveOnView", () => {
  it("stores the code of the page being viewed", () => {
    const store = new MemoryStore("OH");
    saveOnView("TX", () => store as unknown as Storage);
    expect(store.map.get(KEY)).toBe("TX");
  });

  it("stays quiet when storage throws or is missing", () => {
    expect(() => saveOnView("TX", () => { throw new Error("blocked"); })).not.toThrow();
    const throwing = { setItem() { throw new Error("quota"); } } as unknown as Storage;
    expect(() => saveOnView("TX", () => throwing)).not.toThrow();
  });

  it("runs on its own as an inline script", () => {
    const store = new MemoryStore();
    new Function("store", inlineCall(saveOnView, '"PA"', "function(){return store}"))(store);
    expect(store.map.get(KEY)).toBe("PA");
  });
});

describe("what ships in the page", () => {
  const STORE = "function(){return window.localStorage}";
  const shipped = [
    inlineCall(yourState, "document", STORE, "location.hash"),
    inlineCall(rememberPick, "document", STORE),
    inlineCall(saveOnView, '"OH"', STORE),
  ];

  it("runs on its own as inline scripts, with nothing from outside their bodies", () => {
    const { document } = parseHTML(page());
    const store = new MemoryStore("OH");
    // the same shape the page prints: (fn)(document, getStore, ...)
    const at = (fn: (...a: never[]) => unknown, ...args: string[]) => new Function("document", "store", inlineCall(fn, "document", "function(){return store}", ...args));
    at(yourState, '"#find-your-state"')(document, store);
    expect(document.querySelector("[data-ys-open]")!.getAttribute("href")).toBe("/state/oh/");
    expect(document.querySelector("[data-ys-saved]")!.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("[data-ys]")!.hasAttribute("data-ys-list")).toBe(true);
    (document.querySelector('[data-ys-pick="AL"]') as unknown as HTMLElement).click();
    expect(store.map.get(KEY)).toBe("AL");
  });

  it("stays under 1 KB gzipped", () => {
    const code = shipped.join("");
    expect(code).not.toMatch(/^\s*\/\//m);
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(1024);
  });

  it("uses only hooks the components render", () => {
    const row = readFileSync(new URL("../components/YourState.astro", import.meta.url), "utf8");
    const list = readFileSync(new URL("../components/FindYourState.astro", import.meta.url), "utf8");
    const src = [yourState, rememberPick].map(String).join("\n");
    const hooks = [...new Set([...src.matchAll(/\[(data-ys[a-z-]*)\]/g)].map((m) => m[1]))];
    // the short names the script builds ("[data-ys-" + sel + "]")
    const built = [...src.matchAll(/q\("([a-z]+)"\)/g)].map((m) => `data-ys-${m[1]}`);
    expect(hooks.length + built.length).toBeGreaterThan(8);
    for (const hook of [...hooks, ...built]) expect(row + list, hook).toContain(hook);
    for (const attr of ["data-px", "data-ch", "data-ink", "data-pl"]) expect(list).toContain(attr);
    expect(list).toContain('id="find-your-state"');
  });
});
