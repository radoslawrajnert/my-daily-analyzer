// Minimal service worker for installability + basic offline support.
//
// This app is already offline-first in the sense that all real data lives in localStorage (and,
// optionally, Firebase when Cloud Sync is turned on) -- there's no server API this SW needs to
// front. Its only job is to (a) let the browser consider the app "installable" (a PWA requires a
// manifest + a registered service worker that handles fetch), and (b) cache the app shell itself
// (this HTML file + its icons/manifest) so opening the installed app with no network connection
// still loads the app instead of a browser error page.
//
// Bump CACHE_NAME whenever index.html changes so returning visitors pick up the new version
// instead of being stuck on a stale cached copy -- APP_VERSION already gets bumped on every
// release, so its value doubles as the cache-busting key.
const CACHE_NAME = "body-nutrition-analyzer-v2.26";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first for navigations (so a logged-in user always gets the latest code when online),
// falling back to the cached shell when offline. Cache-first for everything else (icons/manifest
// barely change and aren't worth a network round-trip every load).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  if(req.mode === "navigate"){
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
