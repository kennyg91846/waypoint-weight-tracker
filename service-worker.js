// service-worker.js — makes Waypoint fully usable offline as a PWA.
//
// Registered from both log.js and chart.js on page load. All app data
// (weight entries) lives in IndexedDB via Dexie, not in this cache —
// this cache is only for the static app shell (HTML/CSS/JS/fonts/icons),
// so the app can load and function with no network connection at all.
//
// Bumping CACHE_NAME (e.g. to 'waypoint-v2') is the mechanism for
// shipping updated assets: the 'activate' handler below deletes any
// cache whose name doesn't match the current CACHE_NAME, so a version
// bump forces old cached files to be dropped in favor of fresh ones.
const CACHE_NAME = 'waypoint-v24';
// Every file the app needs to run offline. Keep this in sync with
// reality — if a new asset (font, icon, script) is added to the app but
// not listed here, it won't be pre-cached on install and may fail to
// load offline until the browser happens to fetch it online first.
const ASSETS = [
  './',
  './index.html',
  './chart.html',
  './manifest.json',
  './css/style.css',
  './css/fonts.css',
  './js/db.js',
  './js/install.js',
  './js/log.js',
  './js/chart.js',
  './vendor/dexie.min.js',
  './vendor/chart.umd.min.js',
  './fonts/fraunces/fraunces-latin-400-normal.woff2',
  './fonts/fraunces/fraunces-latin-600-normal.woff2',
  './fonts/fraunces/fraunces-latin-900-normal.woff2',
  './fonts/inter/inter-latin-400-normal.woff2',
  './fonts/inter/inter-latin-500-normal.woff2',
  './fonts/inter/inter-latin-700-normal.woff2',
  './fonts/plex-mono/ibm-plex-mono-latin-400-normal.woff2',
  './fonts/plex-mono/ibm-plex-mono-latin-600-normal.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// On install: pre-download and cache every file in ASSETS, then
// skipWaiting() so this new service worker activates immediately
// instead of waiting for all open tabs of the app to close.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// On activate: delete any cache left over from a previous version
// (anything named differently from the current CACHE_NAME), then
// clients.claim() so this service worker takes control of any already-
// open tabs right away rather than only on their next load.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for everything (this app has no network dependencies at runtime).
// For every GET request: serve from cache if present; otherwise fetch
// from the network, stash a copy in the cache for next time, and return
// it. If the network fetch fails (e.g. offline) and nothing was cached,
// `cached` is undefined and the request simply fails — there's no
// custom offline fallback page.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});
