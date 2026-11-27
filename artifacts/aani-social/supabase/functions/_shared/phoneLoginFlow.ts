// مسار تسجيل الدخول برقم الهاتف وكلمة المرور — كامل، بقابلات للحقن (fetch/env)
// ليُختبر فعلياً بلا شبكة ولا مشروع Supabase.
//
// ترتيب لا يُخترق:
// 1) CAPTCHA خادمي (Turnstile): نجاح + hostname + action قبل أي شيء آخر.
// 2) تطبيع الرقم.
// 3) محدّد معدل **مشترك** في قاعدة البيانات (دالة ذرية)، لا Map داخل نسخة،
//    ببصمات HMAC-SHA-256 بمفتاح مستقل (LOGIN_RATE_LIMIT_HMAC_SECRET) ونطاقين
//    منفصلين للهاتف وIP.
// 4) البحث عن الحساب في account_phone_aliases.
// 5) قراءة بريد المصادقة الأصلي عبر Admin API.
// 6) التحقق من كلمة المرور عبر Supabase Auth.
// 7) إعادة الرمزين فقط.
//
// IP الموثوق: لا تُقرأ x-forwarded-for ولا x-real-ip إطلاقاً. المصدر الوحيد
// هو cf-connecting-ip مع علامتي المنصة (cf-ray وcf-worker: supabase.co)،
// وتفصيله في resolveTrustedClientIp. بلا IP موثوق تُستهلك بصمة الهاتف وحدها،
// فلا يُجمع المستخدمون في حد واحد غير مقصود.
//
// إن تعذّر الوصول إلى محدّد المعدل أو غاب مفتاح HMAC أو كان غير صالح تُرفض
// المحاولة (fail-closed) بلا رجوع إلى SHA-256 غير مقيّد، ولا تُقرأ بيانات أي
// حساب. الرسالة العامة لا تكشف وجود الرقم ولا لمن.

import {
  PHONE_MESSAGES,
  failureBody,
  hmacSha256Hex,
  isUsableRateLimitSecret,
  logFailure,
  normalizePhoneToE164,
  resolveTrustedClientIp,
  sessionTokens,
  verifyTurnstileToken,
  type TurnstileExpectation,
} from "./phone.ts";

export const LOGIN_CAPTCHA_ACTION = "phone_login";
export const RATE_WINDOW_SECONDS = 900;
export const RATE_MAX_ATTEMPTS = 10;

export type PhoneLoginDeps = {
  fetchImpl: typeof fetch;
  env: (name: string) => string | undefined;
};

type LoginBody = {
  phone?: unknown;
  password?: unknown;
  captchaToken?: unknown;
};

type AuthUser = {
  email?: unknown;
};

type RateOutcome =
  | { status: "allowed" }
  | { status: "limited" }
  | { status: "unavailable" };

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

