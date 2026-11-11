/**
 * مشغّل الصوت الفوري العالمي (Single Audio Instance & Direct HTML5 Audio Mode).
 *
 * عنصر HTMLAudioElement واحد فقط يُعاد استخدامه لجميع المعاينات الصوتية في
 * التطبيق (مكتبة الأصوات، شاشة المعاينة، صفحة الصوت): عند التنقل بين الأصوات
 * يُستبدل src على الكائن نفسه بدل إنشاء كائن جديد، فيُجهَض طلب التنزيل السابق
 * فوراً (إلغاء الاستدعاءات المعلقة) ويُتفادى ضغط الذاكرة وGarbage Collection.
 *
 * الضبط (Direct Mode بلا حظر شبكة أو CORS):
 * - بلا crossOrigin إطلاقاً: لا مصافحة CORS ولا حظر موارد — المتصفح يبثّ
 *   الأوتار مباشرة عبر HTTP Range/206 دون انتظار.
 * - preload='metadata' فقط: طول الشريط دون استهلاك ذاكرة أو بان
دويث ثقيل،
 *   والتشغيل يبثّ فور استدعاء play() بالتوازي مع الجلب (لا انتظار
 *   canplaythrough ولا جلب كامل ولا ArrayBuffer).
 * - playInstant يُستدعى داخل معالج الحدث المباشر (بدون أي await قبله):
 *   src + play() في نفس الملي ثانية لتفادي سياسة التشغيل التلقائي،
 *   وسلسلة play() ملتقطة دائماً فلا Uncaught Audio Promises في الكونسول.
 * - onPlaying يُستدعى فور صدور أول نغمة صوتية (التحول من Spinner إلى Pause).
 */

export type InstantTrimRange = { start: number; end: number };

export type InstantPlayOptions = {
  /** حدود اقتصاص الصوت (بالثواني) — تُحصر الحلقة ضمنها كطبقة ضمان فوق ترميز #t= */
  trim?: InstantTrimRange | null;
  /** تكرار التشغيل (الافتراضي true) */
  loop?: boolean;
  /** قراءة المسودة في كل نبضة timeupdate (تحديث حي أثناء سحب مقابض الاقتصاص) */
  getTrim?: () => InstantTrimRange | null;
  /** فور صدور أول نغمة صوتية: التحويل من مؤشر التحميل إلى إيقاف مؤقت */
  onPlaying?: () => void;
  /** عند انتهاء المقطع طبيعياً */
  onEnded?: () => void;
  /** عند فشل التشغيل (رابط مفقود أو رفض المتصفح) */
  onError?: () => void;
  /** لحظة توفر المدة الكاملة (iOS يمنع قراءتها قبل إيماءة المستخدم — تُقرأ من عنصر التشغيل الفعلي) */
  onLoadedMetadata?: (duration: number) => void;
};

let audio: HTMLAudioElement | null = null;
let currentSrc = '';
let playingReported = false;
// جيل الطلب الحالي: يُبطِل أي .play() أو رد نداء معلّق من محاولة سابقة عند التنقل السريع
let playGeneration = 0;

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!audio) {
    audio = new Audio();
    // metadata فقط: يقرأ طول الشريط بلا استهلاك ذاكرة/بان
دويث ثقيل،
    // والتشغيل يبثّ فور .play() عبر HTTP Range بلا أي انتظار
    audio.preload = 'metadata';
    audio.loop = true;
  }
  return audio;
}

function clearHandlers(): void {
  if (!audio) return;
  audio.onplaying = null;
  audio.onended = null;
  audio.ontimeupdate = null;
  audio.onloadedmetadata = null;
  playingReported = false;
}

/**
 * تشغيل فوري على المشغّل الموحّد: يُستدعى مباشرة داخل معالج الحدث (نقرة المستخدم)
 * بلا أي انتظار — يوقف ما سبق، يبدّل src عند الحاجة، ثم يستدعي .play() فوراً.
 */
