const CACHE_NAME = '2-4-cloud-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      throw new Error('Offline resource unavailable');
    }
  })());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data.json();
    } catch {
      payload = { title: '2-4 cloud', body: event.data.text() };
    }
    const target = new URL(payload.url || '/calendar', self.location.origin);
    const url = target.origin === self.location.origin ? target.pathname + target.search + target.hash : '/calendar';
    await self.registration.showNotification(payload.title || '2-4 cloud', {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag || undefined,
      silent: true,
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || '/calendar', self.location.origin);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (current) {
      await current.navigate(url.href);
      await current.focus();
    } else {
      await self.clients.openWindow(url.href);
    }
  })());
});
