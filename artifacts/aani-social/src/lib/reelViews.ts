// تتبع صامت لمشاهدات الريلز الفعلية (المرحلة الثالثة من خوارزمية آني).
//
// يُسجَّل صف واحد في public.post_view_events لكل جلسة مشاهدة فعلية، أي لكل
// منشور في جلسة التصفح الحالية. الجدول وأعمدته وفهارسه وسياسات RLS موجودة
// مسبقاً في الإنتاج، وهذا الملف لا ينفّذ SQL ولا ينشئ أي ترحيل.
//
// القاعدة (ثابتة في هذا الملف):
//   * الشريحة تُعتبر ظاهرة عند 60% على الأقل — وهي نفس عتبة
//     IntersectionObserver الموجود في ReelSlide (threshold 0.6). لا يُنشأ
//     مراقب ثانٍ هنا؛ المكوّن يمرّر النتيجة عبر `active`.
//   * جلسة المشاهدة تبدأ عند أول تشغيل فعلي للفيديو (حدث playing)، ولا تبدأ
//     أبداً بمجرد التحميل أو الـpreload أو الظهور وحده.
//   * الصفحة المخفية لا تُحتسب: لا مدة ظهور ولا مدة تشغيل.
//
// ما لا يفعله هذا الملف:
//   * لا يغيّر ترتيب الريلز ولا usePosts ولا خوارزمية التوصية أو أوزانها.
//   * لا يضيف أي عنصر مرئي ولا يغيّر التصميم.
//   * لا يلمس IntersectionObserver الحالي ولا playExclusive ولا إيقاف
//     الفيديوهات الحصرية ولا الصوت الخلفي ولا مزامنته ولا القص ولا التشغيل
//     التلقائي. كل مستمعاته إضافية ومستقلة.
//   * لا يمسّ post_impressions ولا منطق المرحلة الثانية (impressions.ts).
//
// الحمولة: أحد عشر عموداً فقط، بلا أي عمود آخر، ومطابقة حرفياً لقيود الجدول
// في Production:
//   event_id, user_id, post_id, surface ('reels'), content_type ('video'),
//   session_id, visible_duration_ms, played_duration_ms, media_duration_ms,
//   completion_ratio, replay_count, early_skip
//
// قيود Production التي تحكم هذه الحمولة (من
// supabase/migrations/20261116113304_create_post_recommendation_telemetry_tables.sql):
//   * surface text not null check (surface in ('feed','reels')) — بلا قيمة افتراضية
//   * content_type text not null check (content_type in ('text','image','video')) — بلا قيمة افتراضية
//   * session_id uuid not null
//   * visible_duration_ms integer not null default 0 check (between 0 and 86400000)
//   * played_duration_ms  integer not null default 0 check (between 0 and 86400000)
//   * media_duration_ms   integer null check (is null or between 1 and 86400000)
//   * completion_ratio    numeric(6,5) null check (is null or between 0 and 1)
//   * replay_count        integer not null default 0 check (between 0 and 1000)
//   * early_skip          boolean not null default false
// ولذلك: المدة غير المعروفة تُرسل null ولا تُحوَّل إلى 0 (الصفر يخالف القيد)،
// ونسبة الإكمال تكون null حين لا تُعرف المدة، وكل الأعداد تُقصّ على حدودها.

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';

/** الصف كما يُرسل إلى public.post_view_events. */
type ReelViewEvent = {
  event_id: string;
  user_id: string;
  post_id: string;
  /** العمود NOT NULL في الإنتاج وبلا قيمة افتراضية: 'reels' دائماً. */
  surface: 'reels';
  /** العمود NOT NULL في الإنتاج وبلا قيمة افتراضية: 'video' دائماً. */
  content_type: 'video';
  session_id: string;
  visible_duration_ms: number;
  played_duration_ms: number;
  /** null حين لا تُعرف مدة الفيديو — القاعدة لا تقبل 0 هنا. */
  media_duration_ms: number | null;
  /** null حين لا تُعرف المدة، فلا تُدَّعى نسبة إكمال. */
  completion_ratio: number | null;
  replay_count: number;
  early_skip: boolean;
};

// ---------------------------------------------------------------------
// ثوابت القياس — كل تعريف هنا مقصود وثابت، ولا يعتمد على ترتيب المحتوى.
// ---------------------------------------------------------------------

