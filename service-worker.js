/* TradeArena · Service Worker
 * --------------------------------------------------------------
 * Cache-first for the static app shell (HTML / CSS / JS / fonts /
 * icons), network-first for everything else (Supabase REST, market
 * datafeed, etc.). Falls back to the cached shell when the network
 * is unavailable so installed users can keep navigating offline.
 *
 * Bump CACHE_VERSION whenever any precached file changes — the
 * activate handler will purge older caches automatically.
 */
const CACHE_VERSION = 'tradearena-v3';
const PRECACHE = [
  '/',
  '/index.html',
  '/trade.html',
  '/portfolio.html',
  '/profile.html',
  '/account.html',
  '/auth.html',
  '/schools.html',
  '/module.html',
  '/lesson.html',
  '/reels.html',
  '/chart.html',
  '/about.html',
  '/contact.html',
  '/careers.html',
  '/press.html',
  '/terms.html',
  '/privacy.html',
  '/risk.html',
  '/cookies.html',

  '/manifest.json',
  '/assets/styles.css',
  '/assets/favicon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',

  '/assets/app.js',
  '/assets/config.js',
  '/assets/supabase.js',
  '/assets/market.js',
  '/assets/metrics.js',
  '/assets/datafeed.js',
  '/assets/reels.js',
  '/assets/chart-bootstrap.js',
  '/assets/js/market-data.js',
];

// ----- Install: precache the shell ---------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Cache each file individually so a single 404 doesn't poison
      // the whole install (e.g. an HTML page that hasn't been added
      // to the project yet). Failures are logged but not fatal.
      Promise.all(PRECACHE.map((url) =>
        cache.add(url).catch((err) => {
          console.warn('[sw] precache miss', url, err && err.message);
        })
      ))
    ).then(() => self.skipWaiting())
  );
});

// ----- Activate: drop stale caches ---------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ----- Fetch: route by request kind --------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache mutations

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Always go to the network for Supabase and any other 3rd-party
  // API. Returning stale data here would silently break trading
  // and auth flows.
  if (!isSameOrigin && /supabase\.|finnhub\.|api\./.test(url.host)) {
    return; // let the browser handle it
  }

  // Navigation requests (HTML pages): network-first, fall back to
  // the cached page, then to /index.html for unknown routes.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // Static same-origin assets (CSS / JS / images / fonts / icons):
  // cache-first, fall through to the network.
  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        // Only cache successful, basic responses.
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Cross-origin assets (Google Fonts, Font Awesome CDN, Chart.js
  // CDN, etc.): stale-while-revalidate so the first install works
  // online and subsequent loads work offline.
  event.respondWith(
    caches.match(req).then((hit) => {
      const networked = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || networked;
    })
  );
});
