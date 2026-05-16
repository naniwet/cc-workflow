// cc-workflow PWA service worker — network-first for shell assets, no
// push handler (Phase 2 / P0-6a). Web Push is explicitly P1, see
// dev-plan §11 §7.
//
// Strategies:
//   • static shell (manifest / index / app.js / style.css / icon)  → NETWORK-first
//     (fall back to cache only when offline)
//   • everything else (esp. /sessions /runs/* /loops API)          → bypass SW
//
// Why network-first for the shell:
//   This is a frequently-deployed dev tool — when the user pulls new
//   commits and refreshes, they expect to see the new UI. Cache-first
//   would serve a stale app.js until the SW itself happens to update.
//   Network-first guarantees fresh code as long as the user is online
//   (which they always are — they're triggering remote agent runs).
//   Cache is retained as offline fallback.
//
// Bump VERSION on breaking SW changes so the activate handler purges
// any older cache buckets.

const VERSION = 'cc-v47';
const SHELL = [
  '/pwa/',
  '/pwa/index.html',
  '/pwa/login.html',
  '/pwa/app.js',
  '/pwa/style.css',
  '/pwa/manifest.json',
  '/pwa/icon.svg',
  // PNG raster icons. Chromium-based browsers (Chrome / Edge mobile)
  // require at least one raster icon at 192x192 or 512x512 to consider
  // a manifest "installable" — SVG alone leaves Add-to-Home-Screen
  // grayed out. Both sizes cached so the home-screen icon survives
  // offline.
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only intercept same-origin GETs under /pwa/. APIs always go to network.
  if (event.request.method !== 'GET' || !url.pathname.startsWith('/pwa/')) return;

  // Network-first: try server, refresh cache on success, fall back to
  // cache only when the network fails (offline / server down).
  //
  // `cache: 'no-store'` forces the fetch to bypass the BROWSER HTTP
  // cache. Without this, nginx's `expires 1h` on /pwa/ would let the
  // browser serve a stale app.js to the SW's "network-first" call —
  // turning network-first into "cache-first under the hood". Bit us
  // after HTTPS migration: stale app.js (without the
  // newWsProviderPicker fix) → renderMobileOverview ReferenceError →
  // "Loading…" stuck forever. The SW's own caches.open(VERSION) is
  // the only offline fallback we want.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((resp) => {
        if (resp.ok && resp.status === 200) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then(
          (cached) => cached || caches.match('/pwa/index.html'),
        ),
      ),
  );
});
