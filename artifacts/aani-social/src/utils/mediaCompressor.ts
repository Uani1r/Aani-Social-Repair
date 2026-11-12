// منظومة الضغط وعزل الصوت الموحدة من جهة العميل (قبل الإرسال إلى ImageKit).
//
// - الصور: Canvas → WebP (مع التحويل التلقائي إلى JPEG على iOS Safari) + تصحيح
//   اتجاه EXIF + تصفير أبعاد Canvas المؤقتة لتحرير الذاكرة.
// - الفيديو: mediabunny (WebCodecs) → MP4 بترميز H.264 + AAC، حد أقصى 720p،
//   معدل بت ذكي ينخفض للمقاطع الطويلة، ومحاولة أقسى إذا تجاوز الناتج الحد.
// - الصوت: استخراج مسار الصوت من الفيديو أو تسجيلات الدردشة → AAC .m4a
//   بتردد 44.1kHz (متوافق مع iOS Safari وAndroid Chrome).
//
// كل العمليات داخل طابور متسلسل (runExclusive) مع Wake Lock لحماية iOS Safari
// من تعطّل الضغط في الخلفية، ومسار احتياطي آمن للمتصفحات القديمة.

export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // أماناً تحت حد 25MB في خطة ImageKit المجانية

export type MediaPreset =
  | 'avatar'
  | 'cover'
  | 'feedImage'
  | 'video'
  | 'extractedSound'
  | 'voiceMessage';

export class MediaTooLargeError extends Error {
  constructor(message = 'حجم الملف يتجاوز الحد الأقصى المسموح (24 ميغابايت). اختر مقطعاً أقصر أو ملفاً أصغر.') {
    super(message);
    this.name = 'MediaTooLargeError';
  }
}

export class NoAudioTrackError extends Error {
  constructor(message = 'الفيديو لا يحتوي على مسار صوتي.') {
    super(message);
    this.name = 'NoAudioTrackError';
  }
}

/* ------------------------------------------------------------------ */
/* الطابور المتسلسل + Wake Lock                                        */
/* ------------------------------------------------------------------ */

let lastOperation: Promise<unknown> = Promise.resolve();

/** ينفّذ المهام واحدًا تلو الآخر حتى لا تتزاحم عمليات الضغط الثقيلة على الهاتف. */
export function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = lastOperation.then(task, task);
  lastOperation = result.then(() => undefined, () => undefined);
  return result;
}

type WakeLockLike = { release: () => Promise<void> };
type WakeLockApi = { request: (type: 'screen') => Promise<WakeLockLike> };

let activeWakeLock: WakeLockLike | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (api && !activeWakeLock) activeWakeLock = await api.request('screen');
  } catch {
    /* Wake Lock غير مدعوم — لا يعطل العملية */
  }
}

async function releaseWakeLock(): Promise<void> {
  try {
    await activeWakeLock?.release();
  } catch {
    /* حُرّر تلقائياً */
  } finally {
    activeWakeLock = null;
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('أُلغيت العملية.', 'AbortError');
}

/* ------------------------------------------------------------------ */
/* ضغط الصور عبر Canvas                                                */
/* ------------------------------------------------------------------ */

type ImagePreset = 'avatar' | 'cover' | 'feedImage';

const IMAGE_TARGETS: Record<ImagePreset, {
  square?: number;
  maxSide?: number;
  targetBytes: number;
  startQuality: number;
  minQuality: number;
}> = {
  avatar: { square: 400, targetBytes: 80 * 1024, startQuality: 0.82, minQuality: 0.6 },
  cover: { maxSide: 1200, targetBytes: 200 * 1024, startQuality: 0.82, minQuality: 0.6 },
  feedImage: { maxSide: 1280, targetBytes: 300 * 1024, startQuality: 0.82, minQuality: 0.6 },
};

let webpEncodeSupported: boolean | null = null;

/** iOS Safari لا يدعم ترميز WebP عبر canvas — نكتشف القدرة مرة واحدة. */
function supportsWebpEncode(): boolean {
  if (webpEncodeSupported !== null) return webpEncodeSupported;
  try {
    const probe = document.createElement('canvas');
    probe.width = 2;
    probe.height = 2;
    webpEncodeSupported = probe.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpEncodeSupported = false;
  }
  return webpEncodeSupported;
}

/** فك الصورة مع تصحيح اتجاه EXIF (createImageBitmap ثم مسار بديل عبر <img>). */
async function loadImageSource(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('تعذر فك ترميز الصورة.'));
      image.src = dataUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => { image.src = ''; },
    };
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/png') return 'png';
  return 'jpg';
}

