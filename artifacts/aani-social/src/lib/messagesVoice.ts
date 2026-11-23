// وحدة الرسائل الصوتية في الدردشة: تحليل المحتوى، والتحقق من الروابط الموثوقة،
// وإعدادات المسجل، وقياسات الضغط.
//
// سبب وجودها: الرسائل الصوتية القديمة خُزّنت بروابط Supabase Storage، والجديدة
// تُرفع إلى ImageKit؛ وكان التحقق القديم يقبل نطاق Supabase وحده فيرفض الجديد
// ويُظهره نصاً/JSON بدل مشغّل صوتي. هنا يقبل التحقق المضيفين المعتمدين فقط
// (ImageKit داخل مجلد الرفع الموحّد، أو مشروع Supabase نفسه) ويرفض ما عداهما.
//
// الوحدة خالصة بلا React: تُختبر مباشرة في Node.

import { storageBucket, supabaseUrl } from '@/lib/supabase';

export const CHAT_VOICE_MESSAGE_PREFIX = '[aani-audio:v1]';

/** أقصى مدة معقولة لرسالة صوتية: 24 ساعة (حماية من بيانات مشوهة). */
export const VOICE_MESSAGE_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export interface VoiceMessagePayload {
  url: string;
  durationMs: number;
}

// المضيف المعتمد بدقة: الصورة الرسمية لـImageKit هي `ik.imagekit.io` وحدها.
// لا تُقبل نطاقات مشابهة (`ik.imagekit.io.evil.example`) ولا نطاقات فرعية
// (`<id>.ik.imagekit.io`) غير مستخدمة في هذا المشروع.
const IMAGEKIT_HOST = 'ik.imagekit.io';
const AUDIO_FILE_EXTENSION_PATTERN = /\.(?:m4a|mp4|webm|ogg|oga|mp3|wav|aac|opus)$/i;
/**
 * مسار الرفع الموحّد الذي يبنيه التطبيق: `<userId>/messages/<file>` ويعاد إلى
 * `/<urlEndpointId>/aani/<userId>/messages/<file>` على ImageKit (المقطع الأول
 * هو معرّف endpoint الحساب). يُقبل الشكلان: مع معرّف الـendpoint وبدونه، ولا
 * يُقبل أي مسار آخر حتى لا يصبح التحقق مُمرّراً لأي رابط على النطاق.
 */
const IMAGEKIT_VOICE_PATH_PATTERN = /^(?:\/[^/]+)?\/aani\/[^/]+\/messages\/[^/]+$/i;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isApprovedImageKitHost(hostname: string): boolean {
  return hostname.toLowerCase() === IMAGEKIT_HOST;
}

/**
 * رابط صوت على نطاق ImageKit المعتمد للمشروع، داخل مجلد الرسائل الصوتية فقط،
 * وفي ملف بامتداد صوتي. ما عداه (نطاق خارجي، مجلد آخر، امتداد غير صوتي) مرفوض.
 */
export function isTrustedImageKitVoiceUrl(value: string): boolean {
  if (typeof value !== 'string') return false;
  const url = parseUrl(value.trim());
  if (!url || url.protocol !== 'https:') return false;
  if (!isApprovedImageKitHost(url.hostname)) return false;
  if (!AUDIO_FILE_EXTENSION_PATTERN.test(url.pathname)) return false;
  return IMAGEKIT_VOICE_PATH_PATTERN.test(url.pathname);
}

/**
 * رابط Supabase Storage القديم: نفس مشروع المشروع ونفس الـbucket، وبأي مسار
 * كائني — الصفوف القديمة قد تكون رُفعت قبل تثبيت مجلد الرفع.
 */
export function isTrustedSupabaseVoiceUrl(value: string): boolean {
  const url = parseUrl(value.trim());
  if (!url) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const storageUrl = parseUrl(supabaseUrl);
  if (!storageUrl) return false;

  const storagePath = `/storage/v1/object/public/${storageBucket}/`;
  return url.origin === storageUrl.origin && url.pathname.startsWith(storagePath);
}

/**
 * رابط صوت موثوق: رابط محلي مؤقت للمعاينة قبل الرفع (blob:)، أو رابط ImageKit
 * معتمد، أو رابط Supabase القديم. أي رابط خارجي آخر لا يُعرض ولا يُشغّل.
 */
export function isTrustedVoiceUrl(value: string): boolean {
  if (typeof value !== 'string') return false;
  const url = parseUrl(value.trim());
  if (!url) return false;
  if (url.protocol === 'blob:') return true;
  return isTrustedImageKitVoiceUrl(value) || isTrustedSupabaseVoiceUrl(value);
}

/**
 * يحلّل محتوى رسالة صوتية: البادئة ثم JSON صالحاً بحقلَي `url` و`durationMs`.
 * يعيد null لأي بيانات مشوهة أو رابط غير موثوق، فيبقى النص كما هو بدل مشغّل
 * معطوب.
 */
