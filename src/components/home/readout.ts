// The readout over a chart: point at the line, or focus the chart and press
// the arrow keys, and the line above it says which week that is and its
// price. The chart itself is static SVG drawn at build time (chart.ts); this
// moves a crosshair over it and rewrites two spans. Every value is in the
// line's own data attribute, one per week from the start date, so nothing is
// fetched and a week is its index.
//
// It ships as an inline script through inlineCall, so it must stand alone
// with no imports and no helpers outside its body.

export function readout(doc: Document): void {
  for (const plot of Array.from(doc.querySelectorAll(".plot[data-v]"))) {
    const fig = plot.closest("figure"),
      values = (plot.getAttribute("data-v") || "").split(","),
      n = values.length,
      start = Date.parse(plot.getAttribute("data-start") + "T00:00:00Z"),
      box = plot.querySelector(".pa"),
      cross = plot.querySelector(".cross") as HTMLElement | null,
      day = fig && fig.querySelector(".rd-d"),
      price = fig && fig.querySelector(".rd-v");
    if (n < 2 || !box || !cross || !day || !price || !start) continue;
    let at = n - 1;
    const show = (k: number, mark: boolean) => {
      at = Math.max(0, Math.min(n - 1, k));
      day.textContent = new Date(start + at * 6048e5).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      price.textContent = values[at] ? "$" + values[at] : "no price";
      cross.hidden = !mark;
      cross.style.left = (at / (n - 1)) * 100 + "%";
    };
    const rest = () => show(n - 1, false);
    plot.addEventListener("pointermove", (e) => {
      const r = box.getBoundingClientRect();
      if (r.width) show(Math.round(((e as PointerEvent).clientX - r.left) / r.width * (n - 1)), true);
    });
    plot.addEventListener("pointerleave", rest);
    plot.addEventListener("focus", () => show(at, true));
    plot.addEventListener("blur", rest);
    plot.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key,
        k = key === "ArrowRight" ? at + 1 : key === "ArrowLeft" ? at - 1 : key === "Home" ? 0 : key === "End" ? n - 1 : -1;
      if (k < 0) return;
      show(k, true);
      e.preventDefault();
    });
  }
}
