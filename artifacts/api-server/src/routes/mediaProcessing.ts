import { Router, type Request, type Response } from "express";

import { logger } from "../lib/logger";
import { getMediaAssetProcessingStatus, MediaProcessingError, processMediaAsset } from "../lib/mediaProcessing";
import { readSupabaseAdminConfig } from "../lib/supabaseAdmin";

const router = Router();
const MEDIA_ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readBearerToken(req: Request): string {
  const authorization = req.header("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function getAuthenticatedUserId(config: { url: string; serviceRoleKey: string }, accessToken: string): Promise<string | null> {
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

router.post("/media/process", (req: Request, res: Response) => {
  void (async () => {
    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Video processing service is not configured." });
    }

    const accessToken = readBearerToken(req);
    if (!accessToken) return res.status(401).json({ success: false, error: "Authentication is required." });

    const mediaAssetId = typeof req.body?.media_asset_id === "string" ? req.body.media_asset_id.trim() : "";
    if (!MEDIA_ASSET_ID_PATTERN.test(mediaAssetId)) {
      return res.status(400).json({ success: false, error: "A valid media_asset_id is required." });
    }

    try {
      const userId = await getAuthenticatedUserId(config, accessToken);
      if (!userId) return res.status(401).json({ success: false, error: "The session is invalid or expired." });

      const outcome = await processMediaAsset(config, userId, mediaAssetId);
      return res.status(outcome.status === "processing" ? 202 : 200).json(outcome);
    } catch (error) {
      if (error instanceof MediaProcessingError) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      logger.error({ err: error, mediaAssetId }, "Video processing failed");
      const message = error instanceof Error ? error.message : "Video processing failed.";
      return res.status(500).json({ success: false, error: message.slice(0, 1000) });
    }
  })().catch(error => {
    logger.error({ err: error }, "Media processing request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Video processing failed." });
  });
});

router.get("/media/:mediaAssetId/status", (req: Request, res: Response) => {
  void (async () => {
    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Video processing service is not configured." });
    }

    const accessToken = readBearerToken(req);
    if (!accessToken) return res.status(401).json({ success: false, error: "Authentication is required." });

    const mediaAssetId = typeof req.params.mediaAssetId === "string" ? req.params.mediaAssetId.trim() : "";
    if (!MEDIA_ASSET_ID_PATTERN.test(mediaAssetId)) {
      return res.status(400).json({ success: false, error: "A valid media_asset_id is required." });
    }

    try {
      const userId = await getAuthenticatedUserId(config, accessToken);
      if (!userId) return res.status(401).json({ success: false, error: "The session is invalid or expired." });

      const status = await getMediaAssetProcessingStatus(config, userId, mediaAssetId);
      return res.status(200).json({ success: true, ...status });
    } catch (error) {
      if (error instanceof MediaProcessingError) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      logger.error({ err: error, mediaAssetId }, "Could not read video processing status");
      return res.status(500).json({ success: false, error: "Could not read video processing status." });
    }
  })().catch(error => {
    logger.error({ err: error }, "Media processing status request failed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not read video processing status." });
  });
});

export default router;