/** دقة عدّاد مدة الظهور (ms). */
const TICK_MS = 250;
/** أقصى فجوة تُحتسب في عدّاد الظهور عند تجمّد الخيط الرئيسي (ms). */
const MAX_TICK_GAP_MS = 1000;
/**
 * أقصى قفزة إلى الأمام تُحتسب مدة تشغيل حقيقية (ms). ما زاد عليها يُعدّ
 * بحثاً/قفزة لا تشغيلاً، فلا يُحتسب. البحث اليدوي نفسه يُستثنى أيضاً عبر
 * حدثي seeking/seeked.
 */
const MAX_PLAY_DELTA_MS = 2000;
/**
 * أدنى مدة تشغيل فعلية لاعتبار الجلسة مشاهدة. الجلسة التي لم يتجاوز تشغيلها
 * هذا الحد لا تُرسل إطلاقاً: تحميل الفيديو أو ظهوره بلا تشغيل ليس مشاهدة.
 */
const MIN_RECORDED_PLAYED_MS = 500;
/** هامش اعتبار الموضع "عند بداية المقطع" بالثواني. */
const RESTART_EPSILON_SEC = 0.5;
/**
 * نسبة الموضع السابق من المقطع التي تجعل العودة إلى البداية إعادة تشغيل
 * حقيقية. قاعدة واحدة تغطي الحالتين التلقائيتين الموجودتين في ReelSlide:
 * loop=true (المتصفح يعيد من الصفر بعد النهاية) والقص الزمني (إعادة التشغيل
 * من trim_start بعد trim_end).
 */
const REPLAY_NEAR_END_RATIO = 0.9;
/**
 * نافذة اعتبار القفزة ناتجة عن سحب المستخدم لشريط التقدم (ms). أحداث
 * input/change على input[type=range] تُحدّث الطابع الزمني، فأي عودة إلى
 * البداية خلال هذه النافذة تُعدّ بحثاً يدوياً لا إعادة تشغيل.
 */
const USER_SEEK_WINDOW_MS = 1000;
/**
 * نافذة دمج إعادة التشغيل الواحدة (ms): loop الأصلي قد يُنتج timeupdate
 * و seeked لنفس الإعادة، فلا تُحتسب مرتين.
 */
const RESTART_DEDUPE_MS = 300;
/**
 * تعريف early_skip الثابت في هذا الملف:
 * مشاهدة انتهت بتشغيل فعلي أقل من 3000ms **و** نسبة إكمال أقل من 0.3.
 * قيمة تحليلية فقط — لا تُستخدم لتغيير ترتيب المحتوى في هذه المرحلة.
 */
const EARLY_SKIP_PLAYED_MS = 3000;
const EARLY_SKIP_COMPLETION_RATIO = 0.3;

/** أقصى عدد أحداث في الدفعة الواحدة. */
const BATCH_MAX = 10;
/** تأخير تجميع الأحداث قبل الإرسال (ms). */
const BATCH_DELAY_MS = 2000;
/** تأخير الدفعة التالية عند بقاء أحداث معلّقة (ms). */
const DRAIN_DELAY_MS = 250;
/** تأخير إعادة المحاولة بعد فشل الإرسال (ms). */
const RETRY_DELAY_MS = 15000;
/**
 * الحد التشغيلي للطابور: عند بلوغه لا تُقبل مشاهدات جديدة، ولا تُحذف معلّقة
 * أبداً. المشاهدة التي لا تُقبل لا يُخزَّن لها مفتاح منع تكرار.
 */
const MAX_PENDING = 100;
/** أقصى عدد دفعات في محاولة الإرسال عند مغادرة الصفحة. */
const EXIT_MAX_BATCHES = 5;
/** ميزانية زمنية لمحاولة الإرسال عند مغادرة الصفحة (ms). */
const EXIT_BUDGET_MS = 1200;

const SESSION_STORAGE_KEY = 'aani:reelview-session-id';
const RECORDED_STORAGE_KEY = 'aani:reelview-recorded';
const PENDING_STORAGE_KEY = 'aani:reelview-pending';

/** UUID v4 بلا اعتماد على وجود crypto.randomUUID. */
function randomUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // نسقط إلى المولّد اليدوي أدناه
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** حدود أعمدة الجدول كما هي في Production. */
const MAX_DURATION_MS = 86400000;
const MIN_MEDIA_DURATION_MS = 1;
const MAX_REPLAY_COUNT = 1000;
/** عدد منازل `completion_ratio numeric(6,5)`. */
const COMPLETION_RATIO_SCALE = 100000;

/** مدة تشغيل/ظهور صحيحة الشكل ضمن حدود العمود (0..86400000). */
function clampDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.round(value));
}

