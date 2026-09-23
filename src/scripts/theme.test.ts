import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { inlineCall } from "../lib/inline.ts";
import { applyStoredTheme, themeToggle } from "./theme.ts";

/** The head and header markup Base.astro and ThemeToggle.astro render. */
function page(withButton = true): string {
  return `<!doctype html><html lang="en"><head>
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  </head><body>
    ${withButton ? '<button type="button" class="btn" data-theme-toggle hidden>Dark</button>' : ""}
  </body></html>`;
}

/** A localStorage that can be told to throw, like private mode. */
function storage(seed: Record<string, string> = {}, broken = false): Storage {
  const map = new Map(Object.entries(seed));
  const fail = () => {
    throw new Error("SecurityError");
  };
  return {
    getItem: broken ? fail : (k: string) => map.get(k) ?? null,
    setItem: broken ? fail : (k: string, v: string) => void map.set(k, v),
    removeItem: broken ? fail : (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  } as unknown as Storage;
}

/** A window whose system setting is light or dark, with a matchMedia that can announce a change. */
function win(systemDark: boolean, withMatchMedia = true) {
  const listeners: Array<() => void> = [];
  const mq = {
    matches: systemDark,
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.push(fn)),
  };
  const w = withMatchMedia ? { matchMedia: vi.fn(() => mq) } : {};
  return {
    w: w as unknown as Window,
    mq,
    flip: () => {
      mq.matches = !mq.matches;
      for (const fn of listeners) fn();
    },
  };
}

function run(opts: { systemDark?: boolean; store?: Storage; button?: boolean; matchMedia?: boolean } = {}) {
  const { document } = parseHTML(page(opts.button ?? true));
  const store = opts.store ?? storage();
  const { w, flip } = win(opts.systemDark ?? false, opts.matchMedia ?? true);
  themeToggle(document as unknown as Document, w, () => store);
  const button = document.querySelector("[data-theme-toggle]") as unknown as HTMLElement | null;
  return {
    document,
    store,
    flip,
    button,
    html: document.documentElement as unknown as HTMLElement,
    metas: () => Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => [m.getAttribute("content"), m.getAttribute("media")]),
    click: () => button!.click(),
  };
}

describe("before the first paint", () => {
  it("puts a saved choice on <html>", () => {
    for (const t of ["dark", "light"]) {
      const { document } = parseHTML(page());
      applyStoredTheme(document as unknown as Document, () => storage({ "dailyfuel:theme": t }));
      expect(document.documentElement.getAttribute("data-theme")).toBe(t);
    }
  });

  it("leaves the page on the system setting with nothing saved, a bad value, or no storage", () => {
    for (const store of [storage(), storage({ "dailyfuel:theme": "blue" }), storage({}, true)]) {
      const { document } = parseHTML(page());
      expect(() => applyStoredTheme(document as unknown as Document, () => store)).not.toThrow();
      expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    }
  });
});

