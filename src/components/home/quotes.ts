// The ALL STATES quote table: sort by a column head, find a state in the box,
// press "/" to get to the box, Enter to open the one match, and tap anywhere
// on a row to open its state. Your saved state's row is marked from the strip
// above (data-ys-state on the your state slot, set by src/scripts/your-state.ts),
// so this never reads storage itself. With JS off the table stays in name
// order and every code is still a link.
//
// It ships as an inline script through inlineCall, so it must stand alone
// with no imports and no helpers outside its body.

export function quotes(doc: Document): void {
  const table = doc.getElementById("quotes") as HTMLTableElement | null,
    body = table && table.querySelector("tbody");
  if (!table || !body) return;
  const rows = () => Array.from(body.querySelectorAll("tr")),
    heads = Array.from(table.querySelectorAll("thead th[data-k]")),
    attr = (el: Element, name: string) => el.getAttribute("data-" + name) || "",
    find = doc.getElementById("find") as HTMLInputElement | null,
    count = doc.getElementById("count"),
    all = rows().length;

  // the saved state's row, marked so it reads bold with a marker before its code
  const slot = doc.querySelector("[data-ys]"),
    mine = slot && slot.getAttribute("data-ys-state"),
    row = mine && body.querySelector('tr[data-s="' + mine + '"]');
  if (row) row.classList.add("mine");

  // Each head becomes a button. Sorting keeps aria-sort in step and says the
  // order out loud on the count line. Rows with no value for the column go
  // last either way.
  const sort = (th: Element) => {
    const k = attr(th, "k"),
      num = attr(th, "num") === "1",
      cur = th.getAttribute("aria-sort"),
      // numbers open highest first, words A to Z; a second press flips it
      dir = cur === "ascending" ? -1 : cur === "descending" ? 1 : num ? -1 : 1;
    for (const h of heads) {
      h.removeAttribute("aria-sort");
      (h.querySelector(".ar") as Element).textContent = "";
    }
    th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
    (th.querySelector(".ar") as Element).textContent = dir === 1 ? "\u25b2" : "\u25bc";
    const sorted = rows().sort((a, b) => {
      const x = attr(a, k),
        y = attr(b, k);
      if (x === "" || y === "") return (x === "" ? 1 : 0) - (y === "" ? 1 : 0);
      return (num ? Number(x) - Number(y) : x.localeCompare(y)) * dir;
    });
    for (const r of sorted) body.appendChild(r);
    if (count) count.textContent = all + " states, sorted by " + th.getAttribute("aria-label") + (num ? (dir === 1 ? ", lowest first" : ", highest first") : dir === 1 ? ", A to Z" : ", Z to A");
  };
  // the mark's slot (.ar) is in the head from the build, so it moves into the button
  for (const th of heads) {
    const b = doc.createElement("button"),
      ar = th.querySelector(".ar") as Element;
    b.type = "button";
    b.className = "sortb";
    b.textContent = th.textContent;
    ar.textContent = th.getAttribute("aria-sort") ? "\u25b2" : "";
    b.appendChild(ar);
    th.textContent = "";
    th.appendChild(b);
    b.addEventListener("click", () => sort(th));
  }

  // a tap anywhere on a row opens its state, the way its code link does
  body.addEventListener("click", (e) => {
    const t = e.target as Element,
      a = t.closest("a") ? null : (t.closest("tr") || t).querySelector("a");
    if (a) a.click();
  });

  if (!find) return;
  const filter = () => {
    const q = find.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows()) {
      const ok = !q || attr(r, "s").toLowerCase().indexOf(q) === 0 || attr(r, "n").toLowerCase().indexOf(q) > -1;
      r.hidden = !ok;
      if (ok) shown += 1;
    }
    if (count) count.textContent = (q ? shown + " of " : "") + all + " states";
  };
  find.addEventListener("input", filter);
  find.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      find.value = "";
      filter();
    }
    if (e.key !== "Enter") return;
    const q = find.value.trim().toLowerCase(),
      shown = rows().filter((r) => !r.hidden),
      hit = shown.filter((r) => attr(r, "s").toLowerCase() === q || attr(r, "n").toLowerCase() === q)[0] || (shown.length === 1 ? shown[0] : null),
      a = hit && hit.querySelector("a");
    if (a) {
      e.preventDefault();
      a.click();
    }
  });
  // "/" from anywhere on the page goes to the find box, unless you're typing
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable) return;
    e.preventDefault();
    find.focus();
    find.select();
  });
}
