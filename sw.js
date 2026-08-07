/* Aarvex Portal — Service Worker (Phase 2 · PWA + offline)
 * Farmers often have patchy connectivity, so the app shell is cached for
 * instant loads and offline resilience.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/icons): cache-first, updated in the background.
 *   - API calls (the Lambda origin): network-first, never cached long-term
 *     (prices/stock/orders must be fresh); on failure we surface a clear
 *     offline JSON rather than a broken page.
 *   - Bump SW_VERSION on every deploy so old caches are purged.
 */
const SW_VERSION = 'aarvex-v2';
const SHELL_CACHE = 'shell-' + SW_VERSION;

/* Kept deliberately small — just the entry shell. Versioned ?v= assets are
   cached on first fetch via the runtime handler below, so we don't have to
   list (and keep updating) every file here. */
const SHELL_ASSETS = [
  'portal.html',
  'manifest.webmanifest',
  'ax-icon.svg',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_ASSETS).catch(function () { /* tolerate a missing file */ });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL_CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isApiRequest(url) {
  // Use word-boundary-style patterns so that /story-editor.html is NOT
  // treated as an API call — only exact API path segments like /story?…
  // or /story/ (with a slash or query-string following) are matched.
  if (/execute-api|amazonaws\.com/.test(url)) return true;
  // Match path segments only: must be followed by '/', '?', '#', or end-of-string.
  return /\/(catalogue|shop|feed|order|rfq|dispute|delivery|story|alert|account|favourites)(\/|\?|#|$)/.test(url);
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = req.url;

  // API → network-first, fresh data; clear offline signal on failure.
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(req).catch(function () {
        return new Response(JSON.stringify({ error: 'offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // Static shell/asset → cache-first, refresh in background (stale-while-revalidate).
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        const network = fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
  }
});
