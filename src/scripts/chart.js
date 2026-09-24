// The readout over a line chart: the week under the pointer, or under the
// arrow keys, its price and its move from the week before. The chart is
// static SVG drawn at build time. The dates and prices come from the numbers
// table under the chart, so the page carries every value once; a plot box
// says which window it shows (data-from, data-to), and a date sits at days
// into the window over the window's days, the same scale the line was drawn
// with (readoutX in src/lib/chart.ts).
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function day(y, m, d) {
    return Date.UTC(y, m, d) / 864e5;
  }
  function iso(s) {
    return day(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  }
  // "Sep 21, 2026", as the table prints it
  function fromText(t) {
    var m = /^(\w{3}) (\d+), (\d{4})$/.exec(t.trim());
    return m ? day(+m[3], MONTHS.indexOf(m[1]), +m[2]) : null;
  }
  function text(n) {
    var d = new Date(n * 864e5);
    return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
  }
  // whole thousandths of a dollar, which are tenths of a cent, so float noise never flips a digit
  function mills(v) {
    return Math.round(v * 1000);
  }
  function price(v) {
    if (v === null) return "No price";
    var m = mills(v);
    return "$" + Math.floor(m / 1000) + "." + String(m % 1000).padStart(3, "0");
  }
  // "+43.0¢", signed like formatSignedCents, from a move in tenths of a cent
  function cents(t) {
    var a = Math.abs(t);
    return (t > 0 ? "+" : t < 0 ? "−" : "") + Math.floor(a / 10) + "." + (a % 10) + "¢";
  }

  var table = document.querySelector(".numbers table");
  if (!table) return;
  var labels = [].slice.call(table.tHead.rows[0].cells).filter(function (th) {
    return th.classList.contains("v");
  }).map(function (th) {
    return th.textContent.trim().replace(/ \$$/, "");
  });
  // oldest first, with every series' value on each row
  var rows = [].slice.call(table.tBodies[0].rows).map(function (r) {
    return {
      d: fromText(r.cells[0].textContent),
      v: [].slice.call(r.querySelectorAll("td.v")).map(function (td) {
        var t = td.textContent.trim();
        return /^\d/.test(t) ? parseFloat(t) : null;
      }),
    };
  }).filter(function (r) { return r.d !== null; }).reverse();

  document.querySelectorAll(".plot[data-from]").forEach(function (plot) {
    var f = iso(plot.getAttribute("data-from")), t = iso(plot.getAttribute("data-to")), span = t - f || 1;
    var pts = rows.filter(function (r) { return r.d >= f && r.d <= t; });
    var n = pts.length;
    if (!n) return;
    var fig = plot.parentNode;
    var rd = fig.querySelector(".rd-d"), rv = fig.querySelector(".rd-v"), rc = fig.querySelector(".rd-c"), rb = fig.querySelector(".rd-b");
    var pa = plot.querySelector(".pa"), cross = plot.querySelector(".cross");
    var idx = n - 1;

    function show(i, on) {
      idx = Math.max(0, Math.min(n - 1, i));
      var p = pts[idx], v = p.v[0];
      rd.textContent = text(p.d);
      rv.textContent = price(v);
      if (rc) {
        // the newest earlier row with a price, which may be before the window
        var k = rows.indexOf(p), b = null;
        while (--k >= 0 && b === null) b = rows[k].v[0];
        var m = v === null || b === null ? null : mills(v) - mills(b);
        rc.textContent = m === null ? "" : cents(m);
        rc.className = "rd-c" + (m > 0 ? " up" : m < 0 ? " down" : "");
      }
      if (rb && p.v.length > 1) rb.textContent = labels[1] + " " + price(p.v[1]);
      cross.style.left = ((p.d - f) / span) * 100 + "%";
      cross.hidden = !on;
    }
    function reset() { show(n - 1, false); }
    // the point nearest a fraction of the plot's width
    function nearest(frac) {
      var target = f + frac * span, lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (pts[mid].d < target) lo = mid; else hi = mid;
      }
      return target - pts[lo].d <= pts[hi].d - target ? lo : hi;
    }
    plot.addEventListener("pointermove", function (e) {
      var r = pa.getBoundingClientRect();
      if (r.width) show(nearest((e.clientX - r.left) / r.width), true);
    });
    plot.addEventListener("pointerleave", function () {
      if (document.activeElement !== plot) reset();
    });
    plot.addEventListener("blur", reset);
    plot.addEventListener("keydown", function (e) {
      var step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -4, PageDown: 4 }[e.key];
      if (step) show(idx + step, true);
      else if (e.key === "Home") show(0, true);
      else if (e.key === "End") show(n - 1, true);
      else if (e.key === "Escape") reset();
      else return;
      e.preventDefault();
    });
  });
})();