export async function compressImage(
  file: File,
  preset: ImagePreset,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const target = IMAGE_TARGETS[preset];
  ensureNotAborted(signal);
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
  // الصور ذات الشفافية (PNG/GIF مثل الملصقات) تحفظ شفافيتها: WebP يدعمها،
  // وإن لم يدعمه المتصفح نُبقي PNG بدل JPEG الذي يهدم الشفافية.
  const hasAlpha = file.type === 'image/png' || file.type === 'image/gif';

  return runExclusive(async () => {
    ensureNotAborted(signal);
    await acquireWakeLock();
    try {
      const { source, width, height, release } = await loadImageSource(file);
      let drawWidth = width;
      let drawHeight = height;
      if (target.square) {
        drawWidth = target.square;
        drawHeight = target.square;
      } else if (target.maxSide) {
        const scale = Math.min(1, target.maxSide / Math.max(width, height));
        drawWidth = Math.max(1, Math.round(width * scale));
        drawHeight = Math.max(1, Math.round(height * scale));
      }

      const formats = hasAlpha
        ? (supportsWebpEncode() ? ['image/webp'] : ['image/png'])
        : (supportsWebpEncode() ? ['image/webp', 'image/jpeg'] : ['image/jpeg']);

      let best: { blob: Blob; ext: string } | null = null;
      let quality = target.startQuality;
      let iteration = 0;
      const maxIterations = 8;

      while (iteration < maxIterations) {
        iteration += 1;
        ensureNotAborted(signal);
        onProgress?.(Math.min(90, Math.round((iteration / maxIterations) * 90)));

        const canvas = document.createElement('canvas');
        canvas.width = drawWidth;
        canvas.height = drawHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('تعذر تجهيز مساحة ضغط الصورة.');
        context.drawImage(source, 0, 0, drawWidth, drawHeight);

        let withinTarget = false;
        for (const mimeType of formats) {
          const blob = await new Promise<Blob | null>(resolve => {
            try {
              canvas.toBlob(resolve, mimeType, mimeType === 'image/png' ? undefined : quality);
            } catch {
              resolve(null);
            }
          });
          if (!blob) continue;
          const ext = extensionFor(blob.type || mimeType);
          if (blob.size <= target.targetBytes) {
            best = { blob, ext };
            withinTarget = true;
            break;
          }
          if (!best || blob.size < best.blob.size) best = { blob, ext };
        }

        // تصفير أبعاد Canvas لتحرير الذاكرة فوراً على الأجهزة الضعيفة
        canvas.width = 0;
        canvas.height = 0;

        if (withinTarget) break;

        // لم نصل للهدف: نخفض الجودة ونصغّر الأبعاد تدريجياً
        if (drawWidth > 200) {
          drawWidth = Math.max(160, Math.round(drawWidth * 0.88));
          drawHeight = target.square
            ? drawWidth
            : Math.max(160, Math.round(drawHeight * 0.88));
        }
        quality = Math.max(target.minQuality, quality - 0.06);
      }

      release();
      ensureNotAborted(signal);
      if (!best) throw new Error('تعذر ضغط الصورة.');
      onProgress?.(100);
      return new File([best.blob], `${baseName}-compressed.${best.ext}`, {
        type: best.blob.type || 'image/jpeg',
        lastModified: Date.now(),
      });
    } finally {
      await releaseWakeLock();
    }
  });
}

/* ------------------------------------------------------------------ */
/* mediabunny: تحميل الكسول + مُرمِّز AAC الاحتياطي                     */
/* ------------------------------------------------------------------ */

type MediabunnyInput = {
  computeDuration: () => Promise<number>;
  getPrimaryVideoTrack: () => Promise<{
    getDisplayWidth: () => Promise<number>;
    getDisplayHeight: () => Promise<number>;
  } | null>;
  getPrimaryAudioTrack: () => Promise<unknown | null>;
};

type MediabunnyModule = {
  Input: new (options: { source: unknown; formats: unknown }) => MediabunnyInput;
  Output: new (options: { format: unknown; target: unknown }) => { target: { buffer: ArrayBuffer | null } };
  BlobSource: new (data: Blob) => unknown;
  BufferTarget: new () => { buffer: ArrayBuffer | null };
  Mp4OutputFormat: new (options?: { fastStart?: 'in-memory' | 'reserve' | 'fragmented' }) => unknown;
  ALL_FORMATS: unknown;
  Quality: new (value: 'high' | 'medium' | 'low' | { bitrate: number }) => unknown;
  Conversion: {
    init: (options: {
      input: unknown;
      output: unknown;
      video?: Record<string, unknown>;
      audio?: Record<string, unknown>;
      trim?: { start: number; end: number };
    }) => Promise<{
      isValid: boolean;
      onProgress: ((progress: number) => void) | null;
      execute: () => Promise<void>;
      cancel: () => Promise<void>;
    }>;
  };
  canEncodeAudio: (codec: string) => Promise<boolean>;
};

let mediabunnyModule: MediabunnyModule | null = null;
let mediabunnyUnavailable = false;

