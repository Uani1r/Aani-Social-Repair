// Worker طابور الحذف المؤجل (Outbox): يعالج مهام media_deletion_jobs.
// - لا يحذف أي ملف قبل فحص المراجع الحية مرة أخرى (فحص صارم).
// - فشل مؤقت → إعادة جدولة بـ Backoff حتى 24 ساعة (المهمة لا تُفقد عند إعادة التشغيل).
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

/** إعادة جدولة المهمة بـ Backoff تصاعدي (5 دقائق × 2^المحاولة، حتى 24 ساعة). */
async function requeueJob(
  config: SupabaseAdminConfig,
  job: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const attempts = typeof job.attempts === "number" ? job.attempts : 0;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const nextAttemptAt = exhausted
    ? undefined
    : new Date(Date.now() + Math.min(2 ** attempts * 5 * 60 * 1000, 24 * 60 * 60 * 1000)).toISOString();
  await patchJob(config, String(job.id), {
    status: exhausted ? "failed" : "pending",
    attempts: attempts + 1,
    ...(nextAttemptAt ? { next_attempt_at: nextAttemptAt } : {}),
    last_error: reason.slice(0, 500),
  });
}

export type DeletionWorkerStats = {
  processed: number;
  completed: number;
  skipped: number;
  failed: number;
  reason?: string;
};

export async function processDeletionJobs(
  configOverride?: SupabaseAdminConfig,
): Promise<DeletionWorkerStats> {
  if (running) {
    return { processed: 0, completed: 0, skipped: 0, failed: 0, reason: "already-running" };
  }
  const config = configOverride ?? readSupabaseAdminConfig();
  if (!config) {
    return { processed: 0, completed: 0, skipped: 0, failed: 0, reason: "no-database-config" };
  }

  running = true;
  try {
    // استلام الدُفعة: فشل هذا الاستعلام يؤجل الدورة كاملة — لا حذف يقع
    const claimResult = await restRequest(config, "GET", "media_deletion_jobs", {
      select: "id,media_url,attempts",
      status: "eq.pending",
      next_attempt_at: `lte.${new Date().toISOString()}`,
      order: "next_attempt_at.asc",
      limit: String(BATCH_SIZE),
    });
    const jobs = asRows(await requireSuccessfulCheck(claimResult));

    let completed = 0;
    let skipped = 0;
    let failed = 0;

    for (const job of jobs) {
      const jobId = String(job.id);
      const mediaUrl = normalizeMediaUrl(job.media_url);
      if (!mediaUrl) {
        await patchJob(config, jobId, { status: "failed", last_error: "invalid-media-url" });
        failed += 1;
        continue;
      }

      await patchJob(config, jobId, { status: "processing" });
      try {
        // فحص المراجع الحية بعد حذف الصف: أي مرجع متبقٍ معناه ملف مشترك — يبقى في ImageKit
        if (await mediaInActiveUse(config, [mediaUrl])) {
          await patchJob(config, jobId, { status: "skipped", last_error: "still-referenced" });
          skipped += 1;
          continue;
        }

        if (!imageKitConfigured()) {
          // لا يمكن الحذف الآن — إعادة جدولة بدل تسجيل فشل نهائي
          await requeueJob(config, job, "imagekit-not-configured");
          failed += 1;
          continue;
        }

        const result = await deleteImageKitFilesByUrls([mediaUrl]);
        if (result.deleted > 0 || result.failed === 0) {
          // محذوف، أو غير موجود أصلاً (مكرر من محاولة سابقة) — لا إعادة حذف للملف نفسه
          await patchJob(config, jobId, { status: "completed" });
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

    return { processed: jobs.length, completed, skipped, failed };
  } finally {
    running = false;
  }
}
