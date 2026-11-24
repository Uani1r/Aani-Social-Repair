// تجهيز فيديو الاستوديو لرسالة محادثة: تحقق من الحدود، ضغط، صورة غلاف، قياسات.
//
// الترتيب: تحقق (نوع/مدة/حجم) → ضغط medi bunny (بالحفاظ على الصوت) → تحقق
// من الحجم النهائي → صورة غلاف → قياسات. أي فشل يعيد رسالة عربية واضحة، ولا
// يُرفع الملف الأصلي بصمت.

import {
  buildChatVideoMetrics,
  chatVideoRejectMessage,
  checkChatVideoLimits,
  type ChatVideoMetrics,
  type ChatVideoRejectReason,
} from '@/lib/chatVideo';
import { createVideoPoster } from '@/lib/videoPoster';
import { compressVideo, inspectMp4Bytes, probeVideoMetadata } from '@/utils/mediaCompressor';

export type ChatVideoPreparation =
  | { ok: true; file: File; poster: File | null; durationMs: number; metrics: ChatVideoMetrics }
  | { ok: false; reason: ChatVideoRejectReason; message: string };

/** معدل الإطارات المقاس من الملف الناتج فعلياً (inspectMp4Bytes) أو غير متاح. */
async function measureFps(file: File): Promise<number | undefined> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
    const inspection = inspectMp4Bytes(bytes);
    const videoTrack = inspection.tracks.find(track => track.kind === 'video');
    return typeof videoTrack?.fps === 'number' && videoTrack.fps > 0 ? videoTrack.fps : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareChatVideo(
  file: File,
  options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {},
): Promise<ChatVideoPreparation> {
  if (!file.type.startsWith('video/')) {
    return { ok: false, reason: 'not-a-video', message: chatVideoRejectMessage('not-a-video') };
  }

  const startedAt = Date.now();
  const originalBytes = file.size;
  const before = await probeVideoMetadata(file);
  const durationSeconds = before?.durationSeconds ?? 0;
  // المدة إلزامية: مدة مجهولة أو غير صالحة ترفض الفيديو قبل أي ضغط أو رفع.
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) {
    return {
      ok: false,
      reason: 'duration-unknown',
      message: chatVideoRejectMessage('duration-unknown'),
    };
  }
  const initialLimit = checkChatVideoLimits({ durationSeconds, sizeBytes: originalBytes });
  if (initialLimit) {
    return { ok: false, reason: initialLimit, message: chatVideoRejectMessage(initialLimit) };
  }

  let compressed: File;
  try {
    compressed = await compressVideo(file, { signal: options.signal, onProgress: options.onProgress });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason: ChatVideoRejectReason = detail.includes('المسار الصوتي')
      ? 'audio-lost'
      : detail.includes('يتجاوز')
        ? 'too-large'
        : 'compression-failed';
    return { ok: false, reason, message: chatVideoRejectMessage(reason, detail) };
  }

  // المدة بعد الضغط تُقاس من الملف المضغوط نفسه، لا من المدة الأصلية.
  const after = await probeVideoMetadata(compressed);
  const compressedDuration = after?.durationSeconds ?? 0;
  if (!(compressedDuration > 0) || !Number.isFinite(compressedDuration)) {
    return {
      ok: false,
      reason: 'duration-unknown',
      message: chatVideoRejectMessage('duration-unknown'),
    };
  }
  const afterLimit = checkChatVideoLimits({ durationSeconds: compressedDuration, sizeBytes: compressed.size });
  if (afterLimit) {
    return { ok: false, reason: afterLimit, message: chatVideoRejectMessage(afterLimit) };
  }

  // صورة الغلاف اختيارية: فشلها لا يُسقط الفيديو (يبقى زر تشغيل بلا معاينة).
  let poster: File | null = null;
  try {
    poster = await createVideoPoster(compressed);
  } catch (error) {
    console.warn('[messages] تعذر إنشاء صورة غلاف للفيديو:', error);
    poster = null;
  }

  // التحقق الحقيقي من الصوت: مسار فعلي في الملف الناتج وترميزه AAC، مقروءاً
  // عبر mediabunny من المسارات نفسها — لا مسح أول 256KB ولا قيمة موروثة.
  const beforeHadAudio = before?.hasAudio === true;
  if (after === null && beforeHadAudio) {
    return { ok: false, reason: 'audio-unverified', message: chatVideoRejectMessage('audio-unverified') };
  }
  const hasAudioAfter = after?.hasAudio === true;
  if (beforeHadAudio && !hasAudioAfter) {
    return { ok: false, reason: 'audio-lost', message: chatVideoRejectMessage('audio-lost') };
  }
  if (beforeHadAudio && !/aac|mp4a/i.test(after?.audioCodec ?? '')) {
    return { ok: false, reason: 'audio-unverified', message: chatVideoRejectMessage('audio-unverified') };
  }

  const fps = await measureFps(compressed);
  const metrics = buildChatVideoMetrics({
    originalBytes,
    finalBytes: compressed.size,
    processingMs: Date.now() - startedAt,
    durationSeconds: compressedDuration,
    width: after?.width ?? before?.width ?? 0,
    height: after?.height ?? before?.height ?? 0,
    fps,
    hasAudioBefore: beforeHadAudio,
    hasAudioAfter,
  });
  try {
    console.info('[messages][chat-video-metrics]', metrics);
  } catch {
    /* لا يؤثر في الإرسال */
  }

  return {
    ok: true,
    file: compressed,
    poster,
    durationMs: Math.round(metrics.durationSeconds * 1000),
    metrics,
  };
}
