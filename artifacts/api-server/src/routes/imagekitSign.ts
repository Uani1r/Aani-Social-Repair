import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";

import { logger } from "../lib/logger";
import { readSupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();

/** صلاحية الرابط الموقّع: ساعة واحدة (الحد الأقصى المقبول من ImageKit). */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

function readImageKitConfig() {
  const urlEndpoint = (process.env["IMAGEKIT_URL_ENDPOINT"] || "").trim().replace(/\/+$/, "");
  const privateKey = (process.env["IMAGEKIT_PRIVATE_KEY"] || "").trim();
  if (!urlEndpoint || !privateKey) return null;
  return { urlEndpoint, privateKey };
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

/**
 * يسأل قاعدة البيانات نفسها عن حق المشاهد في هذا الملف.
 * aani_can_read_media_object تُعيد true فقط إذا كان الملف يخصّ منشوراً أو قصة
 * أو أبرز قصص يملك المستدعي حق قراءتها، أو صورة ملف عامة، أو رفعته الخاصة.
 * يُستدعى بجلسة المستخدم (Authorization) لا بمفتاح الخدمة، فـ auth.uid() هو المشاهد.
 */
async function canReadMediaObject(
  config: { url: string; serviceRoleKey: string },
  accessToken: string,
  objectPath: string,
): Promise<boolean> {
  const response = await fetch(new URL("/rest/v1/rpc/aani_can_read_media_object", config.url), {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_object_name: objectPath }),
  });

  if (!response.ok) {
    // الدالة غير مثبّتة بعد (404/PGRST202) أو رفض صلاحيات: لا توقيع.
    logger.warn({ status: response.status }, "ImageKit sign: media access check failed");
    return false;
  }

  const allowed = await response.json().catch(() => null);
  return allowed === true;
}

/**
 * رابط ImageKit موقّع (Signed URL).
 * الصيغة الرسمية: signature = HMAC-SHA1(privateKey, path + expire).
 * لا يفيد التوقيع إلا إذا كانت الملفات على Restricted access في ImageKit،
 * وإلا بقي الرابط العادي صالحاً. راجع docs/PRIVATE_MEDIA_AR.md.
 */
function buildSignedUrl(urlEndpoint: string, privateKey: string, objectPath: string, expire: number): string {
  const signature = crypto.createHmac("sha1", privateKey).update(`${objectPath}${expire}`).digest("hex");
  return `${urlEndpoint}${objectPath}?expire=${expire}&signature=${signature}`;
}

/**
 * GET /media/imagekit-sign?path=/folder/file.jpg
 * يُعيد رابطاً موقّعاً صالحاً لساعة، بعد التحقق من الجلسة ومن حق المشاهد في الملف.
 * لا يُعيد المفتاح الخاص ولا أي سرّ.
 */
router.get("/media/imagekit-sign", (req: Request, res: Response) => {
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
        error: "ImageKit is not configured. Set IMAGEKIT_URL_ENDPOINT and IMAGEKIT_PRIVATE_KEY.",
      });
    }

    const rawPath = typeof req.query["path"] === "string" ? req.query["path"] : "";
    // مسار فقط: بلا مخطط ولا نطاق، فلا يمكن توقيع رابط مضيف آخر.
    const objectPath = rawPath.trim();
    if (!objectPath.startsWith("/") || objectPath.startsWith("//") || objectPath.length > 1024) {
      return res.status(400).json({ success: false, error: "A single absolute ImageKit path is required." });
    }

    try {
      const userId = await getAuthenticatedUserId(supabaseConfig, accessToken);
      if (!userId) return res.status(401).json({ success: false, error: "The session is invalid or expired." });

      const allowed = await canReadMediaObject(supabaseConfig, accessToken, objectPath);
      if (!allowed) return res.status(403).json({ success: false, error: "This media is not accessible." });

      const expire = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
      return res
        .status(200)
        .set({ "Cache-Control": "private, no-store" })
        .json({
          success: true,
          url: buildSignedUrl(imagekit.urlEndpoint, imagekit.privateKey, objectPath, expire),
          expire,
        });
    } catch (error) {
      logger.error({ err: error }, "ImageKit signed URL generation failed");
      return res.status(500).json({ success: false, error: "Could not sign this media URL." });
    }
  })().catch(error => {
    logger.error({ err: error }, "ImageKit sign request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not sign this media URL." });
  });
});

export default router;
