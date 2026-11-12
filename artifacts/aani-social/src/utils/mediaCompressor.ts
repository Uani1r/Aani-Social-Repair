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

// هامش أمان حقيقي تحت حد 25 MB في خطة ImageKit المجانية:
// 23.5 MiB ≈ 24.6 MB عشرياً — لن يُرفض الملف أبداً عند الحدود الفعلية.
export const MAX_UPLOAD_BYTES = 23.5 * 1024 * 1024;

// GIF وSVG تُرفع كما هي (شفافية/حركة) — سقف صارم لمنع استغلال الاستثناء برفع ملفات ضخمة:
export const UNCOMPRESSIBLE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export type MediaPreset =
  | 'avatar'
  | 'cover'
  | 'feedImage'
  | 'highlightCover'
  | 'storyImage'
  | 'chatImage'
  | 'video'
  | 'extractedSound'
  | 'voiceMessage';

/** كل إعدادات ضغط الصور عبر Canvas — يمر عبرها أي preset صوري في المسار المركزي. */
export const IMAGE_PRESETS = new Set<MediaPreset>([
  'avatar',
  'cover',
  'feedImage',
  'highlightCover',
  'storyImage',
  'chatImage',
]);

export type ImagePreset =
  | 'avatar'
  | 'cover'
  | 'feedImage'
  | 'highlightCover'
  | 'storyImage'
  | 'chatImage';

/** حارس أنواع: يتيح تمرير الـ preset إلى compressImage بلا cast غير آمن. */
export function isImagePreset(value: MediaPreset | null | undefined): value is ImagePreset {
  return value !== null && value !== undefined && IMAGE_PRESETS.has(value);
}

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
/* قياسات التوفير الفعلية (سجل تقني غير حساس — بلا محتوى الملفات)       */
/* ------------------------------------------------------------------ */

export type MediaCompressionMetric = {
  kind: 'image' | 'video' | 'audio';
  preset?: MediaPreset;
  originalBytes: number;
  finalBytes: number;
  durationMs: number;
  outcome: 'ok' | 'skipped-passthrough' | 'failed';
  failureReason?: string;
  finalVideoCodec?: string;
  savingPct: number;
};

const METRICS_BUFFER_LIMIT = 200;
const compressionMetrics: MediaCompressionMetric[] = [];

function computeSavingPct(originalBytes: number, finalBytes: number): number {
  // savingPct = originalBytes > 0 ? (original - final) / original * 100 : 0
  return originalBytes > 0
    ? Math.max(0, Math.round(((originalBytes - finalBytes) / originalBytes) * 100))
    : 0;
}

/** تسجيل نتيجة عملية ضغط — لا يُسجل محتوى الملفات ولا أي بيانات شخصية. */
export function recordCompressionMetric(
  metric: Omit<MediaCompressionMetric, 'savingPct'>,
): void {
  const entry: MediaCompressionMetric = {
    ...metric,
    savingPct: computeSavingPct(metric.originalBytes, metric.finalBytes),
  };
  compressionMetrics.push(entry);
  if (compressionMetrics.length > METRICS_BUFFER_LIMIT) compressionMetrics.shift();
  try {
    console.info(
      `[media-metrics] ${metric.kind} ${metric.preset ?? '-'} `
      + `${metric.originalBytes}→${metric.finalBytes}B `
      + `(${entry.savingPct}% توفير) في ${Math.round(metric.durationMs)}ms — ${metric.outcome}`
      + `${metric.failureReason ? `: ${metric.failureReason}` : ''}`
      + `${metric.finalVideoCodec ? ` [${metric.finalVideoCodec}]` : ''}`,
    );
  } catch {
    /* تجاهل */
  }
}

