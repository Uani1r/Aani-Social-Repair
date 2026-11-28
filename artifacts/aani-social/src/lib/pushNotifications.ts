import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { DeviceSignOutDeps } from '@/lib/pushSignOut';
import {
  buildRegistrationInput,
  buildRevocationInput,
  readInstallationId,
  readOrCreateInstallationId,
  validateRegistrationInput,
  type StorageLike,
} from '@/lib/deviceTokens';

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

/** مشروع Firebase القديم ممنوع: المشروع المعتمد هو Ani Social. */
const FORBIDDEN_FIREBASE_PROJECT = 'ani1-20bed';

export const isFirebaseMessagingConfigured = () => Boolean(
  firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.messagingSenderId
  && firebaseConfig.appId
  && vapidKey
  && firebaseConfig.projectId !== FORBIDDEN_FIREBASE_PROJECT,
);

/**
 * رسائل بيئة الإشعارات: مصدر واحد للواجهة وللتسجيل.
 * على iPhone وiPad لا تعمل إشعارات الويب قبل إضافة التطبيق إلى الشاشة
 * الرئيسية، ولا يجوز طلب إذن المتصفح في متصفح عادي.
 */
export const PUSH_MESSAGES = {
  ready: 'إشعارات هذا الجهاز مفعّلة.',
  needsPermission: 'اسمح بالإشعارات من نافذة المتصفح لإكمال التفعيل.',
  denied: 'الإشعارات محظورة من إعدادات المتصفح. اسمح بها ثم حاول مجدداً.',
  iosInstall:
    'على iPhone وiPad لا تصل إشعارات الويب قبل تثبيت التطبيق: افتح آني في Safari، اضغط زر المشاركة، اختر «إضافة إلى الشاشة الرئيسية»، ثم افتح آني من الشاشة الرئيسية وفعّل الإشعارات من هنا.',
  iosInstalledHint:
    'التطبيق مفتوح من الشاشة الرئيسية — يمكنك الآن تفعيل الإشعارات على هذا الجهاز.',
  unsupported: 'هذا المتصفح لا يدعم إشعارات الويب على هذا الجهاز.',
  insecure: 'تتطلب الإشعارات فتح التطبيق عبر HTTPS.',
  saveFailed: 'تعذر حفظ رمز الإشعارات. تأكد من تطبيق ترحيل قاعدة البيانات ثم حاول مجدداً.',
  saveUnverified: 'لم يتأكد حفظ رمز الإشعارات على الخادم. أعد المحاولة.',
} as const;

/** هل المتصفح على iPhone/iPad؟ كل المتصفحات هناك تعمل على WebKit. */
export function isIosBrowser(userAgent: string): boolean {
  const value = typeof userAgent === 'string' ? userAgent.toLowerCase() : '';
  if (!value) return false;
  return /iphone|ipad|ipod/.test(value);
}

/**
 * هل التطبيق مفتوح بوضع standalone بعد التثبيت؟
 * `navigator.standalone` في iOS، و`display-mode: standalone` في بقية المتصفحات.
 */
export function isStandaloneDisplay(input: {
  navigatorStandalone?: unknown;
  displayModeStandalone?: unknown;
}): boolean {
  return input.navigatorStandalone === true || input.displayModeStandalone === true;
}

export type PushEnvironmentStatus =
  | 'ready'
  | 'needs-permission'
  | 'denied'
  | 'ios-install-required'
  | 'unsupported'
  | 'insecure';

export type PushEnvironment = {
  status: PushEnvironmentStatus;
  message: string;
  /** هل يجوز طلب إذن المتصفح الآن؟ لا قبل التثبيت على iOS. */
  canRequestPermission: boolean;
};

/**
 * بيئة الإشعارات كقرار واحد قابل للاختبار:
 *   1. بلا HTTPS → غير ممكن.
 *   2. بلا Notification أو Service Worker → غير مدعوم.
 *   3. iOS بلا تثبيت → شرح الإضافة إلى الشاشة الرئيسية، وبلا طلب إذن.
 *   4. الإذن محظور → رسالة المحظور.
 *   5. الإذن ممنوح → التفعيل متاح.
 *   6. غير محسوم → طلب الإذن بتفاعل المستخدم.
 */
export function evaluatePushEnvironment(input: {
  isIos: boolean;
  standalone: boolean;
  hasNotificationApi: boolean;
  hasServiceWorker: boolean;
  secureContext: boolean;
  permission: 'default' | 'granted' | 'denied' | 'unsupported';
}): PushEnvironment {
  if (!input.secureContext) {
    return { status: 'insecure', message: PUSH_MESSAGES.insecure, canRequestPermission: false };
  }
  if (!input.hasNotificationApi || !input.hasServiceWorker) {
    return { status: 'unsupported', message: PUSH_MESSAGES.unsupported, canRequestPermission: false };
  }
  // الترتيب مقصود: التثبيت يُفحص قبل الإذن، فلا يُطلب إذن في متصفح عادي على iOS.
  if (input.isIos && !input.standalone) {
    return { status: 'ios-install-required', message: PUSH_MESSAGES.iosInstall, canRequestPermission: false };
  }
  if (input.permission === 'denied') {
    return { status: 'denied', message: PUSH_MESSAGES.denied, canRequestPermission: false };
  }
  if (input.permission === 'granted') {
    return { status: 'ready', message: PUSH_MESSAGES.ready, canRequestPermission: false };
  }
  if (input.permission === 'default') {
    return { status: 'needs-permission', message: PUSH_MESSAGES.needsPermission, canRequestPermission: true };
  }
  return { status: 'unsupported', message: PUSH_MESSAGES.unsupported, canRequestPermission: false };
}

