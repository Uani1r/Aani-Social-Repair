// التنظيف التلقائي للموسائط وقاعدة البيانات ضمن حدود الباقات المجانية
// (ImageKit: 25 MB للملف و20 GB تخزين، Supabase: 500 MB لقاعدة البيانات).
//
// POST /api/media/purge-expired
//   فحص دوري يُستدعى من العميل مرة يومياً. يحذف:
//   1) ملفات ImageKit للقصص المنتهية (بعد مهلة يومين) غير المستخدمة
//      في أبرز القصص (غلاف أو عنصر) أو في مكتبة الأصوات النشطة.
//   2) صفوف القصص المنتهية ومشاهداتها من قاعدة البيانات.
//   3) الإشعارات الأقدم من 30 يوماً.
//
// POST /api/media/imagekit-delete  { kind: "post" | "story", id }
//   يُستدعى من العميل قبل حذف صف المنشور/الستوري حتى يتسنى التحقق من
//   الملكية. يرفض حذف الوسائط إذا كانت مستخدمة في أبرز القصص أو الأصوات.

import { Router, type Request, type Response } from "express";

import { logger } from "../lib/logger";
import { readSupabaseAdminConfig, type SupabaseAdminConfig } from "../lib/supabaseAdmin";
import { baseUrl, deleteImageKitFilesByUrls, imageKitConfigured } from "../lib/imagekitAdmin";

const router = Router();

// مهلة يومين قبل مسح القصص المنتهية (تسمح بتأخر إضافة أبرز القصص)
const STORY_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
// الإشعارات تبقى 30 يوماً ثم تُحذف
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

async function restRequest(
  config: SupabaseAdminConfig,
  method: string,
  table: string,
  searchParams: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = new URL(`/rest/v1/${table}`, config.url);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      Prefer: "return=representation",
    },
  });
  const data = response.ok ? await response.json().catch(() => null) : null;
  return { ok: response.ok, status: response.status, data };
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** هل هذه الوسائط مستخدمة في أبرز القصص (غلاف أو عنصر) أو في مكتبة الأصوات النشطة؟ */
async function mediaInActiveUse(
  config: SupabaseAdminConfig,
  mediaUrls: string[],
  options: { sourceStoryId?: string } = {},
): Promise<boolean> {
  if (mediaUrls.length === 0) return false;

  const highlights = asRows((await restRequest(config, "GET", "profile_highlights", {
    select: "media_url,source_story_id",
    limit: "1000",
  })).data);
  const highlightUrls = highlights.map((row) => baseUrl(row.media_url)).filter(Boolean);
  const highlightStoryIds = highlights
    .map((row) => row.source_story_id)
    .filter((value): value is string => typeof value === "string");
  if (options.sourceStoryId && highlightStoryIds.includes(options.sourceStoryId)) return true;
  if (mediaUrls.some((url) => highlightUrls.includes(url))) return true;

  const sounds = asRows((await restRequest(config, "GET", "sounds", {
    select: "source_video_url,preview_url",
    limit: "1000",
  })).data);
  const soundUrls = sounds
    .flatMap((row) => [baseUrl(row.source_video_url), baseUrl(row.preview_url)])
    .filter(Boolean);
  return mediaUrls.some((url) => soundUrls.includes(url));
}

