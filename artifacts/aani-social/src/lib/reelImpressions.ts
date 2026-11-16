// تتبع صامت لظهور الريلز المصوّرة (المرحلة 5-B2).
//
// يُسجَّل صف واحد في public.post_view_events لكل ريل صورة في جلسة التصفح
// الحالية، بـ surface = 'reels' و content_type = 'image'. الجدول وأعمدته
// وقيوده وسياسات RLS موجودة مسبقاً في الإنتاج، وهذا الملف لا ينفّذ SQL ولا
// ينشئ أي ترحيل.
//
// القاعدة (ثابتة في هذا الملف):
//   * الشريحة تُعتبر ظاهرة عند 60% على الأقل — وهي نفس عتبة
//     IntersectionObserver الموجود في ReelSlide (threshold 0.6). لا يُنشأ
//     مراقب ثانٍ هنا؛ المكوّن يمرّر النتيجة عبر `active`.
//   * تُسجَّل **مدة الظهور الفعلية فقط**: عدّاد زمن حائطي يعمل حين تكون
//     الشريحة ظاهرة والصفحة visible. لا تُحتسب أي مدة والصفحة مخفية.
//   * التحميل المسبق ليس ظهوراً: لا تبدأ الجلسة عند تركيب المكوّن ولا عند
//     preload أو تحميل البيانات أو الصورة، بل عند أول لحظة تكون فيها الشريحة
//     ظاهرة فعلاً والصفحة visible.
//   * أدنى مدة ظهور لاعتبار الظهور انطباعاً هي MIN_VISIBLE_MS؛ ما دونها يُهمل
//     تماماً ولا يُرسل.
//   * الريل المصوّر لا تشغيل فيه، فلا تُدّعى إشارات فيديو: played_duration_ms
//     = 0، و media_duration_ms و completion_ratio = null، و replay_count = 0،
//     و early_skip = false.
//
// منع التكرار: مفتاح واحد لكل منشور في جلسة التصفح، يُضاف عند قبول الحدث في
// الطابور، فلا يتكرر الحدث مهما أُعيد تركيب المكوّن أو تكرّرت أحداث الظهور.
//
// الإرسال غير متزامن: طابور محفوظ في sessionStorage، دفعات بحد عشرة أحداث،
// وإعادة محاولة عند الفشل بنفس event_id، مع upsert على (user_id, event_id)
// و ignoreDuplicates — فلا تكرار على الخادم ولا حجب للعرض.
//
// ما لا يفعله هذا الملف:
//   * لا يلمس reelViews.ts (تتبع الفيديو) ولا impressions.ts (المرحلة الثانية).
//   * لا يغيّر تشغيل الفيديو أو الصوت أو playExclusive أو القص أو الصوت الخلفي.
//   * لا يلمس روابط ImageKit الموقّعة ولا منطق الوسائط ولا محرك ترتيب الرئيسية.
//   * لا يضيف أي عنصر مرئي ولا يغيّر التصميم.
//
// قيود Production التي تحكم الحمولة
// (من supabase/migrations/20261116113304_create_post_recommendation_telemetry_tables.sql):
//   * surface text not null check (surface in ('feed','reels')) — بلا افتراضي
//   * content_type text not null check (content_type in ('text','image','video'))
//   * session_id uuid not null
//   * visible_duration_ms integer not null check (between 0 and 86400000)
//   * played_duration_ms  integer not null check (between 0 and 86400000)
//   * media_duration_ms   integer null check (is null or between 1 and 86400000)
//   * completion_ratio    numeric(6,5) null check (is null or between 0 and 1)
//   * replay_count        integer not null check (between 0 and 1000)
//   * early_skip          boolean not null

import { useCallback, useEffect, useRef } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';

/** الصف كما يُرسل إلى public.post_view_events — بلا أي عمود آخر. */
type ReelImageImpression = {
  event_id: string;
  user_id: string;
  post_id: string;
  /** العمود NOT NULL في الإنتاج وبلا قيمة افتراضية: 'reels' دائماً. */
  surface: 'reels';
  /** الريل المصوّر: 'image' دائماً في هذا المسار. */
  content_type: 'image';
  session_id: string;
  visible_duration_ms: number;
  /** لا تشغيل لصورة: 0 دائماً. */
  played_duration_ms: number;
  /** لا مدة وسائط لصورة: null (القاعدة ترفض 0 في هذا العمود). */
  media_duration_ms: number | null;
  /** لا نسبة إكمال لصورة: null. */
  completion_ratio: number | null;
  replay_count: number;
  early_skip: boolean;
};