/**
 * مدة المقطع: null حين لا تُعرف (أو أقل من 1ms)، وإلا بين 1 و86400000.
 * لا تُحوَّل مدة مجهولة إلى صفر: القاعدة ترفض 0 في هذا العمود.
 */
function clampMediaDurationMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1) return null;
  return Math.min(MAX_DURATION_MS, rounded);
}

/** نسبة إكمال بين 0 و1 بخمس منازل عشرية — مطابقة لـnumeric(6,5). */
function clampCompletionRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * COMPLETION_RATIO_SCALE) / COMPLETION_RATIO_SCALE));
}

// ---------------------------------------------------------------------
// تحقق صارم من الأحداث المستعادة من sessionStorage مقابل قيود الجدول:
// كل حقل رقمي يُفحص نوعه وحدوده، لا مجرد كونه رقماً منتهياً. الحدث الذي لا
// يطابق القيود يُرفض ولا يُرسل، فلا يصل صف مخالف إلى القاعدة.
// ---------------------------------------------------------------------

/** عدد صحيح فعلاً (لا كسور، ولا NaN/Infinity) ضمن حدود مغلقة. */
function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * media_duration_ms: `integer null check (is null or between 1 and 86400000)`.
 * الصفر مرفوض لأن القاعدة ترفضه.
 */
function isMediaDurationMs(value: unknown): value is number | null {
  if (value === null) return true;
  return isIntegerWithin(value, MIN_MEDIA_DURATION_MS, MAX_DURATION_MS);
}

/**
 * completion_ratio: `numeric(6,5) null check (is null or between 0 and 1)`.
 * يشترط أن يكون رقماً منتهياً بين 0 و1، وبلا كسور تتجاوز خمس منازل عشرية
 * (دقة العمود)، فلا يُرسل ما قد يقرّبه الخادم أو يرفضه.
 */
function isCompletionRatio(value: unknown): value is number | null {
  if (value === null) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < 0 || value > 1) return false;
  const scaled = value * COMPLETION_RATIO_SCALE;
  // سماحية صغيرة لتمثيل الفاصلة العائمة: 0.12345 * 100000 قد لا يكون صحيحاً تماماً.
  return Math.abs(scaled - Math.round(scaled)) < 1e-3;
}

function isReelViewEvent(value: unknown): value is ReelViewEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.event_id === 'string' && UUID_PATTERN.test(row.event_id)
    // user_id و post_id عمودان uuid في الإنتاج: التحقق المحلي يطابق نوع القاعدة.
    && typeof row.user_id === 'string' && UUID_PATTERN.test(row.user_id)
    && typeof row.post_id === 'string' && UUID_PATTERN.test(row.post_id)
    // العمودان NOT NULL وبلا قيمة افتراضية في الإنتاج: أي حدث مستعاد بغيرهما تالف.
    && row.surface === 'reels'
    && row.content_type === 'video'
    && typeof row.session_id === 'string' && UUID_PATTERN.test(row.session_id)
    // integer not null check (between 0 and 86400000)
    && isIntegerWithin(row.visible_duration_ms, 0, MAX_DURATION_MS)
    && isIntegerWithin(row.played_duration_ms, 0, MAX_DURATION_MS)
    && isMediaDurationMs(row.media_duration_ms)
    && isCompletionRatio(row.completion_ratio)
    // integer not null check (between 0 and 1000)
    && isIntegerWithin(row.replay_count, 0, MAX_REPLAY_COUNT)
    // boolean not null
    && typeof row.early_skip === 'boolean';
}

// ---------------------------------------------------------------------
// معرّف جلسة التصفح: ثابت طوال جلسة التبويب الحالية، ويُولَّد في الذاكرة
// احتياطياً حين لا يتوفر التخزين.
// ---------------------------------------------------------------------
let cachedSessionId: string | null = null;

function readSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  if (typeof window === 'undefined') {
    cachedSessionId = randomUuid();
    return cachedSessionId;
  }
  try {
    const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored && UUID_PATTERN.test(stored)) {
      cachedSessionId = stored;
      return stored;
    }
  } catch {
    // التخزين غير متاح: نكمل بمعرّف في الذاكرة
  }
  const created = randomUuid();
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
  } catch {
    // لا شيء: المعرّف يبقى في الذاكرة لهذه الصفحة
  }
  cachedSessionId = created;
  return created;
}

