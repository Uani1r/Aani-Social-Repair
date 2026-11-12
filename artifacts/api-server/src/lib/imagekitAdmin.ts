// عميل إدارة ImageKit من جهة الخادم باستخدام المفتاح الخاص (Basic auth).
// المفتاح الخاص لا يغادر الخادم أبداً؛ تُستخدم هذه الوحدة لحذف الملفات
// غير المستخدمة فقط (القصص المنتهية والمنشورات المحذوفة) للحفاظ على
// حد تخزين 20 GB في الباقة المجانية.
//
// الحذف يعتمد على واجهتين موثقتين ومستقرتين فقط:
//   GET  /v1/files?path=<folder>  (قائمة ملفات المجلد — كل عنصر يحمل fileId وurl)
//   DELETE /v1/files/:fileId
// نطابق الرابط الأساسي (بلا معاملات #t=/؟tr=) فنحذف الملف المقابل بالضبط.

let cachedPrivateKey: string | null | undefined;

export function imageKitConfigured(): boolean {
  if (cachedPrivateKey === undefined) {
    cachedPrivateKey = (process.env["IMAGEKIT_PRIVATE_KEY"] || "").trim() || null;
  }
  return cachedPrivateKey !== null;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${cachedPrivateKey!}:`).toString("base64")}`,
  };
}

type ImageKitFileItem = {
  fileId?: unknown;
  url?: unknown;
  name?: unknown;
  isFolder?: unknown;
};

async function imagekitRequest(
  path: string,
  searchParams: Record<string, string> = {},
  method: string = "GET",
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = new URL(`https://api.imagekit.io/v1/${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { method, headers: authHeaders() });
  const data = response.ok ? await response.json().catch(() => null) : null;
  return { ok: response.ok, status: response.status, data };
}

/** الرابط الأساسي بلا معاملات تحويل (?tr=) ولا هاشتاغ تعديل (#t= / #crop=) */
export function baseUrl(value: unknown): string {
  return typeof value === "string" ? value.split(/[?#]/)[0] : "";
}

/**
 يحذف ملفات ImageKit التي تطابق هذه الروابط بالضبط (مطابقة الرابط الأساسي).
 يعيد عدد الملفات المحذوفة والفاشلة.
 */
export async function deleteImageKitFilesByUrls(
  fileUrls: string[],
): Promise<{ deleted: number; failed: number }> {
  if (!imageKitConfigured()) return { deleted: 0, failed: 0 };

  const targets = new Map<string, string>(); // الرابط الأساسي → مجلد ImageKit
  for (const raw of fileUrls) {
    if (typeof raw !== "string" || !raw) continue;
    try {
      const parsed = new URL(raw);
      const folderPath = parsed.pathname.replace(/\/[^/]*$/, "");
      if (!folderPath || !folderPath.includes("/aani/")) continue;
      targets.set(`${parsed.origin}${parsed.pathname}`, folderPath);
    } catch {
      continue;
    }
  }
  if (targets.size === 0) return { deleted: 0, failed: 0 };

  // نُخزّن قائمة كل مجلد مرة واحدة ضمن عملية الحذف نفسها
  const listCache = new Map<string, ImageKitFileItem[]>();
  let deleted = 0;
  let failed = 0;

  for (const [targetUrl, folderPath] of targets) {
    let items = listCache.get(folderPath);
    if (!items) {
      const listed = await imagekitRequest("files", {
        path: folderPath,
        includeFolder: "false",
        limit: "1000",
      });
      items = Array.isArray(listed.data) ? (listed.data as ImageKitFileItem[]) : [];
      listCache.set(folderPath, items);
    }

    const match = items.find((item) =>
      typeof item.url === "string" ? baseUrl(item.url) === targetUrl : false,
    );
    const fileId = typeof match?.fileId === "string" ? match.fileId : "";
    if (!fileId) {
      failed += 1;
      continue;
    }

    const removed = await imagekitRequest(`files/${encodeURIComponent(fileId)}`, {}, "DELETE");
    if (removed.ok) deleted += 1;
    else failed += 1;
  }

  return { deleted, failed };
}
