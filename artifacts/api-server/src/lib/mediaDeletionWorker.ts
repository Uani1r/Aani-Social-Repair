// Worker طابور الحذف المؤجل (Outbox): يعالج مهام media_deletion_jobs.
// - حجز ذري للمهام عبر RPC (FOR UPDATE SKIP LOCKED) مع إيجار: المهام المتروكة
//   بعد انتهاء مدة الحجز (توقف الخادم مثلاً) تُسترجع تلقائياً — لا مهمة عالقة.
// - لا يحذف أي ملف قبل فحص المراجع الحية مرة أخرى (فحص صارم، fail closed).
// - مرجع حي → المهمة تعود إلى pending بفحص لاحق (أسبوع) — لا ملفات عالقة للأبد.
// - فشل مؤقت → إعادة جدولة بـ Backoff حتى 24 ساعة، والمهمة لا تُفقد عند إعادة التشغيل.
// - قفل داخل العملية يمنع تشغيل دورتين متزامنتين، ودُفعة محدودة كل دورة.

import { logger } from "./logger";
import { readSupabaseAdminConfig, type SupabaseAdminConfig } from "./supabaseAdmin";
import { deleteImageKitFilesByUrls, imageKitConfigured } from "./imagekitAdmin";
import {
  asRows,
  mediaInActiveUse,
  normalizeMediaUrl,
  requireSuccessfulCheck,
  restRequest,
} from "./mediaDb";

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 12;
const LEASE_MINUTES = 30;
const STILL_REFERENCED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

let running = false;

export function isDeletionWorkerRunning(): boolean {
  return running;
}

async function patchJob(
  config: SupabaseAdminConfig,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const response = await restRequest(config, "PATCH", "media_deletion_jobs", { id: `eq.${id}` }, fields);
  if (!response.ok) {
    throw new Error(`Failed to update media deletion job ${id}: HTTP ${response.status}`);
  }
}

/** تأخير إعادة المحاولة: 5 دقائق × 2^المحاولة، حتى سقف 24 ساعة (دالة صرفة قابلة للاختبار). */
export function computeRetryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, Math.floor(attempts)) * 5 * 60 * 1000, 24 * 60 * 60 * 1000);
}

/** إيقاف المحاولات نهائياً بعد الحد الأقصى — المهمة تُعلَّم failed وتبقى قابلة لإعادة الفتح عند إدراج الرابط من جديد. */
export function shouldStopRetrying(attempts: number, maxAttempts: number = MAX_ATTEMPTS): boolean {
  return attempts >= maxAttempts;
}

/** إعادة جدولة المهمة بـ Backoff تصاعدي (5 دقائق × 2^المحاولة، حتى 24 ساعة). */
async function requeueJob(
  config: SupabaseAdminConfig,
  job: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const attempts = typeof job.attempts === "number" ? job.attempts : 0;
  const exhausted = shouldStopRetrying(attempts);
  const nextAttemptAt = exhausted
    ? undefined
    : new Date(Date.now() + computeRetryDelayMs(attempts)).toISOString();
  await patchJob(config, String(job.id), {
    status: exhausted ? "failed" : "pending",
    attempts: attempts + 1,
    ...(nextAttemptAt ? { next_attempt_at: nextAttemptAt } : {}),
    last_error: reason.slice(0, 500),
  });
}

/**
 حجز دفعة مهام ذرياً: RPC بقفل SKIP LOCKED يمنع عاملين من معالجة المهمة نفسها،
 ويسترجع المهام التي انتهى إيجارها (processing متقادمة) — فلا تبقى عالقة للأبد.
 مسار احتياطي REST (قبل تطبيق الترحيل) مع شرط الإيجار نفسه — ضعيف الذرية لكنه
 مقيد بقفل العملية الواحدة داخل هذا الـ Worker.
 */
