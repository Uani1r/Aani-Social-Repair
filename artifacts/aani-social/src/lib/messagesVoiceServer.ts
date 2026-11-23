// مصادر جهة العميل لمسار الرسائل الصوتية.
//
// ترتيب الإرسال:
//   1) تحويل على الخادم (FFmpeg → M4A/AAC أحادي) — المسار المفضّل.
//   2) إن تعذّر الخادم (404/503/شبكة/فشل التحويل) وكان التسجيل نفسه M4A صالحاً
//      الحاوية (ما يسجّله iPhone Safari)، يُرفع كما هو إلى ImageKit مباشرة —
//      وهو المسار الذي كان يعمل قبل إضافة التحويل الخادمي، فلا تتوقف البصمة.
//   3) WebM/Opus الخام لا يُرسل أبداً: قد لا يعمل على iPhone Safari، ويبقى
//      التسجيل في الجهاز مع إعادة المحاولة.

import { supabase } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import {
  buildVoiceCompressionMetrics,
  normalizeVoiceMimeType,
  isTrustedImageKitVoiceUrl,
  type VoiceCompressionMetrics,
} from '@/lib/messagesVoice';

interface VoiceUploadResponse {
  success?: unknown;
  url?: unknown;
  metrics?: {
    finalBytes?: unknown;
    processingMs?: unknown;
    durationSeconds?: unknown;
  } | null;
}

/** عدد محاولات التحويل على الخادم قبل إعلان الفشل (محدود). */
export const VOICE_TRANSCODE_ATTEMPTS = 2;
/** انتظار قصير قبل إعادة المحاولة (انقطاع عابر). */
export const VOICE_TRANSCODE_RETRY_DELAY_MS = 700;

export type VoicePrepareFailureReason = 'empty-recording' | 'transcode-failed';

export type VoicePrepareSource = 'server' | 'direct-m4a';

export type VoicePrepareOutcome =
  | { ok: true; url: string; metrics: VoiceCompressionMetrics; source: VoicePrepareSource }
  | { ok: false; reason: VoicePrepareFailureReason };

async function readAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * محاولة تحويل واحدة على الخادم. تعيد null عند أي فشل (بلا جلسة، خادم غير
 * متاح، رابط ناتج غير موثوق) — ولا ترفع شيئاً بنفسها.
 */
export async function transcodeVoiceMessageOnServer(
  blob: Blob,
  messageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; metrics: VoiceCompressionMetrics } | null> {
  if (!messageId) return null;
  const accessToken = await readAccessToken();
  if (!accessToken) return null;

  let response: Response;
  try {
    response = await fetch('/api/media/voice', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': blob.type || 'application/octet-stream',
        'x-aani-message-id': messageId,
      },
      body: blob,
      signal: options.signal,
    });
  } catch (error) {
    console.warn('[messages] تعذر الوصول إلى خدمة تحويل الصوت:', error);
    return null;
  }

  const rawBody = await response.text().catch(() => '');
  if (!response.ok) {
    // رسالة الخادم توضّح المرحلة (403 صلاحية، 503 غير مهيأ، 422 تحويل)
    console.warn('[messages] رفض الخادم تحويل الرسالة الصوتية:', response.status, rawBody.slice(0, 300));
    return null;
  }

  let payload: VoiceUploadResponse | null = null;
  try {
    payload = JSON.parse(rawBody) as VoiceUploadResponse;
  } catch {
    // استجابة ليست JSON غالباً صفحة SPA: المضيف الحالي لا يوجّه /api إلى
    // خدمة الـAPI (Netlify بلا API proxy مثلاً)، فيفشل التحويل دائماً.
    console.warn(
      '[messages] خدمة تحويل الصوت لا تُعيد JSON — المسار غير منشور على هذا المضيف '
        + 'أو /api غير موجّه إلى خدمة الـAPI. أضف API_PROXY_TARGET في إعدادات نشر الواجهة (Netlify).',
      rawBody.slice(0, 120),
    );
    return null;
  }
  if (!payload || payload.success !== true) {
    console.warn('[messages] خدمة تحويل الصوت أعادت فشلاً:', payload);
    return null;
  }
  if (typeof payload.url !== 'string' || !isTrustedImageKitVoiceUrl(payload.url)) {
    console.warn('[messages] رابط صوت غير موثوق من الخادم.');
    return null;
  }

  const finalBytes = typeof payload.metrics?.finalBytes === 'number' ? payload.metrics.finalBytes : 0;
  const processingMs = typeof payload.metrics?.processingMs === 'number' ? payload.metrics.processingMs : 0;

  return {
    url: payload.url,
    metrics: buildVoiceCompressionMetrics({
      originalBytes: blob.size,
      finalBytes,
      processingMs,
      sourceMimeType: blob.type,
      targetMimeType: 'audio/mp4',
      outcome: 'transcoded',
    }),
  };
}

/** براندات MP4/M4A المقبولة في صندوق `ftyp` (ما يسجّله Safari/iOS). */
const M4A_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'M4A ', 'M4B ', 'qt  ', 'dash', 'mmp4'];

