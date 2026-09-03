/* GBX Pipeline service worker — caches the app shell so the CRM opens instantly
   from the home screen and still loads with a flaky connection. Data calls
   (the real API, Microsoft Graph, ad webhooks) are always network-first and
   never cached here. */
const VERSION = 'gbx-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle same-origin shell assets; fonts and APIs go straight to the network.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const fetched = fetch(req).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || fetched;
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
