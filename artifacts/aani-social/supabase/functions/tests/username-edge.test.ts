// اختبارات Deno لدالة الدخول باسم المستخدم.
//
// تُشغَّل في CI بـ: deno test --allow-read tests/username-edge.test.ts
//
// ما تُثبته فعلياً (بلا شبكة ولا مشروع Supabase):
// - رفض الطلب بلا CAPTCHA أو بفشلها أو باختلاف hostname/action **قبل** أي
//   استهلاك للمحدّد أو أي بحث عن حساب.
// - محدّد المحاولات المشترك (aani_consume_login_attempt) بعد CAPTCHA، وبصمتان
//   منفصلتان بـHMAC: `username` و`ip`.
// - تعذر المحدّد أو غياب مفتاح HMAC صالح أو كونه سر الدور = رفض (fail-closed).
// - كلمة مرور خاطئة واسم مستخدم غير موجود يعيدان الرد نفسه بالحرف نفسه.
// - النجاح يعيد الرمزين فقط: لا بريد ولا اسم مستخدم ولا كائن user.
// - لا كلمة مرور ولا بريد في أي جسم رد ولا في السجلات.

import {
  USERNAME_LOGIN_CAPTCHA_ACTION,
  USERNAME_LOGIN_MESSAGES,
  USERNAME_RATE_MAX_ATTEMPTS,
  USERNAME_RATE_WINDOW_SECONDS,
  createUsernameLoginHandler,
  normalizeUsername,
} from "../_shared/usernameLoginFlow.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const USERNAME = "user.name";
const PASSWORD = "correct horse battery";
const EMAIL = "someone@example.com";
const HOSTNAME = "aani-social-repair.onrender.com";
const SERVICE_ROLE_KEY = "service-role-key-0123456789abcdef0123456789";

type RateRow = { attempts: number; resetAt: number };

type CaptchaState = { success: boolean; hostname: string; action: string; errorCodes?: unknown };

type FakeDb = {
  now: number;
  rateLimits: Map<string, RateRow>;
  rateLimitDown: boolean;
  profile: { username: string; userId: string } | null;
  passwords: Map<string, string>;
  captcha: CaptchaState;
  calls: string[];
  buckets: string[];
  ratePayloads: Array<{ p_bucket?: string; p_window_seconds?: number; p_max_attempts?: number }>;
  profileQueries: string[];
};

function createDb(): FakeDb {
  return {
    now: Date.UTC(2026, 0, 1, 12, 0, 0),
    rateLimits: new Map<string, RateRow>(),
    rateLimitDown: false,
    profile: { username: USERNAME, userId: "user-1" },
    passwords: new Map([[EMAIL, PASSWORD]]),
    captcha: { success: true, hostname: HOSTNAME, action: USERNAME_LOGIN_CAPTCHA_ACTION },
    calls: [],
    buckets: [],
    ratePayloads: [],
    profileQueries: [],
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

/** محدّد مشترك واحد تشترك فيه نسخ الدالة: نفس الخريطة ونفس القاعدة. */
function createFakeFetch(db: FakeDb): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    db.calls.push(url);

    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      if (!db.captcha.success) return json({ success: false, "error-codes": ["invalid-input-response"] });
      if (Object.prototype.hasOwnProperty.call(db.captcha, "errorCodes")) {
        return json({
          success: true,
          hostname: db.captcha.hostname,
          action: db.captcha.action,
          "error-codes": db.captcha.errorCodes,
        });
      }
      return json({ success: true, hostname: db.captcha.hostname, action: db.captcha.action });
    }

    if (url.includes("/rest/v1/rpc/aani_consume_login_attempt")) {
      if (db.rateLimitDown) return json({ message: "down" }, 500);
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        p_bucket?: string;
        p_window_seconds?: number;
        p_max_attempts?: number;
      };
      db.ratePayloads.push(payload);
      const bucket = payload.p_bucket ?? "";
      db.buckets.push(bucket);
      const existing = db.rateLimits.get(bucket);
      if (!existing || existing.resetAt <= db.now) {
        db.rateLimits.set(bucket, { attempts: 1, resetAt: db.now + USERNAME_RATE_WINDOW_SECONDS * 1000 });
        return json([{ allowed: true, remaining: USERNAME_RATE_MAX_ATTEMPTS - 1, retry_after_seconds: 0 }]);
      }
      if (existing.attempts >= USERNAME_RATE_MAX_ATTEMPTS) {
        return json([{
          allowed: false,
          remaining: 0,
          retry_after_seconds: Math.ceil((existing.resetAt - db.now) / 1000),
        }]);
      }
      existing.attempts += 1;
      return json([{
        allowed: true,
        remaining: USERNAME_RATE_MAX_ATTEMPTS - existing.attempts,
        retry_after_seconds: 0,
      }]);
    }

    if (url.includes("/rest/v1/profiles")) {
      const query = new URL(url).searchParams.get("username") ?? "";
      db.profileQueries.push(query);
      return json(db.profile && `eq.${db.profile.username}` === query ? [{ id: db.profile.userId }] : []);
    }

    if (url.includes("/auth/v1/admin/users/")) {
      const userId = url.slice(url.lastIndexOf("/") + 1);
      return db.profile && db.profile.userId === userId
        ? json({ user: { id: userId, email: EMAIL } })
        : json({ message: "not found" }, 404);
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
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  TURNSTILE_ALLOWED_HOSTNAMES: `${HOSTNAME},www.${HOSTNAME}`,
  LOGIN_RATE_LIMIT_HMAC_SECRET: "rate-limit-hmac-secret-0123456789abcdef",
};

