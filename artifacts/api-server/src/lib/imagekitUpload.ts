// رفع ملف إلى ImageKit من جهة الخادم بالمفتاح الخاص (Basic auth).
// مشترك بين الرفع الاحتياطي للوسائط (mediaUpload) ورفع الرسائل الصوتية
// المعالجة (mediaVoice)، فلا يتكرر بناء الطلب ولا يغادر المفتاح الخادم.

import { logger } from "./logger";

const IMAGEKIT_UPLOAD_ENDPOINT = "https://upload.imagekit.io/api/v1/files/upload";

export class ImageKitUploadError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ImageKitUploadError";
    this.status = status;
    this.detail = detail;
  }
}

export function readImageKitPrivateKey(): string {
  return (process.env["IMAGEKIT_PRIVATE_KEY"] || "").trim();
}

/**
 * مجلد نظيف تحت /aani فقط. يُطبَّع مرة واحدة: قيمة تبدأ أصلاً بـ`/aani/`
 * (كما يرسلها العميل) لا تُضاعف البادئة، فلا ينتهي الملف في `/aani/aani/...`
 * ويبقى تحت مجلد المستخدم الذي يتحقق منه سجل الرفع.
 */
export function normalizeImageKitFolder(raw: string): string {
  const cleaned = (raw || "")
    .replace(/[^a-zA-Z0-9._\-\/]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const relative = cleaned.replace(/^aani\//, "");
  return `/aani/${relative || "misc"}`;
}

/** هل تُرفع الملفات الجديدة كخاصة؟ يُفعَّل فقط مع توقيع إلزامي في الواجهة. */
function privateUploadsEnabled(): boolean {
  const signedUrlsEnabled = (process.env["IMAGEKIT_SIGNED_URLS_ENABLED"] || "").trim().toLowerCase() === "true";
  const privateUploadsRequested = (process.env["IMAGEKIT_PRIVATE_UPLOADS"] || "").trim().toLowerCase() === "true";
  if (privateUploadsRequested && !signedUrlsEnabled) {
    logger.warn("IMAGEKIT_PRIVATE_UPLOADS is set without IMAGEKIT_SIGNED_URLS_ENABLED — uploading public files instead");
  }
  return privateUploadsRequested && signedUrlsEnabled;
}

export interface ImageKitUploadParams {
  bytes: Buffer;
  fileName: string;
  folder: string;
  contentType: string;
}

/**
 * يرفع ملفاً واحداً ويعيد رابطه العام ومعرّفه. يرمي ImageKitUploadError
 * بحالة صريحة ورسالة الخدمة عند الفشل — لا نجاح وهمي.
 */
export async function uploadFileToImageKit(
  params: ImageKitUploadParams,
): Promise<{ url: string; fileId: string | null }> {
  const privateKey = readImageKitPrivateKey();
  if (!privateKey) {
    throw new ImageKitUploadError(503, "ImageKit is not configured (IMAGEKIT_PRIVATE_KEY).");
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(params.bytes)], { type: params.contentType }), params.fileName);
  form.append("fileName", params.fileName);
  form.append("folder", normalizeImageKitFolder(params.folder));
  form.append("useUniqueFileName", "true");
  if (privateUploadsEnabled()) form.append("isPrivateFile", "true");

  const response = await fetch(IMAGEKIT_UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
    },
    body: form,
  });

  const payload = await response.json().catch(() => null) as
    | { url?: unknown; fileId?: unknown; message?: unknown; help?: unknown }
    | null;

  if (response.ok && payload && typeof payload.url === "string" && payload.url) {
    return {
      url: payload.url,
      fileId: typeof payload.fileId === "string" && payload.fileId ? payload.fileId : null,
    };
  }

  const detail = typeof payload?.message === "string"
    ? payload.message
    : typeof payload?.help === "string"
      ? payload.help
      : `HTTP ${response.status}`;
  throw new ImageKitUploadError(response.status >= 400 ? response.status : 502, `ImageKit upload failed: ${detail}`);
}
