// Minimal service worker: makes the app installable and opens offline with the last data.
// Data is network-first so you always see the newest daily update when online.
const CACHE = "rr-v10";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Bandcamp embeds/art go straight to network
  e.respondWith(
    // always check GitHub for a newer copy (cheap 304 if unchanged); cached copy only when offline
    fetch(e.request, { cache: "no-cache" }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request.url.split("?")[0], copy));
      return res;
    }).catch(() => caches.match(e.request.url.split("?")[0]))
  );
});