describe("the DARK button", () => {
  it("shows itself and says what a tap does: Dark on a light page, Light on a dark one", () => {
    const light = run({ systemDark: false });
    expect(light.button!.hasAttribute("hidden")).toBe(false);
    expect(light.button!.textContent).toBe("Dark");
    expect(light.button!.classList.contains("on")).toBe(false);
    const dark = run({ systemDark: true });
    expect(dark.button!.textContent).toBe("Light");
    expect(dark.button!.classList.contains("on")).toBe(true);
    // the system setting alone forces nothing on <html> and leaves theme-color to its media queries
    expect(dark.html.hasAttribute("data-theme")).toBe(false);
    expect(dark.metas()).toEqual([["#ffffff", "(prefers-color-scheme: light)"], ["#000000", "(prefers-color-scheme: dark)"]]);
  });

  it("forces the other theme on a tap, remembers it, and back again", () => {
    const t = run({ systemDark: false });
    t.click();
    expect(t.html.getAttribute("data-theme")).toBe("dark");
    expect((t.store as unknown as { dump: () => Record<string, string> }).dump()).toEqual({ "dailyfuel:theme": "dark" });
    expect(t.button!.textContent).toBe("Light");
    expect(t.button!.classList.contains("on")).toBe(true);
    expect(t.metas()).toEqual([["#000000", null], ["#000000", null]]);
    t.click();
    expect(t.html.getAttribute("data-theme")).toBe("light");
    expect((t.store as unknown as { dump: () => Record<string, string> }).dump()).toEqual({ "dailyfuel:theme": "light" });
    expect(t.button!.textContent).toBe("Dark");
    expect(t.metas()).toEqual([["#ffffff", null], ["#ffffff", null]]);
  });

  it("starts from a saved choice, whatever the system says", () => {
    const { document } = parseHTML(page());
    const store = storage({ "dailyfuel:theme": "light" });
    applyStoredTheme(document as unknown as Document, () => store);
    const { w } = win(true);
    themeToggle(document as unknown as Document, w, () => store);
    const button = document.querySelector("[data-theme-toggle]")!;
    expect(button.textContent).toBe("Dark");
    button.dispatchEvent(new (document.defaultView as unknown as { Event: typeof Event }).Event("click"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(button.textContent).toBe("Light");
  });

  it("follows the system when it changes and nothing is forced", () => {
    const t = run({ systemDark: false });
    t.flip();
    expect(t.button!.textContent).toBe("Light");
    expect(t.html.hasAttribute("data-theme")).toBe(false);
    t.flip();
    expect(t.button!.textContent).toBe("Dark");
  });

  it("still switches the page when storage throws", () => {
    const t = run({ store: storage({}, true) });
    expect(() => t.click()).not.toThrow();
    expect(t.html.getAttribute("data-theme")).toBe("dark");
    expect(t.button!.textContent).toBe("Light");
  });

  it("treats a browser with no matchMedia as light", () => {
    const t = run({ matchMedia: false });
    expect(t.button!.textContent).toBe("Dark");
    t.click();
    expect(t.html.getAttribute("data-theme")).toBe("dark");
  });

  it("does nothing on a page without the button", () => {
    expect(() => run({ button: false })).not.toThrow();
  });
});

describe("what ships in the page", () => {
  const boot = inlineCall(applyStoredTheme, "document", "function(){return window.localStorage}");
  const toggle = inlineCall(themeToggle, "document", "window", "function(){return window.localStorage}");

  it("runs on its own as inline scripts", () => {
    const { document } = parseHTML(page());
    const store = storage({ "dailyfuel:theme": "dark" });
    const window = { localStorage: store, matchMedia: () => ({ matches: false, addEventListener() {} }) };
    new Function("document", "window", boot)(document, window);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    new Function("document", "window", toggle)(document, window);
    const button = document.querySelector("[data-theme-toggle]")!;
    expect(button.hasAttribute("hidden")).toBe(false);
    expect(button.textContent).toBe("Light");
  });

  it("stays small: the two scripts under 700 bytes gzipped together", () => {
    expect(boot).not.toMatch(/^\s*\/\//m);
    expect(toggle).not.toMatch(/^\s*\/\//m);
    expect(gzipSync(boot + toggle, { level: 9 }).length).toBeLessThan(700);
  });

  it("uses only hooks the component and the layout render, hidden until wired", () => {
    const component = readFileSync(new URL("../components/ThemeToggle.astro", import.meta.url), "utf8");
    expect(component).toMatch(/<button[^>]*\bdata-theme-toggle\b[^>]*\bhidden\b/);
    expect(component).toContain('inlineCall(themeToggle, "document", "window", "function(){return window.localStorage}")');
    const base = readFileSync(new URL("../layouts/Base.astro", import.meta.url), "utf8");
    expect(base).toContain('inlineCall(applyStoredTheme, "document", "function(){return window.localStorage}")');
    // the boot script sits in <head>, before the page paints
    expect(base.indexOf("themeBoot}")).toBeLessThan(base.indexOf("</head>"));
    expect(base).toContain('<meta name="color-scheme" content="light dark" />');
  });
});
