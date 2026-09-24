// The MY STATE marker in a state page's head row. Every state page saves the
// state it shows (saveOnView in src/scripts/your-state.ts), and this shows
// the marker once that state is the saved one. The marker is in the page from
// the start, invisible but holding its space, so showing it moves nothing.
// Storage that throws, or that holds another state, leaves it invisible.
//
// It ships as an inline script: the page prints `(${markMyState})(...)`, so
// the function must stand alone, with no imports and no helpers outside its
// body.

export function markMyState(doc: Document, code: string, getStore: () => Storage): void {
  const mark = doc.querySelector("[data-my-state]");
  if (!mark) return;
  try {
    if (getStore().getItem("dailyfuel:state") === code) mark.setAttribute("data-on", "");
  } catch (err) {
    // private mode, blocked storage: no marker
  }
}
