/**
 * تسجيل أجهزة الدفع على العميل (device_tokens).
 *
 * التسجيل انتقل من عمود profiles.fcm_token (جهاز واحد) إلى جدول
 * public.device_tokens عبر دالة الخادم aani_register_device_token، مع
 * installation_id ثابت للتثبيت لتدوير الرمز وإلغاء الجهاز عند الخروج.
 *
 * كل ما هنا نقي وقابل للاختبار بلا متصفح: تُحقن التخزين والعشوائية.
 */

export type DevicePlatform = 'web' | 'android' | 'ios';
export type DeviceProvider = 'fcm' | 'apns' | 'pushkit';

export const DEVICE_INSTALLATION_STORAGE_KEY = 'aani_device_installation_id';

export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type RegistrationInput = {
  platform: DevicePlatform;
  provider: DeviceProvider;
  token: string;
  installationId: string | null;
  deviceName: string | null;
  metadata: Record<string, unknown>;
};

/** المنصة من User-Agent: Android أولاً (Chrome يحتوي "Linux")، ثم iOS، ثم الويب. */
export function detectDevicePlatform(userAgent: string): DevicePlatform {
  const value = typeof userAgent === 'string' ? userAgent.toLowerCase() : '';
  if (/android/.test(value)) return 'android';
  if (/iphone|ipad|ipod/.test(value)) return 'ios';
  return 'web';
}

/** اسم جهاز غير حساس يُعرض للمستخدم فقط (لا معرّفات). */
export function describeDevice(platform: DevicePlatform): string {
  if (platform === 'android') return 'Android';
  if (platform === 'ios') return 'iOS';
  return 'متصفح';
}

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function randomHex(bytes: number, random: () => number): string {
  let result = '';
  for (let index = 0; index < bytes; index += 1) {
    result += Math.floor(random() * 256).toString(16).padStart(2, '0');
  }
  return result;
}

/** يقرأ معرّف التثبيت المحفوظ فقط، بلا إنشاء جديد (للإلغاء عند الخروج). */
export function readInstallationId(storage: StorageLike | null): string | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(DEVICE_INSTALLATION_STORAGE_KEY);
    return typeof stored === 'string' && isUuid(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** معرّف تثبيت ثابت لهذا الجهاز، يُنشأ مرة واحدة ويُحفظ محلياً. */
export function readOrCreateInstallationId(
  storage: StorageLike | null,
  random: () => number = Math.random,
): string {
  if (storage) {
    try {
      const stored = storage.getItem(DEVICE_INSTALLATION_STORAGE_KEY);
      if (typeof stored === 'string' && isUuid(stored)) return stored;
    } catch {
      /* التخزين غير متاح */
    }
  }

  const generated = `${randomHex(4, random)}-${randomHex(2, random)}-4${randomHex(2, random).slice(1)}-a${randomHex(2, random).slice(1)}-${randomHex(6, random)}`;
  const installationId = isUuid(generated) ? generated : '00000000-0000-4000-a000-000000000000';

  if (storage) {
    try {
      storage.setItem(DEVICE_INSTALLATION_STORAGE_KEY, installationId);
    } catch {
      /* التخزين غير متاح */
    }
  }
  return installationId;
}

/** يتحقق من أن الرمز والمنصة صالحان قبل أي طلب. */
export function validateRegistrationInput(input: {
  token?: unknown;
  platform?: unknown;
  provider?: unknown;
}): { ok: boolean; error?: string } {
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token) return { ok: false, error: 'لم يُصدر Firebase رمزاً لهذا الجهاز.' };
  if (token.length > 4096) return { ok: false, error: 'رمز الجهاز غير صالح.' };
  const platform = typeof input.platform === 'string' ? input.platform : '';
  if (!['web', 'android', 'ios'].includes(platform)) return { ok: false, error: 'منصة الجهاز غير معروفة.' };
  const provider = typeof input.provider === 'string' ? input.provider : '';
  if (!['fcm', 'apns', 'pushkit'].includes(provider)) return { ok: false, error: 'مزوّد الإشعارات غير معروف.' };
  return { ok: true };
}

/** وسائط RPC aani_register_device_token بلا أي بيانات حساسة. */
export function buildRegistrationInput(input: {
  token: string;
  userAgent: string;
  installationId: string | null;
}): RegistrationInput {
  const platform = detectDevicePlatform(input.userAgent);
  return {
    platform,
    provider: 'fcm',
    token: input.token.trim(),
    installationId: input.installationId,
    deviceName: describeDevice(platform),
    metadata: { app: 'aani-social', surface: 'web' },
  };
}

/** وسائط إلغاء الجهاز عند تسجيل الخروج (marker فقط، لا حذف). */
export function buildRevocationInput(input: {
  installationId: string | null;
}): { p_installation_id: string | null; p_token: null; p_id: null } {
  return {
    p_installation_id: input.installationId,
    p_token: null,
    p_id: null,
  };
}
