import path from "path";
import { existsSync } from "node:fs";
import express from "express";
import app from "./app";
import { logger } from "./lib/logger";
import { PUSH_WEBHOOK_PATHS } from "./routes/pushNotifications";
import { readAdminConfig, runExpiredRecordsCleanup, sweepOrphanUploads } from "./lib/mediaDb";
import { processDeletionJobs } from "./lib/mediaDeletionWorker";

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
  void (async () => {
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
  })();
}

function startMediaMaintenanceScheduler(): void {
  // دورة أولى بعد 30 ثانية من الإقلاع ثم كل 6 ساعات
  setTimeout(runMaintenanceCycle, 30_000);
  setInterval(runMaintenanceCycle, MEDIA_MAINTENANCE_INTERVAL_MS);
  logger.info({ intervalMs: MEDIA_MAINTENANCE_INTERVAL_MS }, "Media maintenance scheduler started");
}
