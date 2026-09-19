// Crosshair and tooltip for line charts. Pointer or keyboard: focus a chart and
// use the arrow keys. Every value is also in the table under the chart. The
// charts are static SVG drawn at build time; this is the only chart code here.
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(iso) {
    var a = iso.split("-");
    return MONTHS[+a[1] - 1] + " " + +a[2];
  }
  function dateLabel(iso, weekly) {
    var s = shortDate(iso) + ", " + iso.slice(0, 4);
    return weekly ? "Week of " + s : s;
  }
  function day(iso) {
    return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  }
  function priceNodes(v) {
    var units = Math.round(v * 10000);
    var mills = Math.floor((units + 5) / 10);
    var main = "$" + Math.floor(mills / 1000) + "." + String(Math.floor((mills % 1000) / 10)).padStart(2, "0");
    var frag = document.createDocumentFragment();
    var sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = main + (mills % 10);
    var vis = document.createElement("span");
    vis.setAttribute("aria-hidden", "true");
    vis.textContent = main;
    var t = document.createElement("span");
    t.className = "tenth";
    t.textContent = String(mills % 10);
    vis.appendChild(t);
    frag.appendChild(sr);
    frag.appendChild(vis);
    return frag;
  }
  // The direction arrow, then "30.4¢ vs week before": format.ts changeTenths
  // rounding and the map bins' about the same line. The arrow comes from the
  // page's ArrowSprite (arrow-up, arrow-down, arrow-flat).
  function changeRow(v, b, date, weekly, flat) {
    var d = Math.round(v * 10000) - Math.round(b[1] * 10000);
    var t = Math.floor((Math.abs(d) + 5) / 10);
    var dir = t < flat ? "flat" : d > 0 ? "up" : "down";
    var row = document.createElement("div");
    row.className = "tip-row tip-change";
    row.innerHTML = '<svg class="glyph glyph-' + dir + '" aria-hidden="true"><use href="#arrow-' + dir + '"></use></svg>';
    var one = weekly ? 7 : 1;
    row.appendChild(document.createTextNode(Math.floor(t / 10) + "." + (t % 10) + "¢ vs " +
      (day(date) - day(b[0]) === one ? (weekly ? "week" : "day") + " before" : shortDate(b[0]))));
    return row;
  }

  document.querySelectorAll("[data-chart]").forEach(function (plot) {
    var data;
    try { data = JSON.parse(plot.getAttribute("data-chart")); } catch (e) { return; }
    var n = data.dates.length;
    if (!n) return;
    var area = plot.querySelector(".plot-area");
    var cross = document.createElement("div");
    cross.className = "cross";
    cross.hidden = true;
    area.appendChild(cross);
    var dots = data.series.map(function (s) {
      var d = document.createElement("span");
      d.className = "cross-dot cross-dot-" + s.kind;
      d.hidden = true;
      area.appendChild(d);
      return d;
    });
    var tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    area.appendChild(tip);
    var idx = -1;

    // newest earlier value of the primary series, for the change row
    function earlier(i) {
      var vals = data.series[0].values;
      for (var j = i - 1; j >= 0; j--) if (vals[j] !== null) return [data.dates[j], vals[j]];
      return data.prev;
    }

    function show(i) {
      idx = Math.max(0, Math.min(n - 1, i));
      var x = data.x[idx];
      cross.style.left = x + "%";
      cross.hidden = false;
      tip.textContent = "";
      var head = document.createElement("div");
      head.className = "tip-date";
      head.textContent = dateLabel(data.dates[idx], data.weekly);
      tip.appendChild(head);
      data.series.forEach(function (s, k) {
        var v = s.values[idx];
        var y = s.y[idx];
        if (v === null || y === null) { dots[k].hidden = true; }
        else {
          dots[k].style.left = x + "%";
          dots[k].style.top = y + "%";
          dots[k].hidden = false;
        }
        var row = document.createElement("div");
        row.className = "tip-row";
        var key = document.createElement("span");
        key.className = "tip-key tip-key-" + s.kind;
        var val = document.createElement("strong");
        if (v === null) val.textContent = "No price";
        else val.appendChild(priceNodes(v));
        var lab = document.createElement("span");
        lab.className = "tip-label";
        lab.textContent = s.label;
        row.appendChild(key);
        row.appendChild(val);
        row.appendChild(lab);
        tip.appendChild(row);
        if (k === 0 && v !== null) {
          var b = earlier(idx);
          if (b) tip.appendChild(changeRow(v, b, data.dates[idx], data.weekly, data.flat));
        }
      });
      tip.hidden = false;
      // put the tooltip beside the crosshair on whichever side has room
      var aw = area.offsetWidth, tw = tip.offsetWidth, px = (x / 100) * aw;
      var left;
      if (px + 12 + tw <= aw + 40) left = px + 12;
      else if (px - 12 - tw >= -40) left = px - 12 - tw;
      else left = Math.max(-40, Math.min(aw + 40 - tw, px - tw / 2));
      tip.style.right = "auto";
      tip.style.left = left + "px";
    }
    function hide() {
      cross.hidden = true;
      tip.hidden = true;
      dots.forEach(function (d) { d.hidden = true; });
    }
    function nearest(frac) {
      var target = frac * 100;
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (data.x[mid] < target) lo = mid; else hi = mid;
      }
      return Math.abs(data.x[lo] - target) <= Math.abs(data.x[hi] - target) ? lo : hi;
    }
    area.addEventListener("pointermove", function (e) {
      var r = area.getBoundingClientRect();
      if (r.width === 0) return;
      show(nearest((e.clientX - r.left) / r.width));
    });
    area.addEventListener("pointerleave", function () {
      if (document.activeElement !== plot) hide();
    });
    plot.addEventListener("focus", function () { show(idx < 0 ? n - 1 : idx); });
    plot.addEventListener("blur", hide);
    plot.addEventListener("keydown", function (e) {
      var step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -4, PageDown: 4 }[e.key];
      if (step) { show(idx + step); e.preventDefault(); }
      else if (e.key === "Home") { show(0); e.preventDefault(); }
      else if (e.key === "End") { show(n - 1); e.preventDefault(); }
      else if (e.key === "Escape") { hide(); }
    });
  });
})();
