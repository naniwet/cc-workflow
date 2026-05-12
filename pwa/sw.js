// cc-workflow PWA service worker — cache-only, no push handler (Phase 2 / P0-6a).
// Web Push is explicitly P1, see dev-plan §11 §7.
//
// Strategies:
//   • static shell (manifest / index / app.js / style.css / icon)  → cache-first
//   • everything else (esp. /sessions /runs/* /loops API)          → network-only
//
// 401s are never cached. SW activates immediately on update.

const VERSION = 'cc-v1';
const SHELL = [
  '/pwa/',
  '/pwa/index.html',
  '/pwa/app.js',
  '/pwa/style.css',
  '/pwa/manifest.json',
  '/pwa/icon.svg',
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
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        // 401/403/404 — don't poison the cache
        if (resp.ok && resp.status === 200) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return resp;
      });
    }).catch(() => caches.match('/pwa/index.html'))
  );
});
