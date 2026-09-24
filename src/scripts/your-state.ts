// "Your state": the boxed strip under the U.S. average on the home page shows
// one state's price, so a return visit takes zero taps. Opening a state's page
// saves it, and so does a pick from the Find your state list, so the last
// state you looked at is the one waiting on the home page. The state code is
// the only thing stored, in this browser's localStorage under
// "dailyfuel:state". Nothing is sent anywhere.
//
// All three functions ship as inline scripts: the pages print `(${fn})(...)`,
// so each one must stand alone, with no imports and no helpers outside its
// body. Anything unexpected (storage that throws, a value that isn't a state,
// JS off) leaves the strip as the server rendered it: "Nothing saved yet",
// with the Find your state list under it.

/**
 * Right after the Find your state list on the 404 page: a tap on a state saves
 * it, then the link goes on to its page as usual. The home page's list does
 * the same inside yourState, so it ships one script instead of two.
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
 * On every state page: remember the state being viewed, so the home page
 * shows it next time. Storage that throws is ignored; the page works the same.
 */
export function saveOnView(code: string, getStore: () => Storage): void {
  try {
    getStore().setItem("dailyfuel:state", code);
  } catch (err) {
    // private mode, blocked storage, quota: nothing to do
  }
}

/**
 * On the home page, right after the Find your state list: fill the saved
 * strip from the saved state's link in the list (the build prints its price,
 * change and plate on the link), show it in place of "Nothing saved yet", and
 * mark the slot with data-ys-state so the quote table's script can bold the
 * row. CSS hides the list on a marked slot until CHANGE asks for it. Then
 * wire CHANGE and FORGET, and open the list for a link to /#find-your-state
 * (every state page's "All states"). `hash` is location.hash.
 */
export function yourState(doc: Document, getStore: () => Storage, hash: string): void {
  const slot = doc.querySelector("[data-ys]"),
    find = doc.querySelector("[data-ys-find]");
  if (!slot || !find) return;
  const setOpen = (on: boolean) => find.toggleAttribute("open", on);
  if (hash === "#find-your-state") setOpen(true);
  // a pick from the list saves it, the way rememberPick does on the 404 page
  find.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("[data-ys-pick]");
    if (!a) return;
    try {
      getStore().setItem("dailyfuel:state", a.getAttribute("data-ys-pick") as string);
    } catch (err) {
      // private mode, blocked storage, quota: the link still works
    }
  });

  const q = (sel: string) => slot.querySelector("[data-ys-" + sel + "]") as HTMLElement | null,
    saved = q("saved"),
    none = q("none"),
    open = q("open"),
    change = q("change"),
    forget = q("forget"),
    move = q("move");
  if (!saved || !none || !open || !change || !forget || !move) return;
  const text = (sel: string, value: string) => {
    const el = q(sel);
    if (el) el.textContent = value;
  };
  let code = "";
  try {
    // the saved value only counts when it names a link in the list; anything
    // else (a value that isn't a state, a selector that won't parse) leaves
    // the strip alone
    const a = find.querySelector('[data-ys-pick="' + getStore().getItem("dailyfuel:state") + '"]');
    if (!a) return;
    const attr = (name: string) => a.getAttribute("data-" + name) || "";
    code = attr("ys-pick");
    const name = (a.textContent || "").replace(code, "").trim();
    text("code", code);
    text("name", name);
    text("price", attr("px"));
    text("plate", attr("pl"));
    move.textContent = attr("ch");
    // the ink rides on the link only when the move rose or fell
    move.className = "ch " + (attr("ink") || "muted");
    open.setAttribute("href", a.getAttribute("href") as string);
    open.setAttribute("aria-label", "Open " + name);
  } catch (e) {
    return;
  }
  none.setAttribute("hidden", "");
  saved.removeAttribute("hidden");
  slot.setAttribute("data-ys-state", code);

  // The list stays in the page for CHANGE. It shows only while it is open,
  // and the CSS hides a closed list on a marked slot.
  const sync = () => {
    const on = find.hasAttribute("open");
    slot.toggleAttribute("data-ys-list", on);
    change.setAttribute("aria-expanded", String(on));
  };
  sync();
  // CHANGE opens the list under the strip, and closes it again.
  change.addEventListener("click", () => {
    setOpen(!find.hasAttribute("open"));
    sync();
    const list = find.querySelector("[data-ys-list]") as HTMLElement | null;
    // keep the strip in view; the list opens right under it
    if (list && find.hasAttribute("open")) list.focus({ preventScroll: true });
  });
  // Closing the list from its own summary tucks it away and hands focus back
  // to CHANGE, since the summary goes with it. (Browsers fire toggle a tick
  // after CHANGE sets open too, which does the same again, harmlessly.)
  find.addEventListener("toggle", () => {
    sync();
    if (!find.hasAttribute("open") && slot.hasAttribute("data-ys-state")) change.focus();
  });
  forget.addEventListener("click", () => {
    try {
      getStore().removeItem("dailyfuel:state");
    } catch (e) {
      // still forget it on this page
    }
    saved.setAttribute("hidden", "");
    none.removeAttribute("hidden");
    slot.removeAttribute("data-ys-state");
    for (const row of Array.from(doc.querySelectorAll("tr.mine"))) row.classList.remove("mine");
    setOpen(false);
    sync();
    const summary = find.querySelector("summary") as HTMLElement | null;
    if (summary) summary.focus();
  });
}
