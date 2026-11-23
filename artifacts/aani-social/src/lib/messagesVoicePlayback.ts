// منطق تشغيل الرسائل الصوتية: مشغّل واحد فقط، وحالة خطأ قابلة لإعادة المحاولة.
//
// الوحدة صرفة: تستقبل عنصر صوت يشبه HTMLAudioElement، فتُختبر بدون متصفح.
// تشغيل رسالة يوقف التي قبلها، وفشل التشغيل يُنهي حالة التحميل دائماً (لا
// Spinner عالق) ويُبقي زر التشغيل قابلاً للضغط من جديد.

export interface VoiceAudioLike {
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  currentTime: number;
}

export type VoicePlaybackResult = 'playing' | 'paused' | 'error';

export interface VoicePlaybackHandlers {
  onLoading?(loading: boolean): void;
  onPlaying?(playing: boolean): void;
  onError?(error: unknown): void;
}

/**
 * يبدأ أو يوقف التشغيل. عند `reloadOnError` يُعاد تحميل المصدر من أوله قبل
 * المحاولة (إعادة المحاولة بعد فشل سابق). أي فشل يعيد 'error' بعد إنهاء
 * حالة التحميل، فلا يبقى مؤشر دوّار عالقاً.
 */
export async function toggleVoicePlayback(
  audio: VoiceAudioLike,
  handlers: VoicePlaybackHandlers = {},
  options: { reloadOnError?: boolean } = {},
): Promise<VoicePlaybackResult> {
  const { onLoading, onPlaying, onError } = handlers;

  if (!audio.paused) {
    audio.pause();
    onLoading?.(false);
    onPlaying?.(false);
    return 'paused';
  }

  if (options.reloadOnError) {
    try {
      audio.load();
      audio.currentTime = 0;
    } catch {
      /* العنصر قد لا يكون جاهزاً لإعادة التحميل */
    }
  }

  onLoading?.(true);
  try {
    await audio.play();
    onLoading?.(false);
    onPlaying?.(true);
    return 'playing';
  } catch (error) {
    onLoading?.(false);
    onPlaying?.(false);
    onError?.(error);
    return 'error';
  }
}

let activeStopper: (() => void) | null = null;

/**
 * يحجز مشغّل الصوت النشط: يوقف السابق ويعيد دالة تحرير لا تُوقف إلا حجزها هي،
 * فلا يُوقف مشغّل أحدث حجزاً.
 */
export function claimVoicePlayback(stop: () => void): () => void {
  if (activeStopper && activeStopper !== stop) activeStopper();
  activeStopper = stop;
  return () => {
    if (activeStopper === stop) activeStopper = null;
  };
}

export function stopActiveVoicePlayback(): void {
  const stop = activeStopper;
  activeStopper = null;
  stop?.();
}
