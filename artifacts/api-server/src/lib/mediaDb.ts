// أدوات Supabase REST للمهام الخلفية الموثوقة (service_role يتجاوز RLS).
// قاعدة صارمة: أي فحص مراجع فاشل يرمي استثناءً — الحذف يُؤجل ولا يُنفذ أبداً
// على فشل استعلام أو بيانات غير قابلة للتحقق.

import {
  readSupabaseAdminConfig,
  type SupabaseAdminConfig,
} from "./supabaseAdmin";
import { logger } from "./logger";

export type { SupabaseAdminConfig };
export function readAdminConfig(): SupabaseAdminConfig | null {
  return readSupabaseAdminConfig();
}

/** الرابط الأساسي للوسائط بلا معاملات تحويل (?tr=) ولا هاشتاغ تعديل (#t=). */
export function normalizeMediaUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    // روابط نسبية قديمة (مسارات Supabase Storage) — نكتفِ بإزالة الزخرفة
    return value.split(/[?#]/)[0];
  }
}

export class MediaReferenceCheckError extends Error {}

/**
 تحقق إلزامي: لا تعتبر قائمة فارغة دليلاً على عدم وجود مراجع —
 فشل الاستعلام أو البيانات غير القابلة للتحقق يمنع الحذف.
 */
export async function requireSuccessfulCheck(
  result: { ok: boolean; status: number; data: unknown },
): Promise<Record<string, unknown>[]> {
  if (!result.ok) {
    throw new MediaReferenceCheckError(`Media reference check failed: HTTP ${result.status}`);
  }
  if (result.data === null) {
    throw new MediaReferenceCheckError("Media reference check returned no verifiable data.");
  }
  if (!Array.isArray(result.data)) {
    throw new MediaReferenceCheckError("Media reference check returned unexpected data.");
  }
  return result.data as Record<string, unknown>[];
}

/**
 عمود غير موجود في هذه البيئة (ترحيل مفقود): الجدول لا يحمل مراجع بهذا الشكل.
 يُسجل ويُتجاهل كجدول — هذا ليس "قائمة فارغة = آمن" بل غياب العمود نفسه.
 */
export function isUnknownColumnError(result: { status: number; data: unknown }): boolean {
  const message =
    result.data && typeof result.data === "object" && "message" in (result.data as Record<string, unknown>)
      ? String((result.data as Record<string, unknown>).message)
      : "";
  return result.status === 400
    && (message.includes("does not exist")
      || message.includes("Could not find the '")
      || message.includes("PGRST204"));
}

export async function restRequest(
  config: SupabaseAdminConfig,
  method: string,
  path: string,
  searchParams: Record<string, string> = {},
  body?: Record<string, unknown> | Record<string, unknown>[],
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = new URL(`/rest/v1/${path}`, config.url);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = response.ok ? await response.json().catch(() => null) : null;
  return { ok: response.ok, status: response.status, data };
}

/**
 فحص صارم: هل الروابط (أو معرّف قصة/منشور) مستخدمة في أي جدول حي؟
 الجداول: posts، stories، profile_highlights، sounds، messages،
 profiles (avatar/cover)، media_assets.
 أي فشل استعلام يرمي استثناءً (إلا عموداً غير موجود في هذه البيئة).
 */
export async function mediaInActiveUse(
  config: SupabaseAdminConfig,
  mediaUrls: string[],
  options: { excludePostId?: string; excludeStoryId?: string } = {},
): Promise<boolean> {
  const urls = [...new Set(mediaUrls.map(normalizeMediaUrl).filter(Boolean))];
  if (urls.length === 0 && !options.excludeStoryId) return false;

  // ilike على المقطع يغطي الروابط المزخرفة (?tr= / #t=) وغير المزخرفة معاً.
  // روابط هذا التطبيق بلا فواصل ولا % فيُبنى شرط or= بأمان.
  const urlConditions = (columns: string[]): string[] =>
    urls.flatMap((url) => columns.map((column) => `${column}.ilike.*${url}*`));

  async function anyMatch(
    table: string,
    conditions: string[],
    extraParams: Record<string, string> = {},
  ): Promise<boolean> {
    if (conditions.length === 0) return false;
    const result = await restRequest(config, "GET", table, {
      select: "id",
      or: `(${conditions.join(",")})`,
      limit: "1",
      ...extraParams,
    });
    try {
      const rows = await requireSuccessfulCheck(result);
      return rows.length > 0;
    } catch (error) {
      if (isUnknownColumnError(result)) {
        logger.warn({ table, status: result.status }, "Reference check skipped: schema lacks expected column");
        return false;
      }
      throw error;
    }
  }

  const checks: Promise<boolean>[] = [
    // أبرز القصص: غلاف أو عنصر (media_url) أو مرجع القصة الأصلية
    anyMatch("profile_highlights", urlConditions(["media_url"])),
    // الأصوات النشطة: الفيديو الأصلي أو معاينة الصوت
    anyMatch("sounds", urlConditions(["source_video_url", "preview_url"])),
    // الرسائل والمرفقات (الروابط محفوظة داخل نص الرسالة)
    anyMatch("messages", urlConditions(["content"])),
    // صور الحساب والأغلفة
    anyMatch("profiles", urlConditions(["avatar_url", "cover_url"])),
    // أصول الوسائط قيد المعالجة
    anyMatch("media_assets", urlConditions(["video_url"])),
    // منشورات أخرى تشترك في الملف نفسه
    anyMatch(
      "posts",
      urlConditions(["media_url"]),
      options.excludePostId ? { id: `neq.${options.excludePostId}` } : {},
    ),
    // قصص أخرى (مثل إعادة نشر قصة تنسخ media_url الأصلي)
    anyMatch(
      "stories",
      urlConditions(["media_url"]),
      options.excludeStoryId ? { id: `neq.${options.excludeStoryId}` } : {},
    ),
  ];

  if (options.excludeStoryId) {
    checks.push(anyMatch("profile_highlights", [`source_story_id.eq.${options.excludeStoryId}`]));
  }

  // فشل أي فحص يمنع الحذف — نجمعها جميعاً ونتحمل أول رفض
  for (const check of checks) {
    if (await check) return true;
  }
  return false;
}

/** تنظيف سجلات قاعدة البيانات عبر RPC الدالة المجدولة (service_role). */
export async function runExpiredRecordsCleanup(
  config: SupabaseAdminConfig,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(new URL("/rest/v1/rpc/aani_cleanup_expired_media_records", config.url), {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`Expired records cleanup RPC failed: HTTP ${response.status}`);
  }
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/** إضافة روابط إلى طابور الحذف المؤجل (بلا تكرار — unique(media_url)). */
export async function enqueueMediaDeletionJobs(
  config: SupabaseAdminConfig,
  mediaUrls: string[],
): Promise<number> {
  const payload = [...new Set(mediaUrls.map(normalizeMediaUrl).filter(Boolean))]
    .map((url) => ({ media_url: url, status: "pending" }));
  if (payload.length === 0) return 0;

  const response = await fetch(
    new URL("/rest/v1/media_deletion_jobs?on_conflict=media_url", config.url),
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`Enqueueing media deletion jobs failed: HTTP ${response.status}`);
  }
  const inserted = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(inserted) ? inserted.length : 0;
}

export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}
