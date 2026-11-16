// تشخيص مسار ترتيب الرئيسية (المرحلة 4-B) — سجلات فقط، بلا أي أثر على المحرك.
//
// POST /api/feed-diagnostics
//   يستقبل من المتصفح ملخصاً واحداً لكل محاولة تحديث للرئيسية، ويكتبه في سجل
//   الخادم (Render) بصيغة منظّمة. الغرض معرفة هل عُرض ترتيب
//   get_personalized_feed أم انتقل المسار إلى الجلب الزمني، والسبب بدقة.
//
// الأمان:
//   * يتطلب جلسة Supabase صحيحة: الرمز يُقرأ من ترويسة Authorization ويُتحقق
//     منه مقابل /auth/v1/user بنفس آلية imagekitSign و mediaCleanup القائمة.
//     بلا جلسة صحيحة: 401 ولا يُسجَّل شيء.
//   * لا يُسجَّل معرّف المستخدم ولا بريده ولا أي معرّف حساب. معرّف المستخدم
//     يُستخدم في الذاكرة فقط لحدّ المعدل ثم يُهمَل.
//   * لا يُسجَّل جسم الطلب كما وصل: يُبنى كائن السجل من حقول محددة بعد
//     التحقق من نوعها وحدودها، فأي حقل زائد (أو محتوى منشور أو رابط وسائط أو
//     رمز) لا يصل إلى السجل.
//   * حدّ معدل داخل العملية لكل مستخدم يمنع إغراق السجلات، بنفس أسلوب
//     mediaCleanup (نافذة دقيقة، عدّاد في Map).
//
// لا يكتب في قاعدة البيانات، ولا يقرأ منها، ولا يعدّل أي ترتيب أو حالة.

import { Router, type Request, type Response } from "express";

import { logger } from "../lib/logger";
import { readSupabaseAdminConfig, type SupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();

/** الحالات المسموح تسجيلها — أي قيمة أخرى تُرفض. */
const ALLOWED_OUTCOMES = new Set([
  "personalized_success",
  "rpc_error",
  "rpc_timeout",
  "rpc_empty_or_invalid",
  "posts_fetch_failed",
  "no_usable_posts",
  "incomplete_match",
  "hydration_failed",
  // تجهيز التفاعلات فشل داخلياً بلا استثناء (أعاد نفس المصفوفة).
  "hydration_incomplete",
  // تجهيز التفاعلات لم يُشغَّل (بلا جلسة أو بلا منشورات) — ليس فشلاً.
  "hydration_skipped",
]);

/** حدود معقولة للأعداد والزمن: تمنع قيماً شاذة من تلويث السجل. */
const MAX_COUNT = 100000;
const MAX_DURATION_MS = 120000;
/** معرّف العملية: UUID أو رمز قصير آمن — لا نصوص حرة. */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// حدّ المعدل داخل العملية: 12 طلباً/دقيقة لكل مستخدم.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 12;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function rateLimited(bucketKey: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(bucketKey, { count: 1, windowStart: now });
    // تنظيف الكيانات المنتهية حتى لا تتضخم الذاكرة على المدى الطويل.
    if (rateBuckets.size > 5000) {
      for (const [key, value] of rateBuckets) {
        if (now - value.windowStart > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
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

/** عدد صحيح غير سالب ضمن حد أقصى، وإلا null. */
function readCount(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > max) return null;
  return value;
}

/**
 * POST /api/feed-diagnostics
 * يسجّل ملخصاً واحداً ويعيد 204 بلا جسم. لا يُعيد أي بيانات للمتصفح.
 */
router.post("/feed-diagnostics", (req: Request, res: Response) => {
  void (async () => {
    const supabaseConfig = readSupabaseAdminConfig();
    if (!supabaseConfig) {
      return res.status(503).json({ success: false, error: "Authentication service is not configured." });
    }

    const accessToken = readBearerToken(req);
    if (!accessToken) {
      return res.status(401).json({ success: false, error: "Authentication is required." });
    }

    let userId: string | null = null;
    try {
      userId = await getAuthenticatedUserId(supabaseConfig, accessToken);
    } catch (error) {
      logger.warn({ err: error }, "Feed diagnostics: session verification failed");
      return res.status(503).json({ success: false, error: "Could not verify the session." });
    }
    if (!userId) {
      return res.status(401).json({ success: false, error: "The session is invalid or expired." });
    }

    // الحدّ بعد التحقق حتى لا تُستهلك حصة مستخدم مجهول.
    if (rateLimited(userId)) {
      return res.status(429).json({ success: false, error: "Too many diagnostics requests." });
    }

    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: "A diagnostic object is required." });
    }
    const payload = body as Record<string, unknown>;

    const outcome = typeof payload["outcome"] === "string" ? payload["outcome"] : "";
    if (!ALLOWED_OUTCOMES.has(outcome)) {
      return res.status(400).json({ success: false, error: "Unknown outcome." });
    }

    const operationId = typeof payload["operation_id"] === "string" ? payload["operation_id"] : "";
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return res.status(400).json({ success: false, error: "A valid operation id is required." });
    }

    const rpcRows = readCount(payload["rpc_rows"], MAX_COUNT);
    const requestedPosts = readCount(payload["requested_posts"], MAX_COUNT);
    const matchedPosts = readCount(payload["matched_posts"], MAX_COUNT);
    const durationMs = readCount(payload["duration_ms"], MAX_DURATION_MS);
    if (rpcRows === null || requestedPosts === null || matchedPosts === null || durationMs === null) {
      return res.status(400).json({ success: false, error: "Diagnostic counters must be non-negative integers." });
    }

    // سبب الانتقال إلى المسار الزمني: من قائمة الحالات المسموحة فقط، أو null
    // عند النجاح. لا نص حر من العميل يصل إلى السجل.
    const rawReason = payload["fallback_reason"];
    let fallbackReason: string | null = null;
    if (typeof rawReason === "string" && rawReason) {
      if (!ALLOWED_OUTCOMES.has(rawReason)) {
        return res.status(400).json({ success: false, error: "Unknown fallback reason." });
      }
      fallbackReason = rawReason;
    }

    // كائن السجل يُبنى حقلاً بحقل: لا معرّف مستخدم، ولا محتوى، ولا روابط،
    // ولا شيء من جسم الطلب لم يُتحقق منه أعلاه.
    logger.info(
      {
        feedDiagnostic: {
          operationId,
          outcome,
          rpcRows,
          requestedPosts,
          matchedPosts,
          durationMs,
          fallbackReason,
        },
      },
      "feed ranking diagnostic",
    );

    return res.status(204).end();
  })().catch(error => {
    logger.error({ err: error }, "Feed diagnostics request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not record the diagnostic." });
  });
});

export default router;
