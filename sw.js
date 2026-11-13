const CACHE_NAME = 'gbcl-auction-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Always fetch live API requests from network; fallback to cache for static UI files
  if (event.request.url.includes('workers.dev') || event.request.url.includes('google.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
