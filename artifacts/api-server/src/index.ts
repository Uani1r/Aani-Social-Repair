import path from "path";
import { existsSync } from "node:fs";
import express from "express";
import app from "./app";
import { logger } from "./lib/logger";
import { PUSH_WEBHOOK_PATHS } from "./routes/pushNotifications";
import { readAdminConfig, runExpiredRecordsCleanup, sweepOrphanUploads } from "./lib/mediaDb";
import { processDeletionJobs } from "./lib/mediaDeletionWorker";
import { imageKitConfigured } from "./lib/imagekitAdmin";

// شبكة أمان للعملية كاملة: أي رفض وعد أو استثناء غير متوقع (من عامل الصيانة
// أو غيره) يُسجَّل ويُبتلع بدل إسقاط الخادم وتعطيل كل المستخدمين. الحماية
// الأساسية تبقى try/catch داخل كل دورة، وهذه طبقة أخيرة فقط.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection — process kept alive");
});
process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception — process kept alive");
});

// تحديد مسار ملفات الواجهة الثابتة: يعمل من جذر المستودع (تشغيل التطوير/النشر)
// ومن حاوية الإنتاج (Dockerfile ينسخ dist/public إلى جذر العمل).
const publicPath =
  [path.resolve(process.cwd(), "dist/public"), path.resolve(process.cwd(), "artifacts/aani-social/dist/public")]
    .find((candidate) => existsSync(path.join(candidate, "index.html")))
    ?? path.resolve(process.cwd(), "dist/public");

// خدمة ملفات الـ CSS والـ JS المجمعة
app.use(express.static(publicPath));

// توجيه باقي المسارات إلى index.html لدعم تطبيقات الصفحات الواحدة (SPA)
// ملاحظة: في Express 5 لم يعد النمط "*" صالحاً في المسارات (path-to-regexp v8)
// ويسبب PathError عند الإقلاع، لذلك نستخدم وسيطاً بلا نمط بدلاً منه.
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(publicPath, "index.html"));
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // طباعة مسار الـWebhook الصحيح بالكامل لوضعه في إعدادات Webhook بـSupabase
  const replitDomain =
    process.env["REPLIT_DEVDOMAIN"] ||
    process.env["REPLIT_DOMAINS"]?.split(",")[0] ||
    "";
  const publicBaseUrl =
    process.env["PUBLIC_BASE_URL"] ||
    (replitDomain ? `https://${replitDomain}` : `http://localhost:${port}`);
  const primaryWebhookUrl = `${publicBaseUrl}/api/send-push-notification`;

  console.log("=".repeat(64));
  console.log("🔔 مسار Webhook الإشعارات الصحيح (ضعه في Supabase):");
  console.log(`   POST ${primaryWebhookUrl}`);
  console.log("   الترويسة المطلوبة: x-push-webhook-secret = <قيمة PUSH_WEBHOOK_SECRET>");
  console.log("-".repeat(64));
  console.log("   المسارات الإضافية المدعومة (كلها تعمل بنفس المعالج):");
  for (const webhookPath of PUSH_WEBHOOK_PATHS) {
    console.log(`   POST ${publicBaseUrl}${webhookPath}`);
  }
  console.log("=".repeat(64));

  logger.info(
    { primaryWebhookUrl, paths: PUSH_WEBHOOK_PATHS },
    "Push notification webhook endpoints ready",
  );

  startMediaMaintenanceScheduler();
});

