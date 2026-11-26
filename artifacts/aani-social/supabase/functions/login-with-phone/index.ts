// تسجيل الدخول برقم الهاتف وكلمة مرور الحساب — بلا SMS وبلا OTP.
//
// المسار:
// 1) تطبيع الرقم إلى E.164.
// 2) البحث عن الحساب في public.account_phone_aliases برقمه الفريد.
// 3) قراءة هوية المصادقة الأصلية للحساب (بريده) من Supabase Auth Admin.
// 4) التحقق من كلمة المرور عبر Supabase Auth نفسه
//    (`/auth/v1/token?grant_type=password`).
// 5) إعادة الجلسة (access_token وrefresh_token فقط) بعد النجاح.
//
// الأمان:
// - رسالة واحدة عامة عند أي فشل: رقم غير مرتبط، أو كلمة مرور خاطئة، أو حساب
//   بلا هوية بريد — لا يُكشف إن كان الرقم مسجلاً ولا لمن.
// - لا يُعاد البريد ولا كائن user إلى العميل: الجلسة تُختصر إلى رمزين.
// - لا تُطبع كلمة المرور ولا الرقم ولا الرموز في السجلات.
// - لا يُقرأ أي user_id من الطلب، ولا يُنشأ JWT من عندنا.
// - حدّ محاولات داخل نسخة الدالة (best effort) + تأخير ثابت عند الفشل. هذا
//   ليس بديلاً عن CAPTCHA ولا عن محدّد معدل مشترك: يجب إضافتهما قبل الإطلاق
//   (انظر الملاحظة أسفل الملف).

const DEFAULT_COUNTRY_CODE = "+964";
const PHONE_E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

const INVALID_CREDENTIALS = "رقم الهاتف أو كلمة المرور غير صحيحة.";
const RATE_LIMITED = "تجاوزت عدد المحاولات. انتظر قليلاً ثم أعد المحاولة.";
const UNAVAILABLE = "تعذر إكمال تسجيل الدخول حالياً. حاول بعد قليل.";

// حدّ محاولات بسيط داخل نسخة الدالة: 10 محاولات فاشلة لكل مفتاح في 10 دقائق.
// لا يشارك الحالة بين النسخ، ولذلك يبقى محدّد المعدل المشترك وCAPTCHA مطلوبين
// قبل الإطلاق.
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
const FAILURE_DELAY_MS = 300;

const failures = new Map<string, { count: number; resetAt: number }>();

type LoginBody = {
  phone?: unknown;
  password?: unknown;
};

type AuthUser = {
  email?: unknown;
};

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null): Response {
  const headers = new Headers(corsHeaders(origin));
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function serviceHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

function normalizePhoneToE164(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s().\-–]/g, "");
  if (!cleaned || cleaned.length > 24) return null;
  if (!/^(?:00|\+)?\d+$/.test(cleaned)) return null;

  const countryDigits = DEFAULT_COUNTRY_CODE.slice(1);
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

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

function isRateLimited(keys: string[], now: number): boolean {
  return keys.some(key => {
    const entry = failures.get(key);
    return entry !== undefined && entry.resetAt > now && entry.count >= MAX_FAILURES;
  });
}

function recordFailure(keys: string[], now: number): void {
  if (failures.size > 5000) {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= now) failures.delete(key);
    }
  }
  for (const key of keys) {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) {
      failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
      continue;
    }
    entry.count += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rejectInvalid(origin: string | null, keys: string[]): Promise<Response> {
  recordFailure(keys, Date.now());
  await delay(FAILURE_DELAY_MS);
  return jsonResponse({ error: INVALID_CREDENTIALS }, 401, origin);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: UNAVAILABLE }, 500, origin);
  }

  let body: LoginBody;
  try {
    body = await request.json() as LoginBody;
  } catch {
    return jsonResponse({ error: INVALID_CREDENTIALS }, 400, origin);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: INVALID_CREDENTIALS }, 400, origin);
  }

  const ipKey = `ip:${clientKey(request)}`;
  const now = Date.now();
  if (isRateLimited([ipKey], now)) {
    return jsonResponse({ error: RATE_LIMITED }, 429, origin);
  }

  const rawPhone = typeof body.phone === "string" ? body.phone : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!rawPhone || !password || password.length > 1024) {
    return rejectInvalid(origin, [ipKey]);
  }

  const phone = normalizePhoneToE164(rawPhone);
  if (!phone) return rejectInvalid(origin, [ipKey]);

  const phoneKey = `phone:${phone}`;
  if (isRateLimited([ipKey, phoneKey], now)) {
    return jsonResponse({ error: RATE_LIMITED }, 429, origin);
  }

  try {
    const aliasUrl = new URL(`${supabaseUrl}/rest/v1/account_phone_aliases`);
    aliasUrl.searchParams.set("select", "user_id");
    aliasUrl.searchParams.set("phone_e164", `eq.${phone}`);
    aliasUrl.searchParams.set("limit", "1");

    const aliasResponse = await fetch(aliasUrl, { headers: serviceHeaders(serviceRoleKey) });
    if (!aliasResponse.ok) {
      console.error("[login-with-phone] Alias lookup failed:", aliasResponse.status);
      return jsonResponse({ error: UNAVAILABLE }, 500, origin);
    }
    const aliases = await aliasResponse.json() as { user_id?: unknown }[];
    const userId = Array.isArray(aliases) && typeof aliases[0]?.user_id === "string" ? aliases[0].user_id : "";
    if (!userId) return rejectInvalid(origin, [ipKey, phoneKey]);

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: serviceHeaders(serviceRoleKey),
    });
    if (!userResponse.ok) {
      console.error("[login-with-phone] Auth user lookup failed:", userResponse.status);
      return rejectInvalid(origin, [ipKey, phoneKey]);
    }
    const authUser = await userResponse.json() as AuthUser;
    const email = typeof authUser?.email === "string" ? authUser.email : "";
    if (!email) return rejectInvalid(origin, [ipKey, phoneKey]);

    const tokenResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!tokenResponse.ok) return rejectInvalid(origin, [ipKey, phoneKey]);

    const session = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = session.access_token;
    const refreshToken = session.refresh_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      console.error("[login-with-phone] Auth returned an incomplete session.");
      return jsonResponse({ error: UNAVAILABLE }, 502, origin);
    }

    // الجلسة فقط: لا بريد ولا كائن user ولا رقم.
    return jsonResponse({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: typeof session.token_type === "string" ? session.token_type : "bearer",
      expires_in: typeof session.expires_in === "number" ? session.expires_in : null,
    }, 200, origin);
  } catch (error) {
    console.error("[login-with-phone] Sign-in failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: UNAVAILABLE }, 500, origin);
  }
});

// قبل الإطلاق:
// - أضف CAPTCHA (hCaptcha/Turnstile) على شاشة الدخول وتحقّقها هنا.
// - استبدل حدّ المحاولات في الذاكرة بمحدّد مشترك (Upstash/Redis أو جدول
//   محاولات)، لأن النسخ المتعددة لا تتشارك هذه الخريطة.
// - راقب حدود Supabase Auth نفسه (كتلة الحساب بعد محاولات فاشلة متكررة).
