/* lifeos PWA — service worker.
 * Strategy:
 *   - Precache the shell on install (/, /main.css, /main.js, /manifest.webmanifest).
 *   - For shell GETs: stale-while-revalidate (return cache fast, refresh in bg).
 *   - For /api/* and everything else: network-only pass-through (no caching).
 *
 * 策略：安装时预缓存 PWA 外壳；外壳请求走「先取缓存，后台回源」；其余（含
 * /api/*）一律网络直通。
 */

const CACHE = 'lifeos-shell-v1';
const SHELL = ['/', '/main.css', '/main.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return SHELL.includes(p) || p === '/index.html';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // mutations: pass through / 变更请求直通
  const url = new URL(req.url);

  // API and any non-shell GET: network only.
  if (url.pathname.startsWith('/api/') || !isShell(url)) return;

  // Stale-while-revalidate for the shell.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((resp) => {
        if (resp && resp.status === 200) cache.put(req, resp.clone());
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
