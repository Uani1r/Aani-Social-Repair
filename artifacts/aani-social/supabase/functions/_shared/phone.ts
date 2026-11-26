// أدوات مشتركة لدالتي رقم الدخول بالهاتف.
//
// تُستخدم في الدالتين (`account-phone-alias`, `login-with-phone`) وفي اختبارات
// Deno وحدها: لا منطق قاعدة بيانات هنا ولا أسرار، بل تطبيع الرقم وبوابات
// آمنة ورسائل موحّدة وتسجيل بلا قيم.
//
// قواعد لا تُخترق:
// - لا تُطبع قيمة رقم ولا كلمة مرور ولا رمز جلسة ولا بريد: `logFailure` تمر
//   عبر `redactForLog` التي لا تُرجع إلا نوع الخطأ أو رمز الحالة.
// - الجلسة المُعادة رمزان فقط: `sessionTokens` تُسقط `user` والبريد.
// - لا جلسة ولا رمز عند الفشل: `failureBody` تحمل `error` فقط.

export const DEFAULT_PHONE_COUNTRY_CODE = "+964";
export const PHONE_E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
export const IRAQI_LOCAL_MOBILE_PATTERN = /^07\d{9}$/;

export const PHONE_MESSAGES = {
  invalidCredentials: "رقم الهاتف أو كلمة المرور غير صحيحة.",
  invalidPhone:
    "رقم الهاتف غير صالح. أدخله محلياً (07XX XXX XXXX) أو بصيغة دولية تبدأ بـ +.",
  phoneTaken: "هذا الرقم مستخدم في حساب آخر. استخدم رقماً مختلفاً.",
  unauthorized: "يجب تسجيل الدخول لإدارة رقم الهاتف.",
  rateLimited: "تجاوزت عدد المحاولات. انتظر قليلاً ثم أعد المحاولة.",
  captchaRequired: "تحقق الأمان مطلوب لإكمال الدخول. أعد المحاولة بعد تحديث الصفحة.",
  captchaUnavailable: "الدخول بالهاتف غير متاح حالياً: حماية CAPTCHA لم تُفعّل بعد.",
  unavailable: "تعذر الوصول إلى الخدمة حالياً. حاول بعد قليل.",
} as const;

/** تطبيع الرقم إلى E.164: محلي عراقي، أو دولي بـ+ أو 00. */
export function normalizePhoneToE164(raw: string): string | null {
  const cleaned = String(raw ?? "").trim().replace(/[\s().\-–]/g, "");
  if (!cleaned || cleaned.length > 24) return null;
  if (!/^(?:00|\+)?\d+$/.test(cleaned)) return null;

  const countryDigits = DEFAULT_PHONE_COUNTRY_CODE.slice(1);
  const international = cleaned.startsWith("+") || cleaned.startsWith("00");
  let digits = cleaned.replace(/^\+/, "").replace(/^00/, "");

  if (international) {
    if (digits.startsWith(countryDigits)) {
      digits = `${countryDigits}${digits.slice(countryDigits.length).replace(/^0+/, "")}`;
    }
  } else {
    digits = `${countryDigits}${digits.replace(/^0+/, "")}`;
  }

  const e164 = `+${digits}`;
  return PHONE_E164_PATTERN.test(e164) ? e164 : null;
}

/** رمز حامل صالح فقط: غيابه أو صيغة أخرى تعني «لا جلسة». */
export function requireBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match && match[1] ? match[1] : null;
}

export type SessionTokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number | null;
};

/**
 * يحتفظ بالرمزين فقط من استجابة Supabase Auth: لا `user` ولا بريد ولا أي
 * بيانات حساب. يكفي للواجهة `setSession` ثم `getUser` للتحقق من الهوية.
 */
export function sessionTokens(session: unknown): SessionTokens | null {
  if (!session || typeof session !== "object") return null;
  const record = session as Record<string, unknown>;
  const access = record.access_token;
  const refresh = record.refresh_token;
  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: typeof record.token_type === "string" ? record.token_type : "bearer",
    expires_in: typeof record.expires_in === "number" ? record.expires_in : null,
  };
}

/** جسم فشل: رسالة عامة فقط، بلا رموز جلسة ولا بيانات حساب. */
export function failureBody(message: string): Record<string, unknown> {
  return { error: message };
}

/**
 * نص آمن للسجل: لا يعيد شيئاً من قيم الطلب (رقم، كلمة مرور، رمز، بريد)، بل
 * نوع الخطأ أو رمز الحالة فقط.
 */
export function redactForLog(error: unknown): string {
  if (typeof error === "number" && Number.isFinite(error)) return `status ${error}`;
  if (error instanceof Error) return error.name || "Error";
  return "failure";
}

/** سجل فشل موحّد بلا قيم: يُستخدم في مكان console.error المباشر. */
export function logFailure(scope: string, error: unknown): void {
  console.error(`${scope}: ${redactForLog(error)}`);
}

/**
 * تحقق خادمي من CAPTCHA (Cloudflare Turnstile) قبل أي محاولة دخول.
 * `fetchImpl` يُمرَّر للاختبار، وأي خطأ أو رد غير صالح يعني «ليست بشراً».
 */
export async function verifyTurnstileToken(
  token: string,
  secret: string,
  fetchImpl: typeof fetch,
  remoteIp?: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { success?: unknown };
    return payload.success === true;
  } catch {
    return false;
  }
}
