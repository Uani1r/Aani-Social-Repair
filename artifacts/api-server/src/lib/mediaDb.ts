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

/** الرابط الأساسي للوسائط بلا معاملات تحويل (?tr=) ولا هاشتاغ تعديل (#t=).
 *  سياسة التطبيع الموثقة: يُستخدم الناتج للمقارنة وتحديد هوية الملف في سجل
 *  الرفع فقط — لا للجلب. معاملات التوقيع/المصادقة (ik-s/ik-t/token/expires
 *  وغيرها) تُهمَل عمداً لأن هوية المورد هي المسار نفسه؛ اتجاه المطابقة آمن:
 *  رابط موقّع مخزّن في قاعدة البيانات يطابق الملف العاري فيبقى الملف محفوظاً
 *  عند الشك، بدل حذف ملف مشار إليه برابط موقّع. لا يُحذف أي استعلام أو
 *  معامل من البيانات المخزنة نفسها. */
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
  result: { ok: boolean; status: number; data: unknown; errorText?: string },
): Promise<Record<string, unknown>[]> {
  if (!result.ok) {
    const detail = result.errorText ? ` — ${result.errorText.slice(0, 300)}` : "";
    throw new MediaReferenceCheckError(`Media reference check failed: HTTP ${result.status}${detail}`);
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
 فجوة مخطط: عمود غير موجود (PGRST204/42703) أو جدول غير موجود إطلاقاً في هذه
 البيئة (42P01/PGRST205). كلاهما معناه أن مخزن المراجع هذا غير موجود بالشكل
 الذي يفترضه الكود — يُسجل ويُتخطى الجدول/العمود، وليس "قائمة فارغة = آمن".
 يعمل على جسم الخطأ المُحلَّل (data.message) أو على نص الاستجابة الخام
 (errorText) الذي يحتفظ به restRequest الآن. أي خطأ آخر (تصريح، 5xx، ...)
 لا يُصنف فجوة مخطط ويبقى قاتلاً — Fail Closed.
 */
export type RestResult = {
  ok: boolean;
  status: number;
  data: unknown;
  /** نص الاستجابة الخام — يُحفظ دائماً حتى تبقى رسالة الخطأ قابلة للقراءة والتشخيص. */
  errorText: string;
};

function extractRestErrorMessage(result: { data: unknown; errorText?: string }): string {
  if (result.data && typeof result.data === "object") {
    const record = result.data as Record<string, unknown>;
    const message = record["message"] ?? record["error"];
    if (typeof message === "string" && message) return message;
  }
  return result.errorText ?? "";
}

export function isUnknownColumnError(result: { status: number; data: unknown; errorText?: string }): boolean {
  if (result.status !== 400 && result.status !== 404) return false;
  const message = extractRestErrorMessage(result);
  return message.includes("does not exist")
    || message.includes("Could not find the '")
    || message.includes("PGRST204")
    || message.includes("PGRST205")
    || /\b(42703|42P01)\b/.test(message);
}

/**
 فجوة على مستوى الجدول (لا عمود): العلاقة نفسها غير موجودة في هذه البيئة —
 42P01 "relation ... does not exist" أو PGRST205 "table ... not found in
 schema cache". رسائل الأعمدة (42703 / PGRST204 "... column ...") مستثناة صراحةً.
 */
export function isMissingRelationError(result: { status: number; data: unknown; errorText?: string }): boolean {
  if (result.status !== 400 && result.status !== 404) return false;
  const message = extractRestErrorMessage(result);
  const relationMissing = /\b42P01\b/.test(message)
    || message.includes("PGRST205")
    || /relation\s+"[^"]+"\s+does not exist/.test(message);
  return relationMissing && !message.toLowerCase().includes("column");
}

export async function restRequest(
  config: SupabaseAdminConfig,
  method: string,
  path: string,
  searchParams: Record<string, string> = {},
  body?: Record<string, unknown> | Record<string, unknown>[],
): Promise<RestResult> {
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
  // نص الاستجابة الخام يُحفظ دائماً: رسالة الخطأ من PostgREST (جسم JSON أو نص)
  // تبقى متاحة للتصنيف (فجوة مخطط؟) وللتشخيص بدل إسقاطها عند الفشل.
  const rawBody = await response.text().catch(() => "");
  let data: unknown = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data, errorText: rawBody };
}