async function loadMediabunny(): Promise<MediabunnyModule | null> {
  if (mediabunnyModule) return mediabunnyModule;
  if (mediabunnyUnavailable) return null;
  try {
    // الاسم الحرفي للحزمة يعيش داخل mediabunnyLoader.ts فقط: إن لم تكن
    // الحزمة مثبتة يفشل تحميل الوحدة المنفصلة وحدها (import مرفوض يُلتقط
    // هنا) ولا يمنع إقلاع التطبيق — vite:import-analysis لا يرى الحزمة
    // في أي وحدة من وحدات الإقلاع الأساسية.
    const loader = await import('./mediabunnyLoader');
    mediabunnyModule = (await loader.loadMediabunnyModule()) as MediabunnyModule;
  } catch (error) {
    console.warn('[mediaCompressor] تعذر تحميل mediabunny — سيُستخدم المسار الاحتياطي.', error);
    mediabunnyUnavailable = true;
  }
  return mediabunnyModule;
}

let aacEncoderReady = false;

/** بعض المتصفحات (Safari القديم) تفتقر لتشفير AAC في WebCodecs — نضيف مُرمِّز libavcodec. */
async function ensureAacEncoder(mb: MediabunnyModule): Promise<void> {
  if (aacEncoderReady) return;
  aacEncoderReady = true;
  try {
    if (!(await mb.canEncodeAudio('aac'))) {
      const loader = await import('./mediabunnyLoader');
      (await loader.loadAacEncoderModule()).registerAacEncoder();
    }
  } catch (error) {
    console.warn('[mediaCompressor] تعذر تحميل مُرمِّز AAC الاحتياطي — سيُعتمد ترميز النظام.', error);
  }
}

/** ربط إشارة الإلغاء بعملية تحويل mediabunny. */
function wireConversionAbort(
  conversion: { cancel: () => Promise<void> },
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => {
    void conversion.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/* ------------------------------------------------------------------ */
/* ضغط الفيديو (H.264 + AAC داخل MP4)                                  */
/* ------------------------------------------------------------------ */

export async function compressVideo(
  file: File,
  options: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
    maxBytes?: number;
  } = {},
): Promise<File> {
  const { onProgress, signal } = options;
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  ensureNotAborted(signal);

  const mb = await loadMediabunny();
  // مسار احتياطي آمن: متصفح قديم + ملف ضمن الحد → يُرفع كما هو بلا تعطل
  if (!mb) {
    if (file.size <= maxBytes) return file;
    throw new MediaTooLargeError();
  }

  const baseName = file.name.replace(/\.[^.]+$/, '') || 'video';

  const attemptEncode = async (bitrate: number, targetWidth: number, targetHeight: number): Promise<File> => {
    ensureNotAborted(signal);
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new mb.BufferTarget(),
    });
    const conversion = await mb.Conversion.init({
      input,
      output,
      video: targetWidth > 0
        ? {
            width: targetWidth,
            height: targetHeight,
            fit: 'contain',
            quality: new mb.Quality({ bitrate }),
          }
        : { quality: new mb.Quality({ bitrate }) },
      audio: { codec: 'aac', quality: new mb.Quality({ bitrate: 128e3 }) },
    });
    if (!conversion.isValid) {
      throw new Error('تعذر تجهيز تحويل الفيديو: الترميز غير مدعوم في هذا المتصفح.');
    }
    conversion.onProgress = progress => onProgress?.(Math.min(99, Math.round(progress * 100)));
    const detachAbort = wireConversionAbort(conversion, signal);
    try {
      await conversion.execute();
    } finally {
      detachAbort();
    }
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('تعذر إنتاج ملف الفيديو المضغوط.');
    return new File([buffer], `${baseName}-720p.mp4`, { type: 'video/mp4', lastModified: Date.now() });
  };

  // قراءة الميتاداتا مرة واحدة (مدة + أبعاد) لقرار التخطي وحساب معدل البت
  const probeInput = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const duration = await probeInput.computeDuration().catch(() => 0);
  const videoTrack = await probeInput.getPrimaryVideoTrack().catch(() => null);
  const sourceWidth = videoTrack ? await videoTrack.getDisplayWidth().catch(() => 0) : 0;
  const sourceHeight = videoTrack ? await videoTrack.getDisplayHeight().catch(() => 0) : 0;

  // تخطي إعادة الترميز: MP4 بجودة ≤720p وحجمه أقل من 6MB أصلاً
  const isMp4 = file.type === 'video/mp4' || /\.mp4$/i.test(file.name);
  const alreadyCompact = sourceWidth > 0 && sourceHeight > 0
    && Math.max(sourceWidth, sourceHeight) <= 1280
    && Math.min(sourceWidth, sourceHeight) <= 720;
  if (isMp4 && alreadyCompact && file.size <= 6 * 1024 * 1024 && file.size <= maxBytes) {
    onProgress?.(100);
    return file;
  }
  if (file.size > maxBytes && !videoTrack) throw new MediaTooLargeError();

  // الأبعاد: أقصى 720 للجانب القصير و1280 للطويل، بأبعاد زوجية لمتطلبات H.264
  let targetWidth = 0;
  let targetHeight = 0;
  if (sourceWidth > 0 && sourceHeight > 0) {
    const scale = Math.min(
      1,
      1280 / Math.max(sourceWidth, sourceHeight),
      720 / Math.min(sourceWidth, sourceHeight),
    );
    targetWidth = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    targetHeight = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
  }

  // معدل بت ذكي: 1.3Mbps للمقاطع القصيرة، وينخفض تلقائياً للطويلة
  // ليظل الناتج بحدود 10–14MB (نطرح ~160k لنسبة الصوت وحمل الحاوية)
  const videoBitrateFor = (targetBytes: number) => {
    const seconds = Math.max(duration, 1);
    const budgetBps = (targetBytes * 8) / seconds;
    return Math.min(1_300_000, Math.max(500_000, Math.floor(budgetBps - 160_000)));
  };
  const primaryBitrate = duration > 0 ? videoBitrateFor(12 * 1024 * 1024) : 1_300_000;

  await acquireWakeLock();
  try {
    let result = await runExclusive(() => attemptEncode(primaryBitrate, targetWidth, targetHeight));
    if (result.size > maxBytes) {
      // محاولة ثانية أشد: نعيد المعايرة على هامش 18MB
      const harsherBitrate = Math.max(
        400_000,
        Math.floor(primaryBitrate * Math.min(0.85, (18 * 1024 * 1024) / result.size)),
      );
      onProgress?.(0);
      result = await runExclusive(() => attemptEncode(harsherBitrate, targetWidth, targetHeight));
    }
    if (result.size > maxBytes) throw new MediaTooLargeError();
    onProgress?.(100);
    return result;
  } finally {
    await releaseWakeLock();
  }
}

