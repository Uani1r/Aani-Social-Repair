// حذف الحساب نهائياً من الخادم — بلا bucket ثابت وبلا حذف جزئي للوسائط.
//
// التصميم:
// 1) الهوية من رمز الجلسة الموثّق فقط (`/auth/v1/user`)، ولا `user_id` من جسم
//    الطلب ولا من أي ترويسة يرسلها العميل.
// 2) لا يُحذف أي ملف تخزين هنا: لا bucket `aani-media` ولا غيره. الوسائط تدخل
//    طابور `media_deletion_jobs` بمشغّلات قاعدة البيانات بعد حذف الصفوف،
//    ويتحقق Worker من المراجع الحية قبل حذف أي ملف مشترك.
// 3) حذف حساب Auth عبر Admin API بعد التحقق، وحده المسؤول عن التتابع
//    (ON DELETE CASCADE) الذي يُدرج مهام الوسائط.
// 4) فشل الحذف لا يترك حالة جزئية صامتة: يُعاد فشل صريح برسالة عامة، ولا
//    يُقال إن الحساب حُذف. تكرار الطلب لحساب محذوف يُعدّ نجاحاً (idempotent).
// 5) لا تُطبع رموز ولا معرّفات ولا أجسام أخطاء: رمز الحالة فقط.

export const ACCOUNT_DELETION_FUNCTION = "delete-account";
export const DELETION_CONFIRMATION = "delete";
export const DELETION_UNAUTHORIZED_MESSAGE = "يجب تسجيل الدخول لحذف الحساب.";
export const DELETION_CONFIRMATION_MESSAGE = "تأكيد الحذف مطلوب.";
export const DELETION_FAILED_MESSAGE =
  "تعذر حذف الحساب وبياناته. لم يُحذف الحساب ولم تُحذف وسائطه؛ حاول مجددًا أو تواصل مع الدعم.";

type Deps = {
  fetchImpl: typeof fetch;
  env: (name: string) => string | undefined;
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

export function createDeleteAccountHandler(deps: Deps): (request: Request) => Promise<Response> {
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
      return jsonResponse({ error: DELETION_FAILED_MESSAGE }, 500, origin);
    }

    const accessToken = requireBearerToken(request.headers.get("authorization"));
    if (!accessToken) {
      return jsonResponse({ error: DELETION_UNAUTHORIZED_MESSAGE }, 401, origin);
    }

    let body: { confirmation?: unknown };
    try {
      body = await request.json() as { confirmation?: unknown };
    } catch {
      return jsonResponse({ error: DELETION_CONFIRMATION_MESSAGE }, 400, origin);
    }
    if (!body || body.confirmation !== DELETION_CONFIRMATION) {
      return jsonResponse({ error: DELETION_CONFIRMATION_MESSAGE }, 400, origin);
    }

    try {
      const userResponse = await deps.fetchImpl(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      });
      if (!userResponse.ok) {
        return jsonResponse({ error: DELETION_UNAUTHORIZED_MESSAGE }, 401, origin);
      }
      const sessionUser = await userResponse.json() as { id?: unknown };
      const userId = typeof sessionUser?.id === "string" ? sessionUser.id : "";
      if (!userId) {
        return jsonResponse({ error: DELETION_UNAUTHORIZED_MESSAGE }, 401, origin);
      }

      const deleteResponse = await deps.fetchImpl(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}?should_soft_delete=false`,
        {
          method: "DELETE",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );

      // تكرار الطلب: الحساب محذوف سابقاً = نجاح، لا فشل مضلّل.
      if (deleteResponse.status === 404) {
        return jsonResponse({ success: true, alreadyDeleted: true }, 200, origin);
      }
      if (!deleteResponse.ok) {
        console.error(`[delete-account] Auth deletion failed: status ${deleteResponse.status}`);
        return jsonResponse({ error: DELETION_FAILED_MESSAGE }, 502, origin);
      }

      // الوسائط لم تُمس هنا: المشغّلات أدرجتها في طابور الحذف، والـWorker
      // يتحقق من المراجع الحية قبل أي حذف.
      return jsonResponse({ success: true, mediaQueued: true }, 200, origin);
    } catch {
      console.error("[delete-account] unexpected failure");
      return jsonResponse({ error: DELETION_FAILED_MESSAGE }, 500, origin);
    }
  };
}