async function claimJobs(config: SupabaseAdminConfig): Promise<Record<string, unknown>[]> {
  const response = await fetch(
    new URL("/rest/v1/rpc/aani_claim_media_deletion_jobs", config.url),
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_batch: BATCH_SIZE, p_lease_minutes: LEASE_MINUTES }),
    },
  );
  const data = await response.json().catch(() => null) as unknown;
  if (response.ok && Array.isArray(data)) {
    return data as Record<string, unknown>[];
  }
  const message = data && typeof data === "object" && "message" in (data as Record<string, unknown>)
    ? String((data as Record<string, unknown>).message)
    : "";
  if (response.status === 404 || message.includes("does not exist") || message.includes("schema cache")) {
    // الترحيل لم يُطبق بعد — مسار احتياطي بنفس شرط الإيجار
    logger.warn("aani_claim_media_deletion_jobs unavailable yet — using REST claim fallback");
    const claim = await restRequest(config, "GET", "media_deletion_jobs", {
      select: "id,media_url,attempts",
      or: `(
        and(status.eq.pending,next_attempt_at.lte.${new Date().toISOString()}),
        and(status.eq.processing,updated_at.lte.${new Date(Date.now() - LEASE_MINUTES * 60 * 1000).toISOString()})
      )`,
      order: "next_attempt_at.asc",
      limit: String(BATCH_SIZE),
    });
    const jobs = asRows(await requireSuccessfulCheck(claim));
    for (const job of jobs) {
      await patchJob(config, String(job.id), { status: "processing" });
    }
    return jobs;
  }
  throw new Error(`Claiming media deletion jobs failed: HTTP ${response.status}`);
}

export type DeletionWorkerStats = {
  processed: number;
  completed: number;
  deferred: number;
  failed: number;
  reason?: string;
};

export async function processDeletionJobs(
  configOverride?: SupabaseAdminConfig,
): Promise<DeletionWorkerStats> {
  if (running) {
    return { processed: 0, completed: 0, deferred: 0, failed: 0, reason: "already-running" };
  }
  const config = configOverride ?? readSupabaseAdminConfig();
  if (!config) {
    return { processed: 0, completed: 0, deferred: 0, failed: 0, reason: "no-database-config" };
  }

  running = true;
  try {
    // فشل حجز الدُفعة يؤجل الدورة كاملة — لا حذف يقع على شك
    const jobs = await claimJobs(config);

    let completed = 0;
    let deferred = 0;
    let failed = 0;

    for (const job of jobs) {
      const jobId = String(job.id);
      const mediaUrl = normalizeMediaUrl(job.media_url);
      if (!mediaUrl) {
        await patchJob(config, jobId, { status: "failed", last_error: "invalid-media-url" });
        failed += 1;
        continue;
      }

      try {
        // فحص المراجع الحية بعد حذف الصف: أي مرجع متبقٍ معناه ملف مشترك — يبقى في ImageKit
        if (await mediaInActiveUse(config, [mediaUrl])) {
          // مرجع حي الآن قد يزول لاحقاً: المهمة تعود إلى pending بفحص بعد أسبوع —
          // لا ملفات غير مستخدمة تبقى عالقة في skipped إلى الأبد، ولا إزعاج دوري متكرر.
          await patchJob(config, jobId, {
            status: "pending",
            next_attempt_at: new Date(Date.now() + STILL_REFERENCED_RECHECK_MS).toISOString(),
            last_error: "still-referenced",
          });
          deferred += 1;
          continue;
        }

        if (!imageKitConfigured()) {
          // لا يمكن الحذف الآن — إعادة جدولة بدل تسجيل فشل نهائي
          await requeueJob(config, job, "imagekit-not-configured");
          failed += 1;
          continue;
        }

        const result = await deleteImageKitFilesByUrls([mediaUrl]);
        if (result.deleted > 0 || result.verifiedAbsent > 0) {
          // حُذف فعلياً، أو تحققنا بالفحص الكامل أنه غير موجود في ImageKit أصلاً
          await patchJob(config, jobId, {
            status: "completed",
            last_error: result.verifiedAbsent > 0 ? "verified-absent" : null,
          });
          completed += 1;
        } else {
          await requeueJob(config, job, `imagekit-delete-failed(${result.failed})`);
          failed += 1;
        }
      } catch (error) {
        await requeueJob(config, job, error instanceof Error ? error.message : "unknown-error").catch(() => undefined);
        failed += 1;
        logger.warn({ err: error, jobId }, "Media deletion job failed; will retry with backoff");
      }
    }

    return { processed: jobs.length, completed, deferred, failed };
  } finally {
    running = false;
  }
}