/**
 * بيئة هذا المتصفح فعلياً. iPadOS يعرّف نفسه Macintosh، فيُعامل iOS عند
 * وجود نقاط لمس (maxTouchPoints > 1) — وهذا يمنع طلب إذن في متصفح iPad عادي.
 */
export function readPushEnvironment(): PushEnvironment {
  const userAgent = typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
    ? navigator.userAgent
    : '';
  const maxTouchPoints = typeof navigator !== 'undefined' && typeof navigator.maxTouchPoints === 'number'
    ? navigator.maxTouchPoints
    : 0;
  const isIos = isIosBrowser(userAgent) || (/macintosh/i.test(userAgent) && maxTouchPoints > 1);
  const standalone = isStandaloneDisplay({
    navigatorStandalone: typeof navigator !== 'undefined'
      ? (navigator as Navigator & { standalone?: unknown }).standalone
      : false,
    displayModeStandalone: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false,
  });
  const hasNotificationApi = typeof window !== 'undefined' && 'Notification' in window;
  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const secureContext = typeof window !== 'undefined' && window.isSecureContext === true;
  const permission: 'default' | 'granted' | 'denied' | 'unsupported' =
    hasNotificationApi ? Notification.permission : 'unsupported';

  return evaluatePushEnvironment({
    isIos,
    standalone,
    hasNotificationApi,
    hasServiceWorker,
    secureContext,
    permission,
  });
}

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

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

async function readSessionUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

/**
 * تسجيل هذا الجهاز في public.device_tokens (متعدد الأجهزة).
 *
 * لا يكتب profiles.fcm_token: هذا هو المسار القديم لجهاز واحد، والمسار الجديد
 * هو جدول الأجهزة عبر aani_register_device_token. يُلغي التسجيل السابق للرمز
 * نفسه أو للتثبيت نفسه (بما فيه حساب سابق على الجهاز نفسه) داخل القاعدة.
 */
