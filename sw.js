// Cargas Pro · Service Worker — SIEMPRE intenta la red primero (última versión); la caché es solo para trabajar sin conexión.
const CACHE = 'cargaspro-v8-20261003';
const CORE = ['./', './index.html', './manifest.json', './css/app.css', './js/00-watchdog.js', './js/01-app.js', './js/02-navigation.js', './js/03-palets.js'];
const CDN = ['www.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u =>
    fetch(u, { cache: 'reload' }).then(r => r.ok && c.put(u, r)).catch(() => {})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'CLEAR_CACHE') {
    caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => {
      (e.source || self.clients).postMessage?.('CACHE_CLEARED');
    });
  }
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin && !CDN.includes(url.hostname)) return; // Firestore, Auth, etc. van directos
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-cache' });          // salta la caché HTTP del navegador
      if (fresh && (fresh.ok || fresh.type === 'opaque')) { const c = await caches.open(CACHE); c.put(req, fresh.clone()); }
      return fresh;
    } catch (_) {
      const hit = await caches.match(req, { ignoreSearch: url.origin === self.location.origin });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('./index.html'); if (idx) return idx; }
      return new Response('Sin conexión', { status: 503, statusText: 'Offline' });
    }
  })());
});
