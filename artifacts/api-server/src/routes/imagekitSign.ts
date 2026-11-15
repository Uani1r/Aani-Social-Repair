import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";

import { logger } from "../lib/logger";
import { readSupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();

/** صلاحية الرابط الموقّع: ساعة واحدة. */
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
 * يبني رابط ImageKit موقّعاً بالصيغة الرسمية:
 *   {urlEndpoint}/{relativePath}?ik-t={expire}&ik-s={signature}
 *
 * signature = HMAC-SHA1(privateKey, relativePath + expire) بصيغة hex صغيرة،
 * حيث relativePath هو المسار **بعد** حذف الـendpoint، ويشمل بادئة التحويلات
 * (`tr:w-400,h-300/`) إن وُجدت، ويُرمَّز percent-encoding قبل التوقيع لأن
 * ImageKit تتحقق من المسار كما يصلها مرمّزاً (أسماء غير لاتينية، مسافات).
 *
 * ملاحظة صريحة: إنشاء الرابط لا يُثبت صحته. الصحة تُختبر بفتحه فعلياً مع
 * تفعيل "Restrict unsigned URLs" في ImageKit: الرابط بلا توقيع يُرفض 401،
 * والموقّع يُقبل، والموقّع المنتهي يُرفض. راجع docs/PRIVATE_MEDIA_AR.md.
 */
export function buildImageKitSignedUrl(
  urlEndpoint: string,
  privateKey: string,
  objectPath: string,
  expire: number,
): string {
  const endpoint = urlEndpoint.replace(/\/+$/, "");
  // الـendpoint قد يحمل معرّف الحساب في مساره (/abc123)؛ يُحذف قبل التوقيع
  // لأن ImageKit توقّع المسار **بعد** الـendpoint فقط.
  let endpointPath = "";
  try {
    endpointPath = new URL(endpoint).pathname.replace(/\/+$/, "");
  } catch {
    endpointPath = "";
  }

  let relativePath = objectPath.replace(/^\/+/, "");
  if (endpointPath && endpointPath !== "/") {
    const prefix = endpointPath.replace(/^\/+/, "");
    if (relativePath === prefix) relativePath = "";
    else if (relativePath.startsWith(`${prefix}/`)) relativePath = relativePath.slice(prefix.length + 1);
  }

  // فك أي ترميز وصل من العميل ثم إعادة ترميزه مرة واحدة، حتى لا يُرمَّز مرتين
  // (%20 يصبح %2520) وحتى يبقى الفاصل / كما هو.
  const encodedPath = relativePath
    .split("/")
    .filter(Boolean)
    .map(segment => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // مقطع بترميز غير صالح: يُرمَّز كما وصل.
      }
      return encodeURIComponent(decoded);
    })
    .join("/");

  const signature = crypto
    .createHmac("sha1", privateKey)
    .update(`${encodedPath}${expire}`)
    .digest("hex")
    .toLowerCase();

  return `${endpoint}/${encodedPath}?ik-t=${expire}&ik-s=${signature}`;
}

/** مسار ImageKit صالح: مطلق، بلا مخطط/مضيف/استعلام/شرطة مزدوجة/خروج من الجذر. */
function isSafeImageKitPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.length > 1024) return false;
  if (/[?#\\\s]/.test(value)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  if (value.split("/").includes("..")) return false;
  return true;
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
    const objectPath = rawPath.trim();
    if (!isSafeImageKitPath(objectPath)) {
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
          url: buildImageKitSignedUrl(imagekit.urlEndpoint, imagekit.privateKey, objectPath, expire),
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