// ---------------------------------------------------------------------
// ثوابت القياس
// ---------------------------------------------------------------------

/** دقة عدّاد مدة الظهور (ms). */
const TICK_MS = 250;
/** أقصى فجوة تُحتسب في العدّاد عند تجمّد الخيط الرئيسي (ms). */
const MAX_TICK_GAP_MS = 1000;
/**
 * أدنى مدة ظهور فعلية لاعتبار الظهور انطباعاً. ما دونها يُهمل: مرور سريع أو
 * لحظة تحميل لا تُعدّ مشاهدة.
 */
const MIN_VISIBLE_MS = 500;

/** أقصى عدد أحداث في الدفعة الواحدة. */
const BATCH_MAX = 10;
/** تأخير تجميع الأحداث قبل الإرسال (ms). */
const BATCH_DELAY_MS = 2000;
/** تأخير الدفعة التالية عند بقاء أحداث معلّقة (ms). */
const DRAIN_DELAY_MS = 250;
/** تأخير إعادة المحاولة بعد فشل الإرسال (ms). */
const RETRY_DELAY_MS = 15000;
/**
 * الحد التشغيلي للطابور: عند بلوغه لا تُقبل انطباعات جديدة، ولا تُحذف معلّقة
 * أبداً. الانطباع الذي لا يُقبل لا يُخزَّن له مفتاح منع تكرار.
 */
const MAX_PENDING = 100;
/** أقصى عدد دفعات في محاولة الإرسال عند مغادرة الصفحة. */
const EXIT_MAX_BATCHES = 5;
/** ميزانية زمنية لمحاولة الإرسال عند مغادرة الصفحة (ms). */
const EXIT_BUDGET_MS = 1200;

/** حدود عمود visible_duration_ms في الإنتاج. */
const MAX_DURATION_MS = 86400000;

/**
 * مفاتيح تخزين خاصة بهذا المسار، منفصلة عن مفاتيح reelViews.ts
 * (`aani:reelview-*`) حتى لا يتداخل تتبع الفيديو والصورة.
 */
const SESSION_STORAGE_KEY = 'aani:reelimage-session-id';
const RECORDED_STORAGE_KEY = 'aani:reelimage-recorded';
const PENDING_STORAGE_KEY = 'aani:reelimage-pending';

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

/** مدة ظهور صحيحة الشكل ضمن حدود العمود (0..86400000). */
function clampDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.round(value));
}

/** عدد صحيح فعلاً (لا كسور، ولا NaN/Infinity) ضمن حدود مغلقة. */
function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * تحقق صارم من الانطباعات المستعادة من sessionStorage مقابل قيود الجدول:
 * نوع كل حقل وحدوده، لا مجرد كونه رقماً منتهياً. الحدث المخالف يُرفض ولا يُرسل.
 */