router.post("/media/purge-expired", (req: Request, res: Response) => {
  void (async () => {
    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Database is not configured." });
    }
    const userId = await getAuthenticatedUserId(config, readBearerToken(req));
    if (!userId) {
      return res.status(401).json({ success: false, error: "The session is invalid or expired." });
    }

    try {
      const cutoff = new Date(Date.now() - STORY_GRACE_MS).toISOString();
      const stories = asRows((await restRequest(config, "GET", "stories", {
        select: "id,media_url",
        expires_at: `lt.${cutoff}`,
        limit: "500",
      })).data).filter((row) => typeof row.id === "string");

      const deletableStories = [] as { id: string; mediaUrl: string }[];
      if (stories.length > 0) {
        const highlights = asRows((await restRequest(config, "GET", "profile_highlights", {
          select: "media_url,source_story_id",
          limit: "1000",
        })).data);
        const highlightUrls = highlights.map((row) => baseUrl(row.media_url)).filter(Boolean);
        const highlightStoryIds = highlights
          .map((row) => row.source_story_id)
          .filter((value): value is string => typeof value === "string");

        const sounds = asRows((await restRequest(config, "GET", "sounds", {
          select: "source_video_url,preview_url",
          limit: "1000",
        })).data);
        const soundUrls = sounds
          .flatMap((row) => [baseUrl(row.source_video_url), baseUrl(row.preview_url)])
          .filter(Boolean);

        for (const story of stories) {
          const mediaUrl = baseUrl(story.media_url);
          if (!mediaUrl) {
            // قصة بلا وسائط — يُحذف الصف فقط
            deletableStories.push({ id: String(story.id), mediaUrl: "" });
            continue;
          }
          if (highlightStoryIds.includes(String(story.id))) continue;
          if (highlightUrls.includes(mediaUrl)) continue;
          if (soundUrls.includes(mediaUrl)) continue;
          deletableStories.push({ id: String(story.id), mediaUrl });
        }
      }

      let mediaDeleted = 0;
      if (imageKitConfigured() && deletableStories.length > 0) {
        const result = await deleteImageKitFilesByUrls(
          deletableStories.map((story) => story.mediaUrl).filter(Boolean),
        );
        mediaDeleted = result.deleted;
      }

      const deletableIds = deletableStories.map((story) => story.id);
      if (deletableIds.length > 0) {
        await restRequest(config, "DELETE", "story_views", {
          story_id: `in.(${deletableIds.join(",")})`,
        });
        await restRequest(config, "DELETE", "stories", {
          id: `in.(${deletableIds.join(",")})`,
        });
      }

      const notificationCutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS).toISOString();
      const notifications = await restRequest(config, "DELETE", "notifications", {
        created_at: `lt.${notificationCutoff}`,
      });

      return res.status(200).json({
        success: true,
        stories: deletableIds.length,
        mediaDeleted,
        notificationsDeleted: Array.isArray(notifications.data) ? notifications.data.length : 0,
      });
    } catch (error) {
      logger.error({ err: error }, "Expired media purge failed");
      return res.status(500).json({ success: false, error: "Could not purge expired media." });
    }
  })().catch((error) => {
    logger.error({ err: error }, "Expired media purge crashed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not purge expired media." });
  });
});

router.post("/media/imagekit-delete", (req: Request, res: Response) => {
  void (async () => {
    const config = readSupabaseAdminConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Database is not configured." });
    }
    if (!imageKitConfigured()) {
      return res.status(503).json({ success: false, error: "ImageKit is not configured." });
    }
    const userId = await getAuthenticatedUserId(config, readBearerToken(req));
    if (!userId) {
      return res.status(401).json({ success: false, error: "The session is invalid or expired." });
    }

    const body = (req.body || {}) as { kind?: unknown; id?: unknown };
    const kind = body.kind === "post" || body.kind === "story" ? body.kind : "";
    const id = typeof body.id === "string" ? body.id : "";
    if (!kind || !id) {
      return res.status(400).json({ success: false, error: "kind and id are required." });
    }

    try {
      if (kind === "post") {
        const posts = asRows((await restRequest(config, "GET", "posts", {
          select: "id,user_id,media_url,media_urls",
          id: `eq.${id}`,
          limit: "1",
        })).data);
        const post = posts[0];
        if (!post || post.user_id !== userId) {
          return res.status(404).json({ success: false, error: "Post not found." });
        }

        const mediaUrls = [
          ...(Array.isArray(post.media_urls)
            ? post.media_urls.filter((value): value is string => typeof value === "string")
            : []),
          String(post.media_url || ""),
        ].map(baseUrl).filter(Boolean);

        if (await mediaInActiveUse(config, mediaUrls)) {
          // الوسائط ما زالت مستخدمة (أبرز القصص/الأصوات) — نحذف الصف فقط ونترك الملفات
          return res.status(200).json({ success: true, deleted: 0, skipped: true, reason: "media-still-referenced" });
        }

        const result = await deleteImageKitFilesByUrls(mediaUrls);
        return res.status(200).json({ success: true, deleted: result.deleted, failed: result.failed });
      }

      const stories = asRows((await restRequest(config, "GET", "stories", {
        select: "id,user_id,media_url",
        id: `eq.${id}`,
        limit: "1",
      })).data);
      const story = stories[0];
      if (!story || story.user_id !== userId) {
        return res.status(404).json({ success: false, error: "Story not found." });
      }

      const mediaUrls = [String(story.media_url || "")].map(baseUrl).filter(Boolean);
      if (await mediaInActiveUse(config, mediaUrls, { sourceStoryId: id })) {
        return res.status(200).json({ success: true, deleted: 0, skipped: true, reason: "media-still-referenced" });
      }

      const result = await deleteImageKitFilesByUrls(mediaUrls);
      if (mediaUrls.length > 0) {
        await restRequest(config, "DELETE", "story_views", { story_id: `eq.${id}` });
      }
      return res.status(200).json({ success: true, deleted: result.deleted, failed: result.failed });
    } catch (error) {
      logger.error({ err: error }, "ImageKit media deletion failed");
      return res.status(500).json({ success: false, error: "Could not delete media files." });
    }
  })().catch((error) => {
    logger.error({ err: error }, "ImageKit media deletion crashed unexpectedly");
    if (!res.headersSent) res.status(500).json({ success: false, error: "Could not delete media files." });
  });
});

export default router;
