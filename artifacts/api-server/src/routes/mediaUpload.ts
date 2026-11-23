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
import {
  ImageKitUploadError,
  normalizeImageKitFolder,
  readImageKitPrivateKey,
  uploadFileToImageKit,
} from "../lib/imagekitUpload";
import { SERVER_BUILD_VERSION } from "../lib/mediaDiagnostics";
import { readSupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // 24MiB

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

    if (!readImageKitPrivateKey()) {
      return res.status(503).json({ success: false, error: "ImageKit is not configured (IMAGEKIT_PRIVATE_KEY)." });
    }

    const folder = normalizeImageKitFolder(decodeURIComponent(req.header("x-aani-folder") || ""));

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

      // رفع من خادم إلى خادم بالمفتاح الخاص (Basic auth) — بلا توقيع توكن
      const uploaded = await uploadFileToImageKit({ bytes: body, fileName, folder, contentType });

      logger.info({ folder, fileName, size: body.byteLength }, "Server-side ImageKit upload succeeded");
      return res.status(200).json({ success: true, url: uploaded.url });
    } catch (error) {
      if (error instanceof ImageKitUploadError) {
        logger.warn({ status: error.status, detail: error.detail, folder }, "Server-side ImageKit upload failed");
        return res.status(error.status).json({ success: false, error: error.detail });
      }
      logger.error({ err: error }, "Server-side media upload failed unexpectedly");
      return res.status(500).json({ success: false, error: "Could not upload the file via the server." });
    }
  })().catch(error => {
    logger.error({ err: error }, "Server-side media upload request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not upload the file via the server." });
  });
});

export default router;
