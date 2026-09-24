// Dark mode. The page follows the system setting on its own through CSS
// (prefers-color-scheme in src/styles/tokens.css). The DARK button in the
// header lets a reader force it either way, and the choice is remembered on
// this phone only, in localStorage under "dailyfuel:theme". Nothing is sent
// anywhere.
//
// Two functions, both shipped as inline scripts through inlineCall, so each
// one must stand alone with no imports and no helpers outside its body:
//   applyStoredTheme runs in <head>, before anything paints, so a saved
//   choice never flashes the other theme first.
//   themeToggle wires the button, which ThemeToggle.astro renders hidden so
//   with JS off there is no button that does nothing.
// Storage that throws (private mode, blocked) leaves the page on the system
// setting, and the button still switches the page it is on.

/** In <head>: put a saved choice on <html> as data-theme before the first paint. */
export function applyStoredTheme(doc: Document, getStore: () => Storage): void {
  try {
    const t = getStore().getItem("dailyfuel:theme");
    if (t === "dark" || t === "light") doc.documentElement.setAttribute("data-theme", t);
  } catch (err) {
    // no storage: the page follows the system setting
  }
}

/**
 * The button says what a tap does: "Dark" on a light page, "Light" on a dark
 * one. It wears the `on` class while the page is dark, which the stylesheet
 * draws as the inverse fill (the mockup's pressed look), and keeps the
 * browser's theme-color in step once a theme is forced.
 */
export function themeToggle(doc: Document, win: Window, getStore: () => Storage): void {
  const button = doc.querySelector("[data-theme-toggle]");
  if (!button) return;
  const root = doc.documentElement;
  const system = typeof win.matchMedia == "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
  const isDark = () => {
    const t = root.getAttribute("data-theme");
    return t ? t === "dark" : Boolean(system && system.matches);
  };
  const paint = () => {
    const dark = isDark();
    button.textContent = dark ? "Light" : "Dark";
    button.classList.toggle("on", dark);
    if (!root.hasAttribute("data-theme")) return;
    for (const m of Array.from(doc.querySelectorAll('meta[name="theme-color"]'))) {
      m.removeAttribute("media");
      m.setAttribute("content", dark ? "#000000" : "#ffffff");
    }
  };
  button.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      getStore().setItem("dailyfuel:theme", next);
    } catch (err) {
      // private mode, blocked storage, quota: this page still switches
    }
    paint();
  });
  if (system && typeof system.addEventListener == "function") system.addEventListener("change", paint);
  paint();
  button.removeAttribute("hidden");
}
