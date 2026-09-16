/* Aarvex Portal Service Worker - PWA + offline, app-ready.
 *
 * Strategy:
 *   - Navigations (HTML document): STALE-WHILE-REVALIDATE - paint the cached
 *     shell instantly, refresh in the background for next launch. A deploy bumps
 *     SW_VERSION so old caches purge on activate; the first launch after a deploy
 *     fetches fresh. Offline falls back to the cached shell, then an offline page.
 *   - Static assets (CSS/JS/img/fonts, ?v= versioned): cache-first with a
 *     background refresh (stale-while-revalidate) for instant loads.
 *   - API calls (Lambda origin / known paths): network-first, never cached
 *     long-term; on failure return a clear offline JSON, not a broken page.
 *   - Bump SW_VERSION on every deploy so old caches purge on activate.
 */
const SW_VERSION = 'aarvex-v64';
const SHELL_CACHE = 'shell-' + SW_VERSION;

// Both HTML entry points are precached so each paints instantly AND is served as
// itself — index.html is the marketing site, portal.html is the app. (Before v37
// only portal.html was cached and the navigation handler fell back to it for
// EVERY document, so /index.html wrongly rendered the portal.)
const SHELL_ASSETS = ['index.html', 'portal.html', 'manifest.webmanifest', 'ax-icon.svg'];

const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline - Aarvex</title>' +
  '<style>body{margin:0;font-family:system-ui,sans-serif;background:#0A0A0A;color:#fff;' +
  'display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}' +
  'div{padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#9aa;font-size:14px;margin:0}</style>' +
  '</head><body><div><h1>You are offline</h1><p>Check your connection and try again.</p></div></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 });
}

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_ASSETS.map(function (a) {
        return fetch(a).then(function (r) { if (r && r.status === 200) return cache.put(a, r); }).catch(function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL_CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

function isApiRequest(url) {
  if (/execute-api|amazonaws\.com/.test(url)) return true;
  return /\/(catalogue|shop|feed|order|rfq|dispute|delivery|story|alert|account|favourites|auth|push)(\/|\?|#|$)/.test(url);
}

function isNavigation(req) {
  return req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  if (isApiRequest(url)) {
    event.respondWith(
      fetch(req).catch(function () {
        return new Response(JSON.stringify({ error: 'offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  if (isNavigation(req)) {
    // index.html (marketing site) and portal.html (app) are DIFFERENT documents,
    // so we must serve the EXACT requested page — never blindly fall back to one
    // shell for the other. Cached exact page paints instantly (and refreshes in
    // the background); otherwise go to the network; only when OFFLINE do we fall
    // back to a path-appropriate shell (portal paths → portal.html, everything
    // else → index.html), then the offline page.
    const network = fetch(req).then(function (res) {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return null; });

    event.respondWith(
      caches.match(req).then(function (cachedExact) {
        if (cachedExact) { event.waitUntil(network); return cachedExact; }
        return network.then(function (res) {
          if (res) return res;
          const wantsPortal = /\/portal\.html(?:$|[?#])/.test(req.url);
          return caches.match(wantsPortal ? 'portal.html' : 'index.html').then(function (shell) {
            return shell || caches.match('portal.html').then(function (p) { return p || offlineResponse(); });
          });
        });
      })
    );
    return;
  }

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
