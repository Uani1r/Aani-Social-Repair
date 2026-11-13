import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";

import { logger } from "../lib/logger";
import { buildImageKitSignature, describeExpireValue, logImageKitAuthDiagnostics } from "../lib/mediaDiagnostics";
import { readSupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();

function readImageKitConfig() {
  const urlEndpoint = (process.env["IMAGEKIT_URL_ENDPOINT"] || "").trim();
  const publicKey = (process.env["IMAGEKIT_PUBLIC_KEY"] || "").trim();
  const privateKey = (process.env["IMAGEKIT_PRIVATE_KEY"] || "").trim();
  if (!urlEndpoint || !publicKey || !privateKey) return null;
  return { urlEndpoint, publicKey, privateKey };
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

// توقيع المصادقة الآمن للرفع المباشر من المتصفح إلى ImageKit.
// المفتاح الخاص يبقى على الخادم فقط؛ يُرجع للعميل (urlEndpoint + publicKey +
// token + expire + signature) الصالحة لمدة 30 دقيقة لعملية رفع واحدة.
router.get("/media/imagekit-auth", (req: Request, res: Response) => {
  void (async () => {
    const supabaseConfig = readSupabaseAdminConfig();
    if (!supabaseConfig) {
      return res.status(503).json({ success: false, error: "Authentication service is not configured." });
    }

    const accessToken = readBearerToken(req);
    if (!accessToken) return res.status(401).json({ success: false, error: "Authentication is required." });

    const imagekit = readImageKitConfig();
    if (!imagekit) {
      return res.status(503).json({
        success: false,
        error: "ImageKit is not configured. Set IMAGEKIT_URL_ENDPOINT, IMAGEKIT_PUBLIC_KEY and IMAGEKIT_PRIVATE_KEY.",
      });
    }

    try {
      const userId = await getAuthenticatedUserId(supabaseConfig, accessToken);
      if (!userId) return res.status(401).json({ success: false, error: "The session is invalid or expired." });

      // فحص تشخيصي صامت: يسجل أي مشكلة في إعدادات ImageKit (مفاتيح ناقصة/
      // فراغات/مفتاح مرفوض من ImageKit نفسه) في سجل الخادم دون تعطيل الطلب
      logImageKitAuthDiagnostics(imagekit);

      const token = crypto.randomUUID();
      // ImageKit يتوقع expire بالثواني (unix time) وبحد أقصى ساعة واحدة
      const expire = Math.floor(Date.now() / 1000) + 60 * 30;
      // خوارزمية ImageKit الرسمية كما في حزمها (imagekit-nodejs
      // → getAuthenticationParameters): HMAC-SHA1 بالمفتاح الخاص
      // كمفتاح، على النص token + expire — وليس SHA1 عادي.
      const signature = buildImageKitSignature(imagekit.privateKey, token, expire);

      // سجل تشخيصي غير حساس: هل المعاملات المولّدة بصيغة سليمة (بلا أسرار)
      logger.info(
        { expire, expireCheck: describeExpireValue(expire), tokenPrefix: token.slice(0, 8), publicKeyPrefix: imagekit.publicKey.slice(0, 12), algorithm: "HMAC-SHA1(privateKey, token+expire)" },
        "ImageKit upload auth generated",
      );

      return res
        .status(200)
        // منع التخزين المؤقت على مستوى المتصفح (خاصة Safari): التوكن أحادي
        // الاستخدام — أي استجابة مخزنة أو معاد استخدامها تعني رفضاً من ImageKit
        .set({
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        })
        .json({
          success: true,
          urlEndpoint: imagekit.urlEndpoint,
          publicKey: imagekit.publicKey,
          // نفس التوكن المُستخدم في حساب التوقيع تماماً — إرجاع توكن مختلف
          // (استدعاء ثانٍ لـ randomUUID) يجعل التوقيع غير مطابق دائماً
          // ويرفض ImageKit كل رفعة برسالة "invalid signature parameter".
          token,
          expire,
          signature,
        });
    } catch (error) {
      logger.error({ err: error }, "ImageKit auth generation failed");
      return res.status(500).json({ success: false, error: "Could not generate ImageKit auth parameters." });
    }
  })().catch(error => {
    logger.error({ err: error }, "ImageKit auth request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not generate ImageKit auth parameters." });
  });
});

export default router;
