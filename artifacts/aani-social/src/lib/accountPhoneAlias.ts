/**
 * رقم الدخول بالهاتف (alias) من الواجهة: قراءة الرقم وإضافته أو تغييره أو
 * حذفه، وتسجيل الدخول بالرقم وكلمة المرور — بلا SMS وبلا OTP.
 *
 * القواعد الأمنية:
 * - كل الطلبات تمر من دوال Edge محميّة: `account-phone-alias` (تقرأ/تغيّر رقم
 *   الحساب نفسه من الجلسة) و`login-with-phone` (تتحقق من كلمة المرور عند
 *   Supabase Auth). لا قراءة ولا كتابة مباشرة لجدول الأرقام من هنا.
 * - لا يُرسل أي `user_id`: الخادم يأخذ الهوية من الجلسة. لا يقبل هذا الملف
 *   هوية حساب في أي دالة.
 * - لا تُخزَّن كلمة المرور ولا الرقم في التخزين المحلي ولا في أي حالة دائمة.
 * - نتيجة الدخول رمزان فقط (access/refresh) ولا بريد ولا كائن مستخدم.
 * - الأخطاء عامة: فشل الدخول لا يكشف إن كان الرقم مسجلاً أم لا.
 */
import { isE164Phone, normalizePhoneToE164 } from '@/lib/accountAuth';

export const ACCOUNT_PHONE_ALIAS_FUNCTION = 'account-phone-alias';
export const PHONE_LOGIN_FUNCTION = 'login-with-phone';

export const PHONE_ALIAS_INVALID_MESSAGE =
  'رقم الهاتف غير صالح. أدخله محلياً (07XX XXX XXXX) أو بصيغة دولية تبدأ بـ +.';
export const PHONE_ALIAS_TAKEN_MESSAGE = 'هذا الرقم مستخدم في حساب آخر. استخدم رقماً مختلفاً.';
export const PHONE_ALIAS_UNAVAILABLE_MESSAGE =
  'تعذر الوصول إلى رقم الدخول من الخادم. حاول بعد إعادة فتح التطبيق.';
export const PHONE_LOGIN_FAILED_MESSAGE = 'رقم الهاتف أو كلمة المرور غير صحيحة.';
export const PHONE_LOGIN_RATE_LIMITED_MESSAGE = 'تجاوزت عدد المحاولات. انتظر قليلاً ثم أعد المحاولة.';

/** نتيجة نداء دالة Edge: نجاح مع البيانات، أو فشل مع الحالة ورسالة عربية. */
export type PhoneInvokeResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; message: string };

/** العميل الوظيفي كما يوفره supabase-js (functions.invoke). */
export type FunctionsClientLike = {
  invoke: (
    name: string,
    options: { body: Record<string, unknown> },
  ) => Promise<{ data: unknown; error: unknown }>;
};

export type PhoneFunctionInvoker = (
  name: string,
  body: Record<string, unknown>,
) => Promise<PhoneInvokeResult>;

function readServerMessage(error: unknown): string {
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : '';
}

async function readErrorBody(context: Response): Promise<{ status: number; message: string }> {
  let message = '';
  try {
    const payload = await context.clone().json() as { error?: unknown };
    message = typeof payload?.error === 'string' ? payload.error : '';
  } catch {
    // جسم غير JSON: تبقى الرسالة العامة.
  }
  return { status: context.status, message };
}

/**
 * يحوّل `functions.invoke` إلى نداء يعيد نتيجة موحّدة: الحالة ورسالة الخادم
 * العربية إن وُجدت، ورسالة عامة عند انقطاع الشبكة.
 */
