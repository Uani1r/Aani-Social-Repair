// رفع الوسائط من جهة الخادم إلى ImageKit — مسار احتياطي مستقل تماماً.
//
// الغرض: عندما يفشل الرفع المباشر من المتصفح بسبب التوقيع
// (token/expire/signature — مثلاً مفاتيح من حسابين مختلفين)، يعيد العميل
// المحاولة عبر هذه النقطة التي تستخدم المفتاح الخاص بنفس أسلوب Basic auth
// المُثبت عمله في منظومة الحذف الآلي (imagekitAdmin.ts) — بلا توقيع إطلاقاً.
//
// الحدود:
// - المصادقة إلزامية: نفس تحقق Supabase المستخدم في نقطة التوقيع.
// - الحد الأقصى 24MiB (يتطابق مع MAX_UPLOAD_BYTES في العميل).
// - المفتاح الخاص لا يغادر الخادم أبداً، ولا يُطبع في السجل أبداً.

import express, { Router, type Request, type Response } from "express";

import { logger } from "../lib/logger";
import { SERVER_BUILD_VERSION } from "../lib/mediaDiagnostics";
import { readSupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // 24MiB

function readImageKitPrivateKey(): string {
  return (process.env["IMAGEKIT_PRIVATE_KEY"] || "").trim();
}

function readBearerToken(req: Request): string {
  const authorization = req.header("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function getAuthenticatedUserId(
  config: { url: string; serviceRoleKey: string },
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

/** مجلد نظيف داخل /aani فقط — نفس قواعد العميل */
function sanitizeFolder(raw: string): string {
  const cleaned = (raw || "")
    .replace(/[^a-zA-Z0-9._\-\/]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return `/aani/${cleaned || "misc"}`;
}

// نقطة تحقق عملية: افتح GET /api/media/upload في المتصفح — الاستجابة JSON
// هنا تعني أن الخادم المُخدَّم يشتمل على نقطة الرفع الاحتياطية فعلاً؛
// 404 تعني أن العملية تستخدم بناءً قديماً بدونها.
router.get("/media/upload", (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    serverBuildVersion: SERVER_BUILD_VERSION,
    route: "POST /api/media/upload",
    message: "نقطة الرفع الاحتياطي حيّة على هذه العملية.",
  });
});

router.post("/media/upload", express.raw({ type: "*/*", limit: "30mb" }), (req: Request, res: Response) => {
  void (async () => {
    const supabaseConfig = readSupabaseAdminConfig();
    if (!supabaseConfig) {
      return res.status(503).json({ success: false, error: "Authentication service is not configured." });
    }

    const accessToken = readBearerToken(req);
    if (!accessToken) return res.status(401).json({ success: false, error: "Authentication is required." });

    const privateKey = readImageKitPrivateKey();
    if (!privateKey) {
      return res.status(503).json({ success: false, error: "ImageKit is not configured (IMAGEKIT_PRIVATE_KEY)." });
    }

    try {
      const userId = await getAuthenticatedUserId(supabaseConfig, accessToken);
      if (!userId) return res.status(401).json({ success: false, error: "The session is invalid or expired." });

      const body = req.body as Buffer | undefined;
      if (!body || !(body instanceof Buffer) || body.byteLength === 0) {
        return res.status(400).json({ success: false, error: "Empty upload body." });
      }
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ success: false, error: "File exceeds the 24MiB server upload limit." });
      }

      const fileNameHeader = req.header("x-aani-file-name") || "";
      const fileName = (decodeURIComponent(fileNameHeader) || `upload-${Date.now()}`)
        .replace(/[\r\n\0]/g, "")
        .slice(0, 180) || `upload-${Date.now()}`;
      // نوع الملف: العميل يرسله في content-type (ترويسة الطلب نفسها) —
      // قد يتضمن charset يُزال هنا؛ x-aani-content-type احتياط للتوافق
      const contentType = (req.header("content-type") || req.header("x-aani-content-type") || "application/octet-stream")
        .split(";")[0]
        .trim()
        .toLowerCase()
        || "application/octet-stream";
      const folder = sanitizeFolder(decodeURIComponent(req.header("x-aani-folder") || ""));

      // رفع من خادم إلى خادم بالمفتاح الخاص (Basic auth) — بلا توقيع توكن
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(body)], { type: contentType }), fileName);
      form.append("fileName", fileName);
      form.append("folder", folder);
      form.append("useUniqueFileName", "true");

      const uploadResponse = await fetch("https://upload.imagekit.io/api/v1/files/upload", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
        },
        body: form,
      });

      const payload = await uploadResponse.json().catch(() => null) as
        | { url?: unknown; message?: unknown; help?: unknown }
        | null;

      if (uploadResponse.ok && payload && typeof payload.url === "string" && payload.url) {
        logger.info({ folder, fileName, size: body.byteLength }, "Server-side ImageKit upload succeeded");
        return res.status(200).json({ success: true, url: payload.url });
      }

      const detail = typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.help === "string"
          ? payload.help
          : `HTTP ${uploadResponse.status}`;
      logger.warn({ status: uploadResponse.status, detail, folder }, "Server-side ImageKit upload failed");
      return res.status(uploadResponse.status >= 400 ? uploadResponse.status : 502).json({
        success: false,
        error: `ImageKit upload failed: ${detail}`,
      });
    } catch (error) {
      logger.error({ err: error }, "Server-side media upload failed unexpectedly");
      return res.status(500).json({ success: false, error: "Could not upload the file via the server." });
    }
  })().catch(error => {
    logger.error({ err: error }, "Server-side media upload request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not upload the file via the server." });
  });
});

export default router;
