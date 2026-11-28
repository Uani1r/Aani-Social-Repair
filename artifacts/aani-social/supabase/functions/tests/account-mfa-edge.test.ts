// اختبارات Deno لدالتي MFA وحذف الحساب.
//
// تُشغَّل بـ: deno test --allow-read tests/account-mfa-edge.test.ts
// بلا شبكة ولا مشروع Supabase: كل نداء يمر عبر fetch مزيّف، ونتحقق من ترتيب
// الخطوات ومن ألا يُكتب app_metadata قبل aal2، وأن الحذف لا يلمس التخزين.

import {
  MFA_STATE_LEVEL_REQUIRED_MESSAGE,
  MFA_STATE_UNAUTHORIZED_MESSAGE,
  MFA_STATE_UNAVAILABLE_MESSAGE,
  countVerifiedTotpFactors,
  createMfaStateHandler,
  readAssuranceLevel,
} from "../_shared/accountMfaState.ts";
import {
  DELETION_CONFIRMATION_MESSAGE,
  DELETION_UNAUTHORIZED_MESSAGE,
  createDeleteAccountHandler,
} from "../_shared/accountDeletion.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const VERIFIED_TOTP = { factor_type: "totp", status: "verified", friendly_name: "Aani" };
const UNVERIFIED_TOTP = { factor_type: "totp", status: "unverified" };

function token(aal: "aal1" | "aal2"): string {
  const payload = btoa(JSON.stringify({ sub: "user-1", aal }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

type Db = {
  aal: "aal1" | "aal2";
  factors: Array<Record<string, unknown>>;
  adminFails?: boolean;
  deleteStatus?: number;
  calls: string[];
  lastMetadata?: Record<string, unknown>;
};

function createDb(overrides: Partial<Db> = {}): Db {
  return {
    aal: "aal1",
    factors: [],
    calls: [],
    ...overrides,
  };
}

function fakeFetch(db: Db): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    db.calls.push(`${method} ${url}`);

    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "user-1", app_metadata: {} }), { status: 200 });
    }
    if (url.includes("/auth/v1/admin/users/") && method === "GET") {
      if (db.adminFails) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({
        app_metadata: { provider: "email", existing: "keep" },
        factors: db.factors,
      }), { status: 200 });
    }
    if (url.includes("/auth/v1/admin/users/") && method === "PUT") {
      db.lastMetadata = JSON.parse(String(init?.body ?? "{}")).app_metadata;
      return new Response("{}", { status: 200 });
    }
    if (url.includes("/auth/v1/admin/users/") && method === "DELETE") {
      return new Response("{}", { status: db.deleteStatus ?? 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function mfaRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://project.test/functions/v1/account-mfa", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function env(name: string): string | undefined {
  const values: Record<string, string> = {
    SUPABASE_URL: "https://project.test",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  return values[name];
}

Deno.test("the assurance level is read from the verified token payload only", () => {
  assertEqual(readAssuranceLevel(token("aal2")), "aal2", "aal2");
  assertEqual(readAssuranceLevel(token("aal1")), "aal1", "aal1");
  assertEqual(readAssuranceLevel("not-a-jwt"), "unknown", "garbage");
  assertEqual(readAssuranceLevel(""), "unknown", "empty");
});

Deno.test("only verified TOTP factors count as MFA", () => {
  assertEqual(countVerifiedTotpFactors({ factors: [VERIFIED_TOTP] }), 1, "one verified");
  assertEqual(countVerifiedTotpFactors({ factors: [UNVERIFIED_TOTP] }), 0, "unverified does not count");
  assertEqual(countVerifiedTotpFactors({ factors: [{ factor_type: "sms", status: "verified" }] }), 0, "sms does not count");
  assertEqual(countVerifiedTotpFactors({}), 0, "no factors");
});

Deno.test("a request without a session or with the wrong shape is refused", async () => {
  const db = createDb();
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const unauthorized = await handler(mfaRequest({ action: "sync" }));
  assertEqual(unauthorized.status, 401, "no token");
  assertEqual((await unauthorized.json()).error, MFA_STATE_UNAUTHORIZED_MESSAGE, "message");

  const get = new Request("https://project.test/functions/v1/account-mfa", { method: "GET" });
  assertEqual((await handler(get)).status, 405, "GET is refused");

  const badAction = await handler(mfaRequest({ action: "enable" }, { authorization: `Bearer ${token("aal2")}` }));
  assertEqual(badAction.status, 400, "unknown action");
  assertEqual(db.calls.some(call => call.includes("admin/users")), false, "no admin call");
});

Deno.test("a verified factor at aal1 never writes app_metadata", async () => {
  const db = createDb({ aal: "aal1", factors: [VERIFIED_TOTP] });
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(mfaRequest({ action: "sync" }, { authorization: `Bearer ${token("aal1")}` }));

  assertEqual(response.status, 403, "status");
  assertEqual((await response.json()).error, MFA_STATE_LEVEL_REQUIRED_MESSAGE, "message");
  assertEqual(db.lastMetadata, undefined, "no metadata write");
  assertEqual(db.calls.some(call => call.startsWith("PUT")), false, "no PUT");
});

Deno.test("aal2 with a verified factor enables MFA and keeps the existing app_metadata", async () => {
  const db = createDb({ aal: "aal2", factors: [VERIFIED_TOTP] });
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(mfaRequest({ action: "sync" }, { authorization: `Bearer ${token("aal2")}` }));
  assertEqual(response.status, 200, "status");
  assertEqual((await response.json()).mfaEnabled, true, "enabled");
  assertEqual(db.lastMetadata, { provider: "email", existing: "keep", mfa_enabled: true }, "metadata merge");
});

Deno.test("no verified factor disables MFA without requiring aal2", async () => {
  const db = createDb({ aal: "aal1", factors: [UNVERIFIED_TOTP] });
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(mfaRequest({ action: "sync" }, { authorization: `Bearer ${token("aal1")}` }));
  assertEqual(response.status, 200, "status");
  assertEqual((await response.json()).mfaEnabled, false, "disabled");
  assertEqual(db.lastMetadata, { provider: "email", existing: "keep", mfa_enabled: false }, "metadata merge");
});

Deno.test("an admin lookup failure keeps the previous state and fails closed", async () => {
  const db = createDb({ aal: "aal2", factors: [VERIFIED_TOTP], adminFails: true });
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(mfaRequest({ action: "sync" }, { authorization: `Bearer ${token("aal2")}` }));
  assertEqual(response.status, 502, "status");
  assertEqual(db.lastMetadata, undefined, "no write on failure");
});

Deno.test("deletion needs a session and the confirmation word", async () => {
  const db = createDb();
  const handler = createDeleteAccountHandler({ fetchImpl: fakeFetch(db), env });

  const unauthorized = await handler(new Request("https://project.test/functions/v1/delete-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "delete" }),
  }));
  assertEqual(unauthorized.status, 401, "no token");
  assertEqual((await unauthorized.json()).error, DELETION_UNAUTHORIZED_MESSAGE, "message");

  const unconfirmed = await handler(new Request("https://project.test/functions/v1/delete-account", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token("aal2")}` },
    body: JSON.stringify({ confirmation: "yes" }),
  }));
  assertEqual(unconfirmed.status, 400, "confirmation");
  assertEqual((await unconfirmed.json()).error, DELETION_CONFIRMATION_MESSAGE, "message");
  assertEqual(db.calls.some(call => call.startsWith("DELETE")), false, "no deletion call");
});

Deno.test("deletion never touches storage and reports success only after Auth deletion", async () => {
  const db = createDb({ deleteStatus: 200 });
  const handler = createDeleteAccountHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(new Request("https://project.test/functions/v1/delete-account", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token("aal2")}` },
    body: JSON.stringify({ confirmation: "delete" }),
  }));

  assertEqual(response.status, 200, "status");
  assertEqual((await response.json()).success, true, "success");
  assertEqual(db.calls.some(call => call.includes("/storage/v1")), false, "no storage call");
  assertEqual(db.calls.some(call => call.includes("aani-media")), false, "no bucket name");
  assertEqual(db.calls.filter(call => call.startsWith("DELETE")).length, 1, "one deletion call");
});

