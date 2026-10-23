// App shell is cached for offline use. data/ipos.json is always fetched fresh; when offline we serve the last good copy of it.
// An HTML page must never be handed back in place of the JSON (it used to, which made the app look empty).
const CACHE = "ipo-radar-v100";
const SHELL = ["./", "index.html", "style.css", "theme.css", "mod-stocks.css", "mod-mf.css", "fonts/inter-latin.woff2", "fonts/inter-latin-ext.woff2", "app.js", "charts.js", "live.js", "app-stocks.js", "app-mf.js", "boot.js", "analytics.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/data/files/")) return;   // big PDFs: let the browser handle them, never cache
  const isData = url.pathname.endsWith("/ipos.json");
  const isShell = url.pathname.endsWith("/") || SHELL.some(s => s !== "./" && url.pathname.endsWith(s));
  if (!isData && !isShell) return;                      // everything else: plain network
  const key = isData ? url.origin + url.pathname : e.request;   // ignore ?query so one cached copy always matches
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then(r => {
      // only keep good responses; never cache an HTML error page as data
      if (r.ok && (!isData || /json/i.test(r.headers.get("content-type") || ""))) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); return r; }
      return caches.match(key, { ignoreSearch: true }).then(m => m || r);
    }).catch(() => caches.match(key, { ignoreSearch: true }).then(m => m || (isData ? Response.error() : caches.match("index.html"))))
  );
});
