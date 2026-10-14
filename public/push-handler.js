/* Web Push handlers, loaded into the generated service worker via workbox importScripts.
 * Payloads come from the expiry-push Edge Function: { title, body, tag, url, data }.
 * The tag makes a repeated alert for the same batch and threshold replace, not stack. */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'SpazaStock';
  const data = Object.assign({ url: payload.url || '/?tab=alerts' }, payload.data || {});
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      tag: payload.tag || undefined,
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      vibrate: [200, 100, 200, 100, 300],
      silent: false,
      requireInteraction: data.kind === 'expired',
      data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/?tab=alerts', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          client.postMessage({ type: 'open-alerts' });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
