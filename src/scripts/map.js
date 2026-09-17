// Map tooltips on hover and keyboard focus, plus an outline that sits above
// neighboring states. The native <title> is removed once this runs so there is
// only one tooltip. Without JS the <title> and link text still work.
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
  document.querySelectorAll("[data-map]").forEach(function (wrap) {
    var svg = wrap.querySelector("svg");
    var his = svg.querySelectorAll(".map-hi path");
    function setHi(d) { his.forEach(function (h) { h.setAttribute("d", d); }); }
    var tip = wrap.querySelector(".map-tip");
    svg.querySelectorAll("a > title").forEach(function (t) { t.parentNode.removeChild(t); });
    var active = null;

    function fill(a) {
      tip.textContent = "";
      var name = document.createElement("div");
      name.className = "tip-name";
      name.textContent = a.getAttribute("data-name");
      tip.appendChild(name);
      var priceText = a.getAttribute("data-price");
      if (priceText) {
        var price = document.createElement("div");
        price.className = "tip-price";
        price.textContent = priceText;
        tip.appendChild(price);
      }
      var change = a.getAttribute("data-change");
      if (change) {
        var row = document.createElement("div");
        row.className = "tip-change";
        row.appendChild(glyph(a.getAttribute("data-dir") || "flat"));
        row.appendChild(document.createTextNode(change));
        tip.appendChild(row);
      }
      var note = a.getAttribute("data-note");
      if (note) {
        var nn = document.createElement("div");
        nn.className = "tip-note";
        nn.textContent = note;
        tip.appendChild(nn);
      }
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
    // small eastern states also have a labeled box beside the map; light it up too
    function setBox(code) {
      svg.querySelectorAll(".callout.is-active").forEach(function (b) { b.classList.remove("is-active"); });
      if (code) {
        var box = svg.querySelector('.callout[data-code="' + code + '"]');
        if (box) box.classList.add("is-active");
      }
    }
    function show(a, clientX, clientY) {
      var code = a.getAttribute("data-code");
      var shape = svg.querySelector('a.state[data-code="' + code + '"] path');
      if (active !== a) {
        active = a;
        fill(a);
        setHi(shape ? shape.getAttribute("d") : "");
        setBox(code);
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
      setHi("");
      setBox(null);
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
