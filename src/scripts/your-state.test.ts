import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineCall } from "../lib/inline.ts";
import { myState, rememberPick, yourState } from "./your-state.ts";

// Your state, saved only on purpose: the home page's picker saves the state
// it opens, a state page's Save as my state button saves that state, and the
// 404 page's list saves a tap. Looking at a state never saves it. The home
// page fills its answer from strings the build formatted (yourStateJson,
// checked in yourstate.test.ts), so there is no money math in the browser to
// check here; these tests check the script copies the right line, wears the
// right ink, and fails safe on anything odd.
//
// myState's own cases (the save slot beside a state's name) are in
// my-state.test.ts; this file checks it ships alongside the others.

const KEY = "dailyfuel:state";

/**
 * The block YourState.astro prints, in the shape yourStateJson makes: each
 * state's name and line key, each line once. Strings as the build prints them.
 */
const DATA = {
  s: {
    AL: ["Alabama", "R30"],
    AK: ["Alaska", ""],
    CA: ["California", "SCA"],
    FL: ["Florida", "R1Z"],
    HI: ["Hawaii", ""],
    OH: ["Ohio", "R20"],
    TX: ["Texas", "R30"],
    DE: ["Delaware", "R1Y"],
  },
  l: {
    R30: ["$6.027", "Up 0.4¢", "from $6.023 last week.", "muted", "Gulf Coast average, same in 6 states"],
    SCA: ["$8.039", "Up 27.5¢", "from $7.764 last week.", "up", "California's own average"],
    R1Z: ["$6.096", "Down 2.1¢", "from $6.117 last week.", "down", "Lower Atlantic average, same in 6 states"],
    R20: ["$6.526", "Down 15.4¢", "from $6.680 last week.", "down", "Midwest average, same in 15 states"],
    R1Y: ["$6.312", "No change", "from last week.", "muted", "Central Atlantic average, same in 5 states and DC"],
    "": ["", "No weekly price", "", "muted", "The weekly survey does not cover this state."],
  },
};

const OPTIONS = Object.entries(DATA.s)
  .sort((a, b) => a[1][0].localeCompare(b[1][0]))
  .map(([code, [name]]) => `<option value="${code.toLowerCase()}">${name}</option>`)
  .join("");

/** The same hooks YourState.astro and index.astro render, in the same order. */
function page(opts: { data?: string | null; slot?: boolean; picked?: string; forget?: boolean } = {}): string {
  const { slot = true, forget = true } = opts;
  const data = opts.data === undefined ? JSON.stringify(DATA).replace(/</g, "\\u003c") : opts.data;
  const opts2 = opts.picked ? OPTIONS.replace(`value="${opts.picked}"`, `value="${opts.picked}" selected`) : OPTIONS;
  const ys = slot
    ? `<section class="ys" aria-label="Your state" data-ys><div class="ans">
        <p class="lbl"><span data-f="n"></span> diesel</p>
        <p class="big"><span data-f="p"></span></p>
        <p class="chw"><b data-f="c"></b> <span data-f="f"></span></p>
        <p class="pl" data-f="l"></p>
        <p class="wkl">Prices for the week of Sep 28, 2026.</p>
        <p class="op"><a class="btn wide" href="/#find-your-state" data-ys-open>Open the <span data-f="n"></span> page</a></p>
      </div>${data === null ? "" : `<script type="application/json" id="ys-data">${data}</script>`}</section>`
    : "";
  return `<!doctype html><html><body><main>${ys}
    <section class="hero"><h1 class="lbl">U.S. diesel average</h1>
      <form class="go" action="/go" id="find-your-state"><label class="lbl" for="go-s"><span class="g1">Your state</span><span class="g2">Change your state</span></label>
        <div class="go-r"><select id="go-s" name="s" required><option value="">Pick your state</option>${opts2}</select><button class="btn">Show price</button></div>
      </form>
      <form id="other"><select name="s"><option value="tx" selected>Texas</option></select></form>
    </section>
    ${forget ? `<p class="fg fine">This phone remembers your state. <button type="button" class="btn" data-ys-forget>Forget my state</button></p>` : ""}
    </main></body></html>`;
}

