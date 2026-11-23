// رفع وتسجيل رسالة صوتية للدردشة: تحويل FFmpeg على الخادم ثم رفع الناتج
// المتحقَّق منه إلى ImageKit، وإرجاع الرابط وقياسات الضغط الفعلية.
//
// لماذا على الخادم: التحويل داخل المتصفح يستهلك المعالج/البطارية على iPhone
// Safari، والتسجيل الخام (Opus) قد لا يعمل على iOS. التسجيل الأصلي يبقى في
// جهاز المستخدم حتى تنجح كل الخطوات؛ فلا يُحذف أصل قبل نجاح التحويل والتحقق
// والرفع والتسجيل في سجل الرفع.

import express, { Router, type Request, type Response } from "express";

import { logger } from "../lib/logger";
import { ImageKitUploadError, uploadFileToImageKit } from "../lib/imagekitUpload";
import { normalizeMediaUrl, recordUploadLedger } from "../lib/mediaDb";
import { readSupabaseAdminConfig, type SupabaseAdminConfig } from "../lib/supabaseAdmin";
import { VOICE_MAX_SOURCE_BYTES, VoiceProcessingError, transcodeVoiceToM4a } from "../lib/voiceProcessing";

const router = Router();

const UPLOAD_LIMIT_MB = Math.ceil(VOICE_MAX_SOURCE_BYTES / (1024 * 1024));
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

router.get("/media/voice", (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    route: "POST /api/media/voice",
    maxSourceBytes: VOICE_MAX_SOURCE_BYTES,
  });
});

router.post(
  "/media/voice",
  express.raw({ type: "*/*", limit: `${UPLOAD_LIMIT_MB}mb` }),
  (req: Request, res: Response) => {
    void (async () => {
      const config = readSupabaseAdminConfig();
      if (!config) {
        return res.status(503).json({ success: false, error: "Authentication service is not configured." });
      }

      const accessToken = readBearerToken(req);
      if (!accessToken) return res.status(401).json({ success: false, error: "Authentication is required." });

      const messageId = (req.header("x-aani-message-id") || "").trim();
      if (!MESSAGE_ID_PATTERN.test(messageId)) {
        return res.status(400).json({ success: false, error: "A valid x-aani-message-id header is required." });
      }

      const body = req.body as Buffer | undefined;
      if (!body || !(body instanceof Buffer) || body.byteLength === 0) {
        return res.status(400).json({ success: false, error: "Empty audio body." });
      }
      if (body.byteLength > VOICE_MAX_SOURCE_BYTES) {
        return res.status(413).json({ success: false, error: "Audio exceeds the server voice limit." });
      }

      const sourceMimeType = (req.header("content-type") || "application/octet-stream").trim();
      const originalBytes = body.byteLength;

      try {
        const userId = await getAuthenticatedUserId(config, accessToken);
        if (!userId) return res.status(401).json({ success: false, error: "The session is invalid or expired." });

        // 1) تحويل + تحقق من الناتج (AAC أحادي بمدة موجبة) — لا رفع قبل ذلك
        const transcoded = await transcodeVoiceToM4a({ bytes: body, sourceMimeType });

        // 2) رفع الناتج المتحقَّق منه إلى ImageKit تحت مجلد المستخدم نفسه
        const uploaded = await uploadFileToImageKit({
          bytes: transcoded.bytes,
          fileName: `${messageId}.m4a`,
          folder: `/aani/${userId}/messages`,
          contentType: "audio/mp4",
        });

        const finalBytes = transcoded.bytes.byteLength;
        const savedPercent = originalBytes > 0
          ? Math.round((1 - finalBytes / originalBytes) * 1000) / 10
          : 0;

        // 3) تسجيل الملف في سجل الرفع بعد نجاح الرفع (فحص اليتامى يعتمد عليه).
        //    فشل التسجيل لا يُفشل الرفع، لكنه يُسجَّل بوضوح للمتابعة.
        try {
          await recordUploadLedger(config, normalizeMediaUrl(uploaded.url));
        } catch (ledgerError) {
          logger.warn({ err: ledgerError, messageId }, "Voice upload ledger write failed");
        }

        logger.info({
          userId,
          messageId,
          originalBytes,
          finalBytes,
          savedPercent,
          processingMs: transcoded.processingMs,
          durationSeconds: transcoded.probe.durationSeconds,
          codec: transcoded.probe.codec,
          channels: transcoded.probe.channels,
          sampleRate: transcoded.probe.sampleRate,
          bitRate: transcoded.probe.bitRate,
        }, "Voice message transcoded and uploaded");

        return res.status(200).json({
          success: true,
          url: uploaded.url,
          metrics: {
            originalBytes,
            finalBytes,
            savedPercent,
            processingMs: transcoded.processingMs,
            durationSeconds: transcoded.probe.durationSeconds,
          },
        });
      } catch (error) {
        if (error instanceof VoiceProcessingError) {
          logger.warn({ status: error.statusCode, message: error.message }, "Voice transcoding rejected");
          return res.status(error.statusCode).json({ success: false, error: error.message });
        }
        if (error instanceof ImageKitUploadError) {
          logger.warn({ status: error.status, detail: error.detail }, "Voice upload to ImageKit failed");
          return res.status(error.status).json({ success: false, error: error.detail });
        }
        logger.error({ err: error }, "Voice message processing failed unexpectedly");
        return res.status(500).json({ success: false, error: "Could not process the voice message." });
      }
    })().catch(error => {
      logger.error({ err: error }, "Voice message request failed unexpectedly");
      if (!res.headersSent) res.status(500).json({ success: false, error: "Could not process the voice message." });
    });
  },
);

export default router;
