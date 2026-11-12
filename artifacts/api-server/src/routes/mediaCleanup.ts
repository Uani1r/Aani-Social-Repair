// التنظيف التلقائي للموسائط وقاعدة البيانات ضمن حدود الباقات المجانية.
//
// POST /api/media/purge-expired
//   نقطة تنظيف داخلية فقط: تُحمى بسر داخلي (x-aani-cleanup-secret) ولا يُسمح
//   لأي مستخدم عادي بتشغيلها. تستدعي RPC قاعدة البيانات (تنظيف القصص المنتهية
//   والإشعارات القديمة) — وTriggers جدول media_deletion_jobs يسجلان روابط
//   الوسائط داخل نفس المعاملة، ثم Worker الخادم يحذف ملفات ImageKit بعد فحص المراجع.
//
// POST /api/media/imagekit-delete  { kind: "post" | "story", id }
//   يُستدعى من جلسة مستخدم للتحقق من الملكية وإضافة روابط الوسائط إلى الطابور.
//   لا يحذف أي ملف مباشرة — Worker يفحص المراجع الحية قبل الحذف.

import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";

import { logger } from "../lib/logger";
import { readSupabaseAdminConfig, type SupabaseAdminConfig } from "../lib/supabaseAdmin";
import {
  asRows,
  enqueueMediaDeletionJobs,
  mediaInActiveUse,
  normalizeMediaUrl,
  recordUploadLedger,
  restRequest,
  runExpiredRecordsCleanup,
} from "../lib/mediaDb";
import { isDeletionWorkerRunning, processDeletionJobs } from "../lib/mediaDeletionWorker";

const router = Router();