/* ------------------------------------------------------------------ */
/* عزل الصوت وتحويله إلى AAC .m4a                                      */
/* ------------------------------------------------------------------ */

export async function extractAudio(
  source: Blob,
  options: {
    kind: 'extractedSound' | 'voiceMessage';
    trim?: { start: number; end: number };
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<File> {
  const { kind, trim, onProgress, signal } = options;
  ensureNotAborted(signal);

  const mb = await loadMediabunny();
  if (!mb) {
    // مسار احتياطي: رسائل الدردشة تبقى بصيغة المسجل الأصلية (webm/opus) إن
    // كان المتصفح لا يدعم التحويل، بشرط بقاء الحجم ضمن الحد المسموح.
    if (kind === 'voiceMessage' && source.size <= MAX_UPLOAD_BYTES) {
      return source instanceof File
        ? source
        : new File([source], `voice-${Date.now()}.webm`, { type: source.type || 'audio/webm', lastModified: Date.now() });
    }
    throw new Error('متصفحك لا يدعم استخراج الصوت محلياً.');
  }

  return runExclusive(async () => {
    await acquireWakeLock();
    try {
      const input = new mb.Input({ source: new mb.BlobSource(source), formats: mb.ALL_FORMATS });
      const audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
      if (!audioTrack) throw new NoAudioTrackError();
      await ensureAacEncoder(mb);

      const output = new mb.Output({
        format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new mb.BufferTarget(),
      });
      const conversion = await mb.Conversion.init({
        input,
        output,
        video: { discard: true },
        audio: {
          codec: 'aac',
          sampleRate: 44100,
          quality: new mb.Quality({ bitrate: kind === 'voiceMessage' ? 96e3 : 112e3 }),
          ...(kind === 'voiceMessage' ? { numberOfChannels: 1 } : {}),
        },
        ...(trim && trim.end > trim.start ? { trim: { start: trim.start, end: trim.end } } : {}),
      });
      if (!conversion.isValid) {
        throw new Error('تعذر تجهيز استخراج الصوت: الترميز غير مدعوم في هذا المتصفح.');
      }
      conversion.onProgress = progress => onProgress?.(Math.min(99, Math.round(progress * 100)));
      const detachAbort = wireConversionAbort(conversion, signal);
      try {
        await conversion.execute();
      } finally {
        detachAbort();
      }
      const buffer = output.target.buffer;
      if (!buffer) throw new Error('تعذر إنتاج ملف الصوت.');
      onProgress?.(100);
      return new File(
        [buffer],
        kind === 'voiceMessage' ? `voice-${Date.now()}.m4a` : `sound-${Date.now()}.m4a`,
        { type: 'audio/mp4', lastModified: Date.now() },
      );
    } finally {
      await releaseWakeLock();
    }
  });
}