function readHostnames(env: (name: string) => string | undefined): string[] {
  return (env("TURNSTILE_ALLOWED_HOSTNAMES") ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

/** استهلاك محاولة من المحدّد المشترك؛ أي فشل في الوصول يعني الرفض. */
async function consumeAttempt(
  deps: PhoneLoginDeps,
  supabaseUrl: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<RateOutcome> {
  try {
    const response = await deps.fetchImpl(`${supabaseUrl}/rest/v1/rpc/aani_consume_login_attempt`, {
      method: "POST",
      headers: { ...serviceHeaders(serviceRoleKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_bucket: bucket,
        p_window_seconds: RATE_WINDOW_SECONDS,
        p_max_attempts: RATE_MAX_ATTEMPTS,
      }),
    });
    if (!response.ok) {
      logFailure("[login-with-phone] Rate limit call failed", response.status);
      return { status: "unavailable" };
    }
    const rows = await response.json() as { allowed?: unknown }[];
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row.allowed !== "boolean") {
      logFailure("[login-with-phone] Rate limit response invalid", 502);
      return { status: "unavailable" };
    }
    return row.allowed ? { status: "allowed" } : { status: "limited" };
  } catch (error) {
    logFailure("[login-with-phone] Rate limit unavailable", error);
    return { status: "unavailable" };
  }
}

export function createLoginWithPhoneHandler(
  deps: PhoneLoginDeps,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST") return jsonResponse(failureBody("Method not allowed."), 405, origin);

    const supabaseUrl = deps.env("SUPABASE_URL")?.replace(/\/+$/, "");
    const anonKey = deps.env("SUPABASE_ANON_KEY");
    const serviceRoleKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
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

    // الميزة محجوبة حتى تُضبط حماية CAPTCHA (السر والمضيفات) على الخادم.
    const captchaSecret = deps.env("TURNSTILE_SECRET_KEY")?.trim() ?? "";
    const allowedHostnames = readHostnames(deps.env);
    if (!captchaSecret || allowedHostnames.length === 0) {
      return jsonResponse(failureBody(PHONE_MESSAGES.captchaUnavailable), 503, origin);
    }

    // مفتاح HMAC مستقل للمحدّد: بلا مفتاح صالح لا رجوع إلى SHA-256 غير
    // مقيّد، ولا يُستخدم مفتاح الخدمة مفتاحاً.
    const hmacSecret = deps.env("LOGIN_RATE_LIMIT_HMAC_SECRET");
    if (!isUsableRateLimitSecret(hmacSecret) || hmacSecret === serviceRoleKey) {
      return jsonResponse(failureBody(PHONE_MESSAGES.rateLimitUnavailable), 503, origin);
    }

    const trustedIp = resolveTrustedClientIp(request.headers);
    const captchaToken = typeof body.captchaToken === "string" ? body.captchaToken : "";
    if (!captchaToken) {
      return jsonResponse(failureBody(PHONE_MESSAGES.captchaRequired), 400, origin);
    }

    const expectation: TurnstileExpectation = {
      expectedHostnames: allowedHostnames,
      expectedAction: LOGIN_CAPTCHA_ACTION,
      ...(trustedIp.status === "ip" ? { remoteIp: trustedIp.ip } : {}),
    };
    const human = await verifyTurnstileToken(captchaToken, captchaSecret, deps.fetchImpl, expectation);
    if (!human) {
      return jsonResponse(failureBody(PHONE_MESSAGES.captchaRequired), 400, origin);
    }

    const rawPhone = typeof body.phone === "string" ? body.phone : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!rawPhone || !password || password.length > 1024) {
      return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);
    }

    const phone = normalizePhoneToE164(rawPhone);
    if (!phone) return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);

    // محدّد المعدل المشترك: بصمة HMAC للرقم، ثم بصمة HMAC لـIP الموثوق إن
    // وُجد. بلا IP موثوق لا يُجمع المستخدمون في حد واحد غير مقصود.
    const phoneBucket = `login:phone:${await hmacSha256Hex(hmacSecret, "phone", phone)}`;
    const phoneDecision = await consumeAttempt(deps, supabaseUrl, serviceRoleKey, phoneBucket);
    if (phoneDecision.status === "unavailable") {
      return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 503, origin);
    }
    if (phoneDecision.status === "limited") {
      return jsonResponse(failureBody(PHONE_MESSAGES.rateLimited), 429, origin);
    }

    if (trustedIp.status === "ip") {
      const ipBucket = `login:ip:${await hmacSha256Hex(hmacSecret, "ip", trustedIp.ip)}`;
      const ipDecision = await consumeAttempt(deps, supabaseUrl, serviceRoleKey, ipBucket);
      if (ipDecision.status === "unavailable") {
        return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 503, origin);
      }
      if (ipDecision.status === "limited") {
        return jsonResponse(failureBody(PHONE_MESSAGES.rateLimited), 429, origin);
      }
    }

    try {
      const aliasUrl = new URL(`${supabaseUrl}/rest/v1/account_phone_aliases`);
      aliasUrl.searchParams.set("select", "user_id");
      aliasUrl.searchParams.set("phone_e164", `eq.${phone}`);
      aliasUrl.searchParams.set("limit", "1");

      const aliasResponse = await deps.fetchImpl(aliasUrl, { headers: serviceHeaders(serviceRoleKey) });
      if (!aliasResponse.ok) {
        logFailure("[login-with-phone] Alias lookup failed", aliasResponse.status);
        return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
      }
      const aliases = await aliasResponse.json() as { user_id?: unknown }[];
      const userId = Array.isArray(aliases) && typeof aliases[0]?.user_id === "string" ? aliases[0].user_id : "";
      if (!userId) return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);

      const userResponse = await deps.fetchImpl(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        { headers: serviceHeaders(serviceRoleKey) },
      );
      if (!userResponse.ok) {
        logFailure("[login-with-phone] Auth user lookup failed", userResponse.status);
        return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);
      }
      const authUser = await userResponse.json() as AuthUser;
      const email = typeof authUser?.email === "string" ? authUser.email : "";
      if (!email) return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);

      const tokenResponse = await deps.fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!tokenResponse.ok) {
        logFailure("[login-with-phone] Password grant failed", tokenResponse.status);
        return jsonResponse(failureBody(PHONE_MESSAGES.invalidCredentials), 401, origin);
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
  };
}