/** مفتاح منع التكرار: مشاهدة واحدة لكل منشور في جلسة التصفح. */
function dedupeKeyOf(event: { session_id: string; user_id: string; post_id: string }): string {
  return `${event.session_id}:${event.user_id}:${event.post_id}`;
}

// ---------------------------------------------------------------------
// المفاتيح المسجّلة: تُضاف عند قبول الحدث في الطابور (لا عند الإرسال)، فتمنع
// أي حدث ثانٍ لنفس المنشور في الجلسة نفسها مهما أُعيد تركيب المكوّن.
// ---------------------------------------------------------------------
const recordedViews = new Set<string>();
let recordedLoaded = false;

function loadRecordedViews(): void {
  if (recordedLoaded) return;
  recordedLoaded = true;
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(RECORDED_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === 'string' && value) recordedViews.add(value);
    }
  } catch {
    // قائمة تالفة: نتجاهلها ونبدأ من جديد
  }
}

/**
 * حفظ المفاتيح المسجّلة. تُعيد true فقط إذا تأكدت الكتابة.
 * عند تعذّر التخزين تبقى المفاتيح في الذاكرة لهذه الصفحة وحدها — **ولا
 * يُدَّعى منع تكرار بعد إعادة التحميل في هذه الحالة**.
 */
function persistRecordedViews(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.sessionStorage.setItem(RECORDED_STORAGE_KEY, JSON.stringify(Array.from(recordedViews)));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// EventBatcher: طابور المشاهدات المعلّقة، محفوظ في sessionStorage.
// ---------------------------------------------------------------------
let pending: ReelViewEvent[] = [];
let pendingLoaded = false;
let flushTimer: number | null = null;
let flushing = false;
let flushListenersInstalled = false;

function persistPending(): void {
  if (typeof window === 'undefined') return;
  try {
    if (pending.length === 0) {
      window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // تعذّر الحفظ (امتلاء أو وضع خاص): تبقى الأحداث في الذاكرة وتُرسل عادةً
  }
}

/** استعادة الطابور بعد إعادة تحميل الصفحة، بنفس event_id. */
function loadQueue(): void {
  if (pendingLoaded) return;
  pendingLoaded = true;
  loadRecordedViews();
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored: ReelViewEvent[] = [];
    for (const value of parsed) {
      if (!isReelViewEvent(value)) continue;
      // لا قصّ ولا تجاهل: كل حدث صحيح في التخزين يبقى، ويُرسل تدريجياً.
      if (restored.some(event => event.event_id === value.event_id)) continue;
      restored.push(value);
    }
    pending = restored;
  } catch {
    // بيانات تالفة: نتجاهلها
  }
  if (pending.length > 0) {
    installFlushListeners();
    scheduleFlush(BATCH_DELAY_MS);
  }
}

function scheduleFlush(delay: number): void {
  if (typeof window === 'undefined') return;
  if (flushTimer !== null) return;
  // أثناء إرسال جارٍ: من يكمل الإرسال هو من يجدول الدفعة التالية.
  if (flushing) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushReelViews();
  }, delay);
}

function isPageHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// تمييز البحث اليدوي عن إعادة التشغيل التلقائية.
//
// المسار اليدوي الوحيد للبحث في ReelSlide هو شريط التقدم: input[type=range]
// في الأسفل، onChange يضبط video.currentTime مباشرة. أما إعادة التشغيل
// التلقائية فتأتي من loop الأصلي في المتصفح أو من seekToTrimStart التي
// يستدعيها ReelSlide برمجياً عند بلوغ trim_end.
//
// لذلك يُسجَّل هنا وقت آخر تفاعل للمستخدم مع أي input[type=range] في الصفحة،
// وأي عودة إلى بداية المقطع خلال USER_SEEK_WINDOW_MS منه تُعدّ بحثاً يدوياً
// ولا تُحتسب إعادة تشغيل. المستمع واحد للصفحة كلها، ولا يغيّر سلوك أي عنصر.
// ---------------------------------------------------------------------
let lastUserSeekAt = 0;
let userSeekListenerInstalled = false;

function installUserSeekListener(): void {
  if (userSeekListenerInstalled || typeof document === 'undefined') return;
  userSeekListenerInstalled = true;
  const markUserSeek = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'range') {
      lastUserSeekAt = Date.now();
    }
  };
  try {
    document.addEventListener('input', markUserSeek, true);
    document.addEventListener('change', markUserSeek, true);
  } catch {
    // بلا مستمع: البحث اليدوي قد يُحتسب إعادة تشغيل، وهو الاحتياط الآمن الوحيد
  }
}

