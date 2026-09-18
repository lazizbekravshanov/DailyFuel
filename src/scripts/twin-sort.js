// Sort buttons for a chart's table twin. Keeps aria-sort in step and says the
// new order. Without JS the table stays newest first.
(function () {
  document.querySelectorAll("table[data-twin-sort]:not([data-bound])").forEach(function (table) {
    table.setAttribute("data-bound", "");
    var tbody = table.tBodies[0];
    var status = table.closest(".numbers").querySelector(".twin-status");
    var heads = table.querySelectorAll("th[data-sort-type]");
    var rows = Array.prototype.slice.call(tbody.rows);
    // rows come newest first, so where a row starts is its date order
    var order = new Map(rows.map(function (r, i) { return [r, i]; }));
    function newest(a, b) {
      return order.get(a) - order.get(b);
    }
    // a number from data-sort when the cell has one, else from its text ("$6.250")
    function key(row, col) {
      var c = row.cells[col], k = c.getAttribute("data-sort");
      var v = parseFloat(k === null ? c.textContent.replace(/[^0-9.]/g, "") : k);
      return isNaN(v) ? null : v;
    }
    heads.forEach(function (th) {
      var label = th.textContent.trim();
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sort-btn";
      btn.innerHTML = '<span></span><svg class="sort-icon" viewBox="0 0 10 14" aria-hidden="true" focusable="false"><path class="sort-up" d="M5 1 9 6H1Z"/><path class="sort-down" d="M1 8H9L5 13Z"/></svg>';
      btn.firstChild.textContent = label;
      th.textContent = "";
      th.appendChild(btn);
      btn.addEventListener("click", function () {
        var num = th.getAttribute("data-sort-type") === "number";
        var dir = th.getAttribute("aria-sort") === "descending" ? "ascending" : "descending";
        heads.forEach(function (h) { h.removeAttribute("aria-sort"); });
        th.setAttribute("aria-sort", dir);
        var col = th.cellIndex, sign = dir === "ascending" ? 1 : -1;
        rows.sort(function (a, b) {
          if (!num) return -sign * newest(a, b);
          var va = key(a, col), vb = key(b, col);
          // rows with no value go last either way
          if (va === null || vb === null) return va === vb ? newest(a, b) : va === null ? 1 : -1;
          return (va - vb) * sign || newest(a, b);
        }).forEach(function (r) { tbody.appendChild(r); });
        if (status) {
          status.textContent = "Sorted by " + label.toLowerCase() + ", " +
            (num ? (sign > 0 ? "lowest" : "highest") : (sign > 0 ? "oldest" : "newest")) + " first";
        }
      });
    });
  });
})();
