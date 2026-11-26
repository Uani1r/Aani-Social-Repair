// تسجيل الدخول برقم الهاتف وكلمة مرور الحساب — بلا SMS وبلا OTP.
//
// المسار:
// 1) CAPTCHA خادمي (Cloudflare Turnstile) قبل أي محاولة — إن لم يُضبط السر
//    تبقى الميزة محجوبة (503) ولا تُسمح بأي محاولة.
// 2) تطبيع الرقم إلى E.164.
// 3) حدّ محاولات أولي داخل نسخة الدالة بمفتاح (IP المنصة + الرقم نفسه).
// 4) البحث عن الحساب في public.account_phone_aliases برقمه الفريد.
// 5) قراءة هوية المصادقة الأصلية للحساب (بريده) من Supabase Auth Admin.
// 6) التحقق من كلمة المرور عبر Supabase Auth نفسه
//    (`/auth/v1/token?grant_type=password`).
// 7) إعادة الرمزين فقط (access/refresh) بعد النجاح.
//
// الأمان:
// - رسالة واحدة عامة عند أي فشل (رقم غير مرتبط، كلمة مرور خاطئة، حساب بلا
//   بريد): لا يُكشف إن كان الرقم مسجلاً ولا لمن.
// - لا يُعاد البريد ولا كائن user إلى العميل.
// - لا تُطبع كلمة مرور ولا رقم ولا رموز: كل سجل يمر عبر logFailure.
// - لا يُقرأ أي user_id من الطلب، ولا يُنشأ JWT من عندنا.
//
// حماية تسجيل الدخول قبل الإطلاق:
// - CAPTCHA هنا هي البوابة الفعلية. خريطة المحاولات أدناه داخل نسخة واحدة
//   وليست حماية كافية: مطلوب محدّد معدل مشترك (Upstash/Redis أو جدول
//   محاولات في قاعدة البيانات) قبل الإطلاق. عنوان IP يأتي من منصة الاستضافة
//   (x-forwarded-for) ولا يُعتمد وحده: الحدّ يجمع بينه وبين رقم الهاتف.

import {
  PHONE_MESSAGES,
  failureBody,
  logFailure,
  normalizePhoneToE164,
  sessionTokens,
  verifyTurnstileToken,
} from "../_shared/phone.ts";

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
const FAILURE_DELAY_MS = 300;

const failures = new Map<string, { count: number; resetAt: number }>();

type LoginBody = {
  phone?: unknown;
  password?: unknown;
  captchaToken?: unknown;
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

/** مفتاح IP من ترويسات المنصة فقط، ويُقرأ مع رقم الهاتف لا وحده. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim() ?? "";
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
  return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse(failureBody("Method not allowed."), 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const captchaSecret = Deno.env.get("TURNSTILE_SECRET_KEY")?.trim() ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
  }

  let body: LoginBody;
  try {
    body = await request.json() as LoginBody;
  } catch {
    return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 400, origin);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 400, origin);
  }

  // الميزة محجوبة حتى تُفعّل حماية CAPTCHA على الخادم.
  if (!captchaSecret) {
    return jsonResponse(failureBody(PHONE_MESSAGES.captchaUnavailable), 503, origin);
  }

  const ipKey = `ip:${clientKey(request)}`;
  const captchaToken = typeof body.captchaToken === "string" ? body.captchaToken : "";
  if (!captchaToken) {
    return jsonResponse(failureBody(PHONE_MESSAGES.captchaRequired), 400, origin);
  }
  const human = await verifyTurnstileToken(captchaToken, captchaSecret, fetch, clientKey(request));
  if (!human) {
    recordFailure([ipKey], Date.now());
    return jsonResponse(failureBody(PHONE_MESSAGES.captchaRequired), 400, origin);
  }

  const rawPhone = typeof body.phone === "string" ? body.phone : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!rawPhone || !password || password.length > 1024) {
    return rejectInvalid(origin, [ipKey]);
  }

  const phone = normalizePhoneToE164(rawPhone);
  if (!phone) return rejectInvalid(origin, [ipKey]);

  const phoneKey = `phone:${phone}`;
  const now = Date.now();
  if (isRateLimited([ipKey, phoneKey], now)) {
    return jsonResponse(failureBody(PHONE_MESSAGES.rateLimited), 429, origin);
  }

  try {
    const aliasUrl = new URL(`${supabaseUrl}/rest/v1/account_phone_aliases`);
    aliasUrl.searchParams.set("select", "user_id");
    aliasUrl.searchParams.set("phone_e164", `eq.${phone}`);
    aliasUrl.searchParams.set("limit", "1");

    const aliasResponse = await fetch(aliasUrl, { headers: serviceHeaders(serviceRoleKey) });
    if (!aliasResponse.ok) {
      logFailure("[login-with-phone] Alias lookup failed", aliasResponse.status);
      return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
    }
    const aliases = await aliasResponse.json() as { user_id?: unknown }[];
    const userId = Array.isArray(aliases) && typeof aliases[0]?.user_id === "string" ? aliases[0].user_id : "";
    if (!userId) return rejectInvalid(origin, [ipKey, phoneKey]);

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: serviceHeaders(serviceRoleKey),
    });
    if (!userResponse.ok) {
      logFailure("[login-with-phone] Auth user lookup failed", userResponse.status);
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
    if (!tokenResponse.ok) {
      logFailure("[login-with-phone] Password grant failed", tokenResponse.status);
      return rejectInvalid(origin, [ipKey, phoneKey]);
    }

    const tokens = sessionTokens(await tokenResponse.json());
    if (!tokens) {
      logFailure("[login-with-phone] Auth returned an incomplete session", 502);
      return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 502, origin);
    }

    // الرمزان فقط: لا بريد ولا كائن user ولا رقم.
    return jsonResponse(tokens, 200, origin);
  } catch (error) {
    logFailure("[login-with-phone] Sign-in failed", error);
    return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
  }
});
