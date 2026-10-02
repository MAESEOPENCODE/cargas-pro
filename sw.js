const CACHE_NAME = 'cargas-pro-shell-v8';
const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/00-watchdog.js',
  './js/01-app.js',
  './js/02-navigation.js',
  './js/03-palets.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && (response.ok || response.type === 'opaque')) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(event.request).then(cached => {
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      return new Response('', {status: 503, statusText: 'Offline'});
    }))
  );
});

self.addEventListener('message', event => {
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))).then(() => {
      self.clients.matchAll().then(clients => clients.forEach(client => client.postMessage('CACHE_CLEARED')));
    });
  }
});
