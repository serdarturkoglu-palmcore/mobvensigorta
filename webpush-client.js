/**
 * Web Push App — jenerik istemci kütüphanesi.
 * Her müşteri portalına dahil edilir; müşteriye özel bilgi (VAPID public key, backend URL,
 * userId) config objesiyle dışarıdan verilir — kod içinde hardcode YOK.
 *
 * Kullanım (örnek, portal tarafında):
 *
 *   <script src="webpush-client.js"></script>
 *   <script>
 *     WebPushApp.init({
 *       vapidPublicKey: "BJVia88h...",
 *       registerEndpoint: "https://<function-app>.azurewebsites.net/api/registerInstallation?code=...",
 *       swPath: "sw.js",
 *     });
 *
 *     // Kullanıcı giriş yaptıktan / bir aksiyon aldıktan sonra:
 *     WebPushApp.subscribe(userId);
 *   </script>
 */
(function (global) {
  let config = null;

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function init(userConfig) {
    if (!userConfig || !userConfig.vapidPublicKey || !userConfig.registerEndpoint) {
      throw new Error('WebPushApp.init: vapidPublicKey ve registerEndpoint zorunlu.');
    }
    config = Object.assign({ swPath: 'sw.js' }, userConfig);
  }

  async function subscribe(userId) {
    if (!config) throw new Error('Önce WebPushApp.init(...) çağrılmalı.');
    if (!userId) throw new Error('subscribe(userId): userId zorunlu (Dataverse Contact ile eşleşecek kimlik).');

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { supported: false };
    }

    const registration = await navigator.serviceWorker.register(config.swPath);
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { supported: true, permission };
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });

    const json = subscription.toJSON();
    const installationId = `${userId}-${btoa(json.endpoint).slice(0, 16)}`;

    const response = await fetch(config.registerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId,
        userId,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      }),
    });

    if (!response.ok) {
      throw new Error('Backend kaydı başarısız: ' + response.status);
    }

    return { supported: true, permission, registered: true };
  }

  global.WebPushApp = { init, subscribe };
})(window);
