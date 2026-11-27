// اختبارات Deno لدالتي رقم الدخول بالهاتف.
//
// تُشغَّل في CI بـ: deno test --allow-read tests/phone-edge.test.ts
//
// ما تُثبته فعلياً (بلا شبكة ولا Supabase):
// - الأدوات المشتركة: التطبيع، بوابة الجلسة، رمزا الجلسة، جسم الفشل، السجل
//   بلا قيم، وتحقق Turnstile (نجاح + hostname + action).
// - **طلب الدخول كاملاً** عبر createLoginWithPhoneHandler بقابلات حقن:
//   رفض بلا CAPTCHA أو بفشلها أو باختلاف hostname/action، وأن البحث عن
//   الحساب والتحقق من كلمة المرور لا يحدثان قبل اجتياز CAPTCHA، وأن محدّد
//   المعدل المشترك يمنع التجاوز عبر نسختين، وأن تعذر المحدّد يرفض بأمان، وأن
//   مسارات الفشل لا تعيد جلسة ولا تكشف البريد.

import {
  PHONE_MESSAGES,
  failureBody,
  logFailure,
  normalizePhoneToE164,
  redactForLog,
  requireBearerToken,
  sessionTokens,
  sha256Hex,
  verifyTurnstileToken,
} from "../_shared/phone.ts";
import { LOGIN_CAPTCHA_ACTION, createLoginWithPhoneHandler } from "../_shared/phoneLoginFlow.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const PHONE = "+9647701234567";
const PASSWORD = "correct horse battery";
const EMAIL = "someone@example.com";
const HOSTNAME = "aani.example";

type RateRow = { attempts: number; resetAt: number };

type FakeDb = {
  now: number;
  rateLimits: Map<string, RateRow>;
  rateLimitDown: boolean;
  alias: { phone: string; userId: string } | null;
  passwords: Map<string, string>;
  captcha: { success: boolean; hostname: string; action: string; errorCodes?: string[] };
  calls: string[];
};

function createDb(): FakeDb {
  return {
    now: Date.UTC(2026, 0, 1, 12, 0, 0),
    rateLimits: new Map<string, RateRow>(),
    rateLimitDown: false,
    alias: { phone: PHONE, userId: "user-1" },
    passwords: new Map([[EMAIL, PASSWORD]]),
    captcha: { success: true, hostname: HOSTNAME, action: LOGIN_CAPTCHA_ACTION },
    calls: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const WINDOW_SECONDS = 900;
const MAX_ATTEMPTS = 10;

/** محدّد مشترك واحد تشترك فيه نسختا الدالة: نفس الخريطة ونفس القاعدة. */
function createFakeFetch(db: FakeDb): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    db.calls.push(url);

    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      if (!db.captcha.success) return json({ success: false, "error-codes": ["invalid-input-response"] });
      if (db.captcha.errorCodes?.length) {
        return json({ success: true, hostname: HOSTNAME, action: db.captcha.action, "error-codes": db.captcha.errorCodes });
      }
      return json({ success: true, hostname: db.captcha.hostname, action: db.captcha.action });
    }

    if (url.includes("/rest/v1/rpc/aani_consume_login_attempt")) {
      if (db.rateLimitDown) return json({ message: "down" }, 500);
      const payload = JSON.parse(String(init?.body ?? "{}")) as { p_bucket?: string };
      const bucket = payload.p_bucket ?? "";
      const existing = db.rateLimits.get(bucket);
      if (!existing || existing.resetAt <= db.now) {
        db.rateLimits.set(bucket, { attempts: 1, resetAt: db.now + WINDOW_SECONDS * 1000 });
        return json([{ allowed: true, remaining: MAX_ATTEMPTS - 1, retry_after_seconds: 0 }]);
      }
      if (existing.attempts >= MAX_ATTEMPTS) {
        return json([{
          allowed: false,
          remaining: 0,
          retry_after_seconds: Math.ceil((existing.resetAt - db.now) / 1000),
        }]);
      }
      existing.attempts += 1;
      return json([{ allowed: true, remaining: MAX_ATTEMPTS - existing.attempts, retry_after_seconds: 0 }]);
    }

    if (url.includes("/rest/v1/account_phone_aliases")) {
      const requested = new URL(url).searchParams.get("phone_e164") ?? "";
      const phone = requested.replace(/^eq\./, "");
      return json(db.alias && db.alias.phone === phone ? [{ user_id: db.alias.userId }] : []);
    }

    if (url.includes("/auth/v1/admin/users/")) {
      const userId = url.slice(url.lastIndexOf("/") + 1);
      return db.alias && db.alias.userId === userId ? json({ email: EMAIL }) : json({ message: "not found" }, 404);
    }

    if (url.includes("/auth/v1/token?grant_type=password")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
      const expected = payload.email ? db.passwords.get(payload.email) : undefined;
      if (!expected || expected !== payload.password) return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        user: { id: "user-1", email: EMAIL },
      });
    }

    return json({ message: `unhandled ${url}` }, 404);
  }) as typeof fetch;
}

