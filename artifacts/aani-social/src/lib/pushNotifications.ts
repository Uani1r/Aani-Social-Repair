import { supabase } from '@/lib/supabase';

const readEnv = (): Record<string, string | undefined> => {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return env && typeof env === 'object' ? env : {};
  } catch {
    return {};
  }
};

const env = readEnv();
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY?.trim() || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || '',
  projectId: env.VITE_FIREBASE_PROJECT_ID?.trim() || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
  appId: env.VITE_FIREBASE_APP_ID?.trim() || '',
};
const vapidKey = env.VITE_FIREBASE_VAPID_KEY?.trim() || '';

export const isFirebaseMessagingConfigured = () => Boolean(
  firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.messagingSenderId
  && firebaseConfig.appId
  && vapidKey,
);

type FirebaseAppSdk = {
  getApps: () => Array<{ name: string }>;
  getApp: () => unknown;
  initializeApp: (options: Record<string, string>) => unknown;
};

type FirebaseMessagingSdk = {
  isSupported: () => Promise<boolean>;
  getMessaging: (app: unknown) => unknown;
  getToken: (messaging: unknown, options: { vapidKey: string; serviceWorkerRegistration: ServiceWorkerRegistration }) => Promise<string>;
};

export type PushRegistrationResult = {
  ok: boolean;
  message: string;
};

export async function registerPushNotifications(
  userId: string,
  requestPermission: boolean,
): Promise<PushRegistrationResult> {
  if (!userId) return { ok: false, message: 'سجّل الدخول أولاً لتفعيل الإشعارات.' };
  if (!isFirebaseMessagingConfigured()) {
    return { ok: false, message: 'إعداد Firebase ناقص. أضف إعدادات تطبيق الويب ومفتاح VAPID إلى متغيرات VITE_FIREBASE_* ثم أعد نشر التطبيق.' };
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return { ok: false, message: 'هذا المتصفح لا يدعم إشعارات الويب على هذا الجهاز.' };
  }
  if (!window.isSecureContext) {
    return { ok: false, message: 'تتطلب الإشعارات فتح التطبيق عبر HTTPS.' };
  }

  let permission = Notification.permission;
  if (permission === 'default' && requestPermission) {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    return {
      ok: false,
      message: permission === 'denied'
        ? 'الإشعارات محظورة من إعدادات المتصفح. اسمح بها ثم حاول مجدداً.'
        : 'اسمح بالإشعارات من نافذة المتصفح لإكمال التفعيل.',
    };
  }

  try {
    const serviceWorkerUrl = new URL('/firebase-messaging-sw.js', window.location.origin);
    Object.entries(firebaseConfig).forEach(([key, value]) => serviceWorkerUrl.searchParams.set(key, value));
    await navigator.serviceWorker.register(serviceWorkerUrl.href, { scope: '/' });
    const serviceWorkerRegistration = await navigator.serviceWorker.ready;
    const [appSdk, messagingSdk] = await Promise.all([
      import(/* @vite-ignore */ 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js') as Promise<FirebaseAppSdk>,
      import(/* @vite-ignore */ 'https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js') as Promise<FirebaseMessagingSdk>,
    ]);
    if (!(await messagingSdk.isSupported())) {
      return { ok: false, message: 'خدمة Firebase Messaging غير مدعومة في هذا المتصفح.' };
    }

    const app = appSdk.getApps().some(firebaseApp => firebaseApp.name === '[DEFAULT]')
      ? appSdk.getApp()
      : appSdk.initializeApp(firebaseConfig);
    const messaging = messagingSdk.getMessaging(app);
    const token = await messagingSdk.getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration,
    });
    if (!token) return { ok: false, message: 'لم يُصدر Firebase رمزاً لهذا الجهاز. حاول مرة أخرى.' };

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || authData.user?.id !== userId) {
      return { ok: false, message: 'تعذر التحقق من الحساب النشط. أعد تسجيل الدخول ثم حاول مجدداً.' };
    }

    const { error } = await supabase
      .from('profiles')
      .update({ fcm_token: token })
      .eq('id', userId);
    if (error) {
      console.error('[push] تعذر حفظ رمز FCM:', error);
      return { ok: false, message: 'تعذر حفظ رمز الإشعارات. تأكد من تطبيق ترحيل قاعدة البيانات ثم حاول مجدداً.' };
    }

    return { ok: true, message: 'إشعارات هذا الجهاز مفعّلة.' };
  } catch (error) {
    console.error('[push] تعذر تفعيل إشعارات Firebase:', error);
    return { ok: false, message: 'تعذر تفعيل الإشعارات الآن. تحقق من إعداد Firebase والاتصال ثم حاول مجدداً.' };
  }
}
