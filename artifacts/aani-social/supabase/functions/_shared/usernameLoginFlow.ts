// مسار تسجيل الدخول باسم المستخدم وكلمة المرور — كامل، بقابلات للحقن (fetch/env)
// ليُختبر فعلياً بلا شبكة ولا مشروع Supabase.
//
// ترتيب لا يُخترق:
// 1) CAPTCHA خادمي (Turnstile): نجاح + hostname + action قبل أي شيء آخر.
// 2) تطبيع اسم المستخدم.
// 3) محدّد معدل **مشترك** في قاعدة البيانات (aani_consume_login_attempt)،
//    ببصمات HMAC-SHA-256 بمفتاح مستقل (LOGIN_RATE_LIMIT_HMAC_SECRET) ونطاقين
//    منفصلين: `username` و`ip`.
// 4) البحث عن الحساب في profiles باسم المستخدم.
// 5) قراءة بريد المصادقة الأصلي عبر Admin API.
// 6) التحقق من كلمة المرور عبر Supabase Auth.
// 7) إعادة الرمزين فقط.
//
// IP الموثوق: لا تُقرأ x-forwarded-for ولا x-real-ip إطلاقاً؛ المصدر الوحيد هو
// cf-connecting-ip مع علامتي المنصة (cf-ray وcf-worker)، وتفصيله في
// resolveTrustedClientIp. بلا IP موثوق تُستهلك بصمة اسم المستخدم وحدها.
//
// لا كشف لوجود الحساب: كل فشل بعد CAPTCHA (اسم غير موجود، بريد مفقود، كلمة
// مرور خاطئة) يعيد 401 بالرسالة نفسها. وإن تعذّر الوصول إلى المحدّد أو غاب
// مفتاح HMAC أو كان غير صالح تُرفض المحاولة (fail-closed) بلا أي قراءة حساب.

import {
  failureBody,
  hmacSha256Hex,
  isUsableRateLimitSecret,
  logFailure,
  resolveTrustedClientIp,
  sessionTokens,
  verifyTurnstileToken,
  type TurnstileExpectation,
} from "./phone.ts";

export const USERNAME_LOGIN_CAPTCHA_ACTION = "username_login";
export const USERNAME_RATE_WINDOW_SECONDS = 900;
export const USERNAME_RATE_MAX_ATTEMPTS = 10;
// قواعد اسم المستخدم المشتركة مع الواجهة وقاعدة البيانات (1–32): محرف واحد
// مسموح، والحد الأعلى 32، والحروف صغيرة والمحارف a-z 0-9 _ . فقط.
export const USERNAME_PATTERN = /^[a-z0-9_.]{1,32}$/;

export const USERNAME_LOGIN_MESSAGES = {
  invalidCredentials: "اسم المستخدم أو كلمة المرور غير صحيحة.",
  invalidUsername: "اسم المستخدم غير صالح. استخدم 1–32 محرفاً لاتينياً أو رقماً أو _ أو .",
  captchaRequired: "تحقق الأمان مطلوب لإكمال الدخول. أعد المحاولة بعد تحديث الصفحة.",
  captchaUnavailable: "الدخول باسم المستخدم غير متاح حالياً: حماية CAPTCHA لم تُفعّل بعد.",
  rateLimited: "تجاوزت عدد المحاولات. انتظر قليلاً ثم أعد المحاولة.",
  rateLimitUnavailable: "تعذر الوصول إلى حماية تسجيل الدخول حالياً. حاول بعد قليل.",
  unavailable: "تعذر الوصول إلى الخدمة حالياً. حاول بعد قليل.",
} as const;

export type UsernameLoginDeps = {
  fetchImpl: typeof fetch;
  env: (name: string) => string | undefined;
};

type LoginBody = {
  username?: unknown;
  password?: unknown;
  captchaToken?: unknown;
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

/** اسم المستخدم كما يُخزَّن: بلا @ وبأحرف صغيرة. */
export function normalizeUsername(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
  return USERNAME_PATTERN.test(value) ? value : "";
}

function readHostnames(env: (name: string) => string | undefined): string[] {
  return (env("TURNSTILE_ALLOWED_HOSTNAMES") ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

async function consumeAttempt(
  deps: UsernameLoginDeps,
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
        p_window_seconds: USERNAME_RATE_WINDOW_SECONDS,
        p_max_attempts: USERNAME_RATE_MAX_ATTEMPTS,
      }),
    });
    if (!response.ok) {
      logFailure("[login-with-username] Rate limit call failed", response.status);
      return { status: "unavailable" };
    }
    const rows = await response.json() as { allowed?: unknown }[];
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row.allowed !== "boolean") {
      logFailure("[login-with-username] Rate limit response invalid", 502);
      return { status: "unavailable" };
    }
    return row.allowed ? { status: "allowed" } : { status: "limited" };
  } catch (error) {
    logFailure("[login-with-username] Rate limit unavailable", error);
    return { status: "unavailable" };
  }
}