/**
 * تحقّق حاوية M4A: صندوق `ftyp` في الموضع 4 وبراند معروف. ليس فحصاً كاملاً
 * للترميز، لكنه يمنع تمرير ملف غير MP4 باسم M4A.
 */
export function hasM4aContainer(header: Uint8Array): boolean {
  if (!header || header.length < 12) return false;
  const boxType = String.fromCharCode(header[4], header[5], header[6], header[7]);
  if (boxType !== 'ftyp') return false;
  const brand = String.fromCharCode(header[8], header[9], header[10], header[11]);
  return M4A_BRANDS.includes(brand);
}

/** هل التسجيل M4A صالح الحاوية (يمكن لـiPhone تشغيله كما هو)؟ */
export async function isPlayableM4aRecording(blob: Blob): Promise<boolean> {
  const format = normalizeVoiceMimeType(blob.type);
  if (!format || format.extension !== 'm4a') return false;
  try {
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    return hasM4aContainer(header);
  } catch {
    return false;
  }
}

function waitDelay(delayMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, delayMs);
  });
}

export interface PrepareVoiceMessageOptions {
  attempts?: number;
  retryDelayMs?: number;
  /** حقن التحويل في الاختبارات؛ الإنتاج يستخدم الخادم. */
  transcode?: (blob: Blob, messageId: string) => Promise<{ url: string; metrics: VoiceCompressionMetrics } | null>;
  /** حقن رفع M4A في الاختبارات؛ الإنتاج يستخدم رفع ImageKit المباشر. */
  uploadM4a?: (blob: Blob, messageId: string) => Promise<{ url: string; metrics: VoiceCompressionMetrics } | null>;
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * يرفع تسجيل M4A كما هو إلى ImageKit (بلا أي تحويل على الجهاز). يُستخدم فقط
 * بعد التحقق من الحاوية، وفقط عندما يتعذّر التحويل على الخادم.
 */
async function uploadM4aDirectly(
  blob: Blob,
  messageId: string,
): Promise<{ url: string; metrics: VoiceCompressionMetrics } | null> {
  const format = normalizeVoiceMimeType(blob.type);
  if (!format || format.extension !== 'm4a') return null;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) return null;

  const file = new File([blob], `voice-${messageId}.m4a`, { type: 'audio/mp4' });
  const path = `${userId}/messages/${messageId}.m4a`;
  const url = await uploadMedia({ file, path });
  if (!url || !isTrustedImageKitVoiceUrl(url)) return null;

  return {
    url,
    metrics: buildVoiceCompressionMetrics({
      originalBytes: blob.size,
      finalBytes: blob.size,
      sourceMimeType: blob.type,
      targetMimeType: 'audio/mp4',
      outcome: 'passthrough',
    }),
  };
}

/**
 * يجهّز مصدر الرسالة الصوتية: تحويل خادمي مع إعادة محاولة محدودة، ثم — إذا
 * كان التسجيل M4A صالح الحاوية — رفع مباشر إلى ImageKit (السلوك السابق).
 * WebM/Opus لا يُرسل خاماً أبداً.
 */
export async function prepareVoiceMessageSource(
  blob: Blob,
  messageId: string,
  options: PrepareVoiceMessageOptions = {},
): Promise<VoicePrepareOutcome> {
  if (!blob || !(blob.size > 0)) return { ok: false, reason: 'empty-recording' };

  const attempts = Math.max(1, Math.floor(options.attempts ?? VOICE_TRANSCODE_ATTEMPTS));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? VOICE_TRANSCODE_RETRY_DELAY_MS);
  const transcode = options.transcode ?? ((value, id) => transcodeVoiceMessageOnServer(value, id));
  const wait = options.wait ?? waitDelay;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await transcode(blob, messageId).catch(() => null);
    if (result && isTrustedImageKitVoiceUrl(result.url)) {
      return { ok: true, url: result.url, metrics: result.metrics, source: 'server' };
    }
    if (result) console.warn('[messages] رابط تحويل غير موثوق من الخادم — يُرفض.');
    if (attempt < attempts - 1) await wait(retryDelayMs);
  }

  // الخادم غير متاح أو فشل التحويل: التسجيل M4A من iPhone يعمل كما هو.
  if (!(await isPlayableM4aRecording(blob))) {
    console.warn('[messages] تعذر التحويل على الخادم والتسجيل ليس M4A صالحاً — لن يُرسل خاماً.');
    return { ok: false, reason: 'transcode-failed' };
  }

  const uploadM4a = options.uploadM4a ?? uploadM4aDirectly;
  const fallback = await uploadM4a(blob, messageId).catch(() => null);
  // حتى المسار البديل لا يمرّر رابطاً غير موثوق إلى المشغّل: نفس قاعدة
  // ImageKit المعتمدة التي يُتحقق بها من رابط الخادم.
  if (!fallback || !isTrustedImageKitVoiceUrl(fallback.url)) {
    console.warn('[messages] فشل التحويل الخادمي ولم يُنتج الرفع المباشر رابطاً موثوقاً.');
    return { ok: false, reason: 'transcode-failed' };
  }

  console.info('[messages][voice-metrics] fallback:direct-m4a', fallback.metrics);
  return { ok: true, url: fallback.url, metrics: fallback.metrics, source: 'direct-m4a' };
}
