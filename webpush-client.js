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
 *       vapidPublicKey: "BBqmD8gy...",
 *       registerEndpoint: "https://<function-app>.azurewebsites.net/api/registerInstallation",
 *       swPath: "sw.js",
 *     });
 *
 *     // Kullanıcı giriş yaptıktan / bir aksiyon aldıktan sonra:
 *     WebPushApp.subscribe(userId);
 *   </script>
 *
 * ---------------------------------------------------------------------------
 * DEĞİŞİKLİK (2026-08-20): VAPID anahtarı döndüğünde otomatik yeniden abonelik.
 *
 * Sorun: Tarayıcıda zaten bir push aboneliği varsa ve o abonelik FARKLI bir
 * applicationServerKey (VAPID public key) ile oluşturulmuşsa, Web Push API yeni
 * aboneliği reddediyor:
 *
 *   "A subscription with a different applicationServerKey (or gcm_sender_id)
 *    already exists; to change the applicationServerKey, unsubscribe then resubscribe."
 *
 * Bu, VAPID anahtar çifti her değiştiğinde (anahtar rotasyonu, ortam değişikliği,
 * anahtarın kaybolup yeniden üretilmesi) TÜM kullanıcılarda yaşanır ve abonelik
 * sessizce başarısız olur. Artık mevcut abonelik kontrol ediliyor: anahtarı
 * farklıysa önce iptal edilip yenisi oluşturuluyor.
 * ---------------------------------------------------------------------------
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

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Mevcut aboneliğin, config'teki VAPID public key ile oluşturulup oluşturulmadığını
   * kontrol eder. Farklıysa (ya da anahtar okunamıyorsa) aboneliği iptal eder.
   * @returns {Promise<PushSubscription|null>} Kullanılabilir mevcut abonelik, yoksa null.
   */
  async function reuseOrDropExistingSubscription(registration, desiredKeyBytes) {
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return null;

    let sameKey = false;
    try {
      const existingKey = existing.options && existing.options.applicationServerKey;
      if (existingKey) {
        sameKey = bytesEqual(new Uint8Array(existingKey), desiredKeyBytes);
      }
    } catch (e) {
      // options okunamıyorsa güvenli tarafta kal: aboneliği yenile
      sameKey = false;
    }

    if (sameKey) {
      return existing;
    }

    // Anahtar değişmiş (ya da doğrulanamıyor) — eskisini iptal et ki yenisi açılabilsin.
    try {
      await existing.unsubscribe();
    } catch (e) {
      // İptal başarısız olsa bile subscribe'ı deneyeceğiz; hata oradan anlaşılır.
    }
    return null;
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

    const desiredKeyBytes = urlBase64ToUint8Array(config.vapidPublicKey);

    let subscription = await reuseOrDropExistingSubscription(registration, desiredKeyBytes);

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: desiredKeyBytes,
      });
    }

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

  /**
   * Mevcut push aboneliğini iptal eder. Anahtar rotasyonunda veya kullanıcı
   * bildirimleri kapatmak istediğinde kullanılabilir.
   * NOT: Notification Hub'daki installation kaydı bu çağrıyla SİLİNMEZ —
   * ölü kayıtlar push servisi 410 dönünce Hub tarafından temizlenir.
   */
  async function unsubscribe() {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return { supported: true, wasSubscribed: false };
    await existing.unsubscribe();
    return { supported: true, wasSubscribed: true, unsubscribed: true };
  }

  global.WebPushApp = { init, subscribe, unsubscribe };
})(window);