export function createUsernameLoginHandler(
  deps: UsernameLoginDeps,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST") return jsonResponse(failureBody("Method not allowed."), 405, origin);

    const supabaseUrl = deps.env("SUPABASE_URL")?.replace(/\/+$/, "");
    const anonKey = deps.env("SUPABASE_ANON_KEY");
    const serviceRoleKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.unavailable), 500, origin);
    }

    let body: LoginBody;
    try {
      body = await request.json() as LoginBody;
    } catch {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 400, origin);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 400, origin);
    }

    // الميزة محجوبة حتى تُضبط حماية CAPTCHA (السر والمضيفات) على الخادم.
    const captchaSecret = deps.env("TURNSTILE_SECRET_KEY")?.trim() ?? "";
    const allowedHostnames = readHostnames(deps.env);
    if (!captchaSecret || allowedHostnames.length === 0) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.captchaUnavailable), 503, origin);
    }

    // مفتاح HMAC مستقل للمحدّد: بلا مفتاح صالح لا رجوع إلى SHA-256 غير مقيّد،
    // ولا يُستخدم مفتاح الخدمة مفتاحاً.
    const hmacSecret = deps.env("LOGIN_RATE_LIMIT_HMAC_SECRET");
    if (!isUsableRateLimitSecret(hmacSecret) || hmacSecret === serviceRoleKey) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.rateLimitUnavailable), 503, origin);
    }

    const trustedIp = resolveTrustedClientIp(request.headers);
    const captchaToken = typeof body.captchaToken === "string" ? body.captchaToken : "";
    if (!captchaToken) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.captchaRequired), 400, origin);
    }

    const expectation: TurnstileExpectation = {
      expectedHostnames: allowedHostnames,
      expectedAction: USERNAME_LOGIN_CAPTCHA_ACTION,
      ...(trustedIp.status === "ip" ? { remoteIp: trustedIp.ip } : {}),
    };
    const human = await verifyTurnstileToken(captchaToken, captchaSecret, deps.fetchImpl, expectation);
    if (!human) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.captchaRequired), 400, origin);
    }

    const username = normalizeUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    if (!username) return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidUsername), 401, origin);
    if (!password || password.length > 1024) {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 401, origin);
    }

    const usernameBucket = `login:username:${await hmacSha256Hex(hmacSecret, "username", username)}`;
    const usernameDecision = await consumeAttempt(deps, supabaseUrl, serviceRoleKey, usernameBucket);
    if (usernameDecision.status === "unavailable") {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.unavailable), 503, origin);
    }
    if (usernameDecision.status === "limited") {
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.rateLimited), 429, origin);
    }

    if (trustedIp.status === "ip") {
      const ipBucket = `login:ip:${await hmacSha256Hex(hmacSecret, "ip", trustedIp.ip)}`;
      const ipDecision = await consumeAttempt(deps, supabaseUrl, serviceRoleKey, ipBucket);
      if (ipDecision.status === "unavailable") {
        return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.unavailable), 503, origin);
      }
      if (ipDecision.status === "limited") {
        return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.rateLimited), 429, origin);
      }
    }

    try {
      const profileUrl = new URL(`${supabaseUrl}/rest/v1/profiles`);
      profileUrl.searchParams.set("select", "id");
      profileUrl.searchParams.set("username", `eq.${username}`);
      profileUrl.searchParams.set("limit", "1");

      const profileResponse = await deps.fetchImpl(profileUrl, { headers: serviceHeaders(serviceRoleKey) });
      if (!profileResponse.ok) {
        logFailure("[login-with-username] Profile lookup failed", profileResponse.status);
        return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.unavailable), 500, origin);
      }
      const profiles = await profileResponse.json() as { id?: unknown }[];
      const userId = Array.isArray(profiles) && typeof profiles[0]?.id === "string" ? profiles[0].id : "";
      if (!userId) return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 401, origin);

      const userResponse = await deps.fetchImpl(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        { headers: serviceHeaders(serviceRoleKey) },
      );
      if (!userResponse.ok) {
        logFailure("[login-with-username] Auth user lookup failed", userResponse.status);
        return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 401, origin);
      }
      const authUser = await userResponse.json() as { email?: unknown; user?: { email?: unknown } };
      const email = typeof authUser?.user?.email === "string"
        ? authUser.user.email
        : typeof authUser?.email === "string" ? authUser.email : "";
      if (!email) return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 401, origin);

      const tokenResponse = await deps.fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!tokenResponse.ok) {
        logFailure("[login-with-username] Password grant failed", tokenResponse.status);
        return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.invalidCredentials), 401, origin);
      }

      const tokens = sessionTokens(await tokenResponse.json());
      if (!tokens) {
        logFailure("[login-with-username] Auth returned an incomplete session", 502);
        return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.unavailable), 502, origin);
      }

      // الرمزان فقط: لا بريد ولا كائن user ولا اسم مستخدم.
      return jsonResponse(tokens, 200, origin);
    } catch (error) {
      logFailure("[login-with-username] Sign-in failed", error);
      return jsonResponse(failureBody(USERNAME_LOGIN_MESSAGES.unavailable), 500, origin);
    }
  };
}