export async function registerPushNotifications(
  userId: string,
  requestPermission: boolean,
): Promise<PushRegistrationResult> {
  if (!userId) return { ok: false, message: 'سجّل الدخول أولاً لتفعيل الإشعارات.' };
  if (!supabaseConfigured) return { ok: false, message: 'قاعدة البيانات غير مهيأة.' };
  // التحقق من الجلسة وهوية المستخدم قبل أي تسجيل.
  const sessionUserId = await readSessionUserId();
  if (!sessionUserId) return { ok: false, message: 'تعذر التحقق من الحساب النشط. أعد تسجيل الدخول ثم حاول مجدداً.' };
  if (sessionUserId !== userId) return { ok: false, message: 'الحساب النشط لا يطابق هذا الجهاز. أعد تسجيل الدخول.' };

  if (!isFirebaseMessagingConfigured()) {
    return { ok: false, message: 'إعداد Firebase ناقص. أضف إعدادات تطبيق الويب ومفتاح VAPID إلى متغيرات VITE_FIREBASE_* ثم أعد نشر التطبيق.' };
  }
  // بيئة الإشعارات أولاً: على iPhone/iPad بلا تثبيت لا يُطلب إذن أبداً.
  const environment = readPushEnvironment();
  if (environment.status === 'ios-install-required') return { ok: false, message: environment.message };
  if (environment.status === 'unsupported') return { ok: false, message: environment.message };
  if (environment.status === 'insecure') return { ok: false, message: environment.message };
  if (environment.status === 'denied') return { ok: false, message: environment.message };

  // إذن المتصفح يُطلب فقط بتفاعل المستخدم، وبعد اجتياز بوابة التثبيت.
  let permission = Notification.permission;
  if (permission === 'default' && requestPermission) {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    return {
      ok: false,
      message: permission === 'denied' ? PUSH_MESSAGES.denied : PUSH_MESSAGES.needsPermission,
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

    const validation = validateRegistrationInput({ token, platform: 'web', provider: 'fcm' });
    if (!validation.ok) return { ok: false, message: validation.error || 'لم يُصدر Firebase رمزاً لهذا الجهاز.' };

    const installationId = readOrCreateInstallationId(browserStorage());
    const registration = buildRegistrationInput({
      token,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      installationId,
    });

    // لا نجاح قبل دليل حفظ: الدالة تُعيد صف الجهاز المسجّل نفسه.
    const { data: registeredRow, error } = await supabase.rpc('aani_register_device_token', {
      p_platform: registration.platform,
      p_token: registration.token,
      p_provider: registration.provider,
      p_installation_id: registration.installationId,
      p_device_name: registration.deviceName,
      p_metadata: registration.metadata,
    });
    if (error) {
      console.error('[push] تعذر حفظ رمز الجهاز في device_tokens:', error.code || error.message);
      return { ok: false, message: PUSH_MESSAGES.saveFailed };
    }

    const registered = Array.isArray(registeredRow) ? registeredRow[0] : registeredRow;
    const registeredId = registered && typeof (registered as { id?: unknown }).id === 'string'
      ? String((registered as { id: unknown }).id)
      : '';
    if (!registeredId) {
      console.error('[push] لم يُعِد الخادم صف جهاز مسجّل — لا يُعلن نجاح.');
      return { ok: false, message: PUSH_MESSAGES.saveUnverified };
    }

    return { ok: true, message: PUSH_MESSAGES.ready };
  } catch (error) {
    console.error('[push] تعذر تفعيل إشعارات Firebase:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, message: 'تعذر تفعيل الإشعارات الآن. تحقق من إعداد Firebase والاتصال ثم حاول مجدداً.' };
  }
}

/**
 * إلغاء تسجيل هذا الجهاز عند تسجيل الخروج: علامة revoked_at فقط (لا حذف)،
 * عبر aani_revoke_device_token وبمعرّف التثبيت. لا يمسّ أجهزة حساب آخر.
 */
export async function unregisterPushNotifications(userId: string): Promise<PushRegistrationResult> {
  if (!userId) return { ok: false, message: 'لا حساب نشط.' };
  if (!supabaseConfigured) return { ok: false, message: 'قاعدة البيانات غير مهيأة.' };

  const sessionUserId = await readSessionUserId();
  if (!sessionUserId || sessionUserId !== userId) {
    return { ok: false, message: 'تعذر التحقق من الحساب النشط قبل إلغاء تسجيل الجهاز.' };
  }

  const installationId = readInstallationId(browserStorage());
  if (!installationId) return { ok: true, message: 'لا جهاز مسجّل محلياً.' };

  try {
    const { error } = await supabase.rpc('aani_revoke_device_token', buildRevocationInput({ installationId }));
    if (error) {
      console.error('[push] تعذر إلغاء تسجيل الجهاز:', error.code || error.message);
      return { ok: false, message: 'تعذر إلغاء تسجيل هذا الجهاز الآن.' };
    }
    return { ok: true, message: 'تم إلغاء تسجيل هذا الجهاز.' };
  } catch (error) {
    console.error('[push] تعذر إلغاء تسجيل الجهاز:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, message: 'تعذر إلغاء تسجيل هذا الجهاز الآن.' };
  }
}


/** معرّف تثبيت هذا المتصفح المحفوظ — بلا إنشاء جديد. مفتاح إلغاء رمز الجهاز. */
export function currentDeviceInstallationId(): string | null {
  return readInstallationId(browserStorage());
}

/**
 * إلغاء رمز جهاز هذا المتصفح على الخادم بمعرّف التثبيت وحده.
 * `aani_revoke_device_token` تضبط `revoked_at` ولا تحذف الصف، ولا تمسّ جهازاً آخر.
 * أي خطأ يُعاد كما هو ولا يُترجم إلى «لا شيء يُلغى»: رمز خطأ «الدالة غير ظاهرة
 * في schema cache» لا يثبت أن الدالة أو جدول الأجهزة غير موجود، فقد تكون
 * الدالة موجودة في القاعدة وغير محمّلة في الـcache — والخطأ الملتبس ليس دليلاً.
 */
export async function revokeDeviceTokenForSignOut(installationId: string): Promise<{ error: unknown }> {
  const { error } = await supabase.rpc('aani_revoke_device_token', buildRevocationInput({ installationId }));
  return { error };
}

/**
 * قوالب تسجيل الخروج لهذا الجهاز: الجلسة الحالية، معرّف هذا التثبيت، الإلغاء
 * على الخادم، ثم إنهاء الجلسة الذي يمرّره المستدعي (محلي أو عام).
 */
export function deviceSignOutDeps(endSession: () => Promise<{ error: unknown }>): DeviceSignOutDeps {
  return {
    readUserId: async () => {
      const { data, error } = await supabase.auth.getUser();
      // فشل getUser ليس «لا مستخدم»: يُرمى ليُعامل كفشل تحقق، فلا يُلغى رمز
      // ولا تُنهى الجلسة على حالة غير معروفة. null تبقى لنجاح القراءة وحدها.
      if (error) throw error;
      return data.user?.id ?? null;
    },
    readInstallationId: currentDeviceInstallationId,
    revokeDeviceToken: revokeDeviceTokenForSignOut,
    endSession,
  };
}