/** آخر 200 عملية ضغط — لمعرفة مقدار ما وفّرته المنظومة فعلياً. */
export function getCompressionMetrics(): readonly MediaCompressionMetric[] {
  return compressionMetrics;
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

/**
 الرابط الأساسي للوسائط بلا معاملات تحويل (?tr=) ولا هاشتاغ تعديل (#t= / #crop=).
 الرابطان المتفقاان بعد التطبيع يُعدّان الملف نفسه — لا يُعد اختلاف ?tr= أو #t= اختلافاً.
 */
export function normalizeMediaUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

/**
 حساب معدل بت الفيديو وفق المدة والميزانية الحجمية:
 (حجم الهدف × 8) ÷ المدة − مساحة الصوت − هامش الحاوية، ضمن نطاق [500k, 4.5M].
 هذا حد جودة تشغيل وليس حجماً ثابتاً؛ الحجم الفعلي يُفحص بعد الترميز ويُعاد المحاولة بمعدل أدنى عند التجاوز.
 */
export function calculateVideoBitrate(
  durationSeconds: number,
  targetBytes: number,
  audioBitrate = 128_000,
): number {
  const safeDuration = Math.max(durationSeconds, 1);
  const totalBitsPerSecond = (targetBytes * 8) / safeDuration;
  const containerReserve = 80_000;
  return Math.max(
    500_000,
    Math.min(
      4_500_000,
      Math.floor(totalBitsPerSecond - audioBitrate - containerReserve),
    ),
  );
}

/**
 مسح FourCC لترميزات MP4 (مدخلات stsd داخل moov): يتحقق فعلياً من وجود
 ترميز فيديو H.264 (avc1) بدل الاعتماد على امتداد الملف أو وجود ftyp وحده.
 الصوت اختياري (فيديو صامت مشروع). دالة صرفة قابلة للاختبار بلا متصفح.
 */
export function findMp4CodecMarkers(
  chunks: readonly Uint8Array[],
): { hasH264: boolean; hasAacAudio: boolean } {
  const found = { hasH264: false, hasAacAudio: false };
  if (typeof TextDecoder === 'undefined') return found;
  // latin1: كل بايت → محرف واحد، فتُقرأ FourCCs ASCII بأمان من البيانات الثنائية
  const decoder = new TextDecoder('latin1');
  let carry = '';
  for (const chunk of chunks) {
    const text = carry + decoder.decode(chunk, { stream: true });
    if (text.includes('avc1')) found.hasH264 = true;
    if (text.includes('mp4a')) found.hasAacAudio = true;
    carry = text.slice(-3); // تغطية العلامات الممتدة عبر حدود القطع
    if (found.hasH264 && found.hasAacAudio) break;
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* فحص بنيوي حقيقي لملفات MP4 (شجرة الصناديق — لا مسح FourCC وحده)     */
/* ------------------------------------------------------------------ */

export type Mp4TrackInspection = {
  kind: 'video' | 'audio';
  /** ترميز sample entry كما هو داخل stsd (avc1/hev1/mp4a/Opus/...) */
  codec: string;
  /**
   وجود صندوق إعداد الترميز داخل sample entry نفسه (avcC للـ H.264،
   esds للـ AAC، hvcC للـ HEVC) — دليل بنيوي على مسار فعلي قابل للفك،
   لا مجرد FourCC عابر في البيانات.
   */
  hasCodecConfig: boolean;
};

export type Mp4Inspection = {
  /** صندوق ftyp في المقدمة (حاوية MP4 صالحة) */
  containerVerified: boolean;
  /** صندوق moov وُجد (قد يكون بعد mdat) وقُرئت شجرته */
  moovVerified: boolean;
  tracks: Mp4TrackInspection[];
};

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const VIDEO_SAMPLE_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp09', 'av01']);
const AUDIO_SAMPLE_CODECS = new Set(['mp4a', 'Opus', 'ac-3', 'ec-3', 'fLaC', 'alac']);

/** صندوق إعداد الترميز المتوقع داخل sample entry (H.264 → avcC، AAC → esds، HEVC → hvcC). */
function codecConfigType(codec: string): string | null {
  switch (codec) {
    case 'avc1':
    case 'avc3':
      return 'avcC';
    case 'hvc1':
    case 'hev1':
      return 'hvcC';
    case 'mp4a':
      return 'esds';
    default:
      return null;
  }
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readU64(bytes: Uint8Array, offset: number): number {
  // آمن حتى 2^53 — أحجام الصناديق لا تقترب من هذا أبداً
  return readU32(bytes, offset) * 0x100000000 + readU32(bytes, offset + 4);
}

function fourCCAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 يحلل بايتات MP4 ويستخرج المسارات الفعلية من شجرة الصناديق:
 ftyp في المقدمة → moov → trak → mdia → minf → stbl → stsd →
 sample entries (الترميز + صندوق الإعداد داخل المدخل).
 دالة صرفة قابلة للاختبار بلا متصفح ولا شبكة.
 */
export function inspectMp4Bytes(bytes: Uint8Array): Mp4Inspection {
  const inspection: Mp4Inspection = { containerVerified: false, moovVerified: false, tracks: [] };
  if (bytes.length < 12) return inspection;
  if (fourCCAt(bytes, 4) === 'ftyp') inspection.containerVerified = true;

  /**
   يبحث عن صندوق إعداد الترميز داخل نطاق sample entry نفسه: ترويسة صندوق
   صحيحة (حجم معقول ضمن حدود المدخل + النوع المتوقع). الصناديق الثابتة قبل
   الأبناء تختلف بين الأنواع (78 بايت للفيديو، 28 للصوت) فالمسح داخل المدخل
   وحده أدق من افتراض إزاحة ثابتة، وحدود المدخل تمنع الإيجابيات الخاطئة.
   */
  function entryContainsConfigBox(entryStart: number, entryEnd: number, configType: string): boolean {
    for (let offset = entryStart + 8; offset + 8 <= entryEnd; offset += 1) {
      const size = readU32(bytes, offset);
      if (size < 8 || offset + size > entryEnd) continue;
      if (fourCCAt(bytes, offset + 4) === configType) return true;
    }
    return false;
  }

  /** stsd FullBox: ترويسة (8) + version/flags (4) + entry_count (4) ثم المدخلات. */
  function parseStsd(boxStart: number, boxEnd: number): void {
    let entryOffset = boxStart + 16;
    while (entryOffset + 8 <= boxEnd) {
      const entrySize = readU32(bytes, entryOffset);
      if (entrySize < 8 || entryOffset + entrySize > boxEnd) break;
      const codec = fourCCAt(bytes, entryOffset + 4);
      const kind = VIDEO_SAMPLE_CODECS.has(codec) ? 'video' : AUDIO_SAMPLE_CODECS.has(codec) ? 'audio' : null;
      if (kind) {
        const configType = codecConfigType(codec);
        inspection.tracks.push({
          kind,
          codec,
          hasCodecConfig: configType
            ? entryContainsConfigBox(entryOffset + 8, entryOffset + entrySize, configType)
            : false,
        });
      }
      entryOffset += entrySize;
    }
  }

  function walk(start: number, end: number, depth: number): void {
    if (depth > 6) return;
    let offset = start;
    while (offset + 8 <= end) {
      let size = readU32(bytes, offset);
      const type = fourCCAt(bytes, offset + 4);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = readU64(bytes, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset; // الصندوق الأخير يمتد حتى نهاية النطاق
      }
      if (size < headerSize) break;
      if (offset + size > end) break; // صندوق غير مكتمل في هذه القطعة
      if (type === 'stsd') parseStsd(offset, offset + size);
      else if (type === 'moov') inspection.moovVerified = true;
      else if (CONTAINER_BOXES.has(type)) walk(offset + headerSize, offset + size, depth + 1);
      offset += size;
    }
  }

  walk(0, bytes.length, 0);
  return inspection;
}

/**
 قرار المرور دون إعادة ترميز من التحليل البنيوي:
 - مسار فيديو avc1/avc3 مع صندوق إعداد avcC إلزامي.
 - كل مسار صوتي إن وُجد يجب أن يكون AAC (mp4a + esds).
 - أي ترميز آخر (HEVC، Opus، ...) أو بنية غير قابلة للتحقق → رفض.
 */
export function decideMp4Passthrough(inspection: Mp4Inspection): { accepted: boolean; reason: string } {
  if (!inspection.containerVerified) return { accepted: false, reason: 'ftyp-container-missing' };
  if (!inspection.moovVerified) return { accepted: false, reason: 'moov-missing-or-unparseable' };

  const videoTracks = inspection.tracks.filter(track => track.kind === 'video');
  if (videoTracks.length === 0) return { accepted: false, reason: 'no-video-track' };
  const h264Track = videoTracks.find(track => track.codec === 'avc1' || track.codec === 'avc3');
  if (!h264Track) {
    return { accepted: false, reason: `video-codec-not-h264(${videoTracks.map(track => track.codec).join(",")})` };
  }
  if (!h264Track.hasCodecConfig) {
    return { accepted: false, reason: 'avc-configuration-box-missing' };
  }

  const incompatibleAudio = inspection.tracks.find(
    track => track.kind === 'audio' && !(track.codec === 'mp4a' && track.hasCodecConfig),
  );
  if (incompatibleAudio) {
    return { accepted: false, reason: `audio-track-${incompatibleAudio.codec}-not-verified-aac` };
  }

  return {
    accepted: true,
    reason: `mp4-structure-verified: ${h264Track.codec}+avcC${
      inspection.tracks.some(track => track.kind === 'audio') ? ' + mp4a/esds' : ' (silent)'
    }`,
  };
}

/**
 تحقق حقيقي من ملف MP4 قبل السماح بالمرور دون إعادة ترميز:
 1) صندوق ftyp في المقدمة (حاوية MP4 صالحة)
 2) قراءة الصناديق العليا حتى إيجاد moov (قد يقع بعد mdat ضخم — نقرأ
    ترويسات الصناديق فقط ونقفز فوق البيانات، لا مسح بايتات عمياء)
 3) تحليل شجرة moov: مسارات فيديو H.264 (avc1/avc3 مع صندوق avcC)
    وكل مسار صوتي AAC (mp4a مع esds)
 أي ملف لا يمكن التحقق من مواصفاته → false (إعادة معالجة أو رفض، لا مرور أعمى).
 */
/** مُصدَّرة للاختبارات فقط — منطق القرار نفسه في decideMp4Passthrough. */
export async function verifyMp4Passthrough(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    if (head.length < 12 || fourCCAt(head, 4) !== 'ftyp') return false;

    const MAX_TOP_LEVEL_BOXES = 64;
    const MAX_MOOV_BYTES = 8 * 1024 * 1024;
    let offset = 0;
    for (let boxes = 0; offset + 8 <= file.size && boxes < MAX_TOP_LEVEL_BOXES; boxes += 1) {
      const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
      let size = readU32(header, 0);
      const type = fourCCAt(header, 4);
      let headerSize = 8;
      if (size === 1) {
        if (header.length < 16) return false;
        size = readU64(header, 8);
        headerSize = 16;
      } else if (size === 0) {
        size = file.size - offset; // الصندوق الأخير يمتد حتى نهاية الملف
      }
      if (size < headerSize) return false;
      if (type === 'moov') {
        if (size > MAX_MOOV_BYTES) return false;
        const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
        const inspection = inspectMp4Bytes(bytes);
        // ftyp تحقق من الملف نفسه أعلاه — شريحة moov وحدها لا تحويه
        inspection.containerVerified = true;
        return decideMp4Passthrough(inspection).accepted;
      }
      offset += size;
    }
    // moov غير موجود ضمن الصناديق المقروءة → الملف غير قابل للتحقق
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* ضغط الصور عبر Canvas                                                */
/* ------------------------------------------------------------------ */

const IMAGE_TARGETS: Record<ImagePreset, {
  square?: number;
  maxSide?: number;
  /** حد أقصى للضلع القصير (مثل 1080×1920 للصور العمودية) */
  maxShortSide?: number;
  targetBytes: number;
  startQuality: number;
  minQuality: number;
  /** قص المنتصف 1:1 (Center-Crop) بدل مطّ الصورة داخل الإطار المربع */
  centerCrop?: boolean;
}> = {
  avatar: { square: 320, targetBytes: 80 * 1024, startQuality: 0.82, minQuality: 0.6, centerCrop: true },
  // غلاف/خلفية أبرز القصص: قص مركزي 1:1 بمستهدف 100KB (تُعرض داخل دائرة ~208px)
  highlightCover: { square: 512, targetBytes: 100 * 1024, startQuality: 0.8, minQuality: 0.5, centerCrop: true },
  cover: { maxSide: 1200, targetBytes: 200 * 1024, startQuality: 0.82, minQuality: 0.6 },
  // صور القصص: 1080×1920 كحد أقصى (نحفظ الاتجاه العمودي كما هو)
  storyImage: { maxSide: 1920, maxShortSide: 1080, targetBytes: 350 * 1024, startQuality: 0.82, minQuality: 0.55 },
  // صور المنشورات: 1440px للضلع الأطول
  feedImage: { maxSide: 1440, targetBytes: 300 * 1024, startQuality: 0.82, minQuality: 0.6 },
  // صور الرسائل والتعليقات والملصقات: 1280px للضلع الأطول (الشفافية محفوظة عبر WebP/PNG)
  chatImage: { maxSide: 1280, targetBytes: 250 * 1024, startQuality: 0.82, minQuality: 0.55 },
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
    const startedAt = Date.now();
    await acquireWakeLock();
    try {
      const { source, width, height, release } = await loadImageSource(file);
      try {
        let drawWidth = width;
        let drawHeight = height;
        if (target.square) {
          // قاعدة صارمة: الناتج لا يتجاوز أبعاد المصدر أبداً — لا تكبير للصور الصغيرة
          const sourceMinSide = Math.min(width, height);
          drawWidth = Math.max(1, Math.min(target.square, sourceMinSide));
          drawHeight = drawWidth;
        } else if (target.maxSide || target.maxShortSide) {
          // نُصغّر فقط — لا نكبّر صورة أصغر من هدفها — مع صون نسبة الأبعاد:
          const scale = Math.min(
            1,
            target.maxSide ? target.maxSide / Math.max(width, height) : 1,
            target.maxShortSide ? target.maxShortSide / Math.min(width, height) : 1,
          );
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
          let context: CanvasRenderingContext2D | null = null;
          try {
            context = canvas.getContext('2d');
            if (!context) throw new Error('تعذر تجهيز مساحة ضغط الصورة.');
            if (target.centerCrop) {
              // قص المنتصف (Center-Crop 1:1) بدل إطالة الصورة داخل الإطار:
              const cropSize = Math.min(width, height);
              const cropX = (width - cropSize) / 2;
              const cropY = (height - cropSize) / 2;
              context.drawImage(source, cropX, cropY, cropSize, cropSize, 0, 0, drawWidth, drawHeight);
            } else {
              context.drawImage(source, 0, 0, drawWidth, drawHeight);
            }

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
          } finally {
            // تحرير Canvas فوراً بعد كل تكرار (نجاحاً أو فشلاً) — الأجهزة الضعيفة
            canvas.width = 0;
            canvas.height = 0;
          }

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

        ensureNotAborted(signal);
        if (!best) throw new Error('تعذر ضغط الصورة.');
        const result = new File([best.blob], `${baseName}-compressed.${best.ext}`, {
          type: best.blob.type || 'image/jpeg',
          lastModified: Date.now(),
        });
        recordCompressionMetric({
          kind: 'image',
          preset,
          originalBytes: file.size,
          finalBytes: result.size,
          durationMs: Date.now() - startedAt,
          outcome: 'ok',
        });
        onProgress?.(100);
        return result;
      } catch (error) {
        recordCompressionMetric({
          kind: 'image',
          preset,
          originalBytes: file.size,
          finalBytes: 0,
          durationMs: Date.now() - startedAt,
          outcome: 'failed',
          failureReason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        // تحرير مصدر الصورة دائماً (نجاحاً أو فشلاً أو إلغاءً) — iOS Safari حساس للذاكرة
        try {
          release();
        } catch {
          /* محرر مسبقاً */
        }
      }
    } finally {
      await releaseWakeLock();
    }
  });
}

/* ------------------------------------------------------------------ */
/* mediabunny: تحميل الكسول + مُرمِّز AAC الاحتياطي                     */
/* ------------------------------------------------------------------ */

type MediabunnyVideoTrack = {
  getDisplayWidth: () => Promise<number>;
  getDisplayHeight: () => Promise<number>;
  /** سلسلة الترميز مثل 'avc1' — تُستخدم للتحقق قبل تخطي إعادة الترميز */
  codec?: unknown;
};

type MediabunnyAudioTrack = { codec?: unknown };

type MediabunnyInput = {
  computeDuration: () => Promise<number>;
  getPrimaryVideoTrack: () => Promise<MediabunnyVideoTrack | null>;
  getPrimaryAudioTrack: () => Promise<MediabunnyAudioTrack | null>;
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
  const startedAt = Date.now();

  const mb = await loadMediabunny();
  if (!mb) {
    // لا نرفع الفيديو الأصلي بصمت إذا تعذر الضغط (Safari قديم بلا WebCodecs).
    // مسار المرور الصغير يتطلب تحققاً بنيوياً حقيقياً: حاوية MP4 (ftyp) +
    // تحليل شجرة moov — مسار فيديو avc1 مع صندوق avcC، وكل صوت AAC (mp4a+esds).
    // الامتداد ومسح FourCC وحدهما لا يثبتان شيئاً؛ ما لا يمكن التحقق منه يُرفض.
    if (file.type === 'video/mp4'
      && file.size <= 6 * 1024 * 1024
      && file.size <= maxBytes
      && await verifyMp4Passthrough(file)) {
      console.warn('[mediaCompressor] تعذر ضغط الفيديو محلياً — سيُرفع ملف MP4 صغير (≤6MB) بعد تحقق بنيوي للحاوية والمسارات (avc1+avcC / mp4a+esds).');
      recordCompressionMetric({
        kind: 'video',
        preset: 'video',
        originalBytes: file.size,
        finalBytes: file.size,
        durationMs: Date.now() - startedAt,
        outcome: 'skipped-passthrough',
        failureReason: 'no-webcodecs: mp4-structure-verified',
        finalVideoCodec: 'avc1+avcC (structure-verified)',
      });
      return file;
    }
    recordCompressionMetric({
      kind: 'video',
      preset: 'video',
      originalBytes: file.size,
      finalBytes: 0,
      durationMs: Date.now() - startedAt,
      outcome: 'failed',
      failureReason: 'no-webcodecs and file not verifiable as MP4/H.264',
    });
    throw new Error('تعذر ضغط الفيديو على متصفحك (يتطلب WebCodecs). لا يمكن رفع الملفات الكبيرة غير المضغوطة؛ جرّب متصفحاً حديثاً أو اختر مقطعاً أقصر.');
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

  // تخطي إعادة الترميز: MP4 بترميز H.264+AAC بجودة ≤720p وحجمه أقل من 6MB أصلاً
  // (التحقق من الترميز ضروري: تخطي فيديو بترميز آخر قد يجعله غير قابل للتشغيل
  // في بعض المتصفحات، بينما إعادة الترميز لـ H.264+AAC تضمن التوافق — خصوصاً على iPhone Safari)
  const isMp4 = file.type === 'video/mp4' || /\.mp4$/i.test(file.name);
  const videoCodec = typeof videoTrack?.codec === 'string' ? videoTrack.codec : '';
  const audioTrack = await probeInput.getPrimaryAudioTrack().catch(() => null);
  const audioCodec = typeof audioTrack?.codec === 'string' ? audioTrack.codec : '';
  const videoCodecOk = /avc|h264|h\.264/i.test(videoCodec);
  const audioCodecOk = !audioTrack || /aac|mp4a/i.test(audioCodec);
  const alreadyCompact = sourceWidth > 0 && sourceHeight > 0
    && Math.max(sourceWidth, sourceHeight) <= 1280
    && Math.min(sourceWidth, sourceHeight) <= 720
    && videoCodecOk && audioCodecOk;

  // وصف ترميز الملف كما تحقق فعلياً من المسار probe (يُسجل في القياسات فقط)
  const verifiedCodec = videoCodecOk
    ? `avc1${audioTrack ? `+${/aac|mp4a/i.test(audioCodec) ? 'aac' : audioCodec}` : '+no-audio'}`
    : undefined;

  function recordVideoMetric(
    outcome: 'ok' | 'skipped-passthrough' | 'failed',
    finalBytes: number,
    extra: { failureReason?: string; finalVideoCodec?: string } = {},
  ): void {
    recordCompressionMetric({
      kind: 'video',
      preset: 'video',
      originalBytes: file.size,
      finalBytes,
      durationMs: Date.now() - startedAt,
      outcome,
      failureReason: extra.failureReason,
      finalVideoCodec: extra.finalVideoCodec ?? verifiedCodec,
    });
  }

  if (isMp4 && alreadyCompact && file.size <= 6 * 1024 * 1024 && file.size <= maxBytes) {
    recordVideoMetric('skipped-passthrough', file.size, { failureReason: 'already H.264/AAC ≤720p ≤6MB' });
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

  // معدل بت ذكي وفق المدة والميزانية الحجمية (سقف 4.5Mbps) — الحجم الفعلي
  // يُفحص بعد الترميز وتُعاد المحاولة بمعدل أقسى عند التجاوز:
  const primaryBitrate = duration > 0 ? calculateVideoBitrate(duration, 12 * 1024 * 1024) : 1_300_000;

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

    // لا نجعل الضغط يكبّر الملف بلا داعٍ: إن كان الأصل متوافقاً فعلاً
    // (H.264/AAC محقق من المسار probe) وضمن الحد وأصغر من الناتج — نحتفظ بالأصل.
    if (isMp4 && videoCodecOk && audioCodecOk && file.size <= maxBytes && result.size >= file.size) {
      recordVideoMetric('skipped-passthrough', file.size, { failureReason: 'reencode-not-smaller-than-verified-original' });
      onProgress?.(100);
      return file;
    }

    if (result.size > maxBytes) {
      recordVideoMetric('failed', result.size, {
        failureReason: `exceeds MAX_UPLOAD_BYTES (${result.size}B > ${maxBytes}B) after harsher retry`,
      });
      throw new MediaTooLargeError();
    }
    recordVideoMetric('ok', result.size, { finalVideoCodec: 'avc1+aac (reencoded)' });
    onProgress?.(100);
    return result;
  } catch (error) {
    if (!(error instanceof MediaTooLargeError)) {
      recordVideoMetric('failed', 0, {
        failureReason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
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
  const startedAt = Date.now();

  const mb = await loadMediabunny();
  if (!mb) {
    // مسار احتياطي: رسائل الدردشة تبقى بصيغة المسجل الأصلية (webm/opus) إن
    // كان المتصفح لا يدعم التحويل، بشرط بقاء الحجم ضمن الحد المسموح.
    if (kind === 'voiceMessage' && source.size <= MAX_UPLOAD_BYTES) {
      recordCompressionMetric({
        kind: 'audio',
        preset: kind,
        originalBytes: source.size,
        finalBytes: source.size,
        durationMs: Date.now() - startedAt,
        outcome: 'skipped-passthrough',
        failureReason: 'no-webcodecs: original recorder format kept',
      });
      return source instanceof File
        ? source
        : new File([source], `voice-${Date.now()}.webm`, { type: source.type || 'audio/webm', lastModified: Date.now() });
    }
    recordCompressionMetric({
      kind: 'audio',
      preset: kind,
      originalBytes: source.size,
      finalBytes: 0,
      durationMs: Date.now() - startedAt,
      outcome: 'failed',
      failureReason: 'no-webcodecs',
    });
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
      const result = new File(
        [buffer],
        kind === 'voiceMessage' ? `voice-${Date.now()}.m4a` : `sound-${Date.now()}.m4a`,
        { type: 'audio/mp4', lastModified: Date.now() },
      );
      recordCompressionMetric({
        kind: 'audio',
        preset: kind,
        originalBytes: source.size,
        finalBytes: result.size,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
      });
      return result;
    } catch (error) {
      recordCompressionMetric({
        kind: 'audio',
        preset: kind,
        originalBytes: source.size,
        finalBytes: 0,
        durationMs: Date.now() - startedAt,
        outcome: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await releaseWakeLock();
    }
  });
}