// Rate limiting بسيط داخل العملية: 5 طلبات/دقيقة لكل مسار
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function rateLimited(bucketKey: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(bucketKey, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

/** تحقق بزمن ثابت من السر الداخلي (لا يتسرب عبر توقيت المقارنة). */
function isValidInternalSecret(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readInternalSecret(): string | undefined {
  const secret = (process.env["AANI_MEDIA_CLEANUP_SECRET"] || "").trim();
  return secret || undefined;
}

function readBearerToken(req: Request): string {
  const authorization = req.header("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function getAuthenticatedUserId(
  config: SupabaseAdminConfig,
  accessToken: string,
): Promise<string | null> {
  const response = await fetch(new URL("/auth/v1/user", config.url), {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null) as { id?: unknown } | null;
  return typeof user?.id === "string" && user.id ? user.id : null;
}

// قفل يمنع تشغيل عمليتي تنظيف متزامنتين
let cleanupRunning = false;

router.post("/media/purge-expired", (req: Request, res: Response) => {
  void (async () => {
    if (!isValidInternalSecret(req.header("x-aani-cleanup-secret"), readInternalSecret())) {
      return res.status(403).json({ success: false, error: "Internal cleanup secret is required." });
    }
    if (rateLimited("purge-expired")) {
      return res.status(429).json({ success: false, error: "Too many cleanup requests." });
    }
    if (cleanupRunning || isDeletionWorkerRunning()) {
      return res.status(409).json({ success: false, error: "A cleanup cycle is already running." });
    }

    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Database is not configured." });
    }

    cleanupRunning = true;
    try {
      // RPC ينظف القصص المنتهية (بعد مهلة يومين وشرط عدم الاستخدام في أبرز
      // القصص/الأصوات) ومشاهداتها والإشعارات الأقدم من 30 يوماً. الحذف الفعلي
      // للملفات يتم عبر طابور media_deletion_jobs (Trigger داخل نفس المعاملة).
      const cleanup = await runExpiredRecordsCleanup(config);

      // دفعة Worker مباشرة بعد التنظيف (قفل Worker يمنع التزامن)
      const workerStats = await processDeletionJobs(config).catch((error) => {
        logger.warn({ err: error }, "Post-cleanup deletion worker cycle failed");
        return null;
      });

      logger.info({ cleanup, workerStats }, "Scheduled media cleanup cycle finished");
      return res.status(200).json({ success: true, cleanup, workerStats });
    } catch (error) {
      logger.error({ err: error }, "Expired media cleanup failed");
      return res.status(500).json({ success: false, error: "Could not purge expired media." });
    } finally {
      cleanupRunning = false;
    }
  })().catch((error) => {
    logger.error({ err: error }, "Expired media cleanup crashed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not purge expired media." });
  });
});

router.post("/media/imagekit-delete", (req: Request, res: Response) => {
  void (async () => {
    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Database is not configured." });
    }
    const userId = await getAuthenticatedUserId(config, readBearerToken(req));
    if (!userId) {
      return res.status(401).json({ success: false, error: "The session is invalid or expired." });
    }

    const body = (req.body || {}) as { kind?: unknown; id?: unknown };
    const kind = body.kind === "post" || body.kind === "story" ? body.kind : "";
    const id = typeof body.id === "string" ? body.id : "";
    if (!kind || !id) {
      return res.status(400).json({ success: false, error: "kind and id are required." });
    }

    try {
      if (kind === "post") {
        const posts = asRows((await restRequest(config, "GET", "posts", {
          select: "id,user_id,media_url,media_urls",
          id: `eq.${id}`,
          limit: "1",
        })).data);
        const post = posts[0];
        if (!post || post.user_id !== userId) {
          return res.status(404).json({ success: false, error: "Post not found." });
        }

        const mediaUrls = [
          ...(Array.isArray(post.media_urls)
            ? post.media_urls.filter((value): value is string => typeof value === "string")
            : []),
          String(post.media_url || ""),
        ].map(normalizeMediaUrl).filter(Boolean);

        // فحص صارم: أي فشل استعلام يمنع الإدخال إلى الطابور (يرمي ويُرجع 500)
        if (await mediaInActiveUse(config, mediaUrls, { excludePostId: id })) {
          return res.status(200).json({ success: true, enqueued: 0, skipped: true, reason: "media-still-referenced" });
        }

        const enqueued = await enqueueMediaDeletionJobs(config, mediaUrls);
        return res.status(200).json({ success: true, enqueued });
      }

      const stories = asRows((await restRequest(config, "GET", "stories", {
        select: "id,user_id,media_url",
        id: `eq.${id}`,
        limit: "1",
      })).data);
      const story = stories[0];
      if (!story || story.user_id !== userId) {
        return res.status(404).json({ success: false, error: "Story not found." });
      }

      const mediaUrls = [String(story.media_url || "")].map(normalizeMediaUrl).filter(Boolean);
      if (await mediaInActiveUse(config, mediaUrls, { excludeStoryId: id })) {
        return res.status(200).json({ success: true, enqueued: 0, skipped: true, reason: "media-still-referenced" });
      }

      const enqueued = await enqueueMediaDeletionJobs(config, mediaUrls);
      return res.status(200).json({ success: true, enqueued });
    } catch (error) {
      logger.error({ err: error }, "Media deletion enqueue failed");
      return res.status(500).json({ success: false, error: "Could not schedule media deletion." });
    }
  })().catch((error) => {
    logger.error({ err: error }, "Media deletion enqueue crashed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not schedule media deletion." });
  });
});

// سجل الرفع: العميل يبلّغ بعد نجاح رفع ImageKit حتى يُكنس لاحقاً أي ملف
// بقي بلا مرجع (فشل حفظ السجل في Supabase). فشل التسجيل لا يفشل الرفع أبداً.
router.post("/media/upload-ledger", (req: Request, res: Response) => {
  void (async () => {
    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Database is not configured." });
    }
    const userId = await getAuthenticatedUserId(config, readBearerToken(req));
    if (!userId) {
      return res.status(401).json({ success: false, error: "The session is invalid or expired." });
    }
    const body = (req.body || {}) as { url?: unknown };
    // تحقق صارم من الرابط: ملفات ImageKit فقط، داخل مجلد /aani/، والمجلد الفرعي
    // الأول يطابق هوية المستخدم — كل عمليات الرفع في التطبيق ترفع تحت `${userId}/...`.
    // لا يُسجَّل رابط لا يملكه المستخدم حتى لا تُستخدم الندبة لتسجيل ملفات الغير.
    let mediaUrl = "";
    let ownerSegment = "";
    if (typeof body.url === "string" && body.url) {
      const base = normalizeMediaUrl(body.url);
      try {
        const parsed = new URL(base);
        if (parsed.hostname.endsWith("ik.imagekit.io")) {
          const match = parsed.pathname.match(/^\/aani\/([^/]+)(\/|$)/);
          if (match) {
            mediaUrl = base;
            ownerSegment = decodeURIComponent(match[1]);
          }
        }
      } catch {
        /* رابط غير صالح — يُرفض أدناه */
      }
    }
    if (!mediaUrl) {
      return res.status(400).json({ success: false, error: "A valid ImageKit media URL under /aani/ is required." });
    }
    if (ownerSegment !== userId) {
      return res.status(403).json({ success: false, error: "You can only register uploads from your own media folder." });
    }
    try {
      await recordUploadLedger(config, mediaUrl);
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.warn({ err: error }, "Upload ledger write failed");
      return res.status(502).json({ success: false, error: "Could not record upload ledger." });
    }
  })().catch((error) => {
    logger.error({ err: error }, "Upload ledger request crashed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not record upload ledger." });
  });
});

export default router;
