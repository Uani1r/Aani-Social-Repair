// منطق مشغّل فيديو المحادثة: مشغّل واحد فقط، ولا تشغيل تلقائي.
//
// الوحدة صرفة: تستقبل عنصر فيديو يشبه HTMLVideoElement فتُختبر بلا متصفح.
// لا يُشغَّل شيء قبل ضغط المستخدم زر التشغيل، وتشغيل مقطع يوقف السابق،
// وكل فشل يُنهي حالة التحميل ويُظهر زر إعادة محاولة (لا Spinner عالق).

export interface ChatVideoLike {
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  play(): Promise<void>;
  pause(): void;
}

export type ChatVideoPlaybackResult = 'playing' | 'paused' | 'error';

export interface ChatVideoPlaybackHandlers {
  onLoading?(loading: boolean): void;
  onPlaying?(playing: boolean): void;
  onError?(error: unknown): void;
}

/**
 * يبدأ/يوقف التشغيل. `reloadOnError` يعيد ضبط الموضع إلى البداية قبل محاولة
 * جديدة بعد فشل سابق. أي فشل يعيد 'error' بعد إنهاء التحميل.
 */
export async function toggleChatVideoPlayback(
  video: ChatVideoLike,
  handlers: ChatVideoPlaybackHandlers = {},
  options: { reloadOnError?: boolean } = {},
): Promise<ChatVideoPlaybackResult> {
  const { onLoading, onPlaying, onError } = handlers;

  if (!video.paused) {
    video.pause();
    onLoading?.(false);
    onPlaying?.(false);
    return 'paused';
  }

  if (options.reloadOnError) {
    try {
      video.currentTime = 0;
    } catch {
      /* قد لا يكون المصدر جاهزاً بعد */
    }
  }

  onLoading?.(true);
  try {
    await video.play();
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

let activeChatVideoStopper: (() => void) | null = null;

/** يحجز مشغّل الفيديو النشط: تشغيل مقطع يوقف السابق (فيديو واحد في وقت واحد). */
export function claimChatVideoPlayback(stop: () => void): () => void {
  if (activeChatVideoStopper && activeChatVideoStopper !== stop) activeChatVideoStopper();
  activeChatVideoStopper = stop;
  return () => {
    if (activeChatVideoStopper === stop) activeChatVideoStopper = null;
  };
}

export function stopActiveChatVideoPlayback(): void {
  const stop = activeChatVideoStopper;
  activeChatVideoStopper = null;
  stop?.();
}

/** مدة بالمللي ثانية → m:ss أو h:mm:ss (بلا كسر). */
export function formatChatVideoTime(valueMs: number): string {
  const totalSeconds = Number.isFinite(valueMs) && valueMs > 0 ? Math.floor(valueMs / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** موضع سحب الشريط مقيد داخل [0, المدة] — لا موضع سالب ولا يتجاوز النهاية. */
export function clampChatVideoSeek(valueMs: number, durationMs: number): number {
  if (!Number.isFinite(valueMs)) return 0;
  const max = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return Math.min(max, Math.max(0, valueMs));
}

/** مستوى صوت أو كتم في خطوة واحدة: كتم → 0، أو مستوى يُفكّ الكتم عند > 0. */
export function nextChatVideoMuteState(
  current: { muted: boolean; volume: number },
): { muted: boolean; volume: number } {
  if (current.muted) {
    return { muted: false, volume: current.volume > 0 ? current.volume : 1 };
  }
  return { muted: true, volume: current.volume };
}

export function isChatVideoFullscreenSupported(video: unknown): boolean {
  if (!video || typeof video !== 'object') return false;
  const element = video as {
    requestFullscreen?: unknown;
    webkitEnterFullscreen?: unknown;
  };
  return typeof element.requestFullscreen === 'function'
    || typeof element.webkitEnterFullscreen === 'function';
}


export interface ChatVideoSourceLike extends ChatVideoLike {
  src?: string;
}

/**
 * أول تشغيل: يُسند المصدر ثم ينادي play() **داخل معالج ضغط المستخدم نفسه**
 * بلا أي await قبله، فيبقى تفعيل المستخدم صالحاً على Safari. عنصر الفيديو
 * يبقى بلا مصدر قبل هذه الضغطة، فلا يبدأ أي تنزيل عند ظهور الرسالة.
 */
export function startChatVideoOnUserTap(
  video: ChatVideoSourceLike,
  src: string,
  handlers: ChatVideoPlaybackHandlers = {},
): Promise<ChatVideoPlaybackResult> {
  if (!src) {
    const error = new Error('missing video source');
    handlers.onError?.(error);
    return Promise.resolve('error');
  }
  try {
    video.src = src;
  } catch (error) {
    handlers.onError?.(error);
    return Promise.resolve('error');
  }
  // toggleChatVideoPlayback يستدعي play() قبل أول await: نفس مهمة المستخدم.
  return toggleChatVideoPlayback(video, handlers);
}