const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  TURNSTILE_ALLOWED_HOSTNAMES: `${HOSTNAME}, www.${HOSTNAME}`,
};

function handlerWith(db: FakeDb, overrides: Record<string, string | undefined> = {}) {
  const env = { ...BASE_ENV, ...overrides } as Record<string, string | undefined>;
  const fetchImpl = createFakeFetch(db);
  return createLoginWithPhoneHandler({ fetchImpl, env: name => env[name] });
}

function loginRequest(body: Record<string, unknown>): Request {
  return new Request("https://project.test/functions/v1/login-with-phone", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

Deno.test("normalises Iraqi local and international numbers and rejects others", () => {
  assertEqual(normalizePhoneToE164("07701234567"), PHONE, "local");
  assertEqual(normalizePhoneToE164("0770 123 4567"), PHONE, "local with spaces");
  assertEqual(normalizePhoneToE164("+9647701234567"), PHONE, "international");
  assertEqual(normalizePhoneToE164("009647701234567"), PHONE, "international with 00");
  assertEqual(normalizePhoneToE164("7701234567"), PHONE, "national without a zero is normalised");
  assertEqual(normalizePhoneToE164("12"), null, "too short");
  assertEqual(normalizePhoneToE164(""), null, "empty");
  assertEqual(normalizePhoneToE164("+0123456789"), null, "no leading zero after +");
});

Deno.test("the shared rate-limit bucket is a hash, not a phone", async () => {
  const digest = await sha256Hex(PHONE);
  assertEqual(digest.length, 64, "sha-256 hex length");
  assert(!digest.includes("964"), "the digest must not contain the phone");
  assertEqual(digest, await sha256Hex(PHONE), "the digest is stable");
});

Deno.test("a session token is required and a malformed header is refused", () => {
  assertEqual(requireBearerToken(null), null, "missing header");
  assertEqual(requireBearerToken(""), null, "empty header");
  assertEqual(requireBearerToken("Basic abc"), null, "wrong scheme");
  assertEqual(requireBearerToken("Bearer"), null, "no token");
  assertEqual(requireBearerToken("bearer token-value"), "token-value", "lowercase scheme");
  assertEqual(requireBearerToken("  Bearer   token-value  "), "token-value", "extra spaces");
});

Deno.test("the session body keeps only the two tokens, never the user or email", () => {
  const tokens = sessionTokens({
    access_token: "access",
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3600,
    user: { id: "user-id", email: EMAIL },
    email: EMAIL,
  });
  assert(tokens !== null, "a complete session must be accepted");
  assertEqual(Object.keys(tokens ?? {}).sort(), ["access_token", "expires_in", "refresh_token", "token_type"], "keys");
  assert(!JSON.stringify(tokens).includes("@"), "the email must not be echoed");
  assert(!JSON.stringify(tokens).includes("user-id"), "the user object must be dropped");
});

Deno.test("an incomplete auth response never becomes a session", () => {
  assertEqual(sessionTokens(null), null, "null");
  assertEqual(sessionTokens({}), null, "empty object");
  assertEqual(sessionTokens({ access_token: "access" }), null, "no refresh token");
  assertEqual(sessionTokens({ refresh_token: "refresh" }), null, "no access token");
  assertEqual(sessionTokens("not an object"), null, "not an object");
});

Deno.test("a failure body carries a message only, never a session", () => {
  for (const message of Object.values(PHONE_MESSAGES)) {
    const body = failureBody(message);
    assertEqual(Object.keys(body), ["error"], "failure keys");
    assert(!JSON.stringify(body).includes("token"), "no token in a failure body");
  }
});

Deno.test("logging never prints a number, password, token or email", () => {
  const secretError = new Error("password=hunter2 phone=+9647701234567 token=eyJhbGciOi email=a@b.co");
  const original = console.error;
  const recorded: string[] = [];
  console.error = (...parts: unknown[]) => {
    recorded.push(parts.map(part => String(part)).join(" "));
  };
  try {
    logFailure("[test] failed", secretError);
    logFailure("[test] status", 401);
  } finally {
    console.error = original;
  }

  assert(recorded.length === 2, "both log lines must be written");
  const joined = recorded.join("\n");
  assert(!joined.includes("hunter2"), "a password must never be logged");
  assert(!joined.includes("+9647701234567"), "a phone must never be logged");
  assert(!joined.includes("eyJhbGciOi"), "a token must never be logged");
  assert(!joined.includes("a@b.co"), "an email must never be logged");
  assertEqual(redactForLog(secretError), "Error", "an error is logged by type only");
  assertEqual(redactForLog(500), "status 500", "a status is logged by code only");
  assertEqual(redactForLog("raw value"), "failure", "a raw value is not logged");
});

Deno.test("captcha verification needs success, hostname and action", async () => {
  const expectation = { expectedHostnames: [HOSTNAME], expectedAction: LOGIN_CAPTCHA_ACTION };
  const responder = (body: unknown, status = 200) => (async () => json(body, status)) as typeof fetch;

  assert(await verifyTurnstileToken("token", "secret", responder({
    success: true, hostname: HOSTNAME, action: LOGIN_CAPTCHA_ACTION,
  }), expectation), "a complete response must pass");

  assert(!(await verifyTurnstileToken("token", "secret", responder({
    success: true, hostname: "other.example", action: LOGIN_CAPTCHA_ACTION,
  }), expectation)), "a different hostname must be refused");

  assert(!(await verifyTurnstileToken("token", "secret", responder({
    success: true, hostname: HOSTNAME, action: "signup",
  }), expectation)), "a different action must be refused");

  assert(!(await verifyTurnstileToken("token", "secret", responder({
    success: true, hostname: HOSTNAME,
  }), expectation)), "a missing action must be refused");

  assert(!(await verifyTurnstileToken("token", "secret", responder({
    success: true, action: LOGIN_CAPTCHA_ACTION,
  }), expectation)), "a missing hostname must be refused");

  assert(!(await verifyTurnstileToken("token", "secret", responder({
    success: true, hostname: HOSTNAME, action: LOGIN_CAPTCHA_ACTION, "error-codes": ["timeout-or-duplicate"],
  }), expectation)), "error codes must be refused");

  assert(!(await verifyTurnstileToken("token", "secret", responder({ success: false }), expectation)), "a failure");
  assert(!(await verifyTurnstileToken("token", "secret", responder({}, 500), expectation)), "an HTTP error");
  assert(!(await verifyTurnstileToken("token", "secret", (async () => {
    throw new Error("network");
  }) as typeof fetch, expectation)), "a network error");
  assert(!(await verifyTurnstileToken("", "secret", responder({ success: true }), expectation)), "no token");
  assert(!(await verifyTurnstileToken("token", "", responder({ success: true }), expectation)), "no secret");
  assert(!(await verifyTurnstileToken("token", "secret", responder({
    success: true, hostname: HOSTNAME, action: LOGIN_CAPTCHA_ACTION,
  }), { expectedHostnames: [], expectedAction: LOGIN_CAPTCHA_ACTION })), "no allowed hostname");
});

Deno.test("a full login returns the two tokens only, after captcha and the shared limiter", async () => {
  const db = createDb();
  const handler = handlerWith(db);

  const response = await handler(loginRequest({
    phone: "07701234567",
    password: PASSWORD,
    captchaToken: "turnstile-token",
  }));
  assertEqual(response.status, 200, "status");

  const body = await response.json() as Record<string, unknown>;
  assertEqual(Object.keys(body).sort(), ["access_token", "expires_in", "refresh_token", "token_type"], "body keys");
  assert(!JSON.stringify(body).includes("@"), "the email must not be returned");
  assert(!JSON.stringify(body).includes(PHONE), "the phone must not be returned");

  const captchaIndex = db.calls.findIndex(url => url.includes("challenges.cloudflare.com"));
  const rateIndex = db.calls.findIndex(url => url.includes("aani_consume_login_attempt"));
  const aliasIndex = db.calls.findIndex(url => url.includes("/rest/v1/account_phone_aliases"));
  const tokenIndex = db.calls.findIndex(url => url.includes("/auth/v1/token"));
  assert(captchaIndex >= 0, "the captcha must be verified");
  assert(rateIndex > captchaIndex, "the shared limiter must run after the captcha");
  assert(aliasIndex > rateIndex, "the alias lookup must run after the shared limiter");
  assert(tokenIndex > aliasIndex, "the password check must run after the alias lookup");
});

Deno.test("no account lookup or password check happens without a passing captcha", async () => {
  const cases: { label: string; body: Record<string, unknown>; failCaptcha: boolean }[] = [
    { label: "missing token", body: { phone: PHONE, password: PASSWORD }, failCaptcha: false },
    { label: "failed captcha", body: { phone: PHONE, password: PASSWORD, captchaToken: "x" }, failCaptcha: true },
  ];

  for (const item of cases) {
    const db = createDb();
    if (item.failCaptcha) db.captcha = { ...db.captcha, success: false };
    const response = await handlerWith(db)(loginRequest(item.body));
    assertEqual(response.status, 400, `${item.label}: status`);
    assert(!db.calls.some(url => url.includes("account_phone_aliases")), `${item.label}: no alias lookup`);
    assert(!db.calls.some(url => url.includes("/auth/v1/token")), `${item.label}: no password check`);
    assert(!db.calls.some(url => url.includes("aani_consume_login_attempt")), `${item.label}: no limiter use`);
  }
});

Deno.test("a wrong hostname or a wrong action is refused before any account lookup", async () => {
  const cases = [
    { label: "hostname", captcha: { success: true, hostname: "evil.example", action: LOGIN_CAPTCHA_ACTION } },
    { label: "action", captcha: { success: true, hostname: HOSTNAME, action: "signup" } },
  ];

  for (const item of cases) {
    const db = createDb();
    db.captcha = item.captcha;
    const response = await handlerWith(db)(loginRequest({ phone: PHONE, password: PASSWORD, captchaToken: "x" }));
    assertEqual(response.status, 400, `${item.label}: status`);
    assert(!db.calls.some(url => url.includes("account_phone_aliases")), `${item.label}: no alias lookup`);
    assert(!db.calls.some(url => url.includes("/auth/v1/token")), `${item.label}: no password check`);
  }
});

Deno.test("the login is gated when captcha is not configured", async () => {
  const overridesList: Record<string, string | undefined>[] = [
    { TURNSTILE_SECRET_KEY: undefined },
    { TURNSTILE_ALLOWED_HOSTNAMES: undefined },
    { TURNSTILE_ALLOWED_HOSTNAMES: "  " },
  ];

  for (const overrides of overridesList) {
    const db = createDb();
    const response = await handlerWith(db, overrides)(loginRequest({
      phone: PHONE,
      password: PASSWORD,
      captchaToken: "x",
    }));
    assertEqual(response.status, 503, "status");
    assertEqual(db.calls.length, 0, "nothing must be called");
  }
});

Deno.test("the shared limiter blocks across two handler instances", async () => {
  const db = createDb();
  const first = handlerWith(db);
  const second = handlerWith(db);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const handler = attempt % 2 === 0 ? second : first;
    const response = await handler(loginRequest({ phone: PHONE, password: PASSWORD, captchaToken: "x" }));
    assertEqual(response.status, 200, `attempt ${attempt}`);
  }

  const blocked = await second(loginRequest({ phone: PHONE, password: PASSWORD, captchaToken: "x" }));
  assertEqual(blocked.status, 429, "the eleventh attempt must be refused by the other instance");
  const body = await blocked.json() as { error?: unknown };
  assertEqual(body.error, PHONE_MESSAGES.rateLimited, "the rate limit message");
});

Deno.test("an unavailable limiter refuses the attempt without touching an account", async () => {
  const db = createDb();
  db.rateLimitDown = true;
  const response = await handlerWith(db)(loginRequest({ phone: PHONE, password: PASSWORD, captchaToken: "x" }));

  assertEqual(response.status, 503, "status");
  assert(!db.calls.some(url => url.includes("account_phone_aliases")), "no alias lookup");
  assert(!db.calls.some(url => url.includes("/auth/v1/token")), "no password check");
});

Deno.test("a wrong password, an unknown number and an invalid number all fail alike", async () => {
  const messages: unknown[] = [];

  const wrongPassword = createDb();
  const wrongPasswordResponse = await handlerWith(wrongPassword)(
    loginRequest({ phone: PHONE, password: "wrong", captchaToken: "x" }),
  );
  assertEqual(wrongPasswordResponse.status, 401, "wrong password status");
  messages.push(((await wrongPasswordResponse.json()) as { error?: unknown }).error);

  const unknown = createDb();
  unknown.alias = { phone: "+9647700000001", userId: "user-2" };
  const unknownResponse = await handlerWith(unknown)(
    loginRequest({ phone: PHONE, password: PASSWORD, captchaToken: "x" }),
  );
  assertEqual(unknownResponse.status, 401, "unknown number status");
  messages.push(((await unknownResponse.json()) as { error?: unknown }).error);

  const invalid = createDb();
  const invalidResponse = await handlerWith(invalid)(
    loginRequest({ phone: "12", password: PASSWORD, captchaToken: "x" }),
  );
  assertEqual(invalidResponse.status, 401, "invalid number status");
  messages.push(((await invalidResponse.json()) as { error?: unknown }).error);

  assertEqual(messages, [
    PHONE_MESSAGES.invalidCredentials,
    PHONE_MESSAGES.invalidCredentials,
    PHONE_MESSAGES.invalidCredentials,
  ], "one identical generic message");
  assert(!JSON.stringify(messages).includes("@"), "no email in any failure");
  assert(!JSON.stringify(messages).includes("token"), "no token in any failure");
});

const FUNCTIONS_DIR = new URL("../", import.meta.url);

async function readFunction(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, FUNCTIONS_DIR));
}

