import path from "path";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import { Server } from "socket.io";
import app from "./app";
import { logger } from "./lib/logger";
import { configureGroupSockets } from "./realtime/groupSockets";

// تحديد مسار ملفات الواجهة حسب طريقة تشغيل المستودع.
const defaultPublicPath = path.resolve(process.cwd(), "dist/public");
const artifactPublicPath = path.resolve(process.cwd(), "artifacts/aani-social/dist/public");
const publicPath = existsSync(defaultPublicPath) ? defaultPublicPath : artifactPublicPath;

// خدمة ملفات الـ CSS والـ JS المجمعة
app.use(express.static(publicPath));

// توجيه باقي المسارات إلى index.html لدعم تطبيقات الصفحات الواحدة (SPA)
app.get("/{*path}", (req, res, next) => {
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

const server = createServer(app);
const io = new Server(server, { path: "/api/socket.io", cors: { origin: true } });
configureGroupSockets(io);

server.on("error", (err: Error) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
});
