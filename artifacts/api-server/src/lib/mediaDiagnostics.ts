// فحص تشخيصي مستقل لإعدادات توقيع ImageKit — وحدة معزولة تماماً.
//
// المبادئ:
// - لا تعطّل أي طلب سليم أبداً: كل الفحوصات تسجَّل في سجل الخادم فقط.
// - لا يُطبع المفتاح الخاص ولا التوقيع في السجل: أول أحرف وطول فقط،
//   ليساعد المستخدم على مطابقة القيمة بلوحة ImageKit دون كشفها.
// - تحقق اختياري (بكاش 10 دقائق) من صلاحية المفتاح الخاص عبر واجهة
//   إدارة ImageKit نفسها (نفس أسلوب Basic auth في imagekitAdmin.ts).

import { logger } from "./logger";

export interface ImageKitConfigDiagnosis {
  issues: string[];
  info: string[];
}

export function diagnoseImageKitSignatureConfig(config: {
  urlEndpoint: string;
  publicKey: string;
  privateKey: string;
}): ImageKitConfigDiagnosis {
  const issues: string[] = [];
  const info: string[] = [];
  const { urlEndpoint, publicKey, privateKey } = config;

  if (!/^https:\/\//i.test(urlEndpoint)) {
    issues.push(`IMAGEKIT_URL_ENDPOINT لا يستخدم HTTPS: "${urlEndpoint}"`);
  } else {
    info.push(`urlEndpoint: ${urlEndpoint}`);
  }

  if (!publicKey) {
    issues.push("IMAGEKIT_PUBLIC_KEY فارغ — الرفع المباشر سيفشل دائماً");
  } else {
    if (!publicKey.startsWith("public")) {
      issues.push(
        `IMAGEKIT_PUBLIC_KEY لا يبدأ بـ "public" (يبدأ بـ "${publicKey.slice(0, 8)}") — تحقق أنه المفتاح العام من لوحة ImageKit وليس شيئاً آخر`,
      );
    }
    info.push(`publicKey: يبدأ بـ "${publicKey.slice(0, 12)}" وطوله ${publicKey.length}`);
  }

  if (!privateKey) {
    issues.push("IMAGEKIT_PRIVATE_KEY فارغ — لا يمكن توليد توقيع صحيح");
  } else {
    if (privateKey !== privateKey.trim()) {
      issues.push(
        "IMAGEKIT_PRIVATE_KEY يحتوي فراغات في البداية/النهاية (قُصّت تلقائياً) — تأكد من لصق القيمة في Replit Secrets كما هي تماماً من لوحة ImageKit",
      );
    }
    info.push(
      `privateKey: طوله ${privateKey.trim().length} ويبدأ بـ "${privateKey.trim().slice(0, 7)}" (أول أحرف فقط للمطابقة مع لوحة ImageKit — لا يُنشر المفتاح كاملاً أبداً)`,
    );
  }

  return { issues, info };
}

/** وصف صيغة expire المولّد — ثوانٍ unix خلال ساعة كما يتطلب ImageKit */
export function describeExpireValue(expire: number): string {
  if (!Number.isInteger(expire)) {
    return `غير صحيح: ليس عدداً صحيحاً (${expire})`;
  }
  const now = Math.floor(Date.now() / 1000);
  if (expire <= now) return "منتهٍ بالفعل (في الماضي) — ImageKit سيرفضه";
  if (expire > now + 3600) return "يتجاوز الحد الأقصى لساعة واحدة";
  return `ثوانٍ unix صحيحة (صالح لمدة ${expire - now} ثانية)`;
}

export interface ImageKitProbeResult {
  ok: boolean;
  status: number;
  summary: string;
}

/**
 * تحقق من صلاحية المفتاح الخاص لدى ImageKit نفسها عبر واجهة الإدارة
 * (GET /v1/files?limit=1 بنفس أسلوب Basic auth المستخدم في الحذف الآلي).
 * 200 → المفتاح صالح؛ 401 → القيمة المُخزنة مرفوضة من ImageKit.
 */
export async function probeImageKitAdminCredentials(
  privateKey: string,
): Promise<ImageKitProbeResult> {
  try {
    const response = await fetch("https://api.imagekit.io/v1/files?limit=1&skip=0", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      return { ok: true, status: response.status, summary: "المفتاح الخاص صالح (قَبِلته واجهة إدارة ImageKit)" };
    }
    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        summary: "واجهة إدارة ImageKit رفضت المفتاح الخاص (401) — القيمة المخزنة في IMAGEKIT_PRIVATE_KEY غير صحيحة أو لا تطابق لوحة ImageKit",
      };
    }
    return {
      ok: false,
      status: response.status,
      summary: `استجابة غير متوقعة HTTP ${response.status} من واجهة إدارة ImageKit`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      summary: `تعذر الاتصال بواجهة إدارة ImageKit للتحقق: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// كاش 10 دقائق: لا نضرب واجهة ImageKit مع كل طلب توقيع
const PROBE_CACHE_MS = 10 * 60 * 1000;
let cachedProbe: { at: number; result: ImageKitProbeResult } | null = null;

export async function probeImageKitAdminCredentialsCached(
  privateKey: string,
): Promise<ImageKitProbeResult> {
  if (cachedProbe && Date.now() - cachedProbe.at < PROBE_CACHE_MS) {
    return cachedProbe.result;
  }
  const result = await probeImageKitAdminCredentials(privateKey);
  cachedProbe = { at: Date.now(), result };
  return result;
}

/** يُستدعى من نقطة التوقيع: يسجّل الأسباب الواضحة دون تعطيل الطلب */
export function logImageKitAuthDiagnostics(config: {
  urlEndpoint: string;
  publicKey: string;
  privateKey: string;
}): void {
  try {
    const diagnosis = diagnoseImageKitSignatureConfig(config);
    if (diagnosis.issues.length > 0) {
      logger.warn({ issues: diagnosis.issues, info: diagnosis.info }, "ImageKit auth config issues detected");
    }
    // تحقق دوري (مخزّن مؤقتاً) من صلاحية المفتاح لدى ImageKit — fire-and-forget
    void probeImageKitAdminCredentialsCached(config.privateKey)
      .then(result => {
        if (!result.ok) {
          logger.warn({ status: result.status, detail: result.summary }, "ImageKit private key probe failed");
        } else {
          logger.info(
            { detail: result.summary, publicKeyPrefix: config.publicKey.slice(0, 12) },
            "ImageKit private key probe OK — إذا استمر رفض الرفع بـ invalid signature، فالشك الأول: أن IMAGEKIT_PUBLIC_KEY و IMAGEKIT_PRIVATE_KEY من حسابين مختلفين أو أن الخادم المُخدَّم لم يُعد بناءه (خاصة Replit Deployment يحتاج Deploy لا مجرد سحب)",
          );
        }
      })
      .catch(() => undefined);
  } catch {
    // التشخيص لا يفشل الطلب أبداً
  }
}