function isRecentUserSeek(): boolean {
  return Date.now() - lastUserSeekAt <= USER_SEEK_WINDOW_MS;
}

/**
 * إرسال دفعة واحدة بحجم BATCH_MAX على الأكثر.
 *
 * upsert مع onConflict: 'user_id,event_id' و ignoreDuplicates: true:
 * إعادة إرسال نفس event_id (بعد مهلة وصل طلبها فعلاً، أو بعد فشل حفظ
 * الطابور) لا تُفشل الدفعة ولا تُنشئ صفاً مكرراً، لأن القيد الفريد
 * (user_id, event_id) يمنع التكرار على الخادم. مسار DO NOTHING لا يحتاج
 * سياسة UPDATE.
 *
 * عند الفشل: تبقى الأحداث في الطابور بنفس event_id وتُعاد المحاولة لاحقاً.
 * تُعيد true فقط إذا تأكد قبول الدفعة (أو لم يبقَ شيء)، وfalse عند أي فشل —
 * وبهذا تتوقف flushReelViewsOnExit عند أول فشل.
 */
async function flushReelViews(): Promise<boolean> {
  if (flushing || !supabaseConfigured) return false;
  loadQueue();
  if (pending.length === 0) return true;
  flushing = true;
  const batch = pending.slice(0, BATCH_MAX);
  let nextDelay: number | null = null;
  let sent = false;
  try {
    const { error } = await supabase
      .from('post_view_events')
      .upsert(batch, { onConflict: 'user_id,event_id', ignoreDuplicates: true });
    if (error) {
      nextDelay = RETRY_DELAY_MS;
    } else {
      const sentEventIds = new Set(batch.map(event => event.event_id));
      pending = pending.filter(event => !sentEventIds.has(event.event_id));
      persistPending();
      sent = true;
      if (pending.length > 0) nextDelay = DRAIN_DELAY_MS;
    }
  } catch {
    nextDelay = RETRY_DELAY_MS;
  } finally {
    flushing = false;
  }
  if (nextDelay !== null) scheduleFlush(nextDelay);
  return sent;
}

/**
 * محاولة إرسال عند مغادرة الصفحة أو إخفائها: دفعات متتالية ضمن ميزانية
 * قصيرة، وتتوقف عند أول فشل فلا تتكرر الطلبات الفاشلة فوراً.
 * أفضل محاولة ممكنة فقط — لا ضمان تسليم عند إغلاق Safari، والطابور يبقى في
 * sessionStorage ليُرسل عند العودة.
 */
async function flushReelViewsOnExit(): Promise<void> {
  const startedAt = Date.now();
  for (let index = 0; index < EXIT_MAX_BATCHES; index += 1) {
    if (pending.length === 0) return;
    if (Date.now() - startedAt > EXIT_BUDGET_MS) return;
    if (flushing) return;
    // eslint-disable-next-line no-await-in-loop
    const sent = await flushReelViews();
    if (!sent) return;
    if (pending.length === 0) return;
  }
}

function installFlushListeners(): void {
  if (flushListenersInstalled || typeof window === 'undefined') return;
  flushListenersInstalled = true;
  try {
    window.addEventListener('pagehide', () => {
      void flushReelViewsOnExit();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushReelViewsOnExit();
    });
  } catch {
    // بلا مستمعين: المؤقّت وحده يكفي
  }
}

/** نتيجة محاولة قبول مشاهدة في الطابور. */
type EnqueueOutcome =
  | 'accepted'
  | 'duplicate'
  | 'full'
  | 'unavailable';