export function createPhoneFunctionInvoker(functions: FunctionsClientLike): PhoneFunctionInvoker {
  return async (name, body) => {
    try {
      const { data, error } = await functions.invoke(name, { body });
      if (!error) return { ok: true, data };

      const context = (error as { context?: unknown }).context;
      if (context instanceof Response) {
        const detail = await readErrorBody(context);
        if (detail.message) return { ok: false, status: detail.status, message: detail.message };
        return { ok: false, status: detail.status, message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
      }

      const serverMessage = readServerMessage(error);
      if (serverMessage) return { ok: false, status: 0, message: serverMessage };
      return { ok: false, status: 0, message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
    } catch {
      return { ok: false, status: 0, message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
    }
  };
}

export type PhoneAliasRead =
  | { status: 'absent' }
  | { status: 'present'; phone: string }
  | { status: 'unavailable'; message: string };

/** يقرأ نتيجة `account-phone-alias` لعملية read: رقم الحساب أو لا رقم. */
export function readPhoneAliasPayload(payload: unknown): PhoneAliasRead {
  if (!payload || typeof payload !== 'object') {
    return { status: 'unavailable', message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
  }
  const phone = (payload as { phone?: unknown }).phone;
  if (phone === null) return { status: 'absent' };
  if (typeof phone === 'string' && isE164Phone(phone)) return { status: 'present', phone };
  return { status: 'unavailable', message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
}

/** يقرأ رقم الدخول للحساب الحالي من الدالة المحمية. */
export async function loadPhoneAlias(invoke: PhoneFunctionInvoker): Promise<PhoneAliasRead> {
  const result = await invoke(ACCOUNT_PHONE_ALIAS_FUNCTION, { action: 'read' });
  if (!result.ok) return { status: 'unavailable', message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
  return readPhoneAliasPayload(result.data);
}

export type PhoneAliasSaveResult = { ok: true; phone: string } | { ok: false; message: string };

/**
 * يحفظ رقم الحساب أو يغيّره: تطبيع في الواجهة، ثم طلب واحد ذري إلى الدالة.
 * لا طلب جديد للحساب نفسه بالرقم المستخدم في حساب آخر، ويبقى الرقم السابق
 * عند الفشل لأن الخادم لا يكتب جزءاً من التغيير.
 */
export async function savePhoneAlias(
  phone: string,
  invoke: PhoneFunctionInvoker,
): Promise<PhoneAliasSaveResult> {
  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return { ok: false, message: PHONE_ALIAS_INVALID_MESSAGE };

  const result = await invoke(ACCOUNT_PHONE_ALIAS_FUNCTION, { action: 'set', phone: normalized });
  if (!result.ok) {
    if (result.status === 409) return { ok: false, message: PHONE_ALIAS_TAKEN_MESSAGE };
    if (result.status === 400) return { ok: false, message: PHONE_ALIAS_INVALID_MESSAGE };
    return { ok: false, message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
  }

  const saved = readPhoneAliasPayload(result.data);
  if (saved.status !== 'present') return { ok: false, message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
  return { ok: true, phone: saved.phone };
}

export type PhoneAliasDeleteResult = { ok: true } | { ok: false; message: string };

/** يحذف رقم الدخول للحساب الحالي فقط. */
export async function deletePhoneAlias(invoke: PhoneFunctionInvoker): Promise<PhoneAliasDeleteResult> {
  const result = await invoke(ACCOUNT_PHONE_ALIAS_FUNCTION, { action: 'delete' });
  if (!result.ok) return { ok: false, message: PHONE_ALIAS_UNAVAILABLE_MESSAGE };
  return { ok: true };
}

export type PhoneLoginResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; message: string; rateLimited?: boolean };

/**
 * تسجيل الدخول برقم الهاتف وكلمة المرور: الدالة `login-with-phone` تجد الحساب
 * برقمه وتتحقق من كلمة المرور عند Supabase Auth. لا OTP، ولا رسالة تكشف
 * وجود الرقم.
 *
 * `captchaToken` رمز CAPTCHA من الواجهة (Turnstile). الدالة ترفض أي محاولة
 * بلا رمز صالح، وتبقى الميزة محجوبة حتى تُفعّل حمايتها على الخادم.
 */
export async function loginWithPhone(
  phone: string,
  password: string,
  invoke: PhoneFunctionInvoker,
  captchaToken?: string,
): Promise<PhoneLoginResult> {
  const normalized = normalizePhoneToE164(phone);
  if (!normalized || !password) return { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE };

  const body: Record<string, unknown> = { phone: normalized, password };
  if (captchaToken) body.captchaToken = captchaToken;

  const result = await invoke(PHONE_LOGIN_FUNCTION, body);
  if (!result.ok) {
    if (result.status === 429) {
      return { ok: false, message: PHONE_LOGIN_RATE_LIMITED_MESSAGE, rateLimited: true };
    }
    // 400/503 رسائل حماية CAPTCHA من الخادم نفسه، لا رسائل بيانات دخول.
    if (result.status === 400 || result.status === 503) {
      return { ok: false, message: result.message || PHONE_LOGIN_FAILED_MESSAGE };
    }
    return { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE };
  }

  const payload = result.data as { access_token?: unknown; refresh_token?: unknown } | null;
  const accessToken = payload?.access_token;
  const refreshToken = payload?.refresh_token;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    return { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE };
  }
  // رمزان فقط: لا بريد ولا كائن مستخدم يعود إلى الواجهة.
  return { ok: true, accessToken, refreshToken };
}
