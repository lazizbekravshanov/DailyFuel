import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { inlineCall } from "../../lib/inline.ts";
import { readout } from "./readout.ts";

/** The same shape UsChart.astro renders: the readout, then the plot with one value per week. */
function page(values = "5.718,5.810,,5.675,6.285", start = "2022-06-13"): string {
  return `<!doctype html><html><body><figure class="chart">
    <p class="rdout"><span class="rd-d">Jul 11, 2022</span> <b class="rd-v">$6.285</b></p>
    <div class="plot" tabindex="0" role="img" data-start="${start}" data-v="${values}">
      <div class="pa"><svg></svg><span class="cross" hidden></span></div>
    </div></figure></body></html>`;
}

function run(html = page()) {
  const { document } = parseHTML(html);
  const win = document.defaultView as unknown as typeof globalThis;
  const box = document.querySelector(".pa") as unknown as HTMLElement | null;
  // linkedom lays nothing out; the browser gives the box its width
  if (box) box.getBoundingClientRect = () => ({ left: 100, width: 400 }) as DOMRect;
  readout(document as unknown as Document);
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  const plot = $(".plot");
  const fire = (type: string, extra: Record<string, unknown> = {}) => {
    const e = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, extra);
    plot.dispatchEvent(e);
    return e;
  };
  const state = () => ({ day: $(".rd-d").textContent, price: $(".rd-v").textContent, cross: !$(".cross").hasAttribute("hidden"), left: $(".cross").style.left });
  return { document, $, plot, fire, state };
}

describe("the readout over the chart", () => {
  it("rests on the newest week with no crosshair", () => {
    expect(run().state()).toEqual({ day: "Jul 11, 2022", price: "$6.285", cross: false, left: "" });
  });

  it("walks the weeks with the arrow keys, Home and End, and stops at the ends", () => {
    const { fire, state } = run();
    fire("focus");
    expect(state()).toEqual({ day: "Jul 11, 2022", price: "$6.285", cross: true, left: "100%" });
    let e = fire("keydown", { key: "ArrowLeft" });
    expect(e.defaultPrevented).toBe(true);
    expect(state()).toEqual({ day: "Jul 4, 2022", price: "$5.675", cross: true, left: "75%" });
    fire("keydown", { key: "ArrowLeft" });
    // a week with no price says so, and keeps its place on the line
    expect(state()).toEqual({ day: "Jun 27, 2022", price: "no price", cross: true, left: "50%" });
    fire("keydown", { key: "Home" });
    expect(state()).toEqual({ day: "Jun 13, 2022", price: "$5.718", cross: true, left: "0%" });
    fire("keydown", { key: "ArrowLeft" });
    expect(state().day).toBe("Jun 13, 2022");
    fire("keydown", { key: "End" });
    expect(state().day).toBe("Jul 11, 2022");
    fire("keydown", { key: "ArrowRight" });
    expect(state().day).toBe("Jul 11, 2022");
    e = fire("keydown", { key: "Tab" });
    expect(e.defaultPrevented).toBe(false);
  });

  it("follows the pointer to the nearest week, and lets go on leave and blur", () => {
    const { fire, state } = run();
    fire("pointermove", { clientX: 100 + 400 * 0.3 });
    expect(state()).toEqual({ day: "Jun 20, 2022", price: "$5.810", cross: true, left: "25%" });
    fire("pointermove", { clientX: 100 + 400 * 0.9 });
    expect(state().day).toBe("Jul 11, 2022");
    fire("pointerleave");
    expect(state()).toEqual({ day: "Jul 11, 2022", price: "$6.285", cross: false, left: "100%" });
    fire("keydown", { key: "Home" });
    fire("blur");
    expect(state().cross).toBe(false);
    expect(state().day).toBe("Jul 11, 2022");
  });

  it("leaves a chart alone when it has one week, no start date or no readout", () => {
    for (const html of [page("6.285"), page("6.1,6.2", "soon"), page().replace('class="rd-d"', 'class="x"')]) {
      const { fire, $ } = run(html);
      fire("keydown", { key: "ArrowLeft" });
      expect($(".rd-v").textContent).toBe("$6.285");
      expect($(".cross").hasAttribute("hidden")).toBe(true);
    }
    const { document } = parseHTML("<!doctype html><html><body><p>nothing</p></body></html>");
    expect(() => readout(document as unknown as Document)).not.toThrow();
  });

  it("runs on its own as an inline script, under 700 bytes gzipped", () => {
    const code = inlineCall(readout, "document");
    const { document } = parseHTML(page());
    (document.querySelector(".pa") as unknown as HTMLElement).getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    new Function("document", code)(document);
    const e = new (document.defaultView as unknown as typeof globalThis).Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(e, { key: "Home" });
    document.querySelector(".plot")!.dispatchEvent(e);
    expect(document.querySelector(".rd-v")!.textContent).toBe("$5.718");
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(700);
  });
});
