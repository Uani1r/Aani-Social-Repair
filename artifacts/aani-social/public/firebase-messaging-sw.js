importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
const firebaseConfig = {
  apiKey: params.get('apiKey') || '',
  authDomain: params.get('authDomain') || '',
  projectId: params.get('projectId') || '',
  messagingSenderId: params.get('messagingSenderId') || '',
  appId: params.get('appId') || '',
};

if (firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.messagingSenderId && firebaseConfig.appId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage(payload => {
    const data = payload.data || {};
    const fallback = payload.notification || {};
    // العنوان والنص من data أولاً (يبنيها عامل الإرسال: data.title/body/url)،
    // ثم payload.notification كاحتياطي. بلا هذا يظهر إشعار بعنوان افتراضي ونص فارغ.
    const title = firstText(data.title, fallback.title) || 'إشعار جديد من آني';
    const body = firstText(data.body, fallback.body);
    const target = localTarget(firstText(data.url) || '/feed');

    // أيقونة الإشعار: شعار آني PNG الحقيقي (192×192) بدل مربع اللون البرتقالي
    // في favicon.svg الذي كان يظهر فارغاً في إشعارات Android.
    // ولا badge هنا: أيقونة شريط الحالة في Android تُرسم كظل أبيض لقناة
    // الشفافية، فتمرير صورة ملوّنة يُظهر مربعاً مصمتاً بدل الشعار.
    return self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      tag: typeof data.notification_id === 'string' ? `aani-${data.notification_id}` : undefined,
      data: {
        url: `${target.pathname}${target.search}${target.hash}`,
        notification_id: typeof data.notification_id === 'string' ? data.notification_id : '',
      },
    });
  });
}

/** أول نص غير فارغ (بعد trim) — data أولاً ثم notification. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function localTarget(path) {
  try {
    const target = new URL(path, self.location.origin);
    return target.origin === self.location.origin ? target : new URL('/feed', self.location.origin);
  } catch {
    return new URL('/feed', self.location.origin);
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = localTarget(typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/feed');
  const notificationId = typeof event.notification.data?.notification_id === 'string'
    ? event.notification.data.notification_id
    : '';
  if (notificationId) target.searchParams.set('pushNotificationId', notificationId);
  const targetUrl = target.href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      client.postMessage({ type: 'AANI_PUSH_CLICK', url: targetUrl });
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});
