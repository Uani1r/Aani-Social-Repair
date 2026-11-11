import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { SupabaseAdminConfig } from "./supabaseAdmin";

const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROCESS_LOG_CHARS = 12_000;
const PROCESSING_BUCKET = process.env["SUPABASE_STORAGE_BUCKET"]
  || process.env["VITE_SUPABASE_STORAGE_BUCKET"]
  || "aani-media";

type MediaAsset = {
  id: string;
  user_id: string;
  original_path: string | null;
  storage_path: string | null;
  processed_path: string | null;
  status: string | null;
  video_url: string | null;
  processing_status: string | null;
  error_message: string | null;
};

type RelatedPost = {
  id: string;
  media_url: string | null;
  media_urls: unknown;
  sound_id: string | null;
  audio_url: string | null;
};

type ProcessedMedia = {
  success: true;
  status: "ready" | "processing";
  video_url?: string;
  duration?: number;
  width?: number;
  height?: number;
};

export class MediaProcessingError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "MediaProcessingError";
    this.statusCode = statusCode;
  }
}

function adminHeaders(config: SupabaseAdminConfig): Record<string, string> {
  return {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
  };
}

function restUrl(config: SupabaseAdminConfig, table: string, params: Record<string, string>): URL {
  const url = new URL(`/rest/v1/${table}`, config.url);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

async function restRequest<T>(config: SupabaseAdminConfig, url: URL, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(adminHeaders(config));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${body.slice(0, 600)}`);
  }
  if (!body) return null as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Supabase returned an invalid response.");
  }
}

async function loadMediaAsset(config: SupabaseAdminConfig, mediaAssetId: string): Promise<MediaAsset | null> {
  const rows = await restRequest<MediaAsset[]>(config, restUrl(config, "media_assets", {
    select: "id,user_id,original_path,storage_path,processed_path,status,video_url,processing_status,error_message",
    id: `eq.${mediaAssetId}`,
    limit: "1",
  }));
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function patchMediaAsset(
  config: SupabaseAdminConfig,
  mediaAssetId: string,
  userId: string,
  values: Record<string, unknown>,
  statusFilter?: string,
): Promise<MediaAsset[]> {
  const params: Record<string, string> = {
    id: `eq.${mediaAssetId}`,
    user_id: `eq.${userId}`,
  };
  if (statusFilter) params.processing_status = statusFilter;
  return restRequest<MediaAsset[]>(config, restUrl(config, "media_assets", params), {
    method: "PATCH",
    headers: { "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(values),
  }) || [];
}

async function loadRelatedPosts(config: SupabaseAdminConfig, mediaAssetId: string): Promise<RelatedPost[]> {
  const rows = await restRequest<RelatedPost[]>(config, restUrl(config, "posts", {
    select: "id,media_url,media_urls,sound_id,audio_url",
    media_asset_id: `eq.${mediaAssetId}`,
    limit: "100",
  }));
  return Array.isArray(rows) ? rows : [];
}

async function loadSoundSource(config: SupabaseAdminConfig, soundId: string): Promise<string | null> {
  const rows = await restRequest<Array<{ source_video_url?: unknown }>>(config, restUrl(config, "sounds", {
    select: "source_video_url",
    id: `eq.${soundId}`,
    limit: "1",
  }));
  const source = rows?.[0]?.source_video_url;
  return typeof source === "string" && source.trim() ? source.trim() : null;
}

function stripFragment(url: string): string {
  return url.split("#", 1)[0];
}

async function shouldStripOriginalAudio(
  config: SupabaseAdminConfig,
  posts: RelatedPost[],
  originalVideoUrls: Set<string>,
): Promise<boolean> {
  for (const post of posts) {
    const mediaSources = [post.media_url, ...(Array.isArray(post.media_urls) ? post.media_urls : [])]
      .filter((value): value is string => typeof value === "string" && Boolean(value))
      .map(stripFragment);
    const nativeSources = new Set([...mediaSources, ...originalVideoUrls]);

    if (post.audio_url && !nativeSources.has(stripFragment(post.audio_url))) return true;
    if (post.sound_id) {
      let soundSource: string | null = null;
      try {
        soundSource = await loadSoundSource(config, post.sound_id);
      } catch {
        // When a sound is explicitly attached but its source cannot be checked,
        // favor the requested custom-audio behavior and remove the video's audio.
        return true;
      }
      if (!soundSource || !nativeSources.has(stripFragment(soundSource))) return true;
    }
  }
  return false;
}

function encodedStoragePath(storagePath: string): string {
  return storagePath.split("/").map(segment => encodeURIComponent(segment)).join("/");
}

function validateOriginalPath(originalPath: string, userId: string): void {
  const segments = originalPath.split("/");
  if (
    !originalPath.startsWith(`${userId}/`)
    || originalPath.startsWith("/")
    || segments.some(segment => !segment || segment === "." || segment === "..")
  ) {
    throw new MediaProcessingError(400, "The media asset has an invalid original_path.");
  }
}

function storageObjectUrl(config: SupabaseAdminConfig, storagePath: string): URL {
  return new URL(
    `/storage/v1/object/${encodeURIComponent(PROCESSING_BUCKET)}/${encodedStoragePath(storagePath)}`,
    config.url,
  );
}

function publicStorageUrl(config: SupabaseAdminConfig, storagePath: string): string {
  return new URL(
    `/storage/v1/object/public/${encodeURIComponent(PROCESSING_BUCKET)}/${encodedStoragePath(storagePath)}`,
    config.url,
  ).toString();
}

async function downloadOriginal(
  config: SupabaseAdminConfig,
  originalPath: string,
  userId: string,
  destination: string,
): Promise<void> {
  validateOriginalPath(originalPath, userId);
  const response = await fetch(storageObjectUrl(config, originalPath), {
    headers: adminHeaders(config),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download original media from Storage (${response.status}).`);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SOURCE_BYTES) {
    await response.body.cancel();
    throw new Error("The original video exceeds the 1 GB processing limit.");
  }

  let downloadedBytes = 0;
  const sizeLimit = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      downloadedBytes += buffer.byteLength;
      if (downloadedBytes > MAX_SOURCE_BYTES) {
        callback(new Error("The original video exceeds the 1 GB processing limit."));
        return;
      }
      callback(null, buffer);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    sizeLimit,
    createWriteStream(destination, { flags: "wx" }),
  );
  if (downloadedBytes === 0) throw new Error("The original video file is empty.");
}

