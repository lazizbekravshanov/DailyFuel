import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineCall } from "../lib/inline.ts";
import { shareButton } from "./share.ts";

const URL_OH = "https://dailydiesel.vercel.app/state/oh/";
const TEXT_OH = "Ohio diesel is $6.250 a gallon, up 30.4 cents this week. DOE weekly Midwest average.";
const TITLE_OH = "Ohio diesel, DOE Midwest weekly average | DailyFuel";

/** The markup ShareButton.astro renders, hidden until the script shows it. */
function page(): string {
  return `<!doctype html><html><head><title>${TITLE_OH}</title></head><body>
    <div class="share" data-share hidden>
      <button type="button" class="share-button" data-text="${TEXT_OH}" data-url="${URL_OH}">Share</button>
      <span class="share-status" data-share-status role="status"></span>
    </div></body></html>`;
}

interface Fakes {
  share?: (data: ShareData) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

function run(fakes: Fakes = {}) {
  const { document } = parseHTML(page());
  const share = fakes.share ? vi.fn(fakes.share) : undefined;
  const writeText = fakes.writeText ? vi.fn(fakes.writeText) : undefined;
  const nav = { ...(share && { share }), ...(writeText && { clipboard: { writeText } }) } as unknown as Navigator;
  shareButton(document as unknown as Document, nav);
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  return {
    share,
    writeText,
    box: $("[data-share]"),
    status: () => $("[data-share-status]").textContent,
    click: () => $("[data-share] button").click(),
  };
}

/** Lets the promise chains after a click finish. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function named(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const ok = () => Promise.resolve();

afterEach(() => {
  vi.useRealTimers();
});

describe("share button", () => {
  it("opens the share sheet with the page's sentence, title and canonical URL", async () => {
    const t = run({ share: ok, writeText: ok });
    expect(t.box.hasAttribute("hidden")).toBe(false);
    t.click();
    await settle();
    expect(t.share).toHaveBeenCalledTimes(1);
    expect(t.share!.mock.calls[0][0]).toEqual({ title: TITLE_OH, text: TEXT_OH, url: URL_OH });
    expect(t.writeText).not.toHaveBeenCalled();
    expect(t.status()).toBe("");
  });

  it("does nothing when the reader closes the share sheet", async () => {
    const t = run({ share: () => Promise.reject(named("AbortError")), writeText: ok });
    t.click();
    await settle();
    expect(t.share).toHaveBeenCalledTimes(1);
    expect(t.writeText).not.toHaveBeenCalled();
    expect(t.status()).toBe("");
  });

  it("copies the link when sharing fails any other way", async () => {
    for (const err of [named("NotAllowedError"), named("DataError"), new TypeError("nope"), undefined]) {
      const t = run({ share: () => Promise.reject(err), writeText: ok });
      t.click();
      await settle();
      expect(t.writeText).toHaveBeenCalledWith(URL_OH);
      expect(t.status()).toBe("Link copied");
    }
  });

  it("copies the link when share throws instead of rejecting", async () => {
    const t = run({
      share: () => {
        throw named("TypeError");
      },
      writeText: ok,
    });
    t.click();
    await settle();
    expect(t.writeText).toHaveBeenCalledWith(URL_OH);
    expect(t.status()).toBe("Link copied");
  });

  it("copies the link when there's no share sheet", async () => {
    const t = run({ writeText: ok });
    expect(t.box.hasAttribute("hidden")).toBe(false);
    t.click();
    await settle();
    expect(t.writeText).toHaveBeenCalledWith(URL_OH);
    expect(t.status()).toBe("Link copied");
  });

  it("stays hidden when the browser can neither share nor copy", () => {
    const t = run();
    expect(t.box.hasAttribute("hidden")).toBe(true);
  });

  it("stays hidden when the clipboard has no writeText", () => {
    const { document } = parseHTML(page());
    shareButton(document as unknown as Document, { clipboard: {} } as unknown as Navigator);
    expect(document.querySelector("[data-share]")!.hasAttribute("hidden")).toBe(true);
  });

  it("shows the link to copy by hand when copying fails", async () => {
    const t = run({ writeText: () => Promise.reject(named("NotAllowedError")) });
    t.click();
    await settle();
    expect(t.status()).toBe(`Copy this link: ${URL_OH}`);
  });

  it("shows the link when copying throws", async () => {
    const t = run({
      writeText: () => {
        throw named("SecurityError");
      },
    });
    t.click();
    await settle();
    expect(t.status()).toBe(`Copy this link: ${URL_OH}`);
  });

  it("shows the link when sharing fails and there's no clipboard", async () => {
    const t = run({ share: () => Promise.reject(named("NotAllowedError")) });
    t.click();
    await settle();
    expect(t.status()).toBe(`Copy this link: ${URL_OH}`);
  });

  it("clears Link copied after a few seconds, and keeps a link to copy by hand", async () => {
    vi.useFakeTimers();
    const t = run({ writeText: ok });
    t.click();
    await settle();
    expect(t.status()).toBe("Link copied");
    vi.advanceTimersByTime(4000);
    expect(t.status()).toBe("Link copied");
    vi.advanceTimersByTime(1000);
    expect(t.status()).toBe("");

    let fail = false;
    const u = run({ writeText: () => (fail ? Promise.reject(named("NotAllowedError")) : Promise.resolve()) });
    u.click();
    await settle();
    expect(u.status()).toBe("Link copied");
    // a failed copy right after a good one must not be wiped by the old timer
    fail = true;
    u.click();
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(u.status()).toBe(`Copy this link: ${URL_OH}`);
  });

  it("does nothing on a page without the button", () => {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    expect(() => shareButton(document as unknown as Document, { share: ok } as unknown as Navigator)).not.toThrow();
  });
});

describe("what ships in the page", () => {
  const code = inlineCall(shareButton, "document", "navigator");

  it("runs on its own as an inline script", async () => {
    const { document } = parseHTML(page());
    const share = vi.fn(ok);
    new Function("document", "navigator", code)(document, { share });
    expect(document.querySelector("[data-share]")!.hasAttribute("hidden")).toBe(false);
    (document.querySelector("[data-share] button") as unknown as HTMLElement).click();
    await settle();
    expect(share).toHaveBeenCalledWith({ title: TITLE_OH, text: TEXT_OH, url: URL_OH });
  });

  it("stays under 600 bytes gzipped", () => {
    expect(code).not.toMatch(/^\s*\/\//m);
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(600);
  });

  it("uses only hooks the component renders, and renders it hidden", () => {
    const component = readFileSync(new URL("../components/ShareButton.astro", import.meta.url), "utf8");
    const hooks = [...new Set([...String(shareButton).matchAll(/\[(data-[a-z-]+)\]|"(data-[a-z-]+)"/g)].map((m) => m[1] ?? m[2]))];
    expect(hooks.sort()).toEqual(["data-share", "data-share-status", "data-text", "data-url"]);
    for (const hook of hooks) expect(component, hook).toContain(hook);
    expect(component).toMatch(/<div[^>]*\bdata-share\b[^>]*\bhidden\b/);
    expect(component).toMatch(/role="status"/);
    expect(component).toMatch(/inlineCall\(shareButton, "document", "navigator"\)/);
  });
});
