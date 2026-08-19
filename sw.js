// Web Push App — jenerik service worker.
// Her müşteri portalına AYNEN kopyalanır, müşteriye özel hiçbir bilgi içermez.
// Push mesajının içeriği (başlık/gövde/ikon) tamamen backend'den (Function App -> Notification Hub) gelir.

self.addEventListener('push', function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Bildirim', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Bildirim';
  const options = {
    body: data.body || '',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(targetUrl));
});