function runFfmpeg(inputPath: string, outputPath: string, stripAudio: boolean): Promise<void> {
  const audioOptions = stripAudio ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"];
  const args = [
    "-hide_banner",
    "-y",
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-crf", "23",
    "-maxrate", "4.5M",
    "-bufsize", "9M",
    "-r", "30",
    ...audioOptions,
    "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.env["FFMPEG_PATH"] || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    timeout.unref();

    child.stderr?.on("data", chunk => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_PROCESS_LOG_CHARS);
    });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = timedOut ? "FFmpeg processing exceeded the 10 minute limit." : stderr.trim();
      reject(new Error(detail || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
}

function probeOutput(outputPath: string): Promise<{ duration: number; width: number; height: number }> {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.env["FFPROBE_PATH"] || "ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    timeout.unref();
    child.stdout?.on("data", chunk => {
      stdout = `${stdout}${chunk.toString()}`.slice(0, MAX_PROCESS_LOG_CHARS);
    });
    child.stderr?.on("data", chunk => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_PROCESS_LOG_CHARS);
    });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code ?? "unknown"}.`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as {
          streams?: Array<{ width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const width = Number(result.streams?.[0]?.width);
        const height = Number(result.streams?.[0]?.height);
        const duration = Number(result.format?.duration);
        if (![width, height, duration].every(Number.isFinite) || width <= 0 || height <= 0 || duration <= 0) {
          throw new Error("ffprobe returned invalid video dimensions or duration.");
        }
        resolve({ duration, width, height });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Could not parse ffprobe output."));
      }
    });
  });
}

async function uploadProcessedVideo(config: SupabaseAdminConfig, storagePath: string, filePath: string): Promise<void> {
  const fileInfo = await stat(filePath);
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  const response = await fetch(storageObjectUrl(config, storagePath), {
    method: "POST",
    headers: {
      ...adminHeaders(config),
      "content-type": "video/mp4",
      "content-length": String(fileInfo.size),
      "x-upsert": "true",
    },
    body,
    duplex: "half",
    signal: AbortSignal.timeout(10 * 60 * 1000),
  } as RequestInit & { duplex: "half" });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(`Could not upload processed video to Storage (${response.status}): ${detail}`);
  }
}

function replaceMediaBase(url: string, processedUrl: string): string {
  const fragmentIndex = url.indexOf("#");
  return `${processedUrl}${fragmentIndex >= 0 ? url.slice(fragmentIndex) : ""}`;
}

async function updateRelatedPosts(
  config: SupabaseAdminConfig,
  posts: RelatedPost[],
  originalVideoUrls: Set<string>,
  processedUrl: string,
  mediaAssetId: string,
): Promise<void> {
  for (const post of posts) {
    const currentMediaUrl = post.media_url || "";
    const nextMediaUrl = currentMediaUrl
      ? replaceMediaBase(currentMediaUrl, processedUrl)
      : processedUrl;
    let mediaUrls: string[] | null = null;
    if (Array.isArray(post.media_urls)) {
      const existingUrls = post.media_urls.filter((url): url is string => typeof url === "string");
      let replacedAny = false;
      mediaUrls = existingUrls.map(url => {
        if (originalVideoUrls.has(stripFragment(url))) {
          replacedAny = true;
          return replaceMediaBase(url, processedUrl);
        }
        return url;
      });
      if (!replacedAny && mediaUrls.length > 0) mediaUrls[0] = replaceMediaBase(mediaUrls[0], processedUrl);
    }

    await restRequest<unknown>(config, restUrl(config, "posts", {
      id: `eq.${post.id}`,
      media_asset_id: `eq.${mediaAssetId}`,
    }), {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({ media_url: nextMediaUrl, media_urls: mediaUrls }),
    });
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "An unexpected media processing error occurred.";
  return message.slice(0, 2000);
}

async function processClaimedMediaAsset(
  config: SupabaseAdminConfig,
  userId: string,
  mediaAssetId: string,
  asset: MediaAsset,
): Promise<ProcessedMedia> {
  let tempDirectory: string | null = null;
  try {
    const originalPath = asset.storage_path || asset.original_path;
    if (!originalPath) throw new MediaProcessingError(400, "The media asset has no original storage path.");
    tempDirectory = await mkdtemp(path.join(tmpdir(), `aani-media-${mediaAssetId}-`));
    const inputPath = path.join(tempDirectory, "input-video");
    const outputPath = path.join(tempDirectory, "output.mp4");
    const processedPath = `processed/${userId}/${mediaAssetId}.mp4`;
    const processedUrl = publicStorageUrl(config, processedPath);

    validateOriginalPath(originalPath, userId);
    const originalUrl = asset.video_url || publicStorageUrl(config, originalPath);
    const originalVideoUrls = new Set([stripFragment(originalUrl), publicStorageUrl(config, originalPath)]);
    const relatedPosts = await loadRelatedPosts(config, mediaAssetId);
    const stripAudio = await shouldStripOriginalAudio(config, relatedPosts, originalVideoUrls);

    await downloadOriginal(config, originalPath, userId, inputPath);
    await runFfmpeg(inputPath, outputPath, stripAudio);
    const metadata = await probeOutput(outputPath);
    await uploadProcessedVideo(config, processedPath, outputPath);
    await updateRelatedPosts(config, relatedPosts, originalVideoUrls, processedUrl, mediaAssetId);

    const updated = await patchMediaAsset(config, mediaAssetId, userId, {
      video_url: processedUrl,
      processed_path: processedPath,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      status: "ready",
      processing_status: "ready",
      error_message: null,
    });
    if (!updated.length) throw new Error("The processed video was uploaded but the media asset record could not be finalized.");

    return { success: true, status: "ready", video_url: processedUrl, ...metadata };
  } catch (error) {
    const message = errorText(error);
    try {
      await patchMediaAsset(config, mediaAssetId, userId, {
        status: "failed",
        processing_status: "failed",
        error_message: message,
      });
    } catch (updateError) {
      console.error("[media-processing] Could not record failed processing status:", updateError);
    }
    throw error;
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function processMediaAsset(
  config: SupabaseAdminConfig,
  userId: string,
  mediaAssetId: string,
): Promise<ProcessedMedia> {
  const asset = await loadMediaAsset(config, mediaAssetId);
  if (!asset) throw new MediaProcessingError(404, "Media asset was not found.");
  if (asset.user_id !== userId) throw new MediaProcessingError(403, "You cannot process this media asset.");
  const assetStatus = asset.status || asset.processing_status;
  if (assetStatus === "ready" && asset.video_url) {
    return { success: true, status: "ready", video_url: asset.video_url };
  }

  const processedPath = `processed/${userId}/${mediaAssetId}.mp4`;
  const claimed = await patchMediaAsset(config, mediaAssetId, userId, {
    status: "processing",
    processing_status: "processing",
    processed_path: processedPath,
    error_message: null,
  }, "in.(uploading,failed)");
  if (!claimed.length) {
    const latest = await loadMediaAsset(config, mediaAssetId);
    const latestStatus = latest?.status || latest?.processing_status;
    if (latestStatus === "ready" && latest?.video_url) {
      return { success: true, status: "ready", video_url: latest.video_url };
    }
    if (latestStatus === "processing") {
      return { success: true, status: "processing" };
    }
    throw new MediaProcessingError(409, "The media asset is not ready to be processed.");
  }

  setImmediate(() => {
    void processClaimedMediaAsset(config, userId, mediaAssetId, asset).catch(error => {
      console.error("[media-processing] Background video processing failed:", error);
    });
  });
  return { success: true, status: "processing" };
}

export async function getMediaAssetProcessingStatus(
  config: SupabaseAdminConfig,
  userId: string,
  mediaAssetId: string,
): Promise<{ status: string | null; video_url: string | null; error_message: string | null }> {
  const asset = await loadMediaAsset(config, mediaAssetId);
  if (!asset) throw new MediaProcessingError(404, "Media asset was not found.");
  if (asset.user_id !== userId) throw new MediaProcessingError(403, "You cannot access this media asset.");
  return {
    status: asset.status || asset.processing_status,
    video_url: asset.video_url,
    error_message: asset.error_message,
  };
}
