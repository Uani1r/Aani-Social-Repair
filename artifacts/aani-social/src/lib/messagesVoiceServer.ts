// جسر العميل إلى خادم الرسائل الصوتية: تحويل صوتي على الخادم، وجدولة حذف
// الملف من ImageKit عند حذف الرسالة لدى الجميع.
//
// الدالتان لا ترميان أبداً: فشل الخادم يعني مساراً احتياطياً في المستدعي
// (رفع التسجيل الخام كما هو)، وفشل جدولة الحذف لا يعطّل حذف الرسالة.

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

async function readAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * يحوّل التسجيل على الخادم ويُرفعه إلى ImageKit. يعيد null عند أي فشل
 * (بلا جلسة، خادم غير متاح، مدة غير مدعومة، رابط ناتج غير موثوق) ليُكمل
 * المستدعي برفع الأصل بلا تحويل.
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
    console.warn('[messages] تعذر الوصول إلى خدمة تحويل الصوت — سيُرفع التسجيل كما هو:', error);
    return null;
  }

  if (!response.ok) {
    console.warn('[messages] رفض الخادم تحويل الرسالة الصوتية — سيُرفع التسجيل كما هو:', response.status);
    return null;
  }

  const payload = await response.json().catch(() => null) as VoiceUploadResponse | null;
  if (!payload || payload.success !== true) return null;
  if (typeof payload.url !== 'string' || !isTrustedImageKitVoiceUrl(payload.url)) {
    console.warn('[messages] رابط صوت غير موثوق من الخادم — سيُرفع التسجيل كما هو.');
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

/**
 * يطلب من الخادم جدولة حذف ملف الرسالة الصوتية من ImageKit بعد حذف الصف.
 * الخادم يتحقق من الملكية وفحص المراجع الحية قبل الحذف الفعلي.
 */
export async function enqueueVoiceMessageMediaDeletion(messageId: string): Promise<void> {
  if (!messageId) return;
  try {
    const accessToken = await readAccessToken();
    if (!accessToken) return;
    const response = await fetch('/api/media/imagekit-delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ kind: 'message', id: messageId }),
    });
    if (!response.ok) {
      console.warn('[messages] تعذر جدولة حذف ملف الرسالة الصوتية:', response.status);
    }
  } catch (error) {
    console.warn('[messages] تعذر جدولة حذف ملف الرسالة الصوتية:', error);
  }
}
