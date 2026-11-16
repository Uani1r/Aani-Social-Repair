// تتبع صامت لظهور المنشورات في الـFeed الرئيسي (المرحلة الثانية من خوارزمية آني).
//
// القاعدة: بطاقة المنشور تُحتسب Impression واحداً عندما يظهر 50% منها على الأقل
// داخل نافذة العرض مدةً متصلة قدرها 500ms، مرة واحدة لكل منشور في جلسة التصفح
// الحالية. إن انخفضت النسبة قبل اكتمال المدة تُلغى المحاولة ويُعاد القياس عند
// ظهور البطاقة مجدداً.
//
// ما لا يفعله هذا الملف:
//   * لا يغيّر ترتيب المنشورات ولا استعلامات usePosts، ولا يعرض أي عنصر مرئي.
//   * لا يرسل محتوى المنشور ولا أي بيانات حساسة: الحمولة هي الأعمدة الستة
//     المطلوبة فقط (event_id, user_id, post_id, surface, content_type,
//     session_id) و impression_at يتركه الخادم على قيمته الافتراضية.
//   * لا يعطّل العرض أو التفاعل عند الفشل: كل شيء محمي، وفشل الإرسال يبقي
//     الأحداث معلّقة بنفس event_id.
//   * منطق الصوت في FeedPostCard مستقل تماماً ولا علاقة له بهذا الملف.
//
// حالتان منفصلتان تماماً لكل حدث:
//   * معلّق (pending): في الطابور ولم يُؤكَّد إرساله بعد. محفوظ في sessionStorage
//     حتى لا يضيع عند إعادة تحميل الصفحة.
//   * مسجَّل (recorded): أُرسل بنجاح. عندها فقط يُضاف مفتاح منع التكرار.
// لا يُعتبر المنشور مسجَّلاً بمجرد إضافته إلى الطابور.

import { supabase, supabaseConfigured } from '@/lib/supabase';

export type ImpressionContentType = 'text' | 'image' | 'video';

/** الصف كما يُرسل إلى public.post_impressions — بلا impression_at (افتراضي الخادم). */
type ImpressionEvent = {
  event_id: string;
  user_id: string;
  post_id: string;
  surface: 'feed';
  content_type: ImpressionContentType;
  session_id: string;
};

/** نسبة البطاقة التي يجب أن تكون ظاهرة داخل نافذة العرض. */
const MIN_VISIBLE_RATIO = 0.5;
/** المدة المتصلة المطلوبة قبل الاحتساب (ms). */
const MIN_VISIBLE_MS = 500;
/** أقصى عدد أحداث في الدفعة الواحدة. */
const BATCH_MAX = 10;
/** تأخير تجميع الأحداث قبل الإرسال (ms). */
const BATCH_DELAY_MS = 2000;
/** تأخير الدفعة التالية عند وجود أحداث معلّقة متبقية (ms). */
const DRAIN_DELAY_MS = 250;
/** تأخير إعادة المحاولة بعد فشل الإرسال (ms). */
const RETRY_DELAY_MS = 15000;
/**
 * سقف الأحداث المعلّقة. عند بلوغه لا تُقبل أحداث جديدة ولا تُحذف معلّقة:
 * الأحداث المعلّقة لا تُمحى أبداً، والحدث الذي لم يُقبل لا يُخزَّن له مفتاح
 * منع تكرار، فيمكن احتسابه لاحقاً بعد أن يفرغ الطابور.
 */
const MAX_PENDING = 100;
/** سقف قائمة المنشورات المسجّلة في الجلسة داخل sessionStorage. */
const MAX_RECORDED = 500;
/** أقصى عدد دفعات في محاولة الإرسال عند مغادرة الصفحة. */
const EXIT_MAX_BATCHES = 5;
/** ميزانية زمنية لمحاولة الإرسال عند مغادرة الصفحة (ms). */
const EXIT_BUDGET_MS = 1200;

const SESSION_STORAGE_KEY = 'aani:impression-session-id';
const RECORDED_STORAGE_KEY = 'aani:impression-recorded';
const PENDING_STORAGE_KEY = 'aani:impression-pending';

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

function isImpressionEvent(value: unknown): value is ImpressionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.event_id === 'string' && UUID_PATTERN.test(row.event_id)
    && typeof row.user_id === 'string' && row.user_id.length > 0
    && typeof row.post_id === 'string' && row.post_id.length > 0
    && row.surface === 'feed'
    && (row.content_type === 'text' || row.content_type === 'image' || row.content_type === 'video')
    && typeof row.session_id === 'string' && UUID_PATTERN.test(row.session_id);
}

// ---------------------------------------------------------------------
// معرّف الجلسة: ثابت طوال جلسة التصفح الحالية (sessionStorage)، ويُولَّد
// احتياطياً في الذاكرة حين لا يتوفر التخزين أو في بيئة بلا window.
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

function dedupeKeyOf(event: { session_id: string; user_id: string; post_id: string }): string {
  return `${event.session_id}:${event.user_id}:${event.post_id}`;
}

