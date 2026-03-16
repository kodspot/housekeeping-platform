// Kodspot Housekeeping — Service Worker
// Enables PWA install on desktop & mobile, provides offline fallback

const CACHE_NAME = 'kodspot-v8';
const OFFLINE_URL = '/offline.html';

// Pre-cache essential assets on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        OFFLINE_URL,
        '/css/design-system.css?v=7',
        '/js/app.js?v=8',
        '/favicon-32x32.png',
        '/android-chrome-192x192.png'
      ])
    )
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first strategy: try network, fallback to cache for navigations
self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  // Skip API calls — always go to network
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;

  // For navigation requests (HTML pages), try network first, fallback to offline page
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // For static assets (CSS/JS/images), try cache first, then network
  if (url.pathname.match(/\.(css|js|png|ico|woff2?)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
        return cached || networkFetch;
      })
    );
    return;
  }
});
