// مصادر جهة العميل لمسار الرسائل الصوتية.
//
// القاعدة الصارمة: لا تُرسل رسالة صوتية إلا بعد تحويلها والتحقق منها على
// الخادم (M4A/AAC أحادي). لا يوجد أي مسار يرفع WebM/Opus الخام كرسالة صوتية:
// قد لا يعمل على iPhone Safari، ولن يُخزَّن محتوى يبدو صالحاً ثم لا يُشغَّل.
//
// عند فشل الخادم يبقى التسجيل في الجهاز مع سبب واضح، ويُعاد التحويل لاحقاً
// من نفس الواجهة (retry) — دون أي ترميز ثقيل على جهاز iPhone.

import { supabase } from '@/lib/supabase';
import {
  buildVoiceCompressionMetrics,
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

export type VoicePrepareOutcome =
  | { ok: true; url: string; metrics: VoiceCompressionMetrics }
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

  if (!response.ok) {
    console.warn('[messages] رفض الخادم تحويل الرسالة الصوتية:', response.status);
    return null;
  }

  const payload = await response.json().catch(() => null) as VoiceUploadResponse | null;
  if (!payload || payload.success !== true) return null;
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
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * يجهّز مصدر الرسالة الصوتية: يعيد المحاولة على الخادم (محدودة) ثم يعيد
 * نتيجة صريحة. لا يوجد مسار بديل يرفع التسجيل بصيغته الأصلية: كل مصدر
 * (WebM/Opus أو M4A) يجب أن يمرّ بالتحويل والتحقق على الخادم.
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
    if (result) return { ok: true, url: result.url, metrics: result.metrics };
    if (attempt < attempts - 1) await wait(retryDelayMs);
  }

  return { ok: false, reason: 'transcode-failed' };
}
