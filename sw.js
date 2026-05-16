// Neuzcores Gaming Backlog — Service Worker
// Bump this version alongside APP_VERSION in game-backlog.html on every update
const CACHE = 'gaming-backlog-v1.0.9';
const ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;600&display=swap'
];

// Install: pre-cache static assets (NOT the HTML — we want that fresh)
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete all old caches immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Skip waiting on demand
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Fetch strategy:
// - HTML file: always network-first (never serve stale HTML)
// - API calls: always network, never cache
// - Other assets (icons, fonts): cache-first
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never cache API/data requests
  if (url.includes('jsonbin.io') || url.includes('rawg.io') ||
      url.includes('codetabs.com') || url.includes('allorigins.win') ||
      url.includes('corsproxy.io') || url.includes('media.rawg.io')) {
    return;
  }

  // HTML: network-first, fall back to cache only if offline
  if (url.includes('game-backlog.html') || e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else: cache-first, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
      return cached || networkFetch;
    })
  );
});
