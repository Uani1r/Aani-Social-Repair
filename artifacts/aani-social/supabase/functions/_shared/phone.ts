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
  rateLimitUnavailable: "تعذر الوصول إلى حماية تسجيل الدخول حالياً. حاول بعد قليل.",
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
 * مفتاح HMAC مستقل للمحدّد: 32–256 محرفاً بلا مسافات. ليس مفتاح الخدمة ولا
 * أي مفتاح Supabase، ويُقرأ من `LOGIN_RATE_LIMIT_HMAC_SECRET` وحده.
 */
export function isUsableRateLimitSecret(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 32 || trimmed.length > 256) return false;
  if (/\s/.test(trimmed)) return false;
  return true;
}

/**
 * بصمة HMAC-SHA-256: `domain` يفصل نطاق الهاتف عن نطاق IP فلا تتداخل
 * المفاتيح (نفس القيمة في نطاقين تُنتج بصمتين مختلفتين)، والمفتاح سري مستقل.
 */
export async function hmacSha256Hex(secret: string, domain: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(`${domain}\u0000${value}`);
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type TrustedClientIp =
  | { status: "ip"; ip: string }
  | { status: "unavailable"; reason: "no-platform-markers" | "no-ip" | "invalid-ip" };

/**
 * مصدر IP موثوق، موثّق هنا صراحةً:
 * - لا توجد في وثائق Supabase لـ Edge Functions ترويسة IP مضمونة من المنصة،
 *   و`x-forwarded-for` **لا** يُعتمد: قد يرسله العميل، ووثائق الدوال نفسها
 *   تُظهر مرور ترويسات مخصصة من العميل. لذلك لا يُقرأ هنا إطلاقاً.
 * - الترويسة الوحيدة الموصوفة في وثائق Supabase بأن المنصة تضبطها هي
 *   `cf-connecting-ip` (وثائق Data API)، وتصل الدالة عبر Cloudflare. لذلك لا
 *   تُقبل إلا مع علامتي المنصة التي يعيد كتابتهما Cloudflare على كل طلب:
 *   `cf-ray` موجودة و`cf-worker` تساوي `supabase.co`.
 * - بلا هذه العلامات (مشروع مستضاف ذاتياً، أو ترويسة من العميل) لا IP موثوق:
 *   يُعالج الغياب بأمان في المحدّد (بصمة الهاتف وحدها) ولا يُجمع كل المستخدمين
 *   في حد واحد.
 */
export function resolveTrustedClientIp(headers: Headers): TrustedClientIp {
  const cfRay = (headers.get("cf-ray") ?? "").trim();
  const cfWorker = (headers.get("cf-worker") ?? "").trim().toLowerCase();
  if (!cfRay || cfWorker !== "supabase.co") return { status: "unavailable", reason: "no-platform-markers" };

  const ip = (headers.get("cf-connecting-ip") ?? "").trim();
  if (!ip) return { status: "unavailable", reason: "no-ip" };
  if (!/^[0-9a-fA-F:.]{2,64}$/.test(ip)) return { status: "unavailable", reason: "invalid-ip" };
  return { status: "ip", ip };
}

export type TurnstileExpectation = {
  /** المضيفات المسموح بها (نطاق الموقع)، بأحرف صغيرة. */
  expectedHostnames: string[];
  /** الإجراء المتوقع الذي سجله الودجت. */
  expectedAction: string;
  /** عنوان IP من منصة الاستضافة، إن وُجد. */
  remoteIp?: string;
};

/**
 * تحقق خادمي كامل من CAPTCHA (Cloudflare Turnstile) قبل أي محاولة دخول:
 * - نجاح صريح (`success === true`) وبلا `error-codes`.
 * - `hostname` ضمن المضيفات المسموح بها.
 * - `action` مطابق للإجراء المتوقع.
 * أي استجابة ناقصة أو غير متوقعة أو خطأ شبكة أو غياب السر أو الرمز تعني
 * الرفض (fail-closed). `fetchImpl` يُمرَّر للاختبار.
 */
export async function verifyTurnstileToken(
  token: string,
  secret: string,
  fetchImpl: typeof fetch,
  expectation: TurnstileExpectation,
): Promise<boolean> {
  if (!token || !secret) return false;
  if (!Array.isArray(expectation.expectedHostnames) || expectation.expectedHostnames.length === 0) return false;
  if (!expectation.expectedAction) return false;

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (expectation.remoteIp) form.set("remoteip", expectation.remoteIp);

  let payload: Record<string, unknown>;
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) return false;
    payload = await response.json() as Record<string, unknown>;
  } catch {
    return false;
  }

  if (payload.success !== true) return false;
  // أي وجود لـ error-codes — حتى مصفوفة فارغة أو قيمة غير متوقعة — رفض.
  if ("error-codes" in payload) return false;

  const hostname = typeof payload.hostname === "string" ? payload.hostname.toLowerCase() : "";
  if (!hostname || !expectation.expectedHostnames.includes(hostname)) return false;

  const action = typeof payload.action === "string" ? payload.action : "";
  if (action !== expectation.expectedAction) return false;

  return true;
}
