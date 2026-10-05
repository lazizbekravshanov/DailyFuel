// "Your state": the state a driver saved, shown first on the home page, so a
// return visit takes zero taps. A state is saved only on purpose: the home
// page's picker, the Save as my state button on a state page, or a pick from
// the 404 page's list. Looking at other states never changes it. The state
// code is the only thing stored, in this browser's localStorage under
// "dailyfuel:state". Nothing is sent anywhere.
//
// All three functions ship as inline scripts: the pages print `(${fn})(...)`,
// so each one must stand alone, with no imports and no helpers outside its
// body. Anything unexpected (storage that throws, a value that isn't a state,
// JS off) leaves the page as the server rendered it.

/**
 * Right after the Find your state list on the 404 page: a tap on a state saves
 * it, then the link goes on to its page as usual.
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

/**
 * On every state page, right after the head row: the slot at the right of the
 * name shows "Save as my state", or "Your saved state" when this is the saved
 * one. Both sit in one grid cell from the first paint, so showing either moves
 * nothing. A tap saves this state and says so. Storage that throws shows
 * neither. A page brought back by the back button reloads, since another page
 * may have saved a different state in between.
 */
export function myState(doc: Document, code: string, getStore: () => Storage): void {
  const slot = doc.querySelector("[data-mine]");
  if (!slot) return;
  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) location.reload();
  });
  let st: Storage;
  const paint = () => slot.setAttribute("data-mine", st.getItem("dailyfuel:state") === code ? "y" : "n");
  try {
    st = getStore();
    paint();
  } catch (err) {
    return;
  }
  (slot.querySelector("button") as HTMLElement).addEventListener("click", () => {
    try {
      st.setItem("dailyfuel:state", code);
      paint();
      (slot.querySelector("[tabindex]") as HTMLElement).focus();
    } catch (err) {
      // blocked storage: the button stays
    }
  });
}

/**
 * On the home page, right after the your state section: fill the answer from
 * the page's JSON block (yourStateJson in src/lib/yourstate.ts) and mark the
 * section with data-ys-state, which the CSS keys every show and hide on and
 * the quote table's script reads to bold the row. It also wires the picker,
 * which saves the state it opens (with JS off the form goes through /go, a
 * redirect, and saves nothing), and Forget my state, at the end of the page,
 * which drops it and starts the page over. A page brought back by the back
 * button reloads, since a state page may have saved a different state.
 */
export function yourState(doc: Document, getStore: () => Storage): void {
  const slot = doc.querySelector("[data-ys]"),
    data = doc.getElementById("ys-data");
  if (!slot || !data) return;
  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) location.reload();
  });
  doc.addEventListener("submit", (e) => {
    const f = e.target as HTMLFormElement,
      v = f.id == "find-your-state" && (f.elements.namedItem("s") as HTMLSelectElement).value;
    if (!v) return;
    e.preventDefault();
    try {
      getStore().setItem("dailyfuel:state", v.toUpperCase());
    } catch (err) {
      // blocked storage: the page still opens
    }
    location.href = "/state/" + v + "/";
  });
  doc.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-ys-forget]")) return;
    try {
      getStore().removeItem("dailyfuel:state");
    } catch (err) {
      // nothing saved to drop
    }
    location.reload();
  });
  let code = "",
    v: string[];
  try {
    code = getStore().getItem("dailyfuel:state") || "";
    const all = JSON.parse(data.textContent || "{}");
    // only a state really in the block: a saved "constructor" or "__proto__"
    // would find Object's own members, which throw nothing and fill nothing
    if (!Object.prototype.hasOwnProperty.call(all.s, code)) return;
    const s = all.s[code];
    v = [s[0]].concat(all.l[s[1]]);
  } catch (err) {
    return;
  }
  const put = (k: string, t: string) => {
    for (const el of Array.from(slot.querySelectorAll("[data-f=" + k + "]"))) el.textContent = t;
  };
  put("n", v[0]);
  put("p", v[1]);
  put("c", v[2]);
  put("f", v[3]);
  put("l", v[5]);
  (slot.querySelector("[data-f=c]") as Element).className = v[4];
  const lower = code.toLowerCase();
  (slot.querySelector("[data-ys-open]") as HTMLAnchorElement).href = "/state/" + lower + "/";
  slot.setAttribute("data-ys-state", code);
  // the picker shows the saved state; it comes later in the page
  doc.addEventListener("DOMContentLoaded", () => {
    const s = doc.getElementById("go-s") as HTMLSelectElement | null;
    if (s) s.value = lower;
  });
}
