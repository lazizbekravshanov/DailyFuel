import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { inlineCall } from "../../lib/inline.ts";
import { quotes } from "./quotes.ts";

interface Row {
  s: string;
  n: string;
  l?: string;
  c?: string;
  q?: string;
  r?: string;
  t?: string;
}

const ROWS: Row[] = [
  { s: "AL", n: "Alabama", l: "6.027", c: "27.3", q: "4.7", r: "Gulf Coast", t: "30" },
  { s: "AK", n: "Alaska", t: "8" },
  { s: "CA", n: "California", l: "8.039", c: "27.5", q: "3.5", r: "California", t: "45.4" },
  { s: "DC", n: "District of Columbia", l: "6.312", c: "26.1", q: "4.3", r: "Central Atlantic" },
  { s: "FL", n: "Florida", l: "6.096", c: "-2.1", q: "-0.3", r: "Lower Atlantic", t: "30.4" },
  { s: "OH", n: "Ohio", l: "6.25", c: "30.4", q: "5.1", r: "Midwest", t: "47" },
];

/** The same shape Quotes.astro renders. */
function page(opts: { mine?: string; find?: boolean } = {}): string {
  const { mine, find = true } = opts;
  const rows = ROWS.map((r) => {
    const attrs = (["s", "n", "l", "c", "q", "r", "t"] as const).map((k) => ` data-${k}="${r[k] ?? ""}"`).join("");
    const cells = r.l
      ? `<td>${r.n}</td><td class="num">${r.l}</td><td class="num c-chg up">+${r.c}</td><td class="num c-pct up">+${r.q}</td><td>${r.r}</td>`
      : `<td>${r.n}</td><td colspan="4" class="muted">No EIA survey</td>`;
    return `<tr${attrs} data-h="/state/${r.s.toLowerCase()}/"><th scope="row"><a href="/state/${r.s.toLowerCase()}/">${r.s}</a></th>${cells}<td class="num">${r.t ?? "n/a"}</td></tr>`;
  }).join("");
  return `<!doctype html><html><body>
    <section class="ys" data-ys${mine ? ` data-ys-state="${mine}"` : ""}></section>
    <div class="sh"><p class="meta" id="count" role="status">${ROWS.length} states</p>
    ${find ? `<span class="find"><input id="find" type="text"></span>` : ""}</div>
    <table id="quotes"><thead><tr>
      <th scope="col" data-k="s" aria-label="State code">Sym<span class="ar" aria-hidden="true"></span></th>
      <th scope="col" data-k="n" aria-sort="ascending" aria-label="State name">Name<span class="ar" aria-hidden="true"></span></th>
      <th scope="col" class="num" data-k="l" data-num="1" aria-label="Last price, dollars a gallon">Last $<span class="ar" aria-hidden="true"></span></th>
      <th scope="col" class="num" data-k="c" data-num="1" aria-label="Change in cents from last week">Chg ¢<span class="ar" aria-hidden="true"></span></th>
      <th scope="col" class="num" data-k="q" data-num="1" aria-label="Change in percent from last week">%Chg<span class="ar" aria-hidden="true"></span></th>
      <th scope="col" data-k="r" aria-label="EIA region">Region<span class="ar" aria-hidden="true"></span></th>
      <th scope="col" class="num" data-k="t" data-num="1" aria-label="State diesel tax, cents a gallon">Tax ¢<span class="ar" aria-hidden="true"></span></th>
    </tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function run(opts: { mine?: string; find?: boolean; html?: string } = {}) {
  const { document } = parseHTML(opts.html ?? page(opts));
  const find = document.getElementById("find") as unknown as HTMLInputElement | null;
  // linkedom has no select(); the browser does
  if (find) find.select = vi.fn();
  quotes(document as unknown as Document);
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as unknown as HTMLElement[];
  const order = () => $$("#quotes tbody tr").filter((r) => !r.hasAttribute("hidden")).map((r) => r.getAttribute("data-s"));
  const head = (k: string) => $(`th[data-k="${k}"]`);
  const key = (el: HTMLElement, key: string, extra: Record<string, unknown> = {}) => {
    const e = new (document.defaultView as unknown as typeof globalThis).Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(e, { key, ...extra });
    el.dispatchEvent(e);
    return e;
  };
  return { document, $, $$, order, head, key, find: find as HTMLInputElement };
}

describe("the column heads", () => {
  it("become buttons, with the sort mark on the head the table opens sorted by", () => {
    const { $$, head } = run();
    const buttons = $$("th[data-k] button.sortb");
    expect(buttons).toHaveLength(7);
    expect(buttons.map((b) => b.getAttribute("type"))).toEqual(Array(7).fill("button"));
    expect(head("n").querySelector("button")!.textContent).toBe("Name▲");
    expect(head("s").querySelector("button")!.textContent).toBe("Sym");
    // the mark's slot moves from the head into the button, so nothing changes width
    expect($$(".ar")).toHaveLength(7);
    for (const ar of $$("button.sortb > .ar")) expect(ar.getAttribute("aria-hidden")).toBe("true");
    expect($$("th > .ar")).toHaveLength(0);
    // the head's spoken name stays on the head
    expect(head("l").getAttribute("aria-label")).toBe("Last price, dollars a gallon");
  });

  it("sort numbers highest first, then flip, keeping aria-sort in step and saying so", () => {
    const { $, head, order } = run();
    const btn = head("l").querySelector("button") as HTMLElement;
    btn.click();
    expect(order()).toEqual(["CA", "DC", "OH", "FL", "AL", "AK"]);
    expect(head("l").getAttribute("aria-sort")).toBe("descending");
    expect(head("n").hasAttribute("aria-sort")).toBe(false);
    expect(head("l").querySelector(".ar")!.textContent).toBe("▼");
    expect(head("n").querySelector(".ar")!.textContent).toBe("");
    expect($("#count").textContent).toBe("6 states, sorted by Last price, dollars a gallon, highest first");
    btn.click();
    // a row with no value goes last either way
    expect(order()[5]).toBe("AK");
    expect(order().slice(0, 5)).toEqual(["AL", "FL", "OH", "DC", "CA"]);
    expect(head("l").getAttribute("aria-sort")).toBe("ascending");
    expect($("#count").textContent).toBe("6 states, sorted by Last price, dollars a gallon, lowest first");
  });

  it("sort a fall below every rise, by the number and not the text", () => {
    const { head, order } = run();
    (head("c").querySelector("button") as HTMLElement).click();
    expect(order()).toEqual(["OH", "CA", "AL", "DC", "FL", "AK"]);
  });

  it("sort words A to Z, and Z to A on a second press", () => {
    const { $, head, order } = run();
    const btn = head("n").querySelector("button") as HTMLElement;
    // Name opens ascending, so the first press flips it
    btn.click();
    expect(order()).toEqual(["OH", "FL", "DC", "CA", "AK", "AL"]);
    expect($("#count").textContent).toBe("6 states, sorted by State name, Z to A");
    btn.click();
    expect(order()).toEqual(["AL", "AK", "CA", "DC", "FL", "OH"]);
    (head("r").querySelector("button") as HTMLElement).click();
    expect(order()).toEqual(["CA", "DC", "AL", "FL", "OH", "AK"]);
  });
});

describe("your state's row", () => {
  it("is marked from the strip's slot, never from storage", () => {
    const { $ } = run({ mine: "OH" });
    expect($('tr[data-s="OH"]').getAttribute("class")).toBe("mine");
    expect($('tr[data-s="AL"]').hasAttribute("class")).toBe(false);
  });

  it("is left alone when nothing is saved or the code is not in the table", () => {
    expect(run().document.querySelector("tr.mine")).toBeNull();
    expect(run({ mine: "ZZ" }).document.querySelector("tr.mine")).toBeNull();
  });
});

describe("a tap on a row", () => {
  it("opens the state, the way its code link does", () => {
    const { $ } = run();
    const a = $('tr[data-s="OH"] a');
    const click = vi.spyOn(a, "click");
    $('tr[data-s="OH"] td').click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("lets a tap on the link itself through once", () => {
    const { $ } = run();
    const a = $('tr[data-s="OH"] a');
    const click = vi.spyOn(a, "click");
    a.click();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("the find box", () => {
  it("keeps the rows that match a code's start or a name's middle, and counts them", () => {
    const { $, find, order } = run();
    find.value = "oh";
    find.dispatchEvent(new (find.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
    expect(order()).toEqual(["OH"]);
    expect($("#count").textContent).toBe("1 of 6 states");
    find.value = "A";
    find.dispatchEvent(new (find.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
    // AL and AK by code, everyone with an a in the name
    expect(order()).toEqual(["AL", "AK", "CA", "DC", "FL"]);
    expect($("#count").textContent).toBe("5 of 6 states");
    find.value = "  ";
    find.dispatchEvent(new (find.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
    expect(order()).toHaveLength(6);
    expect($("#count").textContent).toBe("6 states");
  });

  it("clears on Escape", () => {
    const { $, find, key, order } = run();
    find.value = "oh";
    find.dispatchEvent(new (find.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
    key(find, "Escape");
    expect(find.value).toBe("");
    expect(order()).toHaveLength(6);
    expect($("#count").textContent).toBe("6 states");
  });

  it("opens the one match on Enter, by exact code or name, or when one row is left", () => {
    const { $, find, key } = run();
    const clicks = { OH: 0, DC: 0 };
    ($('tr[data-s="OH"] a') as HTMLElement).addEventListener("click", () => (clicks.OH += 1));
    ($('tr[data-s="DC"] a') as HTMLElement).addEventListener("click", () => (clicks.DC += 1));
    find.value = "oh";
    key(find, "Enter");
    expect(clicks.OH).toBe(1);
    find.value = "district of columbia";
    key(find, "Enter");
    expect(clicks.DC).toBe(1);
    // several rows still showing and no exact match: nothing opens
    find.value = "a";
    find.dispatchEvent(new (find.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
    const e = key(find, "Enter");
    expect(clicks).toEqual({ OH: 1, DC: 1 });
    expect(e.defaultPrevented).toBe(false);
  });

  it("takes focus on / from anywhere but a field", () => {
    const { document, find, key } = run();
    const focus = vi.spyOn(find, "focus");
    key(document.body as unknown as HTMLElement, "/");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(find.select).toHaveBeenCalledTimes(1);
    key(find, "/");
    expect(focus).toHaveBeenCalledTimes(1);
    key(document.body as unknown as HTMLElement, "/", { ctrlKey: true });
    key(document.body as unknown as HTMLElement, "?");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("is optional: the table still sorts without it", () => {
    const { head, order } = run({ find: false });
    (head("l").querySelector("button") as HTMLElement).click();
    expect(order()[0]).toBe("CA");
  });
});

describe("what ships", () => {
  it("does nothing on a page without the table", () => {
    const { document } = parseHTML("<!doctype html><html><body><p>nothing</p></body></html>");
    expect(() => quotes(document as unknown as Document)).not.toThrow();
  });

  it("runs on its own as an inline script", () => {
    const { document } = parseHTML(page({ mine: "OH" }));
    new Function("document", inlineCall(quotes, "document"))(document);
    expect(document.querySelector("tr.mine")).not.toBeNull();
    expect(document.querySelectorAll("button.sortb")).toHaveLength(7);
  });

  it("stays under 1.2 KB gzipped, with the sort marks escaped rather than typed", () => {
    const code = inlineCall(quotes, "document");
    expect(code).not.toMatch(/[▲▼]/);
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(1229);
  });
});
