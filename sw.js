/**
 * SENTINEL service worker — the app shell, and nothing else.
 *
 * The whole value of this board is that its data is current, so the one thing
 * this must never do is serve a stale feed and let it pass for live. It caches
 * the shell (the page and the two libraries it needs to boot) and deliberately
 * refuses to cache anything else: no API responses, no map tiles, no proxy
 * traffic. Those go straight to the network every time, and if the network is
 * gone the board says so through its existing feed-status machinery rather than
 * quietly rendering yesterday.
 *
 * What that buys: it installs, it opens instantly, and it opens at all on a
 * flaky connection — with the map empty and every feed visibly offline, which
 * is the honest failure mode.
 */

const SHELL = 'sentinel-shell-v1';

// Same-origin shell only. The Leaflet and satellite.js CDN files are needed to
// boot, so they are fetched opportunistically at install but never block it —
// a CDN hiccup at install time should not leave the app uninstallable.
const CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
const OPTIONAL = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://cdnjs.cloudflare.com/ajax/libs/satellite.js/5.0.0/satellite.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then(async (c) => {
      await c.addAll(CORE);
      await Promise.allSettled(OPTIONAL.map((u) => c.add(u)));
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Anything that is not part of the shell is data, and data is never served from
// cache. `isShell` is an allowlist rather than a blocklist on purpose: a new
// feed added to the app must not accidentally become cacheable.
function isShell(url) {
  const u = new URL(url);
  if (u.origin === self.location.origin) {
    const p = u.pathname.replace(/\/index\.html$/, '/');
    return p === '/' || p.endsWith('/') || /\.(html|webmanifest|svg|css)$/.test(u.pathname);
  }
  return OPTIONAL.includes(url);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  if (!isShell(req.url)) return;   // straight to the network, uncached

  // Network first so a deployed update is picked up on the next load, with the
  // cached shell as the fallback that makes the app openable offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        // `res.ok` alone is not enough to decide something is the app.
        // Behind Cloudflare Access an unauthenticated request is redirected to
        // a hosted login page, which comes back 200 — cache that and the shell
        // becomes a login screen that persists after you have signed in.
        // A genuine shell response is same-origin and unredirected; the login
        // is neither, because it lands on <team>.cloudflareaccess.com.
        const cacheable = res && res.ok && !res.redirected
          && (res.type === 'basic' || OPTIONAL.includes(req.url));
        if (cacheable) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
