import path from "path";
import express from "express";
import app from "./app";
import { logger } from "./lib/logger";

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
});
