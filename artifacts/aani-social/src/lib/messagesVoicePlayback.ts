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

/** ينهي حالة الانتظار والتشغيل عند فشل play() أو حدث خطأ من مصدر الوسائط. */
export function failVoicePlayback(handlers: VoicePlaybackHandlers, error: unknown): void {
  handlers.onLoading?.(false);
  handlers.onPlaying?.(false);
  handlers.onError?.(error);
}

export type VoicePlaybackUrlResolver = (storedUrl: string) => Promise<string | null>;
export type VoicePlaybackUrlValidator = (resolvedUrl: string) => boolean;

/** بعد فشل التشغيل، لا نؤخر ضغطة المستخدم بتجديد الرابط إذا اكتمل تجديده مسبقاً. */
export function needsVoicePlaybackSourceRefresh(
  audioPaused: boolean,
  playbackUrl: string | null,
  hasError: boolean,
  retrySourceReady: boolean,
): boolean {
  return audioPaused && (!playbackUrl || (hasError && !retrySourceReady));
}

/**
 * يحلّ رابط الرسالة الصوتية إلى عنوان العرض النهائي، ويرفض النتيجة الفارغة أو
 * غير الموثوقة أو المتأخرة. المهلة تمنع مؤشر تجهيز المصدر من البقاء إلى الأبد.
 */
export async function resolveVoicePlaybackSource(
  storedUrl: string,
  resolveUrl: VoicePlaybackUrlResolver,
  isTrustedUrl: VoicePlaybackUrlValidator,
  timeoutMs = 15_000,
): Promise<string | null> {
  const source = storedUrl.trim();
  if (!source) return null;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      resolveUrl(source),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
      }),
    ]);
    if (typeof resolved !== 'string' || !resolved.trim()) return null;
    const normalized = resolved.trim();
    return isTrustedUrl(normalized) ? normalized : null;
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
    failVoicePlayback(handlers, error);
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