Deno.test("a failed deletion is reported as a failure, and a repeat is idempotent", async () => {
  const failing = createDb({ deleteStatus: 500 });
  const handler = createDeleteAccountHandler({ fetchImpl: fakeFetch(failing), env });
  const failed = await handler(new Request("https://project.test/functions/v1/delete-account", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token("aal2")}` },
    body: JSON.stringify({ confirmation: "delete" }),
  }));
  assertEqual(failed.status, 502, "status");
  const failedBody = await failed.json();
  assertEqual(failedBody.success, undefined, "no success flag");
  assertEqual(failing.calls.some(call => call.includes("/storage/v1")), false, "no storage call");

  const repeat = createDb({ deleteStatus: 404 });
  const repeatHandler = createDeleteAccountHandler({ fetchImpl: fakeFetch(repeat), env });
  const repeated = await repeatHandler(new Request("https://project.test/functions/v1/delete-account", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token("aal2")}` },
    body: JSON.stringify({ confirmation: "delete" }),
  }));
  assertEqual(repeated.status, 200, "idempotent status");
  assertEqual((await repeated.json()).alreadyDeleted, true, "already deleted");
});


Deno.test("the preflight is answered without a store and without touching the account", async () => {
  const db = createDb();
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(new Request("https://project.test/functions/v1/account-mfa", {
    method: "OPTIONS",
    headers: { origin: "https://aani-social-repair.onrender.com" },
  }));

  assertEqual(response.status, 204, "preflight status");
  assertEqual(response.headers.get("cache-control"), "no-store", "preflight cache");
  assertEqual(
    response.headers.get("access-control-allow-origin"),
    "https://aani-social-repair.onrender.com",
    "preflight origin",
  );
  assertEqual(db.calls.length, 0, "the preflight must not call anything");
});

Deno.test("the success body carries the state only, never a session or an email", async () => {
  const db = createDb({ aal: "aal2", factors: [VERIFIED_TOTP] });
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(mfaRequest({ action: "sync" }, { authorization: `Bearer ${token("aal2")}` }));
  assertEqual(response.status, 200, "status");

  const body = await response.json() as Record<string, unknown>;
  assertEqual(Object.keys(body).sort(), ["mfaEnabled", "verifiedFactors"], "body keys");
  assertEqual(body.mfaEnabled, true, "enabled");
  assertEqual(body.verifiedFactors, 1, "one verified factor");
  assert(!("access_token" in body), "no access token");
  assert(!("email" in body), "no email");
});

Deno.test("a failed admin lookup answers with the shared unavailable message and no state", async () => {
  const db = createDb({ aal: "aal2", factors: [VERIFIED_TOTP], adminFails: true });
  const handler = createMfaStateHandler({ fetchImpl: fakeFetch(db), env });

  const response = await handler(mfaRequest({ action: "sync" }, { authorization: `Bearer ${token("aal2")}` }));
  assertEqual(response.status, 502, "status");

  const body = await response.json() as Record<string, unknown>;
  assertEqual(Object.keys(body), ["error"], "only an error key");
  assertEqual(body.error, MFA_STATE_UNAVAILABLE_MESSAGE, "the shared message");
  assert(!("mfaEnabled" in body), "no state on failure");
  assertEqual(db.lastMetadata, undefined, "no metadata write");
});