class MemoryStore {
  map = new Map<string, string>();
  writes = 0;
  constructor(init?: string) {
    if (init !== undefined) this.map.set(KEY, init);
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.writes++;
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.writes++;
    this.map.delete(k);
  }
}

// The scripts touch window globals (addEventListener for pageshow, location
// for the reload and the jump to a state page); stand them in.
let pageshow: ((e: { persisted: boolean }) => void)[] = [];
let loc: { href: string; reload: ReturnType<typeof vi.fn> };
beforeEach(() => {
  pageshow = [];
  loc = { href: "/", reload: vi.fn() };
  vi.stubGlobal("addEventListener", (type: string, fn: (e: { persisted: boolean }) => void) => {
    if (type === "pageshow") pageshow.push(fn);
  });
  vi.stubGlobal("location", loc);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** linkedom has no form.elements; give each form the one lookup the script uses. */
function withElements(document: Document) {
  for (const f of Array.from(document.querySelectorAll("form"))) {
    Object.defineProperty(f, "elements", { value: { namedItem: (n: string) => f.querySelector(`[name="${n}"]`) } });
  }
}

/** The home page's script, right after the your state section. */
function run(opts: { stored?: string; store?: unknown; html?: string } = {}) {
  const { document } = parseHTML(opts.html ?? page());
  withElements(document as unknown as Document);
  const store = (opts.store ?? new MemoryStore(opts.stored)) as Storage;
  const getStore = typeof opts.store === "function" ? (opts.store as () => Storage) : () => store;
  yourState(document as unknown as Document, getStore);
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  const text = (k: string) => $(`[data-ys] [data-f=${k}]`).textContent;
  const loaded = () => document.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("DOMContentLoaded"));
  return { document, store, $, text, loaded };
}

/** What a reader sees with nothing saved: the answer stays empty and hidden (CSS keys on data-ys-state), the picker leads. */
function expectDefault($: (sel: string) => HTMLElement) {
  expect($("[data-ys]").hasAttribute("data-ys-state")).toBe(false);
  for (const k of ["n", "p", "c", "f", "l"]) expect($(`[data-ys] [data-f=${k}]`).textContent).toBe("");
  expect($("[data-ys-open]").getAttribute("href")).toBe("/#find-your-state");
}

function submit(document: Document, id = "find-your-state") {
  const ev = new (document.defaultView as unknown as typeof globalThis).Event("submit", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
}

describe("the your state answer, filled from a saved state", () => {
  it("leaves the answer empty and unmarked when nothing is saved", () => {
    const { $ } = run();
    expectDefault($);
  });

  it("fills the answer for Ohio, marks the section with the code and opens Ohio's page", () => {
    const { $, text } = run({ stored: "OH" });
    expect($("[data-ys]").getAttribute("data-ys-state")).toBe("OH");
    // the name sits in the label and in the button, every [data-f=n]
    const names = Array.from($("[data-ys]").querySelectorAll("[data-f=n]")).map((e) => e.textContent);
    expect(names).toEqual(["Ohio", "Ohio"]);
    expect(text("p")).toBe("$6.526");
    expect(text("c")).toBe("Down 15.4¢");
    expect(text("f")).toBe("from $6.680 last week.");
    expect(text("l")).toBe("Midwest average, same in 15 states");
    expect($("[data-ys-open]").getAttribute("href")).toBe("/state/oh/");
    expect($("[data-ys-open]").textContent).toBe("Open the Ohio page");
  });

  it("colours only the change: blue for a fall, red for a rise, ink for the rest of the line", () => {
    const { $ } = run({ stored: "OH" });
    expect($("[data-ys] [data-f=c]").getAttribute("class")).toBe("down");
    for (const k of ["n", "p", "f"]) expect($(`[data-ys] [data-f=${k}]`).getAttribute("class") || "").toBe("");
    expect($("[data-ys] [data-f=l]").getAttribute("class")).toBe("pl");
    expect(run({ stored: "CA" }).$("[data-ys] [data-f=c]").getAttribute("class")).toBe("up");
  });

  it("wears muted ink for about the same and for no change", () => {
    let r = run({ stored: "TX" });
    expect(r.text("c")).toBe("Up 0.4¢");
    expect(r.$("[data-ys] [data-f=c]").getAttribute("class")).toBe("muted");
    r = run({ stored: "DE" });
    expect(r.text("c")).toBe("No change");
    expect(r.text("f")).toBe("from last week.");
    expect(r.$("[data-ys] [data-f=c]").getAttribute("class")).toBe("muted");
    expect(r.text("l")).toBe("Central Atlantic average, same in 5 states and DC");
  });

  it("never borrows a number for Alaska or Hawaii", () => {
    for (const [code, name] of [["AK", "Alaska"], ["HI", "Hawaii"]]) {
      const { $, text } = run({ stored: code });
      expect($("[data-ys]").getAttribute("data-ys-state")).toBe(code);
      expect(text("n")).toBe(name);
      expect(text("p")).toBe("");
      expect(text("c")).toBe("No weekly price");
      expect(text("f")).toBe("");
      expect($("[data-ys] [data-f=c]").getAttribute("class")).toBe("muted");
      expect(text("l")).toBe("The weekly survey does not cover this state.");
      expect($("[data-ys-open]").getAttribute("href")).toBe(`/state/${code.toLowerCase()}/`);
    }
  });

  it("gives California its own plate, the one its page and its card print", () => {
    expect(run({ stored: "CA" }).text("l")).toBe("California's own average");
  });

  it("says whose average every priced state reads, never that the state was measured on its own", () => {
    for (const code of ["AL", "FL", "OH", "TX", "DE"]) expect(run({ stored: code }).text("l")).toMatch(/ average, same in \d+ states( and DC)?$/);
  });

  it("sets the picker to the saved state once the page has parsed", () => {
    const { document, loaded } = run({ stored: "OH" });
    // linkedom's select has no value setter; stand in the browser's
    Object.defineProperty(document.getElementById("go-s"), "value", { value: "", writable: true });
    loaded();
    expect((document.getElementById("go-s") as unknown as HTMLSelectElement).value).toBe("oh");
  });
});

describe("the answer fails safe", () => {
  it("when reaching storage throws, like Safari with site data blocked", () => {
    expectDefault(
      run({
        store: () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
      }).$,
    );
  });

  it("when reading storage throws", () => {
    const store = { getItem: () => { throw new Error("denied"); }, setItem() {}, removeItem() {} };
    expectDefault(run({ store }).$);
  });

  it("when storage is missing altogether", () => {
    expectDefault(run({ store: () => undefined }).$);
  });

  it("when the JSON block is missing, empty or broken", () => {
    expect(() => run({ stored: "OH", html: page({ data: null }) })).not.toThrow();
    expectDefault(run({ stored: "OH", html: page({ data: null }) }).$);
    expectDefault(run({ stored: "OH", html: page({ data: "" }) }).$);
    expectDefault(run({ stored: "OH", html: page({ data: '{"s":' }) }).$);
    expectDefault(run({ stored: "OH", html: page({ data: '{"s":{"OH":["Ohio","R20"]}}' }) }).$);
  });

  for (const garbage of ["", "oh", "Ohio", "ZZ", "OH ", "0", "null", "__proto__", "constructor", "toString", "hasOwnProperty", '<img src=x onerror="alert(1)">', '{"code":"OH"}', "OH\"]", "*", "[data-ys-pick]"]) {
    it(`when the saved value is ${JSON.stringify(garbage)}`, () => {
      const { $, document } = run({ stored: garbage });
      expectDefault($);
      expect(document.querySelector("img")).toBeNull();
    });
  }

  it("when the page has no section at all", () => {
    expect(() => run({ stored: "OH", html: page({ slot: false }) })).not.toThrow();
    expect(() => run({ stored: "OH", html: "<!doctype html><html><body><p>nothing</p></body></html>" })).not.toThrow();
  });

  it("never writes to storage just by reading it", () => {
    const { store } = run({ stored: "OH" });
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    expect((store as unknown as MemoryStore).writes).toBe(0);
    const empty = run();
    expect((empty.store as unknown as MemoryStore).map.size).toBe(0);
    expect((empty.store as unknown as MemoryStore).writes).toBe(0);
  });
});

describe("the picker", () => {
  it("saves the picked state and opens its page", () => {
    const { document, store } = run({ html: page({ picked: "oh" }) });
    const ev = submit(document as unknown as Document);
    expect(ev.defaultPrevented).toBe(true);
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    expect(loc.href).toBe("/state/oh/");
  });

  it("replaces a saved state with the new pick", () => {
    const { document, store } = run({ stored: "OH", html: page({ picked: "fl" }) });
    submit(document as unknown as Document);
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("FL");
    expect(loc.href).toBe("/state/fl/");
  });

  it("does nothing with no state picked, so the browser's required check speaks", () => {
    const { document, store } = run({ stored: "OH" });
    const ev = submit(document as unknown as Document);
    expect(ev.defaultPrevented).toBe(false);
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    expect((store as unknown as MemoryStore).writes).toBe(0);
    expect(loc.href).toBe("/");
  });

  it("leaves any other form alone", () => {
    const { document, store } = run({ stored: "OH" });
    const ev = submit(document as unknown as Document, "other");
    expect(ev.defaultPrevented).toBe(false);
    expect((store as unknown as MemoryStore).writes).toBe(0);
    expect(loc.href).toBe("/");
  });

  it("still opens the page when saving throws, is full or storage isn't there", () => {
    for (const store of [
      () => { throw new DOMException("The operation is insecure.", "SecurityError"); },
      { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem() {} },
      () => undefined,
    ]) {
      loc.href = "/";
      const { document } = run({ store, html: page({ picked: "tx" }) });
      expect(() => submit(document as unknown as Document)).not.toThrow();
      expect(loc.href).toBe("/state/tx/");
    }
  });

  it("works with JS off: a plain GET form to /go with the state in s, which vercel.json sends to the state page", () => {
    const index = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8");
    expect(index).toMatch(/<form class="go" action="\/go" id="find-your-state">/);
    expect(index).toMatch(/<select id="go-s" name="s" required>/);
    const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
    const go = (vercel.redirects as { source: string; destination: string; has?: { key: string }[] }[]).filter((r) => r.source === "/go");
    expect(go.map((r) => r.destination)).toEqual(["/state/:s/", "/#find-your-state"]);
    expect(go[0].has?.[0].key).toBe("s");
  });
});

describe("Forget my state", () => {
  it("drops the saved state and starts the page over", () => {
    const { $, store } = run({ stored: "OH" });
    $("[data-ys-forget]").click();
    expect((store as unknown as MemoryStore).map.has(KEY)).toBe(false);
    expect(loc.reload).toHaveBeenCalledTimes(1);
  });

  it("still starts over when removing from storage throws", () => {
    const store = { getItem: () => "OH", setItem() {}, removeItem: () => { throw new Error("denied"); } };
    const { $ } = run({ store });
    expect(() => $("[data-ys-forget]").click()).not.toThrow();
    expect(loc.reload).toHaveBeenCalledTimes(1);
  });

  it("ignores taps anywhere else", () => {
    const { $, store } = run({ stored: "OH" });
    $("[data-ys-open]").click();
    $(".fg").click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    expect(loc.reload).not.toHaveBeenCalled();
  });
});

describe("the back button", () => {
  it("reloads a home page brought back from the cache, since a state page may have saved another state", () => {
    run({ stored: "OH" });
    expect(pageshow).toHaveLength(1);
    pageshow[0]({ persisted: false });
    expect(loc.reload).not.toHaveBeenCalled();
    pageshow[0]({ persisted: true });
    expect(loc.reload).toHaveBeenCalledTimes(1);
  });
});

describe("on the 404 page, with rememberPick", () => {
  const LIST = `<!doctype html><html><body><details class="pick" data-ys-find open><summary class="btn">Find your state</summary>
    <ul class="pick-list" id="find-your-state" data-ys-list tabindex="-1">
      <li><a href="/state/al/" data-ys-pick="AL"><b>AL</b> Alabama</a></li><li><a href="/state/oh/" data-ys-pick="OH"><b>OH</b> Ohio</a></li>
    </ul></details></body></html>`;

  function pick(opts: { store?: unknown; stored?: string } = {}) {
    const { document } = parseHTML(LIST);
    const store = (opts.store ?? new MemoryStore(opts.stored)) as Storage;
    const getStore = typeof opts.store === "function" ? (opts.store as () => Storage) : () => store;
    rememberPick(document as unknown as Document, getStore);
    const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
    return { document, store, $ };
  }

  it("saves the state tapped, from the link or anything inside it", () => {
    const { $, store } = pick();
    $('[data-ys-pick="OH"]').click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("OH");
    ($('[data-ys-pick="AL"] b') as HTMLElement).click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("AL");
  });

  it("replaces a saved state only on a pick", () => {
    const { $, store } = pick({ stored: "AL" });
    $("[data-ys-list]").click();
    $("summary").click();
    expect((store as unknown as MemoryStore).map.get(KEY)).toBe("AL");
    expect((store as unknown as MemoryStore).writes).toBe(0);
  });

  it("shrugs off storage that throws and a page with no list", () => {
    const { $ } = pick({ store: () => { throw new Error("blocked"); } });
    expect(() => $('[data-ys-pick="OH"]').click()).not.toThrow();
    const { document } = parseHTML("<!doctype html><html><body><p>nothing</p></body></html>");
    expect(() => rememberPick(document as unknown as Document, () => new MemoryStore() as unknown as Storage)).not.toThrow();
  });

  it("is the only list left: the 404 page shows it open, with no strip lines on the links", () => {
    const notFound = readFileSync(new URL("../pages/404.astro", import.meta.url), "utf8");
    expect(notFound).toMatch(/<FindYourState open \/>/);
    const index = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8");
    expect(index).not.toContain("<FindYourState");
  });
});

describe("where the scripts sit", () => {
  it("YourState.astro prints the answer, then the JSON block, then the script", () => {
    const src = readFileSync(new URL("../components/YourState.astro", import.meta.url), "utf8");
    const markup = src.slice(src.indexOf("<section"));
    const ans = markup.indexOf('class="ans"');
    const data = markup.indexOf('id="ys-data"');
    const wire = markup.indexOf("set:html={wire}");
    expect(ans).toBeGreaterThan(-1);
    expect(data).toBeGreaterThan(ans);
    expect(wire).toBeGreaterThan(data);
    expect(markup).toMatch(/<script is:inline type="application\/json" id="ys-data" set:html=\{data\}>/);
    // nothing in the JSON can close its <script>
    expect(src).toMatch(/JSON\.stringify\(yourStateJson\(site\)\)\.replace\(\/<\/g, "\\\\u003c"\)/);
  });

  it("the home page puts your state first in main, above the U.S. average", () => {
    const index = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8");
    const body = index.slice(index.indexOf("<Base"));
    expect(body.indexOf("<YourState>")).toBeGreaterThan(-1);
    expect(body.indexOf("<YourState>")).toBeLessThan(body.indexOf('<section class="hero"'));
    // Forget sits far from the picker, after the quotes
    expect(body.indexOf("data-ys-forget")).toBeGreaterThan(body.indexOf("<Quotes"));
  });

  it("state pages offer Save as my state and never save on view", () => {
    const statePage = readFileSync(new URL("../pages/state/[code].astro", import.meta.url), "utf8");
    expect(statePage).toMatch(/inlineCall\(myState, "document", JSON\.stringify\(s\.code\)/);
    expect(statePage).not.toMatch(/saveOnView|markMyState|data-my-state/);
    // the script follows the head row right away, before the price paints
    const row = statePage.indexOf("data-mine");
    const script = statePage.indexOf("set:html={save}");
    const price = statePage.indexOf('class:list={["big"');
    expect(row).toBeGreaterThan(-1);
    expect(script).toBeGreaterThan(row);
    expect(price).toBeGreaterThan(script);
  });
});

describe("what ships in the page", () => {
  const STORE = "function(){return window.localStorage}";
  const shipped = [inlineCall(yourState, "document", STORE), inlineCall(rememberPick, "document", STORE), inlineCall(myState, "document", '"OH"', STORE)];

  it("runs on its own as inline scripts, with nothing from outside their bodies", () => {
    const { document } = parseHTML(page({ picked: "fl" }));
    withElements(document as unknown as Document);
    const store = new MemoryStore("OH");
    // the same shape the page prints: (fn)(document, getStore)
    new Function("document", "store", inlineCall(yourState, "document", "function(){return store}"))(document, store);
    expect(document.querySelector("[data-ys-open]")!.getAttribute("href")).toBe("/state/oh/");
    expect(document.querySelector("[data-ys]")!.getAttribute("data-ys-state")).toBe("OH");
    submit(document as unknown as Document);
    expect(store.map.get(KEY)).toBe("FL");
    expect(loc.href).toBe("/state/fl/");
  });

  it("stays under 1 KB gzipped, all three together", () => {
    const code = shipped.join("");
    expect(code).not.toMatch(/^\s*\/\//m);
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(1024);
  });

  it("uses only hooks the components render", () => {
    const row = readFileSync(new URL("../components/YourState.astro", import.meta.url), "utf8");
    const index = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8");
    const list = readFileSync(new URL("../components/FindYourState.astro", import.meta.url), "utf8");
    const statePage = readFileSync(new URL("../pages/state/[code].astro", import.meta.url), "utf8");
    const all = row + index + list + statePage;
    const src = [yourState, rememberPick, myState].map(String).join("\n");
    const hooks = [...new Set([...src.matchAll(/\[(data-[a-z-]+)\]/g)].map((m) => m[1]))];
    expect(hooks).toEqual(expect.arrayContaining(["data-ys", "data-ys-forget", "data-ys-open", "data-ys-list", "data-ys-pick", "data-mine"]));
    for (const hook of hooks) expect(all, hook).toContain(hook);
    for (const k of ["n", "p", "c", "f", "l"]) expect(row).toContain(`data-f="${k}"`);
    for (const id of ['id="ys-data"', 'id="find-your-state"', 'id="go-s"']) expect(row + index).toContain(id);
  });

  it("prints no arrows, glyphs or dashes", () => {
    const src = readFileSync(new URL("./your-state.ts", import.meta.url), "utf8");
    const row = readFileSync(new URL("../components/YourState.astro", import.meta.url), "utf8");
    for (const text of [JSON.stringify(DATA), row, ...shipped]) {
      expect(text).not.toMatch(/[←-⇿‹›▲-▿✓✔]/);
      expect(text).not.toMatch(/[–—]| - /);
    }
    expect(src).not.toMatch(/[–—]/);
  });
});
