/**
 * أدوات إعدادات الحساب: تطبيع رقم الهاتف إلى E.164، وقراءة مزوّد الدخول
 * وكلمة المرور المحلية من كائن مستخدم Supabase، ورسائل أخطاء عربية آمنة.
 *
 * قواعد أمنية تُحفظ هنا لأن كل تدفقات الحساب تمر من هذه الدوال:
 * - لا تُخزَّن كلمة مرور ولا رمز OTP في هذه الوحدة ولا في أي جدول، ولا
 *   تُطبع قيمها في السجلات؛ تُمرَّر إلى Supabase Auth مباشرة.
 * - لا يوجد أي مفتاح service_role هنا: العميل يستخدم المفتاح العام فقط.
 * - رقم الهاتف لا يُعرض مؤكداً إلا إذا أعاد Supabase تأكيده (phone_confirmed_at
 *   أو نجاح verifyOtp ثم getUser).
 */
import type { User } from '@supabase/supabase-js';

/** الرمز الافتراضي للعراق؛ تُقبل أيضاً الصيغة الدولية الكاملة (+...). */
export const DEFAULT_PHONE_COUNTRY_CODE = '+964';

/** أقل طول لكلمة المرور في الواجهة (سياسة Supabase تبقى المرجع النهائي). */
export const MIN_PASSWORD_LENGTH = 8;

/** هل الرقم بصيغة E.164 صالحة. */
export function isE164Phone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test((value || '').trim());
}

/**
 * يطبّع الرقم إلى E.164: يقبل `+964 770 123 4567`، `00964...`،
 * `07701234567` أو `7701234567` — ويضيف رمز العراق الافتراضي عند غياب رمز
 * الدولة. يُعيد null إذا لم يكن الرقم صالحاً.
 */
export function normalizePhoneToE164(raw: string): string | null {
  const cleaned = (raw || '').trim().replace(/[\s().\-–]/g, '');
  if (!cleaned) return null;
  if (!/^(?:00|\+)?\d+$/.test(cleaned)) return null;

  const countryDigits = DEFAULT_PHONE_COUNTRY_CODE.slice(1);
  const hasInternationalPrefix = cleaned.startsWith('+') || cleaned.startsWith('00');
  let digits = cleaned.replace(/^\+/, '').replace(/^00/, '');

  if (hasInternationalPrefix) {
    // صيغة دولية كاملة: تُقبل كما هي، مع تنظيف صفر وطني زائد بعد رمز العراق.
    if (digits.startsWith(countryDigits)) {
      const national = digits.slice(countryDigits.length).replace(/^0+/, '');
      digits = `${countryDigits}${national}`;
    }
  } else {
    // رقم محلي: يُزال الصفر الوطني ثم يُضاف رمز العراق.
    digits = `${countryDigits}${digits.replace(/^0+/, '')}`;
  }

  const e164 = `+${digits}`;
  return isE164Phone(e164) ? e164 : null;
}

/** عرض مقروء للرقم: `+964 770 123 4567` (أو الرقم كما هو لغير العراق). */
export function formatPhoneForDisplay(phone: string): string {
  const value = (phone || '').trim();
  if (!isE164Phone(value)) return value;
  const digits = value.slice(1);
  const countryDigits = DEFAULT_PHONE_COUNTRY_CODE.slice(1);
  if (!digits.startsWith(countryDigits)) return value;
  const national = digits.slice(countryDigits.length);
  const groups = national.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
  return `${DEFAULT_PHONE_COUNTRY_CODE} ${groups}`.trim();
}

export type AccountAuthIdentity = {
  email: string;
  phone: string;
  /** تأكيد Supabase لرقم الهاتف — لا يُشتق من وجود الرقم وحده. */
  phoneConfirmed: boolean;
  providers: string[];
  primaryProvider: string;
  /** هل يمكن لهذا الحساب أن يملك كلمة مرور محلية (بريد أو هاتف بكلمة مرور). */
  hasPassword: boolean;
};

/**
 * يقرأ هوية الحساب من Supabase: البريد والهاتف وتأكيد الهاتف والمزوّدات.
 * لا شيء هنا يُستنتج من الواجهة وحدها، وكل القيم من `auth.getUser()`.
 */
export function readAccountAuthIdentity(user: User | null | undefined): AccountAuthIdentity {
  const providers = Array.isArray(user?.app_metadata?.providers)
    ? (user.app_metadata.providers as unknown[]).filter((provider): provider is string => typeof provider === 'string')
    : [];
  const identities = Array.isArray(user?.identities) ? user.identities : [];
  const identityProviders = identities
    .map(identity => identity?.provider)
    .filter((provider): provider is string => typeof provider === 'string');
  const primaryProvider = user?.app_metadata?.provider;
  const linkedProvider = identityProviders.find(provider => provider === 'google' || provider === 'apple');
  const allProviders = Array.from(new Set([...providers, ...identityProviders]));
  return {
    email: user?.email || '',
    phone: user?.phone || '',
    phoneConfirmed: Boolean(user?.phone_confirmed_at),
    providers: allProviders,
    primaryProvider: typeof primaryProvider === 'string' ? primaryProvider : linkedProvider || allProviders[0] || 'email',
    hasPassword: allProviders.includes('email') || allProviders.includes('phone'),
  };
}

/** تسمية المزوّد للشارة: لا شارة للبريد حتى لا يتكرر عنوان الحقل. */
export function providerBadgeLabel(provider: string): string {
  if (provider === 'google') return 'Google';
  if (provider === 'apple') return 'Apple';
  if (provider === 'phone') return 'الهاتف';
  return '';
}

/**
 * رسالة خطأ عربية آمنة لأخطاء Supabase Auth في إعدادات الحساب.
 * لا تُدرج رمز OTP أو كلمة المرور في أي رسالة أو سجل.
 */
export function accountAuthErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message || '');
  const code = String((error as { code?: unknown })?.code || '');
  const combined = `${code} ${message}`;
  if (/otp_expired|token has expired|expired|invalid.*otp|otp.*invalid|invalid.*token/i.test(combined)) {
    return 'انتهت صلاحية الرمز أو أنه غير صحيح. أعد إرسال رمز جديد ثم أدخله.';
  }
  if (/over_sms_send_rate_limit|over_email_send_rate_limit|rate limit|too many requests|for security purposes/i.test(combined)) {
    return 'تجاوزت عدد المحاولات المسموح. انتظر قليلاً ثم أعد المحاولة.';
  }
  if (/phone_exists|already.*(registered|in use)|duplicate/i.test(message)) {
    return 'هذا الرقم مرتبط بحساب آخر. استخدم رقماً مختلفاً.';
  }
  if (/invalid.*(login|credentials)|wrong.*password|incorrect.*password/i.test(message)) {
    return 'كلمة المرور الحالية غير صحيحة.';
  }
  if (/same.*password|should be different/i.test(message)) {
    return 'اختر كلمة مرور مختلفة عن كلمة المرور السابقة.';
  }
  if (/weak.*password|password should be at least|password is too short/i.test(message)) {
    return `كلمة المرور ضعيفة. استخدم ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`;
  }
  if (/sms|phone provider|not enabled|phone signups?/i.test(message)) {
    return 'إرسال رمز SMS غير متمكّن في مشروع Supabase. فعّل مزوّد الرسائل في لوحة Supabase أولاً.';
  }
  return fallback;
}