export function playInstant(url: string, options: InstantPlayOptions = {}): void {
  const el = ensureAudio();
  if (!el || !url) return;
  const generation = ++playGeneration;
  // إلغاء الاستدعاءات المعلقة: إيقاف فوري وتفريغ معالجات المقطع السابق
  if (!el.paused) el.pause();
  clearHandlers();

  // استبدال المصدر على الكائن نفسه (لا new Audio): يُجهَض طلب الشبكة السابق تلقائياً
  // بلا crossOrigin إطلاقاً — بلا مصافحة CORS ولا حظر موارد، والبث يبدأ فوراً
  if (currentSrc !== url) {
    el.removeAttribute('src');
    el.removeAttribute('crossorigin');
    el.src = url;
    currentSrc = url;
  }
  el.loop = options.loop !== false;

  const fixedTrim = options.trim && options.trim.end > options.trim.start ? options.trim : null;
  const readTrim = options.getTrim
    ? () => {
        const range = options.getTrim?.();
        return range && range.end > range.start ? range : null;
      }
    : fixedTrim
      ? () => fixedTrim
      : null;

  if (options.onPlaying) {
    // الاستجابة اللحظية: أول نغمة صوتية (الحدث playing أو وعد .play()) تحوّل الزر فوراً
    const reportPlaying = () => {
      if (playingReported || generation !== playGeneration) return;
      playingReported = true;
      options.onPlaying?.();
    };
    el.onplaying = reportPlaying;
    // سلسلة play() ملتقطة دائماً: رفض Autoplay يُسجَّل ولا يُجمّد التطبيق
    void el.play().then(reportPlaying).catch((error: unknown) => {
      console.log('Autoplay handled:', error);
      if (generation !== playGeneration) return;
      options.onError?.();
    });
  } else {
    void el.play().catch((error: unknown) => {
      console.log('Autoplay handled:', error);
      if (generation !== playGeneration) return;
      options.onError?.();
    });
  }

  if (options.onEnded) {
    el.onended = () => {
      if (generation !== playGeneration) return;
      options.onEnded?.();
    };
  }

  if (options.onLoadedMetadata) {
    el.onloadedmetadata = () => {
      if (generation !== playGeneration) return;
      const duration = el.duration;
      if (Number.isFinite(duration) && duration > 0) options.onLoadedMetadata?.(duration);
    };
  }

  // قَصم برمجي كضمان ثانٍ فوق ترميز #t=: يعود لبداية المقطع عند تجاوز نهايته
  if (readTrim) {
    el.ontimeupdate = () => {
      const range = readTrim();
      if (!range) return;
      if (el.currentTime >= range.end - 0.04 || el.currentTime < range.start - 0.05) {
        try { el.currentTime = range.start; } catch { /* قد يرفض المتصفح الضبط قبل الجهوزية */ }
      }
    };
  }

  const initialTrim = readTrim?.() ?? null;
  try { el.currentTime = initialTrim ? Math.max(0, initialTrim.start) : 0; } catch { /* قد يرفض المتصفح الضبط قبل الجهوزية */ }
}

/** إيقاف فوري وتفريغ الموارد: يُستدعى عند فتح مكتبة الأصوات أو إغلاق الشاشات أو إزالة الصوت */
export function stopInstant(): void {
  if (!audio) return;
  playGeneration += 1; // أبطل أي .play() أو رد نداء معلّق
  clearHandlers();
  if (!audio.paused) audio.pause();
  try { audio.currentTime = 0; } catch { /* قد يرفض المتصفح الضبط قبل الجهوزية */ }
}

/**
 * استئناف المشغّل الموحّد إن كان هو نفسه يشغّل هذا الرابط أصلاً (بلا إعادة سحب
 * من الصفر): يعيد التشغيل من الموضع الحالي لحظياً — يُستخدم في شاشة المعاينة
 * حين يكون الصوت المقترح قد بدأ فور اختيار الصورة فلا تُقاطع المعاينة إعادة تشغيل.
 * يعيد true إن كفل بالاستئناف بنفسه، وfalse إن لزم تشغيل جديد عبر playInstant.
 */
