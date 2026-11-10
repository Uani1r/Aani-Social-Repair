// قراءة بيانات المستلم من قاعدة البيانات عبر Supabase REST
// باستخدام مفتاح service_role (يتجاوز RLS) لأن الوصول هنا خلفي فقط.

export type ProfilePushSettings = {
  fcm_token?: unknown;
  notification_settings?: unknown;
};

export type RecipientPushProfile = {
  fcmToken: string;
  notificationSettings: Record<string, unknown> | null;
};

export type SupabaseAdminConfig = {
  url: string;
  serviceRoleKey: string;
};

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function readSupabaseAdminConfig(): SupabaseAdminConfig | null {
  const url = process.env["SUPABASE_URL"] || "";
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] || "";
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

function adminHeaders(serviceRoleKey: string) {
  return { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` };
}

async function queryRest(
  config: SupabaseAdminConfig,
  table: string,
  searchParams: Record<string, string>,
): Promise<unknown[] | null> {
  const url = new URL(`/rest/v1/${table}`, config.url);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: adminHeaders(config.serviceRoleKey) });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as unknown[] | null;
}

// الرمز محفوظ على الملف الشخصي (profiles.fcm_token)؛ وإن لم يوجد
// نجرّب جدول user_tokens إن كان موجوداً في المشروع.
export async function fetchRecipientPushProfile(
  config: SupabaseAdminConfig,
  userId: string,
): Promise<RecipientPushProfile | null> {
  const profiles = await queryRest(config, "profiles", {
    select: "fcm_token,notification_settings",
    id: `eq.${userId}`,
    limit: "1",
  });
  if (!profiles) return null;

  const profile = profiles[0] as ProfilePushSettings | undefined;
  let token = asText(profile?.fcm_token);

  if (!token) {
    const rows = await queryRest(config, "user_tokens", {
      select: "token",
      user_id: `eq.${userId}`,
      limit: "1",
    });
    token = asText((rows?.[0] as { token?: unknown } | undefined)?.token);
  }

  const rawSettings = profile?.notification_settings;
  return {
    fcmToken: token,
    notificationSettings:
      rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
        ? (rawSettings as Record<string, unknown>)
        : null,
  };
}

export async function getPostIdForComment(
  config: SupabaseAdminConfig,
  commentId: string,
): Promise<string> {
  const rows = await queryRest(config, "comments", {
    select: "post_id",
    id: `eq.${commentId}`,
    limit: "1",
  });
  return asText((rows?.[0] as { post_id?: unknown } | undefined)?.post_id);
}

// نوع المحتوى الحقيقي للمنشور (reel / photo / video / text ...)
// يُستخدم لتوجيه إشعار الريل إلى مشغّل الريلز الخاص به.
export async function getPostType(
  config: SupabaseAdminConfig,
  postId: string,
): Promise<string> {
  const rows = await queryRest(config, "posts", {
    select: "type",
    id: `eq.${postId}`,
    limit: "1",
  });
  return asText((rows?.[0] as { type?: unknown } | undefined)?.type);
}
