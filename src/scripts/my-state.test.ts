import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineCall } from "../lib/inline.ts";
import { myState } from "./your-state.ts";

// The save slot in a state page's head row, which replaced the MY STATE
// marker (markMyState) and the save on view behind it. The slot holds
// "Save as my state" and "Your saved state" in one grid cell from the first
// paint, and data-mine says which shows: "n" the button, "y" the words,
// anything else neither. Opening a state page never saves it; only the
// button does.

const KEY = "dailyfuel:state";

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

/** The head row [code].astro prints. */
function page(withSlot = true): Document {
  const slot = withSlot
    ? '<span class="acts mine" data-mine><button type="button" class="btn">Save as my state</button><span class="saved" tabindex="-1">Your saved state</span></span>'
    : "";
  return parseHTML(`<!doctype html><html><body><p class="back"><a href="/#states">All states</a></p><div class="head-row"><h1 class="h1row"><span class="sym">OH</span><span class="nmbig">Ohio</span></h1>${slot}</div></body></html>`)
    .document as unknown as Document;
}

const shows = (doc: Document) => doc.querySelector("[data-mine]")!.getAttribute("data-mine");
const button = (doc: Document) => doc.querySelector("[data-mine] button") as unknown as HTMLElement;
const blocked = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

let pageshow: ((e: { persisted: boolean }) => void)[] = [];
let loc: { reload: ReturnType<typeof vi.fn> };
beforeEach(() => {
  pageshow = [];
  loc = { reload: vi.fn() };
  vi.stubGlobal("addEventListener", (type: string, fn: (e: { persisted: boolean }) => void) => {
    if (type === "pageshow") pageshow.push(fn);
  });
  vi.stubGlobal("location", loc);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opening a state page", () => {
  it("never saves it, not even the first state page ever opened", () => {
    const store = new MemoryStore();
    myState(page(), "TX", () => store as unknown as Storage);
    expect(store.map.size).toBe(0);
    expect(store.writes).toBe(0);
  });

  it("never replaces the saved state: looking at Indiana, Pennsylvania and West Virginia leaves Ohio saved", () => {
    const store = new MemoryStore("OH");
    for (const code of ["IN", "PA", "WV"]) {
      const doc = page();
      myState(doc, code, () => store as unknown as Storage);
      expect(shows(doc)).toBe("n");
    }
    expect(store.map.get(KEY)).toBe("OH");
    expect(store.writes).toBe(0);
  });

  it("shows Your saved state on the saved state's own page", () => {
    const doc = page();
    myState(doc, "OH", () => new MemoryStore("OH") as unknown as Storage);
    expect(shows(doc)).toBe("y");
  });

  it("shows Save as my state for another state, or with nothing saved", () => {
    let doc = page();
    myState(doc, "OH", () => new MemoryStore("PA") as unknown as Storage);
    expect(shows(doc)).toBe("n");
    doc = page();
    myState(doc, "OH", () => new MemoryStore() as unknown as Storage);
    expect(shows(doc)).toBe("n");
    // the code must match exactly
    doc = page();
    myState(doc, "OH", () => new MemoryStore("oh") as unknown as Storage);
    expect(shows(doc)).toBe("n");
  });
});

describe("Save as my state", () => {
  it("saves this state, swaps in Your saved state and moves focus to it", () => {
    const doc = page();
    const store = new MemoryStore("OH");
    myState(doc, "WV", () => store as unknown as Storage);
    const saved = doc.querySelector(".saved") as unknown as HTMLElement;
    const focus = vi.spyOn(saved, "focus");
    button(doc).click();
    expect(store.map.get(KEY)).toBe("WV");
    expect(shows(doc)).toBe("y");
    expect(focus).toHaveBeenCalled();
  });

  it("works the same with nothing saved before", () => {
    const doc = page();
    const store = new MemoryStore();
    myState(doc, "TX", () => store as unknown as Storage);
    button(doc).click();
    expect(store.map.get(KEY)).toBe("TX");
    expect(shows(doc)).toBe("y");
  });

  it("keeps the button when saving throws, and says nothing it did not do", () => {
    const doc = page();
    const store = { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem() {} };
    myState(doc, "OH", () => store as unknown as Storage);
    expect(() => button(doc).click()).not.toThrow();
    expect(shows(doc)).toBe("n");
  });
});

describe("the slot fails safe", () => {
  it("shows neither when reaching or reading storage throws, or storage is missing", () => {
    for (const getStore of [blocked, () => ({ getItem: () => { throw new Error("denied"); } }), () => undefined]) {
      const doc = page();
      expect(() => myState(doc, "OH", getStore as unknown as () => Storage)).not.toThrow();
      expect(shows(doc)).toBe("");
    }
  });

  it("does nothing on a page with no slot", () => {
    expect(() => myState(page(false), "OH", () => new MemoryStore("OH") as unknown as Storage)).not.toThrow();
    expect(pageshow).toHaveLength(0);
  });

  it("reloads a page brought back by the back button, since another page may have saved a different state", () => {
    myState(page(), "OH", () => new MemoryStore() as unknown as Storage);
    expect(pageshow).toHaveLength(1);
    pageshow[0]({ persisted: false });
    expect(loc.reload).not.toHaveBeenCalled();
    pageshow[0]({ persisted: true });
    expect(loc.reload).toHaveBeenCalledTimes(1);
  });
});

describe("in the page", () => {
  const statePage = readFileSync(new URL("../pages/state/[code].astro", import.meta.url), "utf8");

  it("prints the slot hidden until the script marks it, so showing either moves nothing", () => {
    expect(statePage).toMatch(/<span class="acts mine" data-mine><button type="button" class="btn">Save as my state<\/button><span class="saved" tabindex="-1">Your saved state<\/span><\/span>/);
    expect(statePage).toMatch(/\.mine\s*\{\s*display: grid;/);
    expect(statePage).toMatch(/\.mine > \*\s*\{[^}]*visibility: hidden;/);
    expect(statePage).toMatch(/\.mine\[data-mine="n"\] \.btn,\s*\.mine\[data-mine="y"\] \.saved\s*\{[^}]*visibility: visible;/);
  });

  it("the back link says All states with no glyph", () => {
    expect(statePage).toContain('<p class="back"><a href="/#states">All states</a></p>');
    expect(statePage).not.toMatch(/[‹›✓]/);
  });

  it("no page uses the old marker any more", () => {
    expect(statePage).not.toMatch(/markMyState|data-my-state|my-state\.ts/);
  });

  it("inlines to a call that stands alone, and saves only from the button", () => {
    const code = inlineCall(myState, "document", JSON.stringify("OH"), "function(){return window.localStorage}");
    expect(code).toMatch(/^\(function/);
    expect(code).toContain('"dailyfuel:state"');
    expect(code).toContain("data-mine");
    expect(code).not.toMatch(/import|require/);
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(400);
    const doc = page();
    const store = new MemoryStore();
    new Function("document", "store", inlineCall(myState, "document", '"OH"', "function(){return store}"))(doc, store);
    expect(store.writes).toBe(0);
    expect(shows(doc)).toBe("n");
    button(doc).click();
    expect(store.map.get(KEY)).toBe("OH");
  });
});
