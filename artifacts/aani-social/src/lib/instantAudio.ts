/**
 * مشغّل الصوت الفوري العالمي (Single Audio Instance & Preload).
 *
 * عنصر HTMLAudioElement واحد فقط يُعاد استخدامه لجميع المعاينات الصوتية في
 * التطبيق (مكتبة الأصوات، شاشة المعاينة، صفحة الصوت): عند التنقل بين الأصوات
 * يُستبدل src على الكائن نفسه بدل إنشاء كائن جديد، فيُجهَض طلب التنزيل السابق
 * فوراً (إلغاء الاستدعاءات المعلقة) ويُتفادى ضغط الذاكرة وGarbage Collection.
 *
 * الضبط:
 * - preload='auto' + crossOrigin='anonymous' (لمصادر Supabase Storage التي تدعم
 *   CORS وطلبات HTTP Range/206 Partial Content) فيقرأ المشغّل أوتار البداية فقط
 *   كمقطع صغير جداً بدل انتظار الملف كاملاً.
 * - يُستدعى playInstant داخل معالج الحدث المباشر (بدون أي await قبله) لتفادي
 *   قيود سياسة التشغيل التلقائي (Autoplay Policy) في المتصفح.
 * - onPlaying يُستدعى فور صدور أول نغمة صوتية (التحول من Spinner إلى Pause).
 */
import { supabaseUrl } from '@/lib/supabase';

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
};

const storageOrigin = (() => {
  try {
    return new URL(supabaseUrl, window.location.href).origin;
  } catch {
    return '';
  }
})();

let audio: HTMLAudioElement | null = null;
let currentSrc = '';
let playingReported = false;
// جيل الطلب الحالي: يُبطِل أي .play() أو رد نداء معلّق من محاولة سابقة عند التنقل السريع
let playGeneration = 0;

/** المصادر الموثوقة فقط تحصل على crossOrigin (تدعم CORS)؛ غيرها بلا الرأس كي لا يُكسر التشغيل */
function isTrustedMediaOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === storageOrigin;
  } catch {
    return false;
  }
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.loop = true;
  }
  return audio;
}

function clearHandlers(): void {
  if (!audio) return;
  audio.onplaying = null;
  audio.onended = null;
  audio.ontimeupdate = null;
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
  if (currentSrc !== url) {
    el.removeAttribute('src');
    if (isTrustedMediaOrigin(url)) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
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
    void el.play().then(reportPlaying).catch(() => {
      if (generation !== playGeneration) return;
      options.onError?.();
    });
  } else {
    void el.play().catch(() => {
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
 * تسخين ذاكرة المتصفح لأول جزء من الصوت عبر طلب HTTP Range (206 Partial Content)
 * — النقر اللاحق على الصوت يبدأ فوراً لأن الأوتار الأولى حاضرة في الكاش والاتصال مفتوح.
 */
export function warmAudioCache(url: string, bytes = 131072): void {
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
