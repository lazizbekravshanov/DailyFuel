// Map tooltips on hover and keyboard focus, plus an outline that sits above
// neighboring states. While the map shows regions, the outline goes around the
// whole region the state shares its price with, and a dashed line marks the
// state itself. The native <title> is removed once this runs so there is only
// one tooltip. Without JS the <title> and link text still work.
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var GLYPHS = { up: "M5 0.8 9.8 9.2H0.2Z", down: "M0.2 0.8H9.8L5 9.2Z" };
  function glyph(dir) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 10 10");
    svg.setAttribute("class", "glyph glyph-" + dir);
    svg.setAttribute("aria-hidden", "true");
    if (dir === "flat") {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "5"); c.setAttribute("cy", "5"); c.setAttribute("r", "3.6");
      svg.appendChild(c);
    } else {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", GLYPHS[dir]);
      svg.appendChild(p);
    }
    return svg;
  }
  function div(cls, text) {
    var d = document.createElement("div");
    d.className = cls;
    if (text) d.textContent = text;
    return d;
  }
  document.querySelectorAll("[data-map]").forEach(function (wrap) {
    var svg = wrap.querySelector("svg");
    var halo = svg.querySelector(".hi-halo");
    var line = svg.querySelector(".hi-line");
    var one = svg.querySelector(".hi-state");
    var layers = {
      halo: svg.querySelector(".hi-rg-halo"),
      line: svg.querySelector(".hi-rg-line"),
      cover: svg.querySelector(".hi-rg-cover")
    };
    var litRegion = null;
    var tip = wrap.querySelector(".map-tip");
    svg.querySelectorAll("a > title").forEach(function (t) { t.parentNode.removeChild(t); });
    var active = null;

    function fill(a) {
      tip.textContent = "";
      tip.appendChild(div("tip-name", a.getAttribute("data-name")));
      var main = a.getAttribute("data-main");
      var priceText = a.getAttribute("data-price");
      if (main) {
        // the pump way, like everywhere else on the site: $6.25 with a raised 0
        var price = div("tip-price");
        price.appendChild(document.createTextNode(main));
        var t = document.createElement("span");
        t.className = "tenth";
        t.textContent = a.getAttribute("data-tenth") || "";
        price.appendChild(t);
        var unit = document.createElement("span");
        unit.className = "tip-unit";
        unit.textContent = " a gallon";
        price.appendChild(unit);
        tip.appendChild(price);
      } else if (priceText) {
        tip.appendChild(div("tip-price", priceText));
      }
      var change = a.getAttribute("data-change");
      if (change) {
        var row = div("tip-change");
        row.appendChild(glyph(a.getAttribute("data-dir") || "flat"));
        row.appendChild(document.createTextNode(change));
        tip.appendChild(row);
      }
      var note = a.getAttribute("data-note");
      if (note) tip.appendChild(div("tip-note", note));
    }
    function place(clientX, clientY) {
      var wr = wrap.getBoundingClientRect();
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var x = clientX - wr.left + 16;
      var y = clientY - wr.top + 16;
      if (x + tw > wr.width) x = clientX - wr.left - tw - 16;
      if (y + th > wr.height) y = clientY - wr.top - th - 16;
      tip.style.left = Math.max(0, x) + "px";
      tip.style.top = Math.max(0, y) + "px";
    }
    // small eastern states also have a labeled chip beside the map; light up
    // the chip, or every chip in the lit region, and mark the state's own chip
    // so a lit region still shows which one has focus
    function setBoxes(code, region) {
      svg.querySelectorAll(".callout.is-active").forEach(function (b) { b.classList.remove("is-active", "is-current"); });
      if (!code) return;
      var sel = region ? '.callout[data-region="' + region + '"]' : '.callout[data-code="' + code + '"]';
      svg.querySelectorAll(sel).forEach(function (b) {
        b.classList.add("is-active");
        if (b.getAttribute("data-code") === code) b.classList.add("is-current");
      });
    }
    // Light a whole region by copying its state shapes into three layers:
    // wide paper strokes, ink strokes, then the filled shapes on top. Nothing
    // extra ships with the page; the copies only exist while a region is lit.
    function setRegion(region) {
      if (region === litRegion) return;
      litRegion = region;
      layers.halo.textContent = "";
      layers.line.textContent = "";
      layers.cover.textContent = "";
      if (!region) return;
      svg.querySelectorAll('a.state[data-region="' + region + '"] path').forEach(function (p) {
        var a = p.cloneNode(false);
        a.removeAttribute("class");
        layers.halo.appendChild(a);
        var b = p.cloneNode(false);
        b.removeAttribute("class");
        layers.line.appendChild(b);
        layers.cover.appendChild(p.cloneNode(false));
      });
    }
    function setHi(outline, state, region) {
      setRegion(region || null);
      halo.setAttribute("d", outline);
      line.setAttribute("d", outline);
      one.setAttribute("d", state);
    }
    function show(a, clientX, clientY) {
      var code = a.getAttribute("data-code");
      var region = a.getAttribute("data-region");
      var shape = svg.querySelector('a.state[data-code="' + code + '"] path');
      var d = shape ? shape.getAttribute("d") : "";
      if (active !== a) {
        active = a;
        fill(a);
        if (region) setHi("", d, region);
        else setHi(d, "", null);
        setBoxes(code, region);
      }
      tip.hidden = false;
      if (clientX === undefined) {
        // keyboard: sit beside the state instead of on top of it
        var r = (shape || a).getBoundingClientRect();
        clientX = r.right - 8;
        clientY = r.top + Math.min(r.height / 2, 24);
      }
      place(clientX, clientY);
    }
    function hide() {
      active = null;
      tip.hidden = true;
      setHi("", "", null);
      setBoxes(null);
    }
    svg.addEventListener("pointermove", function (e) {
      var a = e.target.closest && e.target.closest("a[data-code]");
      if (a) show(a, e.clientX, e.clientY);
      else if (!svg.contains(document.activeElement)) hide();
    });
    svg.addEventListener("pointerleave", function () {
      if (!svg.contains(document.activeElement)) hide();
    });
    svg.addEventListener("focusin", function (e) {
      var a = e.target.closest && e.target.closest("a[data-code]");
      if (a) show(a);
    });
    svg.addEventListener("focusout", hide);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hide();
    });
  });
})();