function enqueueReelView(event: ReelViewEvent): EnqueueOutcome {
  try {
    if (!supabaseConfigured) return 'unavailable';
    loadQueue();
    const key = dedupeKeyOf(event);
    // مشاهدة مسجّلة أو معلّقة لنفس المنشور في هذه الجلسة: لا حدث ثانٍ.
    if (recordedViews.has(key)) return 'duplicate';
    if (pending.some(item => dedupeKeyOf(item) === key)) return 'duplicate';
    // الطابور بلغ الحد: لا نقبل ولا نخزّن مفتاح منع تكرار، ولا نحذف شيئاً.
    if (pending.length >= MAX_PENDING) {
      scheduleFlush(DRAIN_DELAY_MS);
      return 'full';
    }

    pending.push(event);
    persistPending();
    recordedViews.add(key);
    persistRecordedViews();

    installFlushListeners();
    if (pending.length >= BATCH_MAX) void flushReelViews();
    else scheduleFlush(BATCH_DELAY_MS);
    return 'accepted';
  } catch {
    // التتبع لا يكسر العرض أبداً
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------
// جلسة مشاهدة واحدة لشريحة واحدة.
// ---------------------------------------------------------------------
type ViewSession = {
  eventId: string;
  postId: string;
  userId: string;
  /** بداية المقطع بالثواني (0 إن لم يكن هناك قص). */
  trimStartSec: number;
  /** نهاية المقطع بالثواني، أو null إن كان الفيديو كاملاً. */
  trimEndSec: number | null;
  /** مدة المقطع بالثواني وقت بدء التشغيل، أو null إن لم تُعرف بعد. */
  mediaDurationSec: number | null;
  visibleMs: number;
  playedMs: number;
  /** أقصى موضع وصل إليه التشغيل داخل المقطع (ms) — أساس completion_ratio. */
  maxPositionMs: number;
  replayCount: number;
  /** آخر لحظة احتُسبت فيها إعادة تشغيل، لدمج timeupdate و seeked لنفس الإعادة. */
  lastRestartAtMs: number;
  /** آخر موضع معروف للفيديو (ثواني) لكشف العودة إلى البداية. */
  lastKnownTimeSec: number | null;
  /** الموضع قبل قفزة جارية، يُستهلك عند seeked. */
  preSeekTimeSec: number | null;
  closed: boolean;
};

/**
 * مدة المقطع الفعلي بالثواني، مع مراعاة القص الزمني.
 *
 * تُعيد null إذا كانت المدة مجهولة فعلاً: لا duration صالحة من المتصفح ولا
 * نهاية قصّ معروفة. لا تُصنع قيمة افتراضية، لأن العمود في الإنتاج يرفض 0.
 */
function resolveMediaDurationSec(
  video: HTMLVideoElement | null,
  trimStartSec: number,
  trimEndSec: number | null,
): number | null {
  const rawDuration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const start = Math.max(0, trimStartSec);
  const end = trimEndSec !== null && trimEndSec > start
    ? (rawDuration > 0 ? Math.min(trimEndSec, rawDuration) : trimEndSec)
    : rawDuration;
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return null;
  return span;
}

/**
 * يراقب شريحة ريل واحدة ويُسجّل مشاهدة واحدة عند انتهاء جلستها.
 *
 * كل مستمعاته إضافية على عنصر الفيديو (playing/timeupdate/seeking/seeked)
 * وعلى visibilitychange/pagehide، ولا تغيّر سلوك التشغيل أو الإيقاف أو
 * الحصرية أو الصوت الموجود في ReelSlide.
 *
 * @param active الشريحة ظاهرة بنسبة 60% على الأقل (من مراقب المكوّن الحالي).
 * @param enabled false للمنشورات المؤقتة وللريلز المصوّرة (بلا فيديو).
 */
export function useReelViewTracking(input: {
  videoRef: RefObject<HTMLVideoElement | null>;
  postId: string;
  userId: string;
  active: boolean;
  enabled: boolean;
  trimStartSec?: number;
  trimEndSec?: number;
}): void {
  const { videoRef, postId, userId, active, enabled, trimStartSec, trimEndSec } = input;
  const sessionRef = useRef<ViewSession | null>(null);
  const activeRef = useRef(active);
  const enabledRef = useRef(enabled);

  /** يغلق الجلسة الحالية ويحوّلها إلى حدث واحد في الطابور. */
  const closeSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.closed) return;
    session.closed = true;
    sessionRef.current = null;

    // لم يبدأ تشغيل فعلي كافٍ: تحميل أو ظهور عابر ليس مشاهدة.
    if (session.playedMs < MIN_RECORDED_PLAYED_MS) return;

    const video = videoRef.current;
    // المدة المجهولة تبقى null ولا تُحوَّل إلى 0 — القاعدة ترفض 0 في هذا العمود.
    const mediaDurationSec = resolveMediaDurationSec(video, session.trimStartSec, session.trimEndSec)
      ?? session.mediaDurationSec;
    const mediaDurationMs = clampMediaDurationMs(
      mediaDurationSec === null ? null : mediaDurationSec * 1000,
    );
    // بلا مدة معروفة لا تُدَّعى نسبة إكمال: null بدل رقم مضلّل.
    const completionRatio = mediaDurationMs !== null
      ? clampCompletionRatio(session.maxPositionMs / mediaDurationMs)
      : null;
    const playedMs = clampDurationMs(session.playedMs);
    const visibleMs = clampDurationMs(session.visibleMs);

    enqueueReelView({
      event_id: session.eventId,
      user_id: session.userId,
      post_id: session.postId,
      surface: 'reels',
      content_type: 'video',
      session_id: readSessionId(),
      visible_duration_ms: visibleMs,
      played_duration_ms: playedMs,
      media_duration_ms: mediaDurationMs,
      completion_ratio: completionRatio,
      replay_count: Math.min(MAX_REPLAY_COUNT, Math.max(0, Math.round(session.replayCount))),
      // early_skip يحتاج نسبة إكمال حقيقية؛ بلا مدة معروفة يبقى false.
      early_skip: completionRatio !== null
        && playedMs < EARLY_SKIP_PLAYED_MS
        && completionRatio < EARLY_SKIP_COMPLETION_RATIO,
    });
  }, [videoRef]);

  // حالة الظهور/التفعيل تُقرأ عبر مراجع، فلا تُعاد تهيئة المستمعات مع كل تمرير.
  useEffect(() => {
    activeRef.current = active;
    enabledRef.current = enabled;
    if (!active || !enabled) closeSession();
  }, [active, enabled, closeSession]);

  useEffect(() => {
    if (!enabled || !userId || !postId) return undefined;
    if (typeof window === 'undefined') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    const startSession = (element: HTMLVideoElement): ViewSession => {
      const existing = sessionRef.current;
      if (existing && !existing.closed) return existing;
      const start = Math.max(0, trimStartSec ?? 0);
      const end = typeof trimEndSec === 'number' && trimEndSec > start ? trimEndSec : null;
      const session: ViewSession = {
        eventId: randomUuid(),
        postId,
        userId,
        trimStartSec: start,
        trimEndSec: end,
        mediaDurationSec: resolveMediaDurationSec(element, start, end),
        visibleMs: 0,
        playedMs: 0,
        maxPositionMs: 0,
        replayCount: 0,
        lastRestartAtMs: 0,
        lastKnownTimeSec: element.currentTime,
        preSeekTimeSec: null,
        closed: false,
      };
      sessionRef.current = session;
      return session;
    };

    /** يسجّل أقصى موضع تشغيل داخل المقطع، بلا تأثير على عدّاد التشغيل. */
    const trackPosition = (session: ViewSession, timeSec: number) => {
      const positionMs = (timeSec - session.trimStartSec) * 1000;
      if (positionMs > session.maxPositionMs) session.maxPositionMs = positionMs;
    };

    /**
     * إعادة تشغيل فعلية: عودة من قرب نهاية المقطع إلى بدايته.
     *
     * تُحتسب في الحالتين التلقائيتين فقط:
     *   * loop الأصلي (videoTimeRange == null): المتصفح يعيد من الصفر.
     *   * إعادة القص البرمجية: seekToTrimStart بعد بلوغ trim_end.
     * ولا تُحتسب إذا كان المستخدم قد سحب شريط التقدم خلال USER_SEEK_WINDOW_MS،
     * فسحب المؤشر من قرب النهاية إلى البداية بحثٌ يدوي لا إعادة تشغيل.
     * وتُدمج timeupdate و seeked لنفس الإعادة عبر RESTART_DEDUPE_MS.
     */
    const countRestartIfAny = (session: ViewSession, previousTimeSec: number | null, currentTimeSec: number) => {
      if (previousTimeSec === null) return;
      // بلا مدة مقطع معروفة لا يمكن الحكم على "قرب النهاية"، فلا إعادة تشغيل.
      if (session.mediaDurationSec === null || session.mediaDurationSec <= 0) return;
      const nearStart = currentTimeSec <= session.trimStartSec + RESTART_EPSILON_SEC;
      const wasNearEnd = previousTimeSec >= session.trimStartSec + session.mediaDurationSec * REPLAY_NEAR_END_RATIO;
      if (!nearStart || !wasNearEnd) return;
      // سحب المستخدم شريط التقدم: بحث يدوي، ليس إعادة تشغيل.
      if (isRecentUserSeek()) return;
      const now = Date.now();
      if (now - session.lastRestartAtMs < RESTART_DEDUPE_MS) return;
      session.lastRestartAtMs = now;
      if (session.replayCount < MAX_REPLAY_COUNT) session.replayCount += 1;
    };

    const onPlaying = (event: Event) => {
      const element = event.currentTarget as HTMLVideoElement;
      const session = startSession(element);
      // لا تُحتسب فترة التوقف/التحميل السابقة كتشغيل.
      session.lastKnownTimeSec = element.currentTime;
      session.preSeekTimeSec = null;
      trackPosition(session, element.currentTime);
    };

    const onTimeUpdate = (event: Event) => {
      const element = event.currentTarget as HTMLVideoElement;
      const session = sessionRef.current;
      if (!session || session.closed) return;
      const current = element.currentTime;
      const previous = session.lastKnownTimeSec;

      if (previous !== null && current + RESTART_EPSILON_SEC * 0.02 < previous) {
        // قفزة إلى الخلف (loop أصلي أو إعادة قصّ بلا حدث seeked).
        countRestartIfAny(session, previous, current);
        // القفزة ليست مدة تشغيل ولا موضعاً مشاهداً.
        session.lastKnownTimeSec = current;
        return;
      }

      if (previous !== null && !element.paused) {
        const deltaMs = (current - previous) * 1000;
        // فقط التقدّم الطبيعي: البحث اليدوي والقفزات الكبيرة لا تُحتسب مدةً
        // تشغيل ولا موضعاً مشاهداً.
        if (deltaMs > 0 && deltaMs <= MAX_PLAY_DELTA_MS) {
          session.playedMs += deltaMs;
          // الموضع المشاهد يتقدّم بالتشغيل الفعلي فقط، لا بسحب الشريط.
          trackPosition(session, current);
        }
      }

      session.lastKnownTimeSec = current;
    };

    const onSeeking = () => {
      const session = sessionRef.current;
      if (!session || session.closed) return;
      // يُحفظ الموضع قبل القفزة لتمييز إعادة التشغيل عن البحث اليدوي عند seeked.
      // هدف القفزة نفسه ليس موضعاً مشاهداً: لا يُرفع maxPositionMs هنا.
      if (session.preSeekTimeSec === null) session.preSeekTimeSec = session.lastKnownTimeSec;
    };

    const onSeeked = (event: Event) => {
      const element = event.currentTarget as HTMLVideoElement;
      const session = sessionRef.current;
      if (!session || session.closed) return;
      countRestartIfAny(session, session.preSeekTimeSec, element.currentTime);
      session.preSeekTimeSec = null;
      // الموضع بعد القفزة هو نقطة البداية الجديدة: القفزة نفسها لا تُحتسب مدة
      // تشغيل ولا موضعاً مشاهداً، ولا تُنتج فرقاً سالباً في timeupdate التالي.
      session.lastKnownTimeSec = element.currentTime;
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    // لتمييز سحب شريط التقدم اليدوي عن إعادة التشغيل التلقائية.
    installUserSeekListener();

    // عدّاد مدة الظهور: زمن حائطي فقط عندما تكون الشريحة ظاهرة والصفحة visible
    // وبعد بدء التشغيل الفعلي.
    let lastTickAt = Date.now();
    const tick = () => {
      const now = Date.now();
      const gap = Math.min(now - lastTickAt, MAX_TICK_GAP_MS);
      lastTickAt = now;
      const session = sessionRef.current;
      if (!session || session.closed) return;
      if (!activeRef.current || !enabledRef.current) return;
      if (isPageHidden()) return;
      session.visibleMs += gap;
    };
    const ticker = window.setInterval(tick, TICK_MS);

    // فيديو كان يعمل قبل تركيب المستمعات: نبدأ الجلسة فوراً بدل انتظار حدث
    // playing التالي.
    if (!video.paused) startSession(video);

    const onVisibilityChange = () => {
      if (!isPageHidden()) return;
      // إخفاء الصفحة: أوقف القياس واحفظ ملخص الجلسة (أفضل محاولة ممكنة).
      closeSession();
      void flushReelViewsOnExit();
    };
    const onPageHide = () => {
      closeSession();
      void flushReelViewsOnExit();
    };

    try {
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('pagehide', onPageHide);
    } catch {
      // بلا مستمعين: العدّاد وحده يعمل
    }

    return () => {
      window.clearInterval(ticker);
      try {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', onPageHide);
      } catch {
        // لا شيء
      }
      try {
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('timeupdate', onTimeUpdate);
        video.removeEventListener('seeking', onSeeking);
        video.removeEventListener('seeked', onSeeked);
      } catch {
        // العنصر قد يكون أفلت مرجعه
      }
      // مغادرة الشريحة: أغلق الجلسة وابنِ الحدث.
      closeSession();
      void flushReelViewsOnExit();
    };
  }, [closeSession, enabled, postId, trimEndSec, trimStartSec, userId, videoRef]);
}
