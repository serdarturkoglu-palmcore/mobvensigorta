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
   * DÜZELTME (2026-08-20): installationId artık endpoint'in TAMAMININ hash'inden
   * üretiliyor, ilk 16 karakterinden değil.
   *
   * Önceki kod `btoa(endpoint).slice(0, 16)` kullanıyordu. Bütün FCM endpoint'leri
   * "https://fcm.googleapis.com/fcm/send/" ile başladığı için (asıl benzersiz kısım
   * sonda), base64'e çevrilince İLK 16 KARAKTER HERKESTE AYNI ÇIKIYORDU:
   *
   *   btoa("https://fcm.googleapis.com/fcm/send/AAA...").slice(0,16)
   *     === btoa("https://fcm.googleapis.com/fcm/send/BBB...").slice(0,16)
   *     === "aHR0cHM6Ly9mY20u"   (HER ZAMAN, endpoint ne olursa olsun)
   *
   * Sonuç: installationId = userId + "-" + (sabit, anlamsız 16 karakter).
   * Aynı kullanıcı farklı bir tarayıcıda/anahtar rotasyonu sonrası YENİ bir
   * endpoint ile abone olduğunda bile installationId DEĞİŞMİYORDU — Hub'daki
   * kayıt güncelleniyordu ama bu, farklı endpoint'ler arasında sessiz
   * üzerine-yazmalara (ve olası tutarsız/yarım güncellenmiş kayıtlara) açık
   * bir tasarımdı. Artık SHA-256 ile endpoint'in TAMAMI hash'leniyor.
   */
  async function endpointFingerprint(endpoint) {
    try {
      const data = new TextEncoder().encode(endpoint);
      const digest = await crypto.subtle.digest('SHA-256', data);
      const bytes = new Uint8Array(digest);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
    } catch (e) {
      // crypto.subtle yoksa (çok eski tarayıcı / http olmayan bağlam) son çare:
      // endpoint'in SONUNU kullan (asıl benzersiz kısım orada), baştan değil.
      return endpoint.slice(-24).replace(/[^a-zA-Z0-9]/g, '').slice(0, 22) || 'noid';
    }
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
    const installationId = `${userId}-${await endpointFingerprint(json.endpoint)}`;

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
