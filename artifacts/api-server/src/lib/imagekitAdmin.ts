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
 قائمة كاملة لملفات مجلد ImageKit مع Pagination إلزامية (skip/limit):
 فشل أي صفحة يرمي استثناءً — لا تُستخدم قائمة جزئية أبداً في قرارات الحذف.
 */
export async function listAllImageKitFiles(folderPath: string): Promise<ImageKitFileItem[]> {
  const limit = 1000;
  let skip = 0;
  const all: ImageKitFileItem[] = [];
  while (true) {
    const result = await imagekitRequest("files", {
      path: folderPath,
      includeFolder: "false",
      limit: String(limit),
      skip: String(skip),
    });
    if (!result.ok || !Array.isArray(result.data)) {
      throw new Error(`ImageKit listing failed: HTTP ${result.status}`);
    }
    const batch = result.data as ImageKitFileItem[];
    all.push(...batch);
    if (batch.length < limit) break;
    skip += batch.length;
  }
  return all;
}

export type ImageKitDeletionResult = {
  deleted: number;
  /** تحققنا بالفحص الكامل أن الملف غير موجود في ImageKit (لا هدف حذف له) */
  verifiedAbsent: number;
  failed: number;
};

/**
 يحذف ملفات ImageKit التي تطابق هذه الروابط بالضبط (مطابقة الرابط الأساسي).
 فشل جلب القائمة يرمي استثناءً — المتصل (Worker) يعيد الجدولة بدل الحذف الأعمى.
 لا نعيد أبداً {deleted:0,failed:0} كادعاء نجاح: كل حالة تُميَّز صراحة.
 */
export async function deleteImageKitFilesByUrls(
  fileUrls: string[],
): Promise<ImageKitDeletionResult> {
  if (!imageKitConfigured()) {
    throw new Error("ImageKit is not configured — cannot verify or delete files");
  }

  const targets = new Map<string, string>(); // الرابط الأساسي → مجلد ImageKit
  let verifiedAbsent = 0;
  let unresolvable = 0;

  for (const raw of fileUrls) {
    if (typeof raw !== "string" || !raw) continue;
    try {
      const parsed = new URL(raw);
      if (!parsed.hostname.endsWith("ik.imagekit.io")) {
        // ليس ملفاً في ImageKit أصلاً (روابط تخزين قديمة/خارجية) — لا هدف حذف له
        verifiedAbsent += 1;
        continue;
      }
      const folderPath = parsed.pathname.replace(/\/[^/]*$/, "");
      if (!folderPath || !folderPath.includes("/aani/")) {
        verifiedAbsent += 1;
        continue;
      }
      targets.set(`${parsed.origin}${parsed.pathname}`, folderPath);
    } catch {
      // تعذر تحديد هدف الحذف — فشل صريح (لا نجاح وهمي)
      unresolvable += 1;
    }
  }
  if (targets.size === 0) {
    if (unresolvable > 0) {
      throw new Error(`Could not resolve ImageKit deletion target(s) for ${unresolvable} URL(s)`);
    }
    return { deleted: 0, verifiedAbsent, failed: 0 };
  }

  // نُخزّن قائمة كل مجلد مرة واحدة ضمن عملية الحذف نفسها (لا List لكل ملف على حدة)
  const listCache = new Map<string, ImageKitFileItem[]>();
  let deleted = 0;
  let failed = 0;

  for (const [targetUrl, folderPath] of targets) {
    let items = listCache.get(folderPath);
    if (!items) {
      items = await listAllImageKitFiles(folderPath);
      listCache.set(folderPath, items);
    }

    const match = items.find((item) =>
      typeof item.url === "string" ? baseUrl(item.url) === targetUrl : false,
    );
    const fileId = typeof match?.fileId === "string" ? match.fileId : "";
    if (!fileId) {
      // القائمة كاملة (بـ Pagination) ولم يجد الملف → تحقق فعلي من عدم الوجود
      // (حُذف سابقاً) — لا حذف أعمى ولا إعادة محاولة أبدية على ملف غير موجود
      verifiedAbsent += 1;
      continue;
    }

    const removed = await imagekitRequest(`files/${encodeURIComponent(fileId)}`, {}, "DELETE");
    if (removed.ok) deleted += 1;
    else failed += 1;
  }

  if (failed > 0 && deleted === 0 && verifiedAbsent === 0) {
    throw new Error(`ImageKit deletion failed for ${failed} file(s)`);
  }
  return { deleted, verifiedAbsent, failed };
}
