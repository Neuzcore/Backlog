// Neuzcores Gaming Backlog — Service Worker
const CACHE = 'gaming-backlog-v2';
const ASSETS = [
  './game-backlog.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;600&display=swap'
];

// Install: cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Skip waiting when told to update immediately
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Fetch strategy:
// - API calls (RAWG, JSONBin) always go to network (never cached)
// - App files: cache-first, fall back to network
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never cache API/data requests
  if (url.includes('jsonbin.io') || url.includes('rawg.io') ||
      url.includes('codetabs.com') || url.includes('allorigins.win') ||
      url.includes('corsproxy.io') || url.includes('media.rawg.io')) {
    return; // let the browser handle it normally
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // cache successful same-origin GET responses
        if (e.request.method === 'GET' && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