// ---------------------------------------------------------------------
// المسجَّل: من تأكد إرساله فقط. في الذاكرة لتصمد أمام إعادة تركيب مكوّنات
// React، وفي sessionStorage لتصمد أمام إعادة تحميل الصفحة في نفس الجلسة.
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

function persistRecordedImpressions(): void {
  if (typeof window === 'undefined') return;
  try {
    const list = Array.from(recordedImpressions).slice(-MAX_RECORDED);
    window.sessionStorage.setItem(RECORDED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // التخزين ممتلئ أو غير متاح: الذاكرة وحدها تكفي لهذه الصفحة
  }
}

/** يُضاف المفتاح بعد نجاح الإرسال فقط — لا عند الإضافة إلى الطابور. */
function markRecorded(events: ImpressionEvent[]): void {
  for (const event of events) recordedImpressions.add(dedupeKeyOf(event));
  persistRecordedImpressions();
}

// ---------------------------------------------------------------------
// EventBatcher: طابور الأحداث المعلّقة، محفوظ في sessionStorage.
// ---------------------------------------------------------------------
let pending: ImpressionEvent[] = [];
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

/** استعادة الأحداث المعلّقة بعد إعادة تحميل الصفحة، بنفس event_id. */
function loadPending(): void {
  if (pendingLoaded) return;
  pendingLoaded = true;
  loadRecordedImpressions();
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored: ImpressionEvent[] = [];
    for (const value of parsed) {
      if (!isImpressionEvent(value)) continue;
      // حدث أُرسل فعلاً في جلسة سابقة لنفس التبويب: لا يُعاد إرساله.
      if (recordedImpressions.has(dedupeKeyOf(value))) continue;
      restored.push(value);
    }
    pending = restored.slice(0, MAX_PENDING);
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
  // أثناء إرسال جارٍ: من يكمل الإرسال هو من يجدول الدفعة التالية، فلا مؤقّت
  // يجدول نفسه مرتين.
  if (flushing) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushImpressions();
  }, delay);
}

function isHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

/**
 * إرسال دفعة واحدة بحجم BATCH_MAX على الأكثر.
 *
 * عند النجاح: تُحذف أحداث الدفعة من المعلّق، وتُضاف مفاتيحها إلى المسجَّل
 * (وهذه هي اللحظة الوحيدة التي يُعتبر فيها الحدث مسجَّلاً)، ثم تُجدول الدفعة
 * التالية فوراً إن بقي شيء.
 *
 * عند الفشل: تبقى الأحداث كما هي بنفس event_id وتُعاد المحاولة لاحقاً.
 *
 * upsert مع ignoreDuplicates: إعادة إرسال نفس event_id (بعد مهلة وصل طلبها
 * فعلاً) لا تُفشل الدفعة، لأن القيد الفريد (user_id, event_id) يمنع التكرار
 * على الخادم. مسار DO NOTHING لا يحتاج سياسة UPDATE.
 */
async function flushImpressions(): Promise<void> {
  if (flushing || !supabaseConfigured) return;
  loadPending();
  if (pending.length === 0) return;
  flushing = true;
  const batch = pending.slice(0, BATCH_MAX);
  /** التأخير المطلوب بعد نهاية المحاولة (null = لا جدولة). */
  let nextDelay: number | null = null;
  try {
    const { error } = await supabase
      .from('post_impressions')
      .upsert(batch, { onConflict: 'user_id,event_id', ignoreDuplicates: true });
    if (error) {
      nextDelay = RETRY_DELAY_MS;
    } else {
      const sentEventIds = new Set(batch.map(event => event.event_id));
      pending = pending.filter(event => !sentEventIds.has(event.event_id));
      persistPending();
      markRecorded(batch);
      // أحداث معلّقة متبقية: تُرسل في دفعة تالية قريبة بحدود BATCH_MAX.
      if (pending.length > 0) nextDelay = DRAIN_DELAY_MS;
    }
  } catch {
    nextDelay = RETRY_DELAY_MS;
  } finally {
    flushing = false;
  }
  // الجدولة بعد إنهاء الإرسال: scheduleFlush لا يجدول أثناء flushing.
  if (nextDelay !== null) scheduleFlush(nextDelay);
}

/**
 * محاولة إرسال عند مغادرة الصفحة أو إخفائها: دفعات متتالية ضمن ميزانية
 * زمنية قصيرة. أفضل محاولة ممكنة فقط — لا ضمان تسليم عند إغلاق المتصفح،
 * والمعلّق يبقى محفوظاً في sessionStorage ليُرسل عند العودة.
 */
async function flushOnExit(): Promise<void> {
  const startedAt = Date.now();
  for (let index = 0; index < EXIT_MAX_BATCHES; index += 1) {
    if (pending.length === 0) return;
    if (Date.now() - startedAt > EXIT_BUDGET_MS) return;
    if (flushing) return;
    // eslint-disable-next-line no-await-in-loop
    await flushImpressions();
    if (pending.length === 0) return;
  }
}

