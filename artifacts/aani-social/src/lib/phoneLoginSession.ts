/**
 * تثبيت جلسة الدخول بالهاتف والتحقق منها — مسار واحد قابل للاختبار.
 *
 * الترتيب لا يُخترق:
 * 1) لا طلب هاتف بلا رمز CAPTCHA صالح (لا يُرسل شيء إلى الدالة).
 * 2) الطلب إلى `login-with-phone` وحدها (عبر `loginWithPhone` المشتركة)، ولا
 *    `signInWithPassword` برقم الهاتف ولا `auth.users.phone`.
 * 3) `setSession` بالرمزين اللذين تعيدهما الدالة.
 * 4) `getUser` للتحقق من هوية المستخدم قبل الانتقال إلى الخلاصة.
 * 5) فشل التحقق بعد تثبيت الجلسة يلغي الجلسة المحلية بأمان.
 *
 * لا تُسجَّل كلمة المرور ولا الرموز ولا يُخزَّن شيء منها محلياً هنا.
 */
import {
  PHONE_LOGIN_FAILED_MESSAGE,
  type PhoneLoginResult,
} from '@/lib/accountPhoneAlias';

export const PHONE_LOGIN_CAPTCHA_REQUIRED_MESSAGE = 'أكمل تحقق الأمان (CAPTCHA) ثم أعد المحاولة.';
export const PHONE_LOGIN_SESSION_FAILED_MESSAGE = 'تعذر التحقق من الجلسة بعد الدخول. أعد المحاولة.';

export type PhoneLoginSessionTokens = {
  accessToken: string;
  refreshToken: string;
};

export type PhoneLoginSessionOutcome =
  | { ok: true; userId: string }
  | { ok: false; message: string };

export type PhoneLoginSessionDeps = {
  login: (phone: string, password: string, captchaToken: string) => Promise<PhoneLoginResult>;
  setSession: (tokens: PhoneLoginSessionTokens) => Promise<{ error: unknown }>;
  getUser: () => Promise<{ data: { user: { id?: string } | null }; error: unknown }>;
  signOutLocal: () => Promise<unknown>;
};

/**
 * يكمل الدخول بالهاتف بعد الدالة المشتركة: لا يبدأ إن غاب رمز CAPTCHA،
 * ولا يعتبر الدخول ناجحاً قبل التحقق من المستخدم، ويلغي الجلسة المحلية إن
 * فشل التحقق.
 */
export async function completePhoneLogin(
  phone: string,
  password: string,
  captchaToken: string,
  deps: PhoneLoginSessionDeps,
): Promise<PhoneLoginSessionOutcome> {
  if (!captchaToken) return { ok: false, message: PHONE_LOGIN_CAPTCHA_REQUIRED_MESSAGE };

  const result = await deps.login(phone, password, captchaToken);
  if (!result.ok) return { ok: false, message: result.message || PHONE_LOGIN_FAILED_MESSAGE };

  const { error: sessionError } = await deps.setSession({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
  if (sessionError) {
    // لا انتقال بلا جلسة مثبتة.
    return { ok: false, message: PHONE_LOGIN_SESSION_FAILED_MESSAGE };
  }

  const { data, error: userError } = await deps.getUser();
  const userId = data?.user?.id;
  if (userError || !userId) {
    // فشل التحقق بعد تثبيت الجلسة: إلغاء الجلسة المحلية.
    await deps.signOutLocal();
    return { ok: false, message: PHONE_LOGIN_SESSION_FAILED_MESSAGE };
  }

  return { ok: true, userId };
}
