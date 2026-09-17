// Shows the stale banner when AAA prices are 2 or more days old or EIA's week
// is 10 or more days old, counting days in America/New_York.
// Mirrors isStale() in src/lib/dates.ts.
(function () {
  var el = document.getElementById("stale-banner");
  if (!el || !window.Intl) return;
  var parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date())
    .forEach(function (p) { parts[p.type] = p.value; });
  function day(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000; }
  function iso(s) { var a = s.split("-"); return day(+a[0], +a[1], +a[2]); }
  var today = day(+parts.year, +parts.month, +parts.day);
  var aaa = el.getAttribute("data-aaa");
  var eia = el.getAttribute("data-eia");
  var stale = (aaa && today - iso(aaa) >= 2) || (eia && today - iso(eia) >= 10);
  if (stale) el.hidden = false;
  // "EIA posts next week's prices on Tuesday" turns into a late notice once that day has passed
  function late() {
    document.querySelectorAll("[data-next-release]").forEach(function (n) {
      var due = n.getAttribute("data-next-release");
      if (due && today > iso(due)) n.textContent = n.getAttribute("data-late");
    });
  }
  // this script runs above the page content, so wait for the rest to parse
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", late);
  else late();
})();
