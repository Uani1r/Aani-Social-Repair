import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";

import { logger } from "../lib/logger";
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

      const token = crypto.randomUUID();
      const expire = Math.floor(Date.now() / 1000) + 60 * 30;
      const signature = crypto
        .createHmac("sha1", imagekit.privateKey)
        .update(`${token}${expire}`)
        .digest("hex");

      return res.status(200).json({
        success: true,
        urlEndpoint: imagekit.urlEndpoint,
        publicKey: imagekit.publicKey,
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
