// حساب رقم الدخول بالهاتف (alias) — إضافة أو تغيير أو حذف أو قراءة رقم
// الحساب نفسه، بلا SMS وبلا OTP.
//
// الأمان:
// - الهوية من جلسة المستخدم فقط: يُتحقق من JWT عبر Supabase Auth
//   (`/auth/v1/user`) ولا يُقرأ أي user_id من جسم الطلب.
// - كل عمليات الكتابة للحساب نفسه فقط، ولا يُعاد شيء عن حساب آخر.
// - service_role يبقى في الخادم فقط، ولا يصل إلى الواجهة.
// - لا يُكتب الرقم في auth.users، ولا يُستخدم phone_confirm، ولا تُرسل رسالة.
// - الجدول نفسه مقفل على anon/authenticated (RLS بلا سياسات + سحب الصلاحيات)،
//   والوصول عبر الدوال المصرح بها لـ service_role، وقيد UNIQUE هو ما يمنع
//   حجز الرقم نفسه حتى مع طلبات متزامنة.
// - لا تُطبع قيمة الرقم ولا رموز الجلسة: كل سجل يمر عبر logFailure.

import {
  PHONE_MESSAGES,
  failureBody,
  logFailure,
  normalizePhoneToE164,
  requireBearerToken,
} from "../_shared/phone.ts";

type AliasAction = "read" | "set" | "delete";

type AliasRequestBody = {
  action?: unknown;
  phone?: unknown;
};

type PostgrestError = {
  code?: unknown;
  message?: unknown;
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

/** الهوية من الجلسة فقط: Supabase Auth يتحقق من الرمز ويعيد المستخدم. */
async function resolveSessionUserId(
  request: Request,
  supabaseUrl: string,
  anonKey: string,
): Promise<string | null> {
  const token = requireBearerToken(request.headers.get("authorization"));
  if (!token) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json() as { id?: unknown };
  return typeof user?.id === "string" && user.id ? user.id : null;
}

function mapWriteFailure(status: number, payload: PostgrestError | null, origin: string | null): Response {
  const code = typeof payload?.code === "string" ? payload.code : "";
  const message = typeof payload?.message === "string" ? payload.message : "";
  if (code === "23505" || /duplicate|unique/i.test(message)) {
    return jsonResponse(failureBody(PHONE_MESSAGES.phoneTaken), 409, origin);
  }
  if (code === "23514" || code === "22023" || /check|invalid/i.test(message)) {
    return jsonResponse(failureBody(PHONE_MESSAGES.invalidPhone), 400, origin);
  }
  logFailure("[account-phone-alias] Alias write failed", status);
  return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse(failureBody("Method not allowed."), 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
  }

  const userId = await resolveSessionUserId(request, supabaseUrl, anonKey);
  if (!userId) return jsonResponse(failureBody(PHONE_MESSAGES.unauthorized), 401, origin);

  let body: AliasRequestBody;
  try {
    body = await request.json() as AliasRequestBody;
  } catch {
    return jsonResponse(failureBody(PHONE_MESSAGES.invalidPhone), 400, origin);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(failureBody(PHONE_MESSAGES.invalidPhone), 400, origin);
  }

  const action: AliasAction | null =
    body.action === "read" || body.action === "set" || body.action === "delete" ? body.action : null;
  if (!action) return jsonResponse(failureBody("إجراء غير معروف."), 400, origin);

  if (action === "read") {
    const lookupUrl = new URL(`${supabaseUrl}/rest/v1/account_phone_aliases`);
    lookupUrl.searchParams.set("select", "phone_e164");
    lookupUrl.searchParams.set("user_id", `eq.${userId}`);
    lookupUrl.searchParams.set("limit", "1");
    const response = await fetch(lookupUrl, { headers: serviceHeaders(serviceRoleKey) });
    if (!response.ok) {
      logFailure("[account-phone-alias] Alias read failed", response.status);
      return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
    }
    const rows = await response.json() as { phone_e164?: unknown }[];
    const phone = Array.isArray(rows) && typeof rows[0]?.phone_e164 === "string" ? rows[0].phone_e164 : null;
    return jsonResponse({ phone }, 200, origin);
  }

  if (action === "delete") {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/aani_delete_account_phone_alias`, {
      method: "POST",
      headers: { ...serviceHeaders(serviceRoleKey), "Content-Type": "application/json" },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!response.ok) {
      logFailure("[account-phone-alias] Alias delete failed", response.status);
      return jsonResponse(failureBody(PHONE_MESSAGES.unavailable), 500, origin);
    }
    return jsonResponse({ phone: null }, 200, origin);
  }

  const phone = typeof body.phone === "string" ? normalizePhoneToE164(body.phone) : null;
  if (!phone) return jsonResponse(failureBody(PHONE_MESSAGES.invalidPhone), 400, origin);

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/aani_set_account_phone_alias`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "Content-Type": "application/json" },
    body: JSON.stringify({ p_user_id: userId, p_phone_e164: phone }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as PostgrestError | null;
    return mapWriteFailure(response.status, payload, origin);
  }

  return jsonResponse({ phone }, 200, origin);
});
