// Sortable table headers. Turns each sortable header into a button, keeps
// aria-sort in step, and announces the new order. Without JS the table stays
// in alphabetical order.
(function () {
  document.querySelectorAll("table[data-sortable]").forEach(function (table) {
    var tbody = table.tBodies[0];
    var status = document.getElementById(table.getAttribute("data-status"));
    var heads = table.querySelectorAll("thead th[data-sort-type]");
    heads.forEach(function (th) {
      var label = th.textContent.trim();
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sort-btn";
      btn.innerHTML = '<span class="sort-label"></span><svg class="sort-icon" viewBox="0 0 10 14" aria-hidden="true" focusable="false"><path class="sort-up" d="M5 1 9 6H1Z"/><path class="sort-down" d="M1 8H9L5 13Z"/></svg>';
      btn.querySelector(".sort-label").textContent = label;
      th.textContent = "";
      th.appendChild(btn);
      btn.addEventListener("click", function () {
        var type = th.getAttribute("data-sort-type");
        var first = th.getAttribute("data-sort-first") || "ascending";
        var current = th.getAttribute("aria-sort");
        var dir = current ? (current === "ascending" ? "descending" : "ascending") : first;
        heads.forEach(function (h) { h.removeAttribute("aria-sort"); });
        th.setAttribute("aria-sort", dir);
        var col = th.cellIndex;
        var sign = dir === "ascending" ? 1 : -1;
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (a, b) {
          var va = a.cells[col].getAttribute("data-sort");
          var vb = b.cells[col].getAttribute("data-sort");
          var ea = va === null || va === "", eb = vb === null || vb === "";
          if (ea || eb) {
            if (ea && eb) return byName(a, b);
            return ea ? 1 : -1;
          }
          var c = type === "number" ? Number(va) - Number(vb) : va.localeCompare(vb);
          return c !== 0 ? c * sign : byName(a, b);
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        if (status) {
          status.textContent = "Sorted by " + label.toLowerCase() + (type === "number"
            ? (dir === "ascending" ? ", lowest first" : ", highest first")
            : (dir === "ascending" ? ", A to Z" : ", Z to A"));
        }
      });
    });
    function byName(a, b) {
      return a.cells[0].textContent.localeCompare(b.cells[0].textContent);
    }
  });
})();