function isReelImageImpression(value: unknown): value is ReelImageImpression {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.event_id === 'string' && UUID_PATTERN.test(row.event_id)
    // user_id و post_id عمودان uuid في الإنتاج.
    && typeof row.user_id === 'string' && UUID_PATTERN.test(row.user_id)
    && typeof row.post_id === 'string' && UUID_PATTERN.test(row.post_id)
    // العمودان NOT NULL وبلا قيمة افتراضية: أي حدث مستعاد بغيرهما تالف.
    && row.surface === 'reels'
    && row.content_type === 'image'
    && typeof row.session_id === 'string' && UUID_PATTERN.test(row.session_id)
    && isIntegerWithin(row.visible_duration_ms, 0, MAX_DURATION_MS)
    && isIntegerWithin(row.played_duration_ms, 0, MAX_DURATION_MS)
    && row.media_duration_ms === null
    && row.completion_ratio === null
    && isIntegerWithin(row.replay_count, 0, 1000)
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

/** مفتاح منع التكرار: انطباع واحد لكل منشور في جلسة التصفح. */
function dedupeKeyOf(event: { session_id: string; user_id: string; post_id: string }): string {
  return `${event.session_id}:${event.user_id}:${event.post_id}`;
}

// ---------------------------------------------------------------------
// المفاتيح المسجّلة: تُضاف عند قبول الحدث في الطابور (لا عند الإرسال)، فتمنع
// أي حدث ثانٍ لنفس المنشور في الجلسة نفسها مهما أُعيد تركيب المكوّن.
// ---------------------------------------------------------------------
const recordedImpressions = new Set<string>();
let recordedLoaded = false;

function loadRecordedImpressions(): void {
  if (recordedLoaded) return;
  recordedLoaded = true;
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(RECORDED_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === 'string' && value) recordedImpressions.add(value);
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
function persistRecordedImpressions(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.sessionStorage.setItem(RECORDED_STORAGE_KEY, JSON.stringify(Array.from(recordedImpressions)));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// الطابور: انطباعات معلّقة محفوظة في sessionStorage.
// ---------------------------------------------------------------------
let pending: ReelImageImpression[] = [];
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
  loadRecordedImpressions();
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored: ReelImageImpression[] = [];
    for (const value of parsed) {
      if (!isReelImageImpression(value)) continue;
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
    void flushReelImageImpressions();
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
 * إعادة إرسال نفس event_id لا تُنشئ صفاً مكرراً لأن القيد الفريد
 * (user_id, event_id) يمنعه على الخادم. مسار DO NOTHING لا يحتاج سياسة UPDATE.
 *
 * عند الفشل تبقى الأحداث في الطابور بنفس event_id وتُعاد المحاولة لاحقاً.
 * تُعيد true فقط إذا تأكد قبول الدفعة (أو لم يبقَ شيء)، وfalse عند أي فشل —
 * وبهذا تتوقف flushReelImageImpressionsOnExit عند أول فشل.
 */
async function flushReelImageImpressions(): Promise<boolean> {
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
async function flushReelImageImpressionsOnExit(): Promise<void> {
  const startedAt = Date.now();
  for (let index = 0; index < EXIT_MAX_BATCHES; index += 1) {
    if (pending.length === 0) return;
    if (Date.now() - startedAt > EXIT_BUDGET_MS) return;
    if (flushing) return;
    // eslint-disable-next-line no-await-in-loop
    const sent = await flushReelImageImpressions();
    if (!sent) return;
    if (pending.length === 0) return;
  }
}

function installFlushListeners(): void {
  if (flushListenersInstalled || typeof window === 'undefined') return;
  flushListenersInstalled = true;
  try {
    window.addEventListener('pagehide', () => {
      void flushReelImageImpressionsOnExit();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushReelImageImpressionsOnExit();
    });
  } catch {
    // بلا مستمعين: المؤقّت وحده يكفي
  }
}

/** نتيجة محاولة قبول انطباع في الطابور. */
type EnqueueOutcome = 'accepted' | 'duplicate' | 'full' | 'unavailable';

function enqueueReelImageImpression(event: ReelImageImpression): EnqueueOutcome {
  try {
    if (!supabaseConfigured) return 'unavailable';
    loadQueue();
    const key = dedupeKeyOf(event);
    // انطباع مسجّل أو معلّق لنفس المنشور في هذه الجلسة: لا حدث ثانٍ.
    if (recordedImpressions.has(key)) return 'duplicate';
    if (pending.some(item => dedupeKeyOf(item) === key)) return 'duplicate';
    // الطابور بلغ الحد: لا نقبل ولا نخزّن مفتاح منع تكرار، ولا نحذف شيئاً.
    if (pending.length >= MAX_PENDING) {
      scheduleFlush(DRAIN_DELAY_MS);
      return 'full';
    }

    pending.push(event);
    persistPending();
    recordedImpressions.add(key);
    persistRecordedImpressions();

    installFlushListeners();
    if (pending.length >= BATCH_MAX) void flushReelImageImpressions();
    else scheduleFlush(BATCH_DELAY_MS);
    return 'accepted';
  } catch {
    // التتبع لا يكسر العرض أبداً
    return 'unavailable';
  }
}

/** هل لهذا المنشور انطباع مسجّل أو معلّق في جلسة التصفح الحالية؟ */
function hasImpressionFor(userId: string, postId: string): boolean {
  loadQueue();
  const key = `${readSessionId()}:${userId}:${postId}`;
  if (recordedImpressions.has(key)) return true;
  return pending.some(item => dedupeKeyOf(item) === key);
}

// ---------------------------------------------------------------------
// جلسة ظهور واحدة لشريحة واحدة.
// ---------------------------------------------------------------------
type ImpressionSession = {
  eventId: string;
  postId: string;
  userId: string;
  /** مدة الظهور الفعلية المتراكمة (ms). */
  visibleMs: number;
  closed: boolean;
};

/**
 * يراقب شريحة ريل مصوّرة واحدة ويُسجّل انطباعاً واحداً عند انتهاء جلستها.
 *
 * كل ما يفعله عدّاد زمني ومستمعا visibilitychange/pagehide. لا يلمس أي عنصر
 * فيديو، ولا التشغيل، ولا الصوت، ولا المراقب الموجود في ReelSlide.
 *
 * @param active الشريحة ظاهرة بنسبة 60% على الأقل (من مراقب المكوّن الحالي).
 * @param enabled false للمنشورات المؤقتة وللريلز غير المصوّرة.
 */
export function useReelImageImpression(input: {
  postId: string;
  userId: string;
  active: boolean;
  enabled: boolean;
}): void {
  const { postId, userId, active, enabled } = input;
  const sessionRef = useRef<ImpressionSession | null>(null);
  const activeRef = useRef(active);
  const enabledRef = useRef(enabled);

  /**
   * يفتح جلسة إن لم تكن مفتوحة. لا تُفتح إلا حين تكون الشريحة ظاهرة فعلاً
   * والصفحة visible ولم يكن للمنشور انطباع في هذه الجلسة — فالتحميل المسبق
   * والتركيب وحدهما لا يفتحان جلسة.
   */
  const ensureSession = useCallback((): ImpressionSession | null => {
    const existing = sessionRef.current;
    if (existing && !existing.closed) return existing;
    if (!enabledRef.current || !activeRef.current) return null;
    if (isPageHidden()) return null;
    if (!userId || !postId) return null;
    if (hasImpressionFor(userId, postId)) return null;
    const session: ImpressionSession = {
      eventId: randomUuid(),
      postId,
      userId,
      visibleMs: 0,
      closed: false,
    };
    sessionRef.current = session;
    return session;
  }, [postId, userId]);

  /** يغلق الجلسة الحالية ويحوّلها إلى انطباع واحد في الطابور إن استحق. */
  const closeSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.closed) return;
    session.closed = true;
    sessionRef.current = null;

    const visibleMs = clampDurationMs(session.visibleMs);
    // ظهور أقصر من الحد الأدنى لا يُرسل: ليس مشاهدة.
    if (visibleMs < MIN_VISIBLE_MS) return;

    enqueueReelImageImpression({
      event_id: session.eventId,
      user_id: session.userId,
      post_id: session.postId,
      surface: 'reels',
      content_type: 'image',
      session_id: readSessionId(),
      visible_duration_ms: visibleMs,
      played_duration_ms: 0,
      media_duration_ms: null,
      completion_ratio: null,
      replay_count: 0,
      early_skip: false,
    });
  }, []);

  // الخروج من الظهور أو تعطيل الشريحة يُغلق الجلسة فوراً.
  useEffect(() => {
    activeRef.current = active;
    enabledRef.current = enabled;
    if (!active || !enabled) closeSession();
  }, [active, enabled, closeSession]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    // عدّاد مدة الظهور: زمن حائطي فقط، والصفحة visible، والشريحة ظاهرة.
    let lastTickAt = Date.now();
    const tick = () => {
      const now = Date.now();
      // الفجوة تُقصّ حتى لا يُضاف زمن تجمّد الخيط الرئيسي.
      const gap = Math.min(now - lastTickAt, MAX_TICK_GAP_MS);
      lastTickAt = now;
      const session = ensureSession();
      if (!session) return;
      session.visibleMs += gap;
    };
    const ticker = window.setInterval(tick, TICK_MS);

    const onVisibilityChange = () => {
      if (!isPageHidden()) {
        // العودة للظهور: العدّاد يستأنف من نفسه في الدورة التالية.
        lastTickAt = Date.now();
        return;
      }
      // إخفاء الصفحة: لا تُحتسب مدة الإخفاء، وتُغلق الجلسة بأفضل محاولة حفظ.
      closeSession();
      void flushReelImageImpressionsOnExit();
    };
    const onPageHide = () => {
      closeSession();
      void flushReelImageImpressionsOnExit();
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
      // مغادرة الشريحة: أغلق الجلسة وابنِ الانطباع.
      closeSession();
      void flushReelImageImpressionsOnExit();
    };
  }, [closeSession, ensureSession]);
}
