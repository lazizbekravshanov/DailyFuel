import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { inlineCall } from "../lib/inline.ts";
import { markMyState } from "./my-state.ts";
import { saveOnView } from "./your-state.ts";

const KEY = "dailyfuel:state";

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

function page(withMark = true): Document {
  const mark = withMark ? '<span class="acts"><span class="mark" data-my-state>My state ✓</span></span>' : "";
  return parseHTML(`<!doctype html><html><body><div class="head-row"><h1>OH Ohio</h1>${mark}</div></body></html>`).document as unknown as Document;
}

const on = (doc: Document) => doc.querySelector("[data-my-state]")!.hasAttribute("data-on");

describe("the MY STATE marker", () => {
  it("shows once the page's state is the saved one", () => {
    const doc = page();
    const store = new MemoryStore("OH") as unknown as Storage;
    markMyState(doc, "OH", () => store);
    expect(on(doc)).toBe(true);
  });

  it("stays invisible for another state, or with nothing saved", () => {
    const doc = page();
    markMyState(doc, "OH", () => new MemoryStore("PA") as unknown as Storage);
    expect(on(doc)).toBe(false);
    markMyState(doc, "OH", () => new MemoryStore() as unknown as Storage);
    expect(on(doc)).toBe(false);
  });

  it("follows the save on view, so a page shows the marker for itself", () => {
    const doc = page();
    const store = new MemoryStore("PA") as unknown as Storage;
    saveOnView("OH", () => store);
    markMyState(doc, "OH", () => store);
    expect(store.getItem(KEY)).toBe("OH");
    expect(on(doc)).toBe(true);
  });

  it("fails safe when storage throws or the marker is missing", () => {
    const doc = page();
    markMyState(doc, "OH", () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    expect(on(doc)).toBe(false);
    expect(() => markMyState(page(false), "OH", () => new MemoryStore("OH") as unknown as Storage)).not.toThrow();
  });

  it("inlines to a call that stands alone", () => {
    const code = inlineCall(markMyState, "document", JSON.stringify("OH"), "function(){return window.localStorage}");
    expect(code).toMatch(/^\(function/);
    expect(code).toContain('"dailyfuel:state"');
    expect(code).toContain("data-on");
    expect(code).not.toMatch(/import|require/);
    expect(code.length).toBeLessThan(300);
  });
});
