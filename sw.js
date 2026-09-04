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
  './icons/apple-touch-icon.png',
  './icons/badge-96.png'
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

/* ---------- Web Push ---------- */
// Payload shape sent by the server (see /api/v1/push/send):
// { title, body, url, tag, kind: 'lead'|'task'|'mention'|'system', id, actions:[{action,title}], renotify }
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'GBX Pipeline', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'GBX Pipeline';
  const opts = {
    body: d.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    tag: d.tag || ('gbx-' + (d.kind || 'system') + '-' + (d.id || Date.now())),
    renotify: !!d.renotify,
    timestamp: Date.now(),
    vibrate: [80, 40, 80],
    data: { url: d.url || './index.html#/dashboard', id: d.id, kind: d.kind },
    actions: Array.isArray(d.actions) ? d.actions.slice(0, 2) : []
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url, id, kind } = e.notification.data || {};
  const action = e.action;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (action === 'done' && kind === 'task') {
      // Complete straight from the notification; the API call is the source of truth, open clients update via message.
      await fetch('./api/v1/tasks/' + id + '/complete', { method: 'POST' }).catch(() => {});
      wins.forEach((c) => c.postMessage({ type: 'task-done', id }));
      return;
    }
    const target = new URL(url || './index.html#/dashboard', self.location.href).href;
    for (const c of wins) {
      if ('focus' in c) { c.postMessage({ type: 'navigate', url: target }); return c.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (e) => {
  // Browser rotated the subscription: re-subscribe and tell the server.
  e.waitUntil(self.registration.pushManager.subscribe(e.oldSubscription ? e.oldSubscription.options : { userVisibleOnly: true })
    .then((sub) => fetch('./api/v1/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'gbx' }, body: JSON.stringify({ subscription: sub }) }))
    .catch(() => {}));
});
