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
    const title = typeof data.title === 'string' && data.title ? data.title : 'إشعار جديد من آني';
    const body = typeof data.body === 'string' ? data.body : '';
    const target = localTarget(typeof data.url === 'string' ? data.url : '/feed');

    return self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: typeof data.notification_id === 'string' ? `aani-${data.notification_id}` : undefined,
      data: {
        url: `${target.pathname}${target.search}${target.hash}`,
        notification_id: typeof data.notification_id === 'string' ? data.notification_id : '',
      },
    });
  });
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