// دورة صيانة مستقلة تماماً عن دخول المستخدمين:
// 1) RPC تنظيف سجلات قاعدة البيانات (قصص منتهية/مشاهدات/إشعارات قديمة)
// 2) Worker طابور الحذف المؤجل (ملفات ImageKit بعد فحص المراجع)
// قفل Worker + قفل استشاري داخل RPC يمنعان التزامن، والدُفعات محدودة.
const MEDIA_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function runMaintenanceCycle(): void {
  const cycle = (async () => {
    // حماية شاملة: أي خطأ غير متوقع في الدورة (قاعدة بيانات/شبكة/تحليل)
    // يُسجل ويُترك للدورة القادمة — لا يُسقط عملية الخادم أبداً.
    try {
      const config = readAdminConfig();
      if (!config) {
        logger.warn("Media maintenance skipped: Supabase admin config missing");
        return;
      }
      try {
        const cleanup = await runExpiredRecordsCleanup(config);
        logger.info({ cleanup }, "Scheduled expired-records cleanup finished");
      } catch (error) {
        logger.error({ err: error }, "Scheduled expired-records cleanup failed");
      }
      try {
        const stats = await processDeletionJobs(config);
        logger.info({ stats }, "Media deletion worker cycle finished");
      } catch (error) {
        logger.error({ err: error }, "Media deletion worker cycle failed");
      }
      try {
        // كنس الملفات المرفوعة بلا مرجع (فترة سماح 48 ساعة + فحص مراجع صارم)
        const sweep = await sweepOrphanUploads(config, { graceHours: 48, batchSize: 50 });
        logger.info({ sweep }, "Orphan upload sweep finished");
      } catch (error) {
        logger.error({ err: error }, "Orphan upload sweep failed");
      }
    } catch (error) {
      logger.error({ err: error }, "Media maintenance cycle failed; next cycle will retry");
    }
  })();

  // الدورة تُطلق بلا انتظار من مؤقّت، فيجب امتصاص رفضها هنا صراحةً:
  // رفض غير معالج واحد كافٍ لإسقاط عملية Node.js وإسقاط الخدمة كلها.
  void cycle.catch((error) => {
    logger.error({ err: error }, "Media maintenance cycle rejected unexpectedly");
  });
}

function startMediaMaintenanceScheduler(): void {
  // مفتاح إيقاف تشغيلي: ضع AANI_MEDIA_MAINTENANCE_DISABLED=true لإيقاف
  // دورات الصيانة كلياً (حذف ImageKit + كنس اليتامى + تنظيف السجلات) دون
  // نشر كود — للاستخدام اليدوي الآمن عند الحاجة فقط. الافتراضي: مفعّل.
  const disabled = ["1", "true", "yes"].includes(
    (process.env["AANI_MEDIA_MAINTENANCE_DISABLED"] || "").trim().toLowerCase(),
  );
  if (disabled) {
    logger.warn("Media maintenance scheduler is DISABLED via AANI_MEDIA_MAINTENANCE_DISABLED — no automatic deletion will run");
    return;
  }

  if (!imageKitConfigured()) {
    // الفحص مرتين بالداخل: حتى لو لم يُضبط المفتاح الآن، Worker يعيد جدولة
    // المهام بدل الحذف (requeue) — لا حذف يقع على شك أبداً
    logger.warn("IMAGEKIT_PRIVATE_KEY is not set — deletion worker will requeue jobs until it is configured");
  }

  // دورة أولى بعد 30 ثانية من الإقلاع ثم كل 6 ساعات.
  // التفعيل يشترط فقط: ترحيلات 22-25 مطبقة في Supabase (Triggers الطابور
  // تسجل الوسائط عند حذف منشور/قصة/حساب أو استبدال أفاتار/غلاف) + مفاتيح
  // الخدمة مضبوطة. الحماية المفعّلة: قفل استشاري داخل RPC + حجز ذري
  // SKIP LOCKED + قفل عملية واحدة + فحص مراجع حية صارم (Fail Closed) —
  // أي شك في المراجع يعيد المهمة إلى pending ولا يُحذف أي ملف مستخدم.
  // مؤقّت الدورة لا يدع أي استثناء متزامن يهرب إلى حلقة الأحداث
  const scheduledCycle = () => {
    try {
      runMaintenanceCycle();
    } catch (error) {
      logger.error({ err: error }, "Media maintenance scheduler tick failed");
    }
  };

  setTimeout(scheduledCycle, 30_000);
  setInterval(scheduledCycle, MEDIA_MAINTENANCE_INTERVAL_MS);
  logger.info(
    { intervalMs: MEDIA_MAINTENANCE_INTERVAL_MS, firstCycleInMs: 30_000 },
    "Media maintenance scheduler ACTIVE: expired-records cleanup + deletion worker + orphan sweep",
  );
}
