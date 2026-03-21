// Service worker for Control Center PWA.
// No caching — app always needs a live server connection.
// Handles Web Push notifications.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// Show notification when a push message arrives
self.addEventListener('push', e => {
  let data = { title: 'Control Center', body: '', tag: 'cc', url: '/' };
  try { data = { ...data, ...e.data.json() }; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag: data.tag,
      renotify: true,
      data: { url: data.url },
    })
  );
});

// Focus or open the app when notification is clicked
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow('/');
    })
  );
});