function handlerWith(db: FakeDb, overrides: Record<string, string | undefined> = {}) {
  const env = { ...BASE_ENV, ...overrides } as Record<string, string | undefined>;
  return createUsernameLoginHandler({ fetchImpl: createFakeFetch(db), env: name => env[name] });
}

function loginRequest(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://project.test/functions/v1/login-with-username", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-ray": "9a1b2c3d4e5f6a7b-GRU",
      "cf-worker": "supabase.co",
      "cf-connecting-ip": "203.0.113.9",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

const FULL_BODY = { username: USERNAME, password: PASSWORD, captchaToken: "turnstile-token" };

Deno.test("the username is lower-cased, stripped of @ and validated", () => {
  assertEqual(normalizeUsername("User.Name"), USERNAME, "lower case");
  assertEqual(normalizeUsername("  @USER.NAME  "), USERNAME, "leading @ and spaces");
  assertEqual(normalizeUsername("user.name"), USERNAME, "already normalised");
  // الحد الأدنى محرف واحد (لا ثلاثة): الأسماء القصيرة صالحة في كل المواضع.
  for (const value of ["a", "7", "ab", "12", "123", "12345678901234567890", "abcdefghijklmnopqrst", "a_1.b"]) {
    assertEqual(normalizeUsername(value), value.toLowerCase(), `${value} must be accepted`);
  }
  for (const value of ["", "@", "user name", "user@name", "user-name", "x".repeat(33), 123, null]) {
    assertEqual(normalizeUsername(value), "", `${JSON.stringify(value)} must be refused`);
  }
});

Deno.test("a full sign-in returns the two tokens only, after captcha and the shared limiter", async () => {
  const db = createDb();
  const response = await handlerWith(db)(loginRequest({
    username: "@User.Name",
    password: PASSWORD,
    captchaToken: "turnstile-token",
  }));

  assertEqual(response.status, 200, "status");
  const body = await response.json() as Record<string, unknown>;
  assertEqual(
    Object.keys(body).sort(),
    ["access_token", "expires_in", "refresh_token", "token_type"],
    "body keys",
  );
  assert(!JSON.stringify(body).includes("@"), "the email must not be returned");
  assert(!JSON.stringify(body).includes(USERNAME), "the username must not be returned");
  assert(!("user" in body), "the auth user object must be dropped");

  const captchaIndex = db.calls.findIndex(url => url.includes("challenges.cloudflare.com"));
  const rateIndex = db.calls.findIndex(url => url.includes("aani_consume_login_attempt"));
  const profileIndex = db.calls.findIndex(url => url.includes("/rest/v1/profiles"));
  const tokenIndex = db.calls.findIndex(url => url.includes("/auth/v1/token"));
  assert(captchaIndex >= 0, "the captcha must be verified");
  assert(rateIndex > captchaIndex, "the shared limiter must run after the captcha");
  assert(profileIndex > rateIndex, "the profile lookup must run after the shared limiter");
  assert(tokenIndex > profileIndex, "the password check must run after the profile lookup");
  assertEqual(db.profileQueries, [`eq.${USERNAME}`], "the normalised username is the query");
});

Deno.test("the shared limiter is asked for the documented window and maximum", async () => {
  const db = createDb();
  const response = await handlerWith(db)(loginRequest(FULL_BODY));
  assertEqual(response.status, 200, "status");
  assertEqual(db.ratePayloads.length, 2, "a username bucket and an IP bucket");

  for (const payload of db.ratePayloads) {
    assertEqual(payload.p_window_seconds, USERNAME_RATE_WINDOW_SECONDS, "window");
    assertEqual(payload.p_max_attempts, USERNAME_RATE_MAX_ATTEMPTS, "max attempts");
  }
});

Deno.test("no account lookup happens without a captcha token", async () => {
  const db = createDb();
  const response = await handlerWith(db)(loginRequest({ username: USERNAME, password: PASSWORD }));

  assertEqual(response.status, 400, "status");
  assertEqual((await response.json()).error, USERNAME_LOGIN_MESSAGES.captchaRequired, "message");
  assert(!db.calls.some(url => url.includes("aani_consume_login_attempt")), "no limiter use");
  assert(!db.calls.some(url => url.includes("/rest/v1/profiles")), "no profile lookup");
  assert(!db.calls.some(url => url.includes("/auth/v1/token")), "no password check");
});

Deno.test("a failed, wrong-hostname or wrong-action captcha is refused before any lookup", async () => {
  const cases: Array<{ label: string; captcha: CaptchaState }> = [
    { label: "failed", captcha: { success: false, hostname: HOSTNAME, action: USERNAME_LOGIN_CAPTCHA_ACTION } },
    { label: "wrong hostname", captcha: { success: true, hostname: "evil.example", action: USERNAME_LOGIN_CAPTCHA_ACTION } },
    { label: "wrong action", captcha: { success: true, hostname: HOSTNAME, action: "phone_login" } },
    { label: "missing action", captcha: { success: true, hostname: HOSTNAME, action: "" } },
    { label: "expired token", captcha: { success: true, hostname: HOSTNAME, action: USERNAME_LOGIN_CAPTCHA_ACTION, errorCodes: ["timeout-or-duplicate"] } },
  ];

  for (const item of cases) {
    const db = createDb();
    db.captcha = item.captcha;
    const response = await handlerWith(db)(loginRequest(FULL_BODY));
    assertEqual(response.status, 400, `${item.label}: status`);
    assertEqual((await response.json()).error, USERNAME_LOGIN_MESSAGES.captchaRequired, `${item.label}: message`);
    assert(!db.calls.some(url => url.includes("aani_consume_login_attempt")), `${item.label}: no limiter use`);
    assert(!db.calls.some(url => url.includes("/rest/v1/profiles")), `${item.label}: no profile lookup`);
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
    const response = await handlerWith(db, overrides)(loginRequest(FULL_BODY));
    assertEqual(response.status, 503, "status");
    assertEqual((await response.json()).error, USERNAME_LOGIN_MESSAGES.captchaUnavailable, "message");
    assertEqual(db.calls.length, 0, "nothing must be called");
  }
});

Deno.test("the HMAC key must be its own strong value, never the service role key", async () => {
  const overridesList: Record<string, string | undefined>[] = [
    { LOGIN_RATE_LIMIT_HMAC_SECRET: undefined },
    { LOGIN_RATE_LIMIT_HMAC_SECRET: "" },
    { LOGIN_RATE_LIMIT_HMAC_SECRET: "short" },
    { LOGIN_RATE_LIMIT_HMAC_SECRET: "has a space inside the secret value" },
    { LOGIN_RATE_LIMIT_HMAC_SECRET: SERVICE_ROLE_KEY },
  ];

  for (const overrides of overridesList) {
    const db = createDb();
    const response = await handlerWith(db, overrides)(loginRequest(FULL_BODY));
    assertEqual(response.status, 503, "status");
    assertEqual((await response.json()).error, USERNAME_LOGIN_MESSAGES.rateLimitUnavailable, "message");
    assertEqual(db.calls.length, 0, "nothing must be called");
  }
});

Deno.test("a wrong password and an unknown username fail alike", async () => {
  const messages: unknown[] = [];

  const wrongPassword = createDb();
  const wrongPasswordResponse = await handlerWith(wrongPassword)(
    loginRequest({ ...FULL_BODY, password: "wrong password" }),
  );
  assertEqual(wrongPasswordResponse.status, 401, "wrong password status");
  messages.push((await wrongPasswordResponse.json()).error);

  const unknown = createDb();
  unknown.profile = { username: "someone.else", userId: "user-2" };
  const unknownResponse = await handlerWith(unknown)(loginRequest(FULL_BODY));
  assertEqual(unknownResponse.status, 401, "unknown username status");
  messages.push((await unknownResponse.json()).error);

  assertEqual(
    messages,
    [USERNAME_LOGIN_MESSAGES.invalidCredentials, USERNAME_LOGIN_MESSAGES.invalidCredentials],
    "one identical generic message",
  );
  assert(!JSON.stringify(messages).includes("@"), "no email in any failure");
  assert(!JSON.stringify(messages).includes("token"), "no token in any failure");
});

Deno.test("an unavailable limiter refuses the attempt without touching an account", async () => {
  const db = createDb();
  db.rateLimitDown = true;
  const response = await handlerWith(db)(loginRequest(FULL_BODY));

  assertEqual(response.status, 503, "status");
  assertEqual((await response.json()).error, USERNAME_LOGIN_MESSAGES.unavailable, "message");
  assert(!db.calls.some(url => url.includes("/rest/v1/profiles")), "no profile lookup");
  assert(!db.calls.some(url => url.includes("/auth/v1/token")), "no password check");
});

Deno.test("the shared limiter blocks repeated requests across handler instances", async () => {
  const db = createDb();
  const first = handlerWith(db);
  const second = handlerWith(db);

  for (let attempt = 1; attempt <= USERNAME_RATE_MAX_ATTEMPTS; attempt += 1) {
    const handler = attempt % 2 === 0 ? second : first;
    const response = await handler(loginRequest(FULL_BODY));
    assertEqual(response.status, 200, `attempt ${attempt}`);
  }

  const blocked = await second(loginRequest(FULL_BODY));
  assertEqual(blocked.status, 429, "the eleventh attempt must be refused by the other instance");
  assertEqual((await blocked.json()).error, USERNAME_LOGIN_MESSAGES.rateLimited, "the rate limit message");
});

Deno.test("the username and IP buckets are separate and keyed, and a forged header changes nothing", async () => {
  const plain = createDb();
  await handlerWith(plain)(loginRequest(FULL_BODY));

  const forged = createDb();
  await handlerWith(forged)(loginRequest(FULL_BODY, {
    "x-forwarded-for": "198.51.100.7",
    "x-real-ip": "198.51.100.8",
  }));

  assertEqual(plain.buckets.length, 2, "a username bucket and a trusted IP bucket");
  assert(plain.buckets.some(bucket => bucket.startsWith("login:username:")), "the username bucket");
  assert(plain.buckets.some(bucket => bucket.startsWith("login:ip:")), "the IP bucket");
  assert(!plain.buckets.some(bucket => bucket.includes(USERNAME)), "the username is never stored raw");
  assert(!plain.buckets.some(bucket => bucket.includes("203.0.113.9")), "the address is never stored raw");
  assertEqual(forged.buckets, plain.buckets, "the forged headers must not change any bucket");
});

Deno.test("without a trusted IP only the username bucket applies", async () => {
  const db = createDb();
  const response = await handlerWith(db)(loginRequest(FULL_BODY, {
    "cf-ray": "",
    "cf-worker": "",
    "cf-connecting-ip": "",
  }));

  assertEqual(response.status, 200, "status");
  assertEqual(db.buckets.length, 1, "one bucket only");
  assert(db.buckets[0].startsWith("login:username:"), "the username bucket");
});

Deno.test("OPTIONS is answered without a store, and other methods are refused", async () => {
  const db = createDb();
  const handler = handlerWith(db);

  const preflight = await handler(new Request("https://project.test/functions/v1/login-with-username", {
    method: "OPTIONS",
    headers: { origin: "https://aani-social-repair.onrender.com" },
  }));
  assertEqual(preflight.status, 204, "preflight status");
  assertEqual(preflight.headers.get("cache-control"), "no-store", "preflight cache");
  assertEqual(
    preflight.headers.get("access-control-allow-origin"),
    "https://aani-social-repair.onrender.com",
    "preflight origin",
  );
  assertEqual(db.calls.length, 0, "the preflight must not call anything");

  const get = await handler(new Request("https://project.test/functions/v1/login-with-username", { method: "GET" }));
  assertEqual(get.status, 405, "GET is refused");
  assertEqual(db.calls.length, 0, "a refused method must not call anything");
});

Deno.test("logging never prints a password, an email or a token", async () => {
  const db = createDb();
  db.passwords.clear();

  const original = console.error;
  const recorded: string[] = [];
  console.error = (...parts: unknown[]) => {
    recorded.push(parts.map(part => String(part)).join(" "));
  };
  try {
    const response = await handlerWith(db)(loginRequest({ ...FULL_BODY, password: "wrong password" }));
    assertEqual(response.status, 401, "status");
  } finally {
    console.error = original;
  }

  const joined = recorded.join("\n");
  assert(recorded.length >= 1, "a failure is logged");
  assert(!joined.includes("wrong password"), "a password must never be logged");
  assert(!joined.includes(EMAIL), "an email must never be logged");
  assert(!joined.includes("turnstile-token"), "a captcha token must never be logged");
  assert(!joined.includes("access-token"), "a session token must never be logged");
});