export function parseVoiceMessage(content: string): VoiceMessagePayload | null {
  if (typeof content !== 'string' || !content.startsWith(CHAT_VOICE_MESSAGE_PREFIX)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(CHAT_VOICE_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rawUrl = record.url;
  const rawDuration = record.durationMs;

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration)) return null;

  const url = parseUrl(rawUrl.trim());
  if (!url) return null;
  if (!isTrustedVoiceUrl(rawUrl.trim())) return null;

  return {
    url: url.toString(),
    durationMs: Math.min(VOICE_MESSAGE_MAX_DURATION_MS, Math.max(0, rawDuration)),
  };
}

export function voiceMessageContent(url: string, durationMs: number): string {
  return `${CHAT_VOICE_MESSAGE_PREFIX}${JSON.stringify({
    url,
    durationMs: Math.max(0, Math.round(durationMs)),
  })}`;
}

// ===== تسجيل الصوت =====

/**
 * ترتيب تفضيل الصيغ: MP4/AAC أولاً (أفضل توافق مع iOS وSafari)، ثم WebM/Opus
 * في Chrome. الترتيب مفروض هنا لا في المتصفح.
 */
export const VOICE_RECORDER_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const;

/**
 * معدل البت المطلوب من MediaRecorder. إشارة (hint) فقط: المتصفح قد يتجاهلها،
 * لذلك تُقاس النتيجة الفعلية من حجم الملف في سجل القياسات.
 */
export const VOICE_RECORDER_BITS_PER_SECOND = 32_000;

export interface VoiceRecordingFormat {
  mimeType: 'audio/mp4' | 'audio/webm';
  extension: 'm4a' | 'webm';
}

/** أول صيغة يدعمها المتصفح فعلاً، أو null إن لم يدعم أياً من المرشحات. */
export function pickVoiceRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | null {
  for (const candidate of VOICE_RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      /* صيغة رفضها المتصفح — نجرّب التالية */
    }
  }
  return null;
}

/**
 * يطبّع الصيغة الناتجة فعلياً من MediaRecorder (لا الصيغة المطلوبة).
 * يعيد null لصيغة لا نعرف كيف نرفعها.
 */
export function normalizeVoiceMimeType(value: string): VoiceRecordingFormat | null {
  if (typeof value !== 'string') return null;
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a' || mimeType === 'audio/aac') {
    return { mimeType: 'audio/mp4', extension: 'm4a' };
  }
  if (mimeType === 'audio/webm') return { mimeType, extension: 'webm' };
  return null;
}

// ===== المشغّل =====

/** سرعات التشغيل المتاحة للمستخدم. */
export const VOICE_PLAYBACK_RATES = [1, 1.5, 2] as const;

export type VoicePlaybackRate = (typeof VOICE_PLAYBACK_RATES)[number];

// ===== قياسات الضغط =====

export type VoiceCompressionOutcome = 'transcoded' | 'passthrough' | 'failed';

export interface VoiceCompressionMetrics {
  originalBytes: number;
  finalBytes: number;
  /** نسبة التوفير الفعلية بالنسبة المئوية (سالبة إن كبر الملف). */
  savedPercent: number;
  processingMs: number;
  sourceMimeType: string;
  targetMimeType: string;
  outcome: VoiceCompressionOutcome;
  failureReason?: string;
}

/**
 * يبني قياساً واحداً من أرقام حقيقية فقط. صفر أصل لا يعطي NaN، والتوفير
 * يُقرَّب لخانة عشرية واحدة بلا مبالغة: ملف كبر حجمه يعطي نسبة سالبة.
 */
export function buildVoiceCompressionMetrics(input: {
  originalBytes: number;
  finalBytes: number;
  processingMs?: number;
  sourceMimeType?: string;
  targetMimeType?: string;
  outcome?: VoiceCompressionOutcome;
  failureReason?: string;
}): VoiceCompressionMetrics {
  const originalBytes = Number.isFinite(input.originalBytes) && input.originalBytes > 0
    ? Math.round(input.originalBytes)
    : 0;
  const finalBytes = Number.isFinite(input.finalBytes) && input.finalBytes > 0
    ? Math.round(input.finalBytes)
    : 0;
  const savedPercent = originalBytes > 0
    ? Math.round((1 - finalBytes / originalBytes) * 1000) / 10
    : 0;

  return {
    originalBytes,
    finalBytes,
    savedPercent,
    processingMs: Number.isFinite(input.processingMs) && (input.processingMs ?? 0) > 0
      ? Math.round(input.processingMs as number)
      : 0,
    sourceMimeType: input.sourceMimeType || '',
    targetMimeType: input.targetMimeType || '',
    outcome: input.outcome ?? 'transcoded',
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
  };
}
