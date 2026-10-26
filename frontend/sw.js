/*
 * AgentGuard service worker (v0.6.0). It caches the static app shell so the app opens offline (read-only), and
 * shows Web Push alerts. It never caches API responses, and a notification can only open the Review screen:
 * deciding always happens in the signed-in app.
 */
importScripts('/js/sw-helpers.js');
var ag = self.agSw;

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(ag.CACHE).then(function (cache) {
    return cache.addAll(ag.STATIC_FILES.map(function (f) { return '/' + f; }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n.indexOf('agentguard-static-') === 0 && n !== ag.CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api') === 0) return;   // data and the live stream always go to the network, uncached
  if (req.mode === 'navigate') {
    // fresh page when online; the cached shell when offline
    event.respondWith(fetch(req).catch(function () { return caches.match('/index.html'); }));
    return;
  }
  if (!ag.isCacheable(url.pathname)) return;
  // static files: network first so updates show at once, the cache when offline
  event.respondWith(fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(ag.CACHE).then(function (c) { c.put(url.pathname, copy); }); }
    return res;
  }).catch(function () { return caches.match(url.pathname); }));
});

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'AgentGuard';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body.slice(0, 160) : 'An agent is waiting for your decision.',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', renotify: true,
    data: { url: ag.safeReviewUrl(data.url) },
    actions: [{ action: 'review', title: 'Review' }]   // the only action: open the app
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = ag.safeReviewUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      if (new URL(wins[i].url).origin === self.location.origin) {
        wins[i].postMessage({ type: 'open', url: target });
        return wins[i].focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
