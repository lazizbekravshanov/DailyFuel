// "Your state": the home page remembers the last state page you opened and
// shows its price as a small sign under the U.S. sign, so a return visit takes
// zero taps. The state code is the only thing stored, in this browser's
// localStorage under "dailyfuel:state". Nothing is sent anywhere.
//
// Both functions ship as inline scripts: the pages print `(${fn})(...)`, so
// each one must stand alone, with no imports and no helpers outside its body.
// They run where they sit in the HTML, before the page first paints, so the
// row never swaps in front of the reader. Anything unexpected (storage that
// throws, a value that isn't a state, a missing JSON island, JS off) leaves
// the row as the server rendered it: the "Find your state" list.

/** On a state page: remember this state. Storage that is off or full is fine. */
export function saveState(code: string): void {
  try {
    window.localStorage.setItem("dailyfuel:state", code);
  } catch (e) {
    // private mode, blocked storage, quota: the home page just shows the list
  }
}

interface Entry {
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  direction: "up" | "down" | "flat" | null;
  plate: string | null;
}

/**
 * On the home page, right after the row: fill the mini sign from the saved
 * code and wire Change state and Forget. `hash` is location.hash, so a link to
 * /#find-your-state (every state page's "All states") opens the list.
 */
export function yourState(doc: Document, getStore: () => Storage, hash: string): void {
  const KEY = "dailyfuel:state";
  const slot = doc.querySelector("[data-ys]");
  const find = doc.getElementById("find-your-state");
  if (!slot || !find) return;
  const q = (sel: string) => slot.querySelector(sel) as HTMLElement | null;
  const show = (el: Element | null, on: boolean) => {
    if (el) el.toggleAttribute("hidden", !on);
  };
  const setOpen = (on: boolean) => find.toggleAttribute("open", on);
  const wantList = hash === "#find-your-state";
  if (wantList) setOpen(true);

  const saved = q("[data-ys-saved]");
  const link = q("[data-ys-link]");
  const change = q("[data-ys-change]");
  const forget = q("[data-ys-forget]");
  if (!saved || !link || !change || !forget) return;
  let store: Storage | null = null;
  try {
    store = getStore();
    const code = store.getItem(KEY);
    if (!code) return;
    const data = JSON.parse((doc.getElementById("your-state-data") as HTMLElement).textContent as string);
    let s: Entry | null = null;
    for (const e of data.states as Entry[]) if (e.code === code) s = e;
    if (!s) return;

    // Money the way the rest of the site shows it, on whole numbers so float
    // noise never flips a digit: $6.25 and a raised 0, and 30.4¢.
    const units = (x: number) => Math.round(x * 10000);
    const half = (u: number) => Math.floor((u + 5) / 10);
    const tenths = (t: number) => Math.floor(t / 10) + "." + (t % 10);
    const text = (sel: string, value: string) => {
      const el = q(sel);
      if (el) el.textContent = value;
    };

    let label = "Your state, " + s.name + ", ";
    const priced = typeof s.price === "number";
    if (priced) {
      const m = half(units(s.price as number));
      const main = "$" + Math.floor(m / 1000) + "." + String(Math.floor((m % 1000) / 10)).padStart(2, "0");
      text("[data-ys-main]", main);
      text("[data-ys-tenth]", String(m % 10));
      label += main + (m % 10) + " per gallon";
    } else {
      text("[data-ys-none]", data.none);
      label += String(data.none).toLowerCase();
    }
    const moved = priced && typeof s.change === "number";
    if (moved) {
      const u = units(s.change as number);
      const t = half(Math.abs(u));
      const dir = s.direction || (t === 0 ? "flat" : u > 0 ? "up" : "down");
      text("[data-ys-cents]", tenths(t) + "¢");
      for (const g of Array.from(slot.querySelectorAll("[data-ys-glyph]"))) show(g, g.getAttribute("data-ys-glyph") === dir);
      const spoken = t === 0 ? "no change" : (u > 0 ? "up " : "down ") + tenths(t) + " cents";
      label += ", " + (dir === "flat" && t !== 0 ? "about the same, " : "") + spoken + (data.when ? " " + data.when : "");
    }
    if (s.plate) label += ", " + s.plate;
    text("[data-ys-plate]", s.plate || "");
    text("[data-ys-code]", s.code);
    text("[data-ys-name]", s.name);
    show(q("[data-ys-price]"), priced);
    show(q("[data-ys-none]"), !priced);
    show(q("[data-ys-plaque]"), moved);
    show(q("[data-ys-plate]"), Boolean(s.plate));
    link.setAttribute("href", "/state/" + s.code.toLowerCase() + "/");
    link.setAttribute("aria-label", label);
  } catch (e) {
    return;
  }

  let active = true;
  const expanded = () => change.setAttribute("aria-expanded", String(find.hasAttribute("open")));
  show(saved, true);
  // The list stays in the page for Change state. It shows only when asked for.
  show(find, wantList);
  expanded();

  change.addEventListener("click", () => {
    show(find, true);
    setOpen(true);
    expanded();
    const list = find.querySelector("[data-ys-list]") as HTMLElement | null;
    // keep the mini sign in view; the list opens right under it
    if (list) list.focus({ preventScroll: true });
  });
  // Closing the list from its own summary puts the row back the way it was.
  find.addEventListener("toggle", () => {
    if (!active) return;
    expanded();
    if (!find.hasAttribute("open")) {
      show(find, false);
      change.focus();
    }
  });
  forget.addEventListener("click", () => {
    active = false;
    try {
      if (store) store.removeItem(KEY);
    } catch (e) {
      // still forget it on this page
    }
    show(saved, false);
    setOpen(false);
    show(find, true);
    const summary = find.querySelector("summary");
    if (summary) summary.focus();
  });
}
