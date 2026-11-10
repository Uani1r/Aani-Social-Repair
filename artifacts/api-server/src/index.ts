import path from "path";
import express from "express";
import app from "./app";
import { logger } from "./lib/logger";
import { PUSH_WEBHOOK_PATHS } from "./routes/pushNotifications";

// تحديد مسار الملفات الثابتة الناتجة عن البناء
const publicPath = path.resolve(process.cwd(), "dist/public");

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
});
