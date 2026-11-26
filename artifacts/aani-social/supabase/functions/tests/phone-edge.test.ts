// اختبارات Deno لدالتي رقم الدخول بالهاتف.
//
// تُشغَّل في CI بـ: deno test --allow-read tests/phone-edge.test.ts
//
// ما تُثبته فعلياً (بلا شبكة ولا Supabase):
// - تطبيع الرقم (محلي عراقي، دولي، غير صالح).
// - بوابة الجلسة: لا رمز حامل صالح → لا وصول لدالة إدارة الرقم.
// - بناء الجلسة: رمزان فقط، وبلا بريد أو كائن user، وفشل عند استجابة ناقصة.
// - جسم الفشل: رسالة فقط، وبلا رموز جلسة.
// - السجل: لا يُطبع أي قيمة من الطلب (رقم، كلمة مرور، رمز، بريد).
// - CAPTCHA: تحقق خادمي حقيقي الاستدعاء (fetch مزيّف) ورفض عند الخطأ.
// - المصدر: لا console مباشر في الدالتين، ولا service_role في أي جسم رد،
//   وفحص الجلسة يسبق أي RPC في دالة إدارة الرقم.

import {
  PHONE_MESSAGES,
  failureBody,
  logFailure,
  normalizePhoneToE164,
  redactForLog,
  requireBearerToken,
  sessionTokens,
  verifyTurnstileToken,
} from "../_shared/phone.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("normalises Iraqi local and international numbers and rejects others", () => {
  assertEqual(normalizePhoneToE164("07701234567"), "+9647701234567", "local");
  assertEqual(normalizePhoneToE164("0770 123 4567"), "+9647701234567", "local with spaces");
  assertEqual(normalizePhoneToE164("+9647701234567"), "+9647701234567", "international");
  assertEqual(normalizePhoneToE164("009647701234567"), "+9647701234567", "international with 00");
  assertEqual(normalizePhoneToE164("7701234567"), "+9647701234567", "national without a zero is normalised");
  assertEqual(normalizePhoneToE164("12"), null, "too short");
  assertEqual(normalizePhoneToE164(""), null, "empty");
  assertEqual(normalizePhoneToE164("+0123456789"), null, "no leading zero after +");
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
    user: { id: "user-id", email: "someone@example.com" },
    email: "someone@example.com",
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
  const original = console.error;
  const recorded: string[] = [];
  console.error = (...parts: unknown[]) => {
    recorded.push(parts.map(part => String(part)).join(" "));
  };
  try {
    const secretError = new Error("password=hunter2 phone=+9647701234567 token=eyJhbGciOi email=a@b.co");
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

Deno.test("captcha verification is server-side and fails closed", async () => {
  const accepted = await verifyTurnstileToken("token", "secret", (async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch);
  assert(accepted, "a successful verification must pass");

  const refused = await verifyTurnstileToken("token", "secret", (async () =>
    new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch);
  assert(!refused, "a failed verification must be refused");

  const httpError = await verifyTurnstileToken("token", "secret", (async () =>
    new Response("nope", { status: 500 })) as typeof fetch);
  assert(!httpError, "an HTTP error must be refused");

  const networkError = await verifyTurnstileToken("token", "secret", (async () => {
    throw new Error("network");
  }) as typeof fetch);
  assert(!networkError, "a network error must be refused");

  const noToken = await verifyTurnstileToken("", "secret", (async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch);
  assert(!noToken, "a missing token must be refused");

  const noSecret = await verifyTurnstileToken("token", "", (async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch);
  assert(!noSecret, "a missing secret must be refused");

  let requestedBody = "";
  await verifyTurnstileToken("token", "secret", (async (_input: string | URL | Request, init?: RequestInit) => {
    requestedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch, "203.0.113.7");
  assert(requestedBody.includes("secret=secret"), "the secret is sent to Turnstile only");
  assert(requestedBody.includes("response=token"), "the token is sent to Turnstile");
  assert(requestedBody.includes("remoteip=203.0.113.7"), "the platform IP is sent when present");
});

const FUNCTIONS_DIR = new URL("../", import.meta.url);

async function readFunction(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, FUNCTIONS_DIR));
}

Deno.test("both functions log only through the shared redactor", async () => {
  for (const file of ["account-phone-alias/index.ts", "login-with-phone/index.ts"]) {
    const source = await readFunction(file);
    assert(!source.includes("console.error("), `${file} must not call console.error directly`);
    assert(!source.includes("console.log("), `${file} must not call console.log directly`);
    assert(source.includes('from "../_shared/phone.ts"'), `${file} must use the shared phone helpers`);
  }
  const shared = await readFunction("_shared/phone.ts");
  assert(shared.includes("redactForLog"), "the shared module owns the redaction");
});

Deno.test("no response body carries the service role key or the account email", async () => {
  for (const file of ["account-phone-alias/index.ts", "login-with-phone/index.ts"]) {
    const source = await readFunction(file);
    for (const line of source.split("\n")) {
      if (line.includes("jsonResponse(")) {
        assert(!line.includes("serviceRoleKey"), `${file} must not return the service role key`);
        assert(!line.includes("email"), `${file} must not return the account email`);
      }
    }
  }
  const login = await readFunction("login-with-phone/index.ts");
  assert(login.includes("sessionTokens("), "the login function must strip the session to two tokens");
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

Deno.test("a failed sign-in path never answers with a session", async () => {
  const source = await readFunction("login-with-phone/index.ts");
  const failure = source.indexOf("PHONE_MESSAGES.invalidCredentials");
  const success = source.indexOf("return jsonResponse(tokens, 200, origin);");
  assert(failure > 0, "the generic failure must exist");
  assert(success > failure, "the session is returned only after the failure path");
  assert(source.includes("PHONE_MESSAGES.captchaUnavailable"), "the feature is gated until captcha is configured");
  assert(source.includes("verifyTurnstileToken("), "captcha is verified on the server");
  assert(!source.includes("body.user_id"), "no user id may be read from the request body");
});
