const CACHE_NAME = 'atlas-pwa-v13';
const CDN_ORIGINS = new Set(['https://unpkg.com']);
const APP_SHELL = [
  './Atlas.html',
  './styles.css',
  './views.css',
  './renderers.css?v=12',
  './search-overlay.css',
  './fs-api.js',
  './mock-data.js',
  './openviking-adapter.js?v=13',
  './tweaks-panel.jsx',
  './renderers.jsx?v=12',
  './ui-helpers.jsx?v=11',
  './views.jsx?v=13',
  './search-overlay.jsx?v=11',
  './manifest.webmanifest',
  './atlas-icon.svg',
  './atlas-icon-180.png',
  './atlas-icon-192.png',
  './atlas-icon-512.png',
  'https://unpkg.com/react@18.3.1/umd/react.development.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map((asset) => cache.add(asset).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const cacheableOrigin = url.origin === self.location.origin || CDN_ORIGINS.has(url.origin);
  if (!cacheableOrigin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./Atlas.html', copy));
          return response;
        })
        .catch(() => caches.match('./Atlas.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => {
        if (!response || (response.status !== 200 && response.type !== 'opaque')) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }))
  );
});