function installFlushListeners(): void {
  if (flushListenersInstalled || typeof window === 'undefined') return;
  flushListenersInstalled = true;
  try {
    window.addEventListener('pagehide', () => {
      void flushOnExit();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushOnExit();
    });
  } catch {
    // بلا مستمعين: المؤقّت وحده يكفي
  }
}

function enqueueImpression(input: {
  userId: string;
  postId: string;
  contentType: ImpressionContentType;
}): void {
  try {
    if (!input.userId || !input.postId) return;
    if (!supabaseConfigured) return;

    loadPending();
    const sessionId = readSessionId();
    const key = `${sessionId}:${input.userId}:${input.postId}`;
    // مسجَّل سابقاً: لا تكرار.
    if (recordedImpressions.has(key)) return;
    // معلّق بالفعل: لا حدث ثانٍ لنفس المنشور، ولا يُفقد الأول.
    if (pending.some(event => dedupeKeyOf(event) === key)) return;
    // الطابور ممتلئ: لا نقبل حدثاً جديداً (ولا نخزّن له مفتاح منع تكرار)،
    // ولا نحذف شيئاً من المعلّق. يمكن احتسابه لاحقاً بعد أن يفرغ الطابور.
    if (pending.length >= MAX_PENDING) {
      scheduleFlush(RETRY_DELAY_MS);
      return;
    }

    pending.push({
      event_id: randomUuid(),
      user_id: input.userId,
      post_id: input.postId,
      surface: 'feed',
      content_type: input.contentType,
      session_id: sessionId,
    });
    persistPending();

    installFlushListeners();
    if (pending.length >= BATCH_MAX) void flushImpressions();
    else scheduleFlush(BATCH_DELAY_MS);
  } catch {
    // التتبع لا يكسر العرض أبداً
  }
}

/** نوع المحتوى المسجَّل حسب نوع المنشور المخزَّن. */
export function impressionContentTypeForPost(type: string | null | undefined): ImpressionContentType {
  if (type === 'photo') return 'image';
  if (type === 'reel') return 'video';
  return 'text';
}

/**
 * يراقب بطاقة منشور واحدة ويُسجّل Impression واحداً عند ظهور 50% منها على
 * الأقل مدة 500ms متصلة. يُعيد دالة تنظيف تُلغي المؤقّت والمراقب.
 *
 * إخفاء الصفحة: يُوقف المؤقّت فوراً وتُلغى المحاولة غير المكتملة، فلا تُحتسب
 * أي مدة قضاها التبويب مخفياً. عند العودة إلى visible يُعاد تقييم آخر نسبة
 * معروفة للبطاقة، ويبدأ عدّ جديد 500ms فقط إذا كانت النسبة لا تقل عن 50%.
 *
 * يُستدعى فقط من FeedPostCard للبطاقات ضمن الـFeed الرئيسي، ولا يُستدعى
 * للمنشورات المؤقتة (Pending) التي لم تُنشر فعلياً.
 */
export function observeFeedImpression(
  element: Element | null,
  input: { userId: string; postId: string; contentType: ImpressionContentType },
): () => void {
  if (!element) return () => undefined;
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return () => undefined;
  if (!input.userId || !input.postId) return () => undefined;

  let timer: number | null = null;
  /** آخر نسبة ظهور معروفة للبطاقة — تُستخدم عند العودة من الإخفاء. */
  let lastRatio = 0;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const startTimer = () => {
    if (timer !== null) return;
    if (isHidden()) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (isHidden()) return;
      enqueueImpression(input);
    }, MIN_VISIBLE_MS);
  };

  const applyRatio = (ratio: number) => {
    lastRatio = ratio;
    if (ratio >= MIN_VISIBLE_RATIO) startTimer();
    else clearTimer();
  };

  let observer: IntersectionObserver | null = null;
  try {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        applyRatio(entry.isIntersecting ? entry.intersectionRatio : 0);
      }
    }, { threshold: [0, MIN_VISIBLE_RATIO, 1] });
    observer.observe(element);
  } catch {
    return () => undefined;
  }

  const onVisibilityChange = () => {
    if (isHidden()) {
      // إخفاء الصفحة: إلغاء المحاولة الجارية، فلا تُحتسب مدة الإخفاء.
      clearTimer();
      return;
    }
    // العودة للظهور: إعادة تقييم بآخر نسبة معروفة، وعدّ جديد كامل.
    applyRatio(lastRatio);
  };

  try {
    document.addEventListener('visibilitychange', onVisibilityChange);
  } catch {
    // بلا مستمع: المراقب وحده يعمل، والمؤقّت يُلغى عند أول حدث لاحق
  }

  if (!observer) return () => undefined;
  const activeObserver = observer;
  return () => {
    clearTimer();
    try {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    } catch {
      // لا شيء
    }
    try {
      activeObserver.disconnect();
    } catch {
      // لا شيء
    }
  };
}
