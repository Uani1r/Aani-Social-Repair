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
    const notificationId = firstText(data.notification_id);

    // وسم ثابت لكل حدث: إعادة استلام الحدث نفسه تستبدل الإشعار بدل تكديس
    // نسخة ثانية، ووسم بديل عندما لا يحمل الحدث معرّفاً.
    const tag = notificationId
      ? `aani-${notificationId}`
      : `aani-${firstText(data.type, data.event_type) || 'event'}:${firstText(data.reference_id, data.message_id, data.call_id) || 'general'}`;

    // نفس الحدث مرتين في عمر عامل الخدمة → إشعار واحد فقط.
    if (!takeOnce(tag)) return undefined;

    return self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag,
      renotify: false,
      data: {
        url: `${target.pathname}${target.search}${target.hash}`,
        notification_id: notificationId,
      },
    });
  });
}

/**
 * منع الإشعار المكرر داخل عمر عامل الخدمة: بصمة قصيرة العمر (دقيقة) بعدد
 * محدود. لا تعتمد على الذاكرة وحدها لسياسة الإشعارات، لكنها تمنع نسختين
 * متتاليتين لنفس الحدث إذا أعاد المتصفح تسليم الدفعة.
 */
const recentlyShown = new Map();
const RECENT_LIMIT = 20;
const RECENT_TTL_MS = 60_000;

function takeOnce(key) {
  const now = Date.now();
  for (const [storedKey, shownAt] of recentlyShown) {
    if (now - shownAt > RECENT_TTL_MS) recentlyShown.delete(storedKey);
  }
  if (recentlyShown.has(key)) return false;
  recentlyShown.set(key, now);
  while (recentlyShown.size > RECENT_LIMIT) {
    const oldest = recentlyShown.keys().next().value;
    recentlyShown.delete(oldest);
  }
  return true;
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
