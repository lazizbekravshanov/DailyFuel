// DailyFuel's offline copy. Pages only, network first: online, every page
// comes fresh from the network and a copy is kept; with no signal, the last
// copy of that page is shown, or the home page's. A copy says its own week
// and the stale banner says when it is old, so an old copy never passes for
// new prices. Nothing from another host is touched (the map's tiles, Vercel's
// analytics), and nothing but whole pages is kept.
var CACHE = "dailyfuel-pages-v1";
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (e) {
  var r = e.request,
    u = new URL(r.url);
  if (r.method !== "GET" || r.mode !== "navigate" || u.origin !== location.origin || u.pathname.indexOf("/_vercel/") === 0) return;
  e.respondWith(
    fetch(r)
      .then(function (res) {
        // a redirect (the picker's /go) is kept under the page it lands on, not under /go
        if (res.ok && !res.redirected) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(u.pathname, copy);
          });
        }
        return res;
      })
      .catch(function () {
        return caches.match(u.pathname).then(function (m) {
          return m || caches.match("/");
        });
      }),
  );
});