export function resumeInstantIfSame(url: string): boolean {
  if (!audio || !url || currentSrc !== url) return false;
  if (!audio.paused) return true; // يعمل أصلاً على نفس الصوت — لا شيء يُفعل
  const generation = ++playGeneration;
  void audio.play().catch(() => {
    if (generation !== playGeneration) return;
    /* فشل الاستئناف يُتجاهل بصمت — الشاشة تستطيع التشغيل عبر playInstant لاحقاً */
  });
  return true;
}

/**
 * قفزة فورية في زمن التشغيل على المشغّل الموحّد (تزامن حي مع سحب مقبض
 * البداية في أداة الاقتصاص): تنقل موضع التشغيل إلى الزمن المطلوب بلا
 * إعادة تحميل ولا انقطاع. يعيد true عند التنفيذ.
 */
export function seekInstant(time: number): boolean {
  if (!audio) return false;
  const target = Math.max(0, Number.isFinite(time) ? time : 0);
  try {
    audio.currentTime = target;
    return true;
  } catch {
    /* قد يرفض المتصفح الضبط قبل الجهوزية */
    return false;
  }
}

/** إيقاف مؤقت للمشغّل الموحّد (بلا تفريغ الموضع) — يعود التشغيل عبر resumeInstant */
export function pauseInstant(): void {
  if (audio && !audio.paused) audio.pause();
}

/** استئناف التشغيل على المشغّل الموحّد من موضعه الحالي */
export function resumeInstant(): boolean {
  if (!audio) return false;
  if (!audio.paused) return true;
  const generation = ++playGeneration;
  void audio.play().catch(() => {
    if (generation !== playGeneration) return;
    /* فشل الاستئناف يُتجاهل بصمت */
  });
  return true;
}

/**
 * تسخين خفيف جداً (32 كيلوبايت فقط) لأول جزء من الصوت عبر طلب HTTP Range
 * (206 Partial Content) — يفتح الاتصال ويجعل النقر اللاحق يبدأ فوراً.
 * لا ArrayBuffer ولا جلب كامل: طلب صغير واحد يُجهَض تلقائياً بعد 5 ثوانٍ.
 */
export function warmAudioCache(url: string, bytes = 32768): void {
  if (!url || typeof window === 'undefined') return;
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    void fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: controller.signal })
      .catch(() => undefined)
      .finally(() => window.clearTimeout(timer));
  } catch {
    /* الجلب الاستباقي اختياري — تجاهل أي فشل بصمت */
  }
}

let audioContext: AudioContext | null = null;

/**
 * تنشيط صامت لسياق الصوت (Silent Web Audio Warm-up):
 * ينشئ AudioContext ويشغّل نغمة صامتة قصيرة جداً (مخزن مؤقت فارغ) لجعل
 * المتصفح يعتبر الجلسة موثوقة (user-gesture unlocked) فيسمح بالتشغيل
 * الفوري التلقائي بلمح البصر دون حظر. يُستدعى داخل إيماءة مستخدم
 * (فتح واجهة النشر / أول لمسة) ويُستأنف عند كل استدعاء لاحق.
 */
export function warmAudioContext(): void {
  if (typeof window === 'undefined') return;
  if (audioContext) {
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined);
    return;
  }
  try {
    const Context = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audioContext = new Context();
    // مخزن مؤقت فارغ (عينة واحدة صامتة): إشارة تشغيل بلا صوت مسموع
    const silentBuffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    const source = audioContext.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(audioContext.destination);
    source.start(0);
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined);
  } catch {
    /* سياق الصوت غير مدعوم في هذا السياق — التشغيل العادي يبقى يعمل */
  }
}