/* ------------------------------------------------------------------ */
/* صياغة شروط PostgREST لفحص المراجع (قابلة للاختبار بلا شبكة)         */
/* ------------------------------------------------------------------ */

/**
 محارف PostgREST الخاصة التي تُفسَّر داخل or=(...) إن لم تُغلَّف القيمة
 بعلامات اقتباس مزدوجة: الفاصلة تفصل الشروط، والأقواس تفتح تعبيرات متداخلة،
 وعلامات الاقتباس تحدد حدود القيمة.
 */
const POSTGREST_VALUE_SPECIAL = /["(),\s]/;

/**
 قيمة PostgREST آمنة داخل or=(...): تُغلَّف بعلامات اقتباس مزدوجة عند الحاجة
 (مع مضاعفة الاقتباسات الداخلية)، وتبقى كما هي إن كانت بسيطة — نحافظ على
 الصيغة المجرّبة للروابط العادية ولا نغيّرها بلا داعٍ.
 */
export function postgrestValue(value: string): string {
  return POSTGREST_VALUE_SPECIAL.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/**
 شرط overlap على عمود مصفوفة (text[]): المصفوفة تحتوي هذا الرابط.
 كل رابط شرط مستقل — مصفوفة تحتوي عدة روابط تُفحص رابطاً رابطاً ولا تُجمَع
 في قائمة ov.{u1,u2} واحدة تفصلها فواصل قد تنكسر داخل or=(...).
 */
export function arrayOverlapCondition(column: string, url: string): string {
  return `${column}.ov.{${postgrestValue(url)}}`;
}

/**
 شرط ilike على عمود نصي: الرابط كجزء من القيمة (يغطي الروابط المزخرفة
 ?tr= / #t= معاً). محارف % و _ تبقى wildcards — الإفراط في المطابقة
 اتجاه آمن للغاية (الملف يبقى محفوظاً عند الشك).
 */
export function textMatchCondition(column: string, url: string): string {
  return `${column}.ilike.${postgrestValue(`*${url}*`)}`;
}

/**
 كل شروط المراجع لقائمة روابط: لكل رابط شرط لكل عمود نصي وشرط ov لكل
 عمود مصفوفة — جميعها تُدمج لاحقاً في or=(...) واحدة (المطابقة: أي عمود
 يحوي أي رابط = الملف مستخدم).
 */
export function buildMediaReferenceConditions(
  urls: readonly string[],
  textColumns: readonly string[],
  arrayColumns: readonly string[] = [],
): string[] {
  const conditions: string[] = [];
  for (const url of urls) {
    for (const column of textColumns) conditions.push(textMatchCondition(column, url));
    for (const column of arrayColumns) conditions.push(arrayOverlapCondition(column, url));
  }
  return conditions;
}

/**
 فحص صارم: هل الروابط (أو معرّف قصة/منشور) مستخدمة في أي جدول حي؟
 تصنيف الجداول المرجعية (السياسة موثقة في anyMatch أدناه):
 - أساسية (غيابها أو تعذر الاستعلام عنها يوقف الحذف كلياً):
   posts (media_url, media_urls, audio_url)، stories (media_url)،
   profile_highlights (media_url)، sounds (source_video_url, preview_url)،
   messages (content)، profiles (avatar_url, cover_url)،
   media_assets (video_url, poster_url).
 - اختيارية (فقط جدول أغلفة مجموعات أبرز القصص):
   profile_highlight_collections (cover_url) — غياب الجدول كاملاً في بيئة
   بلا ميزة أبرز القصص يعني لا توجد مراجع أصلاً، فيُتخطى وفق السياسة أدناه.
 أي فشل استعلام يرمي استثناءً (إلا فجوات المخطط الموثقة).
 */
export async function mediaInActiveUse(
  config: SupabaseAdminConfig,
  mediaUrls: string[],
  options: { excludePostId?: string; excludeStoryId?: string } = {},
): Promise<boolean> {
  const urls = [...new Set(mediaUrls.map(normalizeMediaUrl).filter(Boolean))];
  if (urls.length === 0 && !options.excludeStoryId) return false;

  // تحويل شرط مثل "media_url.ilike.*https://...*" إلى معاملات استعلام مفردة
  function conditionToParams(condition: string): Record<string, string> {
    const separatorIndex = condition.indexOf('.');
    if (separatorIndex <= 0) throw new Error(`Malformed reference condition: ${condition}`);
    const column = condition.slice(0, separatorIndex);
    const operatorAndValue = condition.slice(separatorIndex + 1);
    return { [column]: operatorAndValue };
  }

  /**
   مبدأ Fail Closed مع تصنيف الجداول:
   - الجداول الأساسية: غياب الجدول نفسه أو تعذر الاستعلام عنه يوقف الحذف
     كلياً (يرمي استثناءً → المهمة تعود إلى pending) — غياب جدول أساسي
     ليس دليلاً على أن الملف غير مستخدم أبداً.
   - الجداول الاختيارية (profile_highlight_collections فقط): غياب الجدول
     كاملاً في بيئات بلا أبرز قصص يُتخطى مع تسجيل.
   - غياب عمود (الجدول موجود): لا يمكن لعمود غير موجود أن يحمل مراجع —
     يُتخطى الشرط وحده مع تسجيل، وبقية أعمدة الجدول تُفحص شرطاً شرطاً.
   أي فشل آخر (تصريح، 5xx...) قاتل دائماً.
   */
  async function anyMatch(
    table: string,
    conditions: string[],
    options: { optional?: boolean; extraParams?: Record<string, string> } = {},
  ): Promise<boolean> {
    const optional = options.optional === true;
    const extraParams = options.extraParams ?? {};
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
      if (!isUnknownColumnError(result)) throw error;

      // غياب الجدول نفسه: أساسي → يتوقف الحذف كلياً؛ اختياري → يُتخطى مع تسجيل
      if (isMissingRelationError(result)) {
        if (optional) {
          logger.warn({ table }, "Optional reference table missing in this environment; table skipped");
          return false;
        }
        logger.error({ table, status: result.status }, "Core reference table is missing; deletion is blocked");
        throw error;
      }

      // غياب عمود: فحص كل شرط بمفرده؛ العمود المفقود وحده يُتخطى مع تسجيل
      let matched = false;
      for (const condition of conditions) {
        const single = await restRequest(config, "GET", table, {
          select: "id",
          ...conditionToParams(condition),
          limit: "1",
          ...extraParams,
        });
        try {
          const rows = await requireSuccessfulCheck(single);
          if (rows.length > 0) matched = true;
        } catch (singleError) {
          if (isUnknownColumnError(single)) {
            if (isMissingRelationError(single)) {
              if (optional) {
                logger.warn({ table }, "Optional reference table missing (probing); table skipped");
                return matched;
              }
              logger.error({ table }, "Core reference table is missing (probing); deletion is blocked");
              throw singleError;
            }
            logger.warn({ table, condition }, "Reference column missing in this environment; column skipped");
            continue;
          }
          throw singleError;
        }
      }
      logger.warn({ table, status: result.status }, "Reference check split: schema lacks an expected column; per-column probing used");
      return matched;
    }
  }

  const excludePost = options.excludePostId ? { id: `neq.${options.excludePostId}` } : {};
  const excludeStory = options.excludeStoryId ? { id: `neq.${options.excludeStoryId}` } : {};

  const checks: Promise<boolean>[] = [
    // أساسي: المنشورات — الرابط الأحادي + مصفوفة الروابط (شرط ov لكل رابط)
    // + رابط الصوت المختار/المستخرج (audio_url — مرجع ملف صوتي حقيقي)
    anyMatch("posts", buildMediaReferenceConditions(urls, ["media_url", "audio_url"], ["media_urls"]), { extraParams: excludePost }),
    // أساسي: القصص (مثل إعادة نشر قصة تنسخ media_url الأصلي)
    anyMatch("stories", buildMediaReferenceConditions(urls, ["media_url"]), { extraParams: excludeStory }),
    // أساسي: أبرز القصص (عناصر مضافة يدوياً أو من قصة)
    anyMatch("profile_highlights", buildMediaReferenceConditions(urls, ["media_url"])),
    // اختياري: أغلفة مجموعات أبرز القصص — قد يغيب الجدول كاملاً في بيئات قديمة (سياسة موثقة أعلاه)
    anyMatch("profile_highlight_collections", buildMediaReferenceConditions(urls, ["cover_url"]), { optional: true }),
    // أساسي: الأصوات النشطة — الفيديو الأصلي أو معاينة الصوت
    anyMatch("sounds", buildMediaReferenceConditions(urls, ["source_video_url", "preview_url"])),
    // أساسي: الرسائل ومرفقات الدردشة (الروابط داخل نص الرسالة)
    anyMatch("messages", buildMediaReferenceConditions(urls, ["content"])),
    // أساسي: صور الحساب والأغلفة
    anyMatch("profiles", buildMediaReferenceConditions(urls, ["avatar_url", "cover_url"])),
    // أساسي: أصول الوسائط قيد المعالجة (الفيديو والصورة البارزة)
    anyMatch("media_assets", buildMediaReferenceConditions(urls, ["video_url", "poster_url"])),
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

/** تسجيل ملف مرفوع حديثاً في سجل الرفع (لملاحقة الملفات بلا مرجع). */
export async function recordUploadLedger(
  config: SupabaseAdminConfig,
  mediaUrl: string,
  fileId?: string,
): Promise<void> {
  const response = await fetch(
    new URL("/rest/v1/media_upload_ledger?on_conflict=media_url", config.url),
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json",
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify({
        media_url: normalizeMediaUrl(mediaUrl),
        ...(fileId ? { file_id: fileId } : {}),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Upload ledger write failed: HTTP ${response.status}`);
  }
}

/**
 كنس الملفات المرفوعة بلا مرجع (Orphan Sweep): يفحص فقط ما تجاوز فترة
 السماح (48 ساعة افتراضياً) بجزء صغير لكل دورة، ويستخدم الفحص الصارم نفسه —
 أي فشل تحقق يترك القيد لدورة قادمة ولا يُحذف شيء على الشك.
 */
export async function sweepOrphanUploads(
  config: SupabaseAdminConfig,
  options: { graceHours?: number; batchSize?: number } = {},
): Promise<{ reviewed: number; enqueued: number; resolved: number; failed: number }> {
  const graceHours = options.graceHours ?? 48;
  const batchSize = options.batchSize ?? 50;
  const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000).toISOString();

  const claim = await restRequest(config, "GET", "media_upload_ledger", {
    select: "id,media_url",
    created_at: `lt.${cutoff}`,
    order: "created_at.asc",
    limit: String(batchSize),
  });
  const rows = asRows(await requireSuccessfulCheck(claim));

  let enqueued = 0;
  let resolved = 0;
  let failed = 0;

  for (const row of rows) {
    const mediaUrl = normalizeMediaUrl(row.media_url);
    if (!mediaUrl) {
      failed += 1;
      continue;
    }
    try {
      if (await mediaInActiveUse(config, [mediaUrl])) {
        // صار له مرجع حي — نُخرجه من السجل؛ حذفه مستقبلاً عبر Triggers الطابور
        await restRequest(config, "DELETE", "media_upload_ledger", { id: `eq.${String(row.id)}` });
        resolved += 1;
      } else {
        // لا مرجع بعد فترة السماح → طابور الحذف (Worker يفحص المراجع مرة أخيرة)
        await enqueueMediaDeletionJobs(config, [mediaUrl]);
        await restRequest(config, "DELETE", "media_upload_ledger", { id: `eq.${String(row.id)}` });
        enqueued += 1;
      }
    } catch (error) {
      // فشل فحص → القيد يبقى في السجل ويُعاد في الدورة القادمة (fail closed)
      failed += 1;
      logger.warn({ err: error, mediaUrl }, "Orphan sweep check failed; ledger row kept for next cycle");
    }
  }

  return { reviewed: rows.length, enqueued, resolved, failed };
}
