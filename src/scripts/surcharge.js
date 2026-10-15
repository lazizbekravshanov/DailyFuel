// The fuel surcharge page's one script (src/pages/surcharge.astro). It turns
// on the four fields, works out the surcharge as they change, says under a
// typed number what is wrong with it, and keeps the base price and the MPG on
// this phone. The sums and the words are src/lib/surcharge.ts's, which
// renders the page's first answer; the page check in src/lib/built.test.ts
// runs this script against that module, so keep the two the same.
// The prices come from the page's JSON block (#sc-data): the weeks, newest
// first, and each price's dollars a gallon for those weeks, null where EIA
// has none.
(function () {
  function $(id) {
    return document.getElementById(id);
  }
  var form = $("sc"),
    data = $("sc-data");
  if (!form || !data) return;
  var px = JSON.parse(data.textContent),
    series = $("sc-s"),
    week = $("sc-w"),
    base = $("sc-b"),
    mpg = $("sc-m"),
    out = $("sc-out"),
    used = $("sc-used"),
    tell = $("sc-say"),
    KEY = "dailyfuel:surcharge",
    NUMBER = /^(\d+\.?\d*|\.\d+)$/,
    BASE = /^(\d+\.?\d{0,3}|\.\d{1,3})$/;

  // thousandths of a dollar, which are tenths of a cent, rounded half up like toMills
  function mills(v) {
    return Math.floor((Math.round(v * 1e4) + 5) / 10);
  }
  // "$6.179", like formatPrice
  function price(v) {
    var m = mills(v);
    return "$" + Math.floor(m / 1e3) + "." + String(m % 1e3).padStart(3, "0");
  }
  // a typed number, or null: the base from 0 to 10 with a $ in front allowed
  // and three decimals at most, the MPG from 2 to 20; one comma counts as the point
  function read(el) {
    var b = el === base,
      t = el.value.trim();
    if (b) t = t.replace(/^\$\s*/, "");
    t = t.replace(",", ".");
    if (!(b ? BASE : NUMBER).test(t)) return null;
    var n = +t;
    return (b ? n <= 10 : n >= 2 && n <= 20) ? n : null;
  }
  // what a select shows: "Midwest", "Oct 12, 2026"
  function label(sel) {
    var o = sel.querySelector('option[value="' + sel.value + '"]');
    return o ? o.textContent : "";
  }
  // only a real change is written, so a live region says nothing twice
  function put(el, t) {
    if (el.textContent !== t) el.textContent = t;
  }
  // A field's error shows once the driver has left the field, or hit enter,
  // and goes as soon as the number is right.
  function check(el, show) {
    var n = read(el),
      bad = n === null;
    if (!bad || show || el.hasAttribute("aria-invalid")) {
      put($(el.getAttribute("aria-describedby")), bad ? el.getAttribute("data-err") : "");
      if (bad) el.setAttribute("aria-invalid", "true");
      else el.removeAttribute("aria-invalid");
    }
    return n;
  }
  function run(show) {
    var b = check(base, show),
      m = check(mpg, show),
      name = label(series),
      wk = label(week),
      p = (px.p[series.value] || [])[px.w.indexOf(week.value)],
      a = "",
      u = "";
    if (b !== null && m !== null) {
      if (p == null) a = "There's no " + name + " DOE price for the week of " + wk + ". Pick another week.";
      else {
        // the price over the base in tenths of a cent a gallon, over the MPG, rounded half up
        var over = mills(p) - mills(b),
          t = over > 0 ? Math.floor(over / m + 0.5 + 1e-9) : 0;
        a = over > 0
          ? Math.floor(t / 10) + "." + (t % 10) + "¢ a mile, $" + t.toLocaleString("en-US") + " on 1,000 miles."
          : "No surcharge, since the price is at or under your base.";
        u = name + " DOE price " + price(p) + ", week of " + wk + ". Base " + price(b) + ", " + m + " MPG.";
      }
    }
    put(out, a);
    put(used, u);
    // a screen reader hears the answer once it settles (a pick, or a number
    // typed and left), not one for every key on the way
    if (show) put(tell, a);
    return b !== null && m !== null;
  }

  // the base and the MPG kept on this phone, when they still read as numbers;
  // storage can be blocked, and then the page's own numbers stay
  try {
    var kept = JSON.parse(window.localStorage.getItem(KEY)) || {};
    [[base, kept.base], [mpg, kept.mpg]].forEach(function (k) {
      if (typeof k[1] != "string") return;
      var was = k[0].value;
      k[0].value = k[1];
      if (read(k[0]) === null) k[0].value = was;
    });
  } catch (e) {}
  form.addEventListener("input", function () {
    if (!run(false)) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ base: base.value.trim(), mpg: mpg.value.trim() }));
    } catch (e) {}
  });
  form.addEventListener("change", function () {
    run(true);
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    run(true);
  });
  form.querySelector("fieldset").removeAttribute("disabled");
  run(false);
})();
