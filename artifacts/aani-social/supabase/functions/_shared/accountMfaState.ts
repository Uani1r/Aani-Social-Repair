// حالة التحقق بخطوتين على الخادم — المصدر الوحيد لحقيقة `app_metadata`.
//
// القواعد:
// - لا يُقرأ أي علم MFA من العميل: يُشتق من عوامل Supabase Auth نفسها.
// - التفعيل يتطلب جلسة صحيحة **و** aal2 **و** عاملاً TOTP مؤكداً؛ وإلا 403.
// - لا `user_metadata` في أي قرار.
// - الكتابة على `app_metadata` عبر Admin API وحدها، بدمج المفاتيح القائمة
//   وعدم حذف شيء منها.
// - لا رموز ولا أسرار في السجلات: رمز الحالة فقط.

export const MFA_STATE_FUNCTION = "account-mfa";
export const MFA_STATE_UNAUTHORIZED_MESSAGE = "يجب تسجيل الدخول لإدارة التحقق بخطوتين.";
export const MFA_STATE_LEVEL_REQUIRED_MESSAGE =
  "أكمل التحقق بخطوتين قبل تغيير حالة الحماية.";
export const MFA_STATE_UNAVAILABLE_MESSAGE =
  "تعذر تحديث حالة التحقق بخطوتين. حاول بعد قليل.";

type Deps = {
  fetchImpl: typeof fetch;
  env: (name: string) => string | undefined;
};

type AdminUser = {
  app_metadata?: Record<string, unknown>;
  factors?: Array<{ factor_type?: unknown; status?: unknown }>;
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

function requireBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match && match[1] ? match[1] : null;
}

/** يقرأ aal من حمولة الرمز بعد التحقق من الرمز نفسه عند Supabase Auth. */
export function readAssuranceLevel(token: string): "aal1" | "aal2" | "unknown" {
  const payload = token.split(".")[1];
  if (!payload) return "unknown";
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { aal?: unknown };
    return decoded.aal === "aal2" ? "aal2" : decoded.aal === "aal1" ? "aal1" : "unknown";
  } catch {
    return "unknown";
  }
}

export function countVerifiedTotpFactors(user: AdminUser): number {
  const factors = Array.isArray(user.factors) ? user.factors : [];
  return factors.filter(
    factor => factor?.factor_type === "totp" && factor?.status === "verified",
  ).length;
}

export function createMfaStateHandler(deps: Deps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405, origin);
    }

    const supabaseUrl = deps.env("SUPABASE_URL")?.replace(/\/+$/, "");
    const anonKey = deps.env("SUPABASE_ANON_KEY");
    const serviceRoleKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse({ error: MFA_STATE_UNAVAILABLE_MESSAGE }, 500, origin);
    }

    const accessToken = requireBearerToken(request.headers.get("authorization"));
    if (!accessToken) {
      return jsonResponse({ error: MFA_STATE_UNAUTHORIZED_MESSAGE }, 401, origin);
    }

    let body: { action?: unknown };
    try {
      body = await request.json() as { action?: unknown };
    } catch {
      return jsonResponse({ error: MFA_STATE_UNAVAILABLE_MESSAGE }, 400, origin);
    }
    if (!body || body.action !== "sync") {
      return jsonResponse({ error: MFA_STATE_UNAVAILABLE_MESSAGE }, 400, origin);
    }

    const serviceHeaders: HeadersInit = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };

    try {
      const userResponse = await deps.fetchImpl(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      });
      if (!userResponse.ok) {
        return jsonResponse({ error: MFA_STATE_UNAUTHORIZED_MESSAGE }, 401, origin);
      }
      const sessionUser = await userResponse.json() as { id?: unknown };
      const userId = typeof sessionUser?.id === "string" ? sessionUser.id : "";
      if (!userId) {
        return jsonResponse({ error: MFA_STATE_UNAUTHORIZED_MESSAGE }, 401, origin);
      }

      const adminResponse = await deps.fetchImpl(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        { headers: serviceHeaders },
      );
      if (!adminResponse.ok) {
        console.error(`[account-mfa] user lookup failed: status ${adminResponse.status}`);
        return jsonResponse({ error: MFA_STATE_UNAVAILABLE_MESSAGE }, 502, origin);
      }
      const adminUser = await adminResponse.json() as AdminUser;
      const verifiedTotp = countVerifiedTotpFactors(adminUser);

      // لا تفعيل بلا إثبات aal2: العامل المؤكد وحده لا يكفي.
      if (verifiedTotp > 0 && readAssuranceLevel(accessToken) !== "aal2") {
        return jsonResponse({ error: MFA_STATE_LEVEL_REQUIRED_MESSAGE }, 403, origin);
      }

      const mfaEnabled = verifiedTotp > 0;
      const appMetadata = {
        ...(adminUser.app_metadata && typeof adminUser.app_metadata === "object"
          ? adminUser.app_metadata
          : {}),
        mfa_enabled: mfaEnabled,
      };

      const updateResponse = await deps.fetchImpl(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: { ...serviceHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ app_metadata: appMetadata }),
        },
      );
      if (!updateResponse.ok) {
        console.error(`[account-mfa] app_metadata update failed: status ${updateResponse.status}`);
        return jsonResponse({ error: MFA_STATE_UNAVAILABLE_MESSAGE }, 502, origin);
      }

      return jsonResponse({ mfaEnabled, verifiedFactors: verifiedTotp }, 200, origin);
    } catch {
      console.error("[account-mfa] unexpected failure");
      return jsonResponse({ error: MFA_STATE_UNAVAILABLE_MESSAGE }, 500, origin);
    }
  };
}
