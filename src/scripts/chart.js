// Crosshair and tooltip for line charts. Pointer or keyboard: focus a chart and
// use the arrow keys. Every value is also in the table under the chart.
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(iso, weekly) {
    var a = iso.split("-");
    var s = MONTHS[+a[1] - 1] + " " + +a[2] + ", " + a[0];
    return weekly ? "Week of " + s : s;
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

    function show(i) {
      idx = Math.max(0, Math.min(n - 1, i));
      var x = data.x[idx];
      cross.style.left = x + "%";
      cross.hidden = false;
      tip.textContent = "";
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
      });
      var head = document.createElement("div");
      head.className = "tip-date";
      head.textContent = dateLabel(data.dates[idx], data.weekly);
      tip.insertBefore(head, tip.firstChild);
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
