// "Your state": pick a state once from the Find your state list and the home
// page shows its price as a small sign under the U.S. sign, so a return visit
// takes zero taps. Only a pick from the list saves it. Opening another state's
// page, like a neighbor's, leaves your state alone. The state code is the only
// thing stored, in this browser's localStorage under "dailyfuel:state".
// Nothing is sent anywhere.
//
// All three functions ship as inline scripts: the pages print `(${fn})(...)`,
// so each one must stand alone, with no imports and no helpers outside its
// body. Anything unexpected (storage that throws, a value that isn't a state,
// a missing JSON island, JS off) leaves the row as the server rendered it: the
// "Find your state" list.

/**
 * Right after the Find your state list, on the home page and the 404 page: a
 * tap on a state saves it, then the link goes on to its page as usual.
 */
export function rememberPick(doc: Document, getStore: () => Storage): void {
  const list = doc.querySelector("[data-ys-list]");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    const a = target && target.closest ? target.closest("[data-ys-pick]") : null;
    if (!a) return;
    try {
      getStore().setItem("dailyfuel:state", a.getAttribute("data-ys-pick") as string);
    } catch (err) {
      // private mode, blocked storage, quota: the link still works
    }
  });
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
 * On the home page, between the mini sign and the list: fill the mini sign
 * from the saved code and mark the row with data-ys-state. It runs before the
 * parser reaches the list, and CSS hides the list on a marked row, so a saved
 * state never paints the list first and then swaps it out.
 */
export function yourState(doc: Document, getStore: () => Storage): void {
  const slot = doc.querySelector("[data-ys]");
  if (!slot) return;
  const q = (sel: string) => slot.querySelector(sel) as HTMLElement | null;
  const show = (el: Element | null, on: boolean) => {
    if (el) el.toggleAttribute("hidden", !on);
  };
  const saved = q("[data-ys-saved]");
  const link = q("[data-ys-link]");
  const spoken = q("[data-ys-spoken]");
  if (!saved || !link || !spoken || !q("[data-ys-change]") || !q("[data-ys-forget]")) return;
  try {
    const code = getStore().getItem("dailyfuel:state");
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

    // What a screen reader says for the link. It starts with the name the
    // sign shows, so a voice command like "click Ohio" finds it.
    let say = s.name + ", ";
    const priced = typeof s.price === "number";
    if (priced) {
      const m = half(units(s.price as number));
      const main = "$" + Math.floor(m / 1000) + "." + String(Math.floor((m % 1000) / 10)).padStart(2, "0");
      text("[data-ys-main]", main);
      text("[data-ys-tenth]", String(m % 10));
      say += main + (m % 10) + " per gallon";
    } else {
      text("[data-ys-none]", data.none);
      say += String(data.none).toLowerCase();
    }
    const moved = priced && typeof s.change === "number";
    if (moved) {
      const u = units(s.change as number);
      const t = half(Math.abs(u));
      const dir = s.direction || (t === 0 ? "flat" : u > 0 ? "up" : "down");
      text("[data-ys-cents]", tenths(t) + "¢");
      for (const g of Array.from(slot.querySelectorAll("[data-ys-glyph]"))) show(g, g.getAttribute("data-ys-glyph") === dir);
      const words = t === 0 ? "no change" : (u > 0 ? "up " : "down ") + tenths(t) + " cents";
      say += ", " + (dir === "flat" && t !== 0 ? "about the same, " : "") + words + (data.when ? " " + data.when : "");
    }
    if (s.plate) say += ", " + s.plate;
    text("[data-ys-spoken]", say + ". Your state.");
    text("[data-ys-plate]", s.plate || "");
    text("[data-ys-code]", s.code);
    text("[data-ys-name]", s.name);
    show(q("[data-ys-price]"), priced);
    show(q("[data-ys-none]"), !priced);
    show(q("[data-ys-plaque]"), moved);
    show(q("[data-ys-plate]"), Boolean(s.plate));
    link.setAttribute("href", "/state/" + s.code.toLowerCase() + "/");
  } catch (e) {
    return;
  }
  show(saved, true);
  slot.setAttribute("data-ys-state", "");
}

/**
 * On the home page, right after the list: open it for a link to
 * /#find-your-state (every state page's "All states"), and wire Change state
 * and Forget when a saved state fills the row. `hash` is location.hash.
 */
export function yourStateList(doc: Document, getStore: () => Storage, hash: string): void {
  const slot = doc.querySelector("[data-ys]");
  const find = doc.querySelector("[data-ys-find]");
  if (!slot || !find) return;
  const setOpen = (on: boolean) => find.toggleAttribute("open", on);
  const wantList = hash === "#find-your-state";
  if (wantList) setOpen(true);
  if (!slot.hasAttribute("data-ys-state")) return;

  const saved = slot.querySelector("[data-ys-saved]");
  const change = slot.querySelector("[data-ys-change]") as HTMLElement | null;
  const forget = slot.querySelector("[data-ys-forget]");
  if (!saved || !change || !forget) return;
  // The list stays in the page for Change state. It shows only when asked for.
  const showList = (on: boolean) => slot.toggleAttribute("data-ys-list", on);
  const isOpen = () => slot.hasAttribute("data-ys-list") && find.hasAttribute("open");
  const expanded = () => change.setAttribute("aria-expanded", String(isOpen()));
  let active = true;
  showList(wantList);
  expanded();

  // Change state opens the list under the mini sign, and closes it again.
  change.addEventListener("click", () => {
    const on = !isOpen();
    showList(on);
    setOpen(on);
    expanded();
    const list = find.querySelector("[data-ys-list]") as HTMLElement | null;
    // keep the mini sign in view; the list opens right under it
    if (on && list) list.focus({ preventScroll: true });
  });
  // Closing the list from its own summary puts the row back the way it was.
  find.addEventListener("toggle", () => {
    if (!active) return;
    if (!find.hasAttribute("open") && slot.hasAttribute("data-ys-list")) {
      showList(false);
      change.focus();
    }
    expanded();
  });
  forget.addEventListener("click", () => {
    active = false;
    try {
      getStore().removeItem("dailyfuel:state");
    } catch (e) {
      // still forget it on this page
    }
    saved.setAttribute("hidden", "");
    slot.removeAttribute("data-ys-state");
    showList(false);
    setOpen(false);
    const summary = find.querySelector("summary");
    if (summary) summary.focus();
  });
}
