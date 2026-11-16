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
// الحمولة: الأعمدة العشرة التالية فقط، بلا أي عمود آخر:
//   event_id, user_id, post_id, session_id, visible_duration_ms,
//   played_duration_ms, media_duration_ms, completion_ratio, replay_count,
//   early_skip

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';

/** الصف كما يُرسل إلى public.post_view_events. */
type ReelViewEvent = {
  event_id: string;
  user_id: string;
  post_id: string;
  session_id: string;
  visible_duration_ms: number;
  played_duration_ms: number;
  media_duration_ms: number;
  completion_ratio: number;
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
 * حقيقية. قاعدة واحدة تغطي الحالتين الموجودتين: loop=true (المتصفح يعيد من
 * الصفر بعد النهاية) والقص الزمني (إعادة التشغيل من trim_start بعد trim_end).
 */
const REPLAY_NEAR_END_RATIO = 0.9;
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

function isReelViewEvent(value: unknown): value is ReelViewEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.event_id === 'string' && UUID_PATTERN.test(row.event_id)
    && typeof row.user_id === 'string' && row.user_id.length > 0
    && typeof row.post_id === 'string' && row.post_id.length > 0
    && typeof row.session_id === 'string' && UUID_PATTERN.test(row.session_id)
    && typeof row.visible_duration_ms === 'number' && Number.isFinite(row.visible_duration_ms)
    && typeof row.played_duration_ms === 'number' && Number.isFinite(row.played_duration_ms)
    && typeof row.media_duration_ms === 'number' && Number.isFinite(row.media_duration_ms)
    && typeof row.completion_ratio === 'number' && Number.isFinite(row.completion_ratio)
    && typeof row.replay_count === 'number' && Number.isFinite(row.replay_count)
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
  /** مدة المقطع بالثواني وقت بدء التشغيل (احتياط عند تعذّر قراءتها لاحقاً). */
  mediaDurationSec: number;
  visibleMs: number;
  playedMs: number;
  /** أقصى موضع وصل إليه التشغيل داخل المقطع (ms) — أساس completion_ratio. */
  maxPositionMs: number;
  replayCount: number;
  /** آخر موضع معروف للفيديو (ثواني) لكشف العودة إلى البداية. */
  lastKnownTimeSec: number | null;
  /** الموضع قبل قفزة جارية، يُستهلك عند seeked. */
  preSeekTimeSec: number | null;
  closed: boolean;
};

/** مدة المقطع الفعلي بالثواني، مع مراعاة القص الزمني. */
function resolveMediaDurationSec(
  video: HTMLVideoElement | null,
  trimStartSec: number,
  trimEndSec: number | null,
): number {
  const rawDuration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const start = Math.max(0, trimStartSec);
  const end = trimEndSec !== null && trimEndSec > start
    ? (rawDuration > 0 ? Math.min(trimEndSec, rawDuration) : trimEndSec)
    : rawDuration;
  const span = end - start;
  return span > 0 ? span : 0;
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
    const mediaDurationSec = resolveMediaDurationSec(video, session.trimStartSec, session.trimEndSec)
      || session.mediaDurationSec;
    const mediaDurationMs = Math.round(mediaDurationSec * 1000);
    // أقصى موضع وصل إليه التشغيل، لا مجموع المدد: إعادة التشغيل لا تُضخّم
    // نسبة الإكمال.
    const completionRatio = mediaDurationMs > 0
      ? Math.min(1, Math.max(0, session.maxPositionMs / mediaDurationMs))
      : 0;
    const roundedRatio = Math.round(completionRatio * 10000) / 10000;
    const playedMs = Math.round(session.playedMs);

    enqueueReelView({
      event_id: session.eventId,
      user_id: session.userId,
      post_id: session.postId,
      session_id: readSessionId(),
      visible_duration_ms: Math.round(session.visibleMs),
      played_duration_ms: playedMs,
      media_duration_ms: mediaDurationMs,
      completion_ratio: roundedRatio,
      replay_count: session.replayCount,
      // early_skip يحتاج مدة مقطع معروفة، وإلا فلا حكم على الإكمال.
      early_skip: mediaDurationMs > 0
        && playedMs < EARLY_SKIP_PLAYED_MS
        && roundedRatio < EARLY_SKIP_COMPLETION_RATIO,
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
     * إعادة تشغيل فعلية: عودة من قرب نهاية المقطع إلى بدايته. تغطي loop
     * (المتصفح يعيد من الصفر) والقص الزمني (إعادة من trim_start).
     */
    const countRestartIfAny = (session: ViewSession, previousTimeSec: number | null, currentTimeSec: number) => {
      if (previousTimeSec === null) return;
      // بلا مدة مقطع معروفة لا يمكن الحكم على "قرب النهاية"، فلا إعادة تشغيل.
      if (session.mediaDurationSec <= 0) return;
      const nearStart = currentTimeSec <= session.trimStartSec + RESTART_EPSILON_SEC;
      const wasNearEnd = previousTimeSec >= session.trimStartSec + session.mediaDurationSec * REPLAY_NEAR_END_RATIO;
      if (nearStart && wasNearEnd) session.replayCount += 1;
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
        // القفزة ليست مدة تشغيل.
        session.lastKnownTimeSec = current;
        trackPosition(session, current);
        return;
      }

      if (previous !== null && !element.paused) {
        const deltaMs = (current - previous) * 1000;
        // فقط التقدّم الطبيعي: البحث اليدوي والقفزات الكبيرة لا تُحتسب.
        if (deltaMs > 0 && deltaMs <= MAX_PLAY_DELTA_MS) session.playedMs += deltaMs;
      }

      session.lastKnownTimeSec = current;
      trackPosition(session, current);
    };

    const onSeeking = (event: Event) => {
      const session = sessionRef.current;
      if (!session || session.closed) return;
      if (session.preSeekTimeSec === null) session.preSeekTimeSec = session.lastKnownTimeSec;
      const element = event.currentTarget as HTMLVideoElement;
      trackPosition(session, element.currentTime);
    };

    const onSeeked = (event: Event) => {
      const element = event.currentTarget as HTMLVideoElement;
      const session = sessionRef.current;
      if (!session || session.closed) return;
      countRestartIfAny(session, session.preSeekTimeSec, element.currentTime);
      session.preSeekTimeSec = null;
      // الموضع بعد القفزة هو نقطة البداية الجديدة: القفزة نفسها لا تُحتسب مدة
      // تشغيل، ولا تُنتج فرقاً سالباً في timeupdate التالي.
      session.lastKnownTimeSec = element.currentTime;
      trackPosition(session, element.currentTime);
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);

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