Deno.test("the functions log only through the shared redactor", async () => {
  for (const file of ["account-phone-alias/index.ts", "login-with-phone/index.ts"]) {
    const source = await readFunction(file);
    assert(!source.includes("console.error("), `${file} must not call console.error directly`);
    assert(!source.includes("console.log("), `${file} must not call console.log directly`);
  }
  const flow = await readFunction("_shared/phoneLoginFlow.ts");
  assert(flow.includes('from "./phone.ts"'), "the flow must use the shared phone helpers");
  assert(!flow.includes("console.error("), "the flow logs only through logFailure");
});

Deno.test("no response body carries the service role key or the account email", async () => {
  for (const file of ["account-phone-alias/index.ts", "_shared/phoneLoginFlow.ts"]) {
    const source = await readFunction(file);
    // كل جسم رد مكتوب صراحة: لا بريد ولا مفتاح خدمة.
    const bodies = source.match(/jsonResponse\(\{[^)]*\}\)/g) ?? [];
    for (const body of bodies) {
      assert(!body.includes("email"), `${file} must not return the account email`);
      assert(!body.includes("serviceRoleKey"), `${file} must not return the service role key`);
    }
    assert(!source.includes("jsonResponse(session,"), `${file} must not echo the raw auth session`);
  }
  const flow = await readFunction("_shared/phoneLoginFlow.ts");
  assert(flow.includes("sessionTokens("), "the login flow must strip the session to two tokens");
  assert(flow.includes("return jsonResponse(tokens, 200, origin);"), "the success body is the stripped tokens");
});

Deno.test("managing the alias requires a real session before any RPC", async () => {
  const source = await readFunction("account-phone-alias/index.ts");
  const sessionCheck = source.indexOf("PHONE_MESSAGES.unauthorized");
  const firstRpc = source.indexOf("/rest/v1/rpc/");
  const firstRead = source.indexOf("/rest/v1/account_phone_aliases");
  assert(sessionCheck > 0, "the function must answer 401 without a session");
  assert(firstRpc > sessionCheck, "the session check must precede the write RPC");
  assert(firstRead > sessionCheck, "the session check must precede the read");
  assert(source.includes("requireBearerToken("), "the bearer token comes from the shared gate");
  assert(!source.includes("body.user_id"), "no user id may be read from the request body");
});

Deno.test("the login function no longer keeps an in-memory limiter", async () => {
  const entry = await readFunction("login-with-phone/index.ts");
  assert(!entry.includes("new Map"), "the entry must not hold a per-instance map");
  const flow = await readFunction("_shared/phoneLoginFlow.ts");
  assert(flow.includes("aani_consume_login_attempt"), "the flow must use the shared database limiter");
  assert(!flow.includes("new Map"), "the flow must not fall back to a per-instance map");
});
