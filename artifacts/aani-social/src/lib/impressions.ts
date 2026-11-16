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
//     حتى لا يضيع عند إعادة تحميل الصفحة، وكل حدث صحيح مستعاد يبقى بلا قصّ
//     ويُرسل تدريجياً على دفعات لا تتجاوز عشرة أحداث.
//   * مسجَّل (recorded): أُرسل بنجاح. عندها فقط يُضاف مفتاح منع التكرار، ويبقى
//     هذا المفتاح طوال جلسة التصفح الحالية بلا سقف يحذفه.
//   * إن تعذّر حفظ المسجَّل في sessionStorage لا يُحذف الحدث من الطابور: يبقى
//     معلّقاً بنفس event_id وتُعاد المحاولة لاحقاً. إعادة إرسال نفس event_id
//     آمنة بفضل القيد الفريد (user_id, event_id)، ولا يُدَّعى منع تكرار بعد
//     إعادة التحميل حين يكون التخزين غير متاح.
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
 * الحد التشغيلي للأحداث المعلّقة: عند بلوغه لا تُقبل أحداث جديدة ولا تُحذف
 * معلّقة أبداً. الأحداث المستعادة من التخزين تبقى كلها ولو تجاوزت هذا الحد،
 * وتُرسل تدريجياً على دفعات لا تتجاوز BATCH_MAX.
 */
const MAX_PENDING = 100;
/** أقصى عدد دفعات في محاولة الإرسال عند مغادرة الصفحة. */
const EXIT_MAX_BATCHES = 5;
/** ميزانية زمنية لمحاولة الإرسال عند مغادرة الصفحة (ms). */
const EXIT_BUDGET_MS = 1200;
/** إعادة محاولة قبول Impression رُفض لأن الطابور ممتلئ (ms). */
const FULL_RETRY_MS = 5000;

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

/**
 * حفظ قائمة المسجَّل في sessionStorage.
 *
 * تُعيد true فقط إذا تأكدت الكتابة فعلاً. عند false لا يكون الحفظ قد تمّ،
 * والمستدعي مسؤول عن عدم حذف الأحداث من الطابور وعن إعادة المحاولة لاحقاً.
 * كل المفاتيح المسجّلة في هذه الجلسة تُكتب بلا سقف: قصّها كان يعيد السماح
 * بتسجيل المنشور نفسه مرة أخرى في نفس الجلسة.
 *
 * التخزين غير متاح (امتلاء أو وضع خاص أو بيئة بلا window): تُعيد false،
 * فتبقى المفاتيح في الذاكرة لهذه الصفحة فقط — **ولا يُدَّعى منع تكرار بعد
 * إعادة التحميل في هذه الحالة**.
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

/**
 * يُضيف مفاتيح الأحداث المسجَّلة بعد نجاح الإرسال فقط — لا عند الإضافة إلى
 * الطابور — ويُعيد نتيجة حفظها في التخزين. الإضافة إلى الذاكرة تتم دائماً،
 * لأن الخادم قبل الأحداث فعلاً، فمنع التكرار داخل هذه الصفحة يبقى قائماً.
 */
function markRecorded(events: ImpressionEvent[]): boolean {
  for (const event of events) recordedImpressions.add(dedupeKeyOf(event));
  return persistRecordedImpressions();
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
 * ترتيب الحفظ عند النجاح مقصود، ولا يُحذف شيء من الطابور إلا بعد تأكد حفظ
 * المسجَّل:
 *   1) تُضاف مفاتيح أحداث الدفعة إلى المسجَّل وتُحفظ في sessionStorage.
 *   2) إن تأكد الحفظ فقط: تُحذف أحداث الدفعة من المعلّق ويُحفظ الطابور.
 * إن فشل حفظ المسجَّل (امتلاء أو تعذّر الوصول): لا حذف من الطابور ولا حفظ له،
 * وتبقى الأحداث معلّقة **بنفس event_id** وتُعاد المحاولة لاحقاً. إعادة إرسال
 * نفس event_id آمنة لأن القيد الفريد (user_id, event_id) يمنع التكرار.
 * في هذه الحالة لا يُدَّعى منع تكرار بعد إعادة التحميل: المفاتيح في الذاكرة
 * وحدها لهذه الصفحة.
 *
 * عند الفشل: تبقى الأحداث كما هي بنفس event_id وتُعاد المحاولة لاحقاً.
 *
 * upsert مع ignoreDuplicates: إعادة إرسال نفس event_id (بعد مهلة وصل طلبها
 * فعلاً) لا تُفشل الدفعة، لأن القيد الفريد (user_id, event_id) يمنع التكرار
 * على الخادم. مسار DO NOTHING لا يحتاج سياسة UPDATE.
 *
 * تُعيد true فقط إذا تأكد قبول الدفعة من الخادم **وحُفظت مفاتيحها بنجاح**
 * (أو لم يبقَ شيء لإرساله)، وfalse عند أي فشل أو تعذّر حفظ — وبهذا يتوقف
 * flushOnExit عند أول فشل.
 */
async function flushImpressions(): Promise<boolean> {
  if (flushing || !supabaseConfigured) return false;
  loadPending();
  if (pending.length === 0) return true;
  flushing = true;
  const batch = pending.slice(0, BATCH_MAX);
  /** التأخير المطلوب بعد نهاية المحاولة (null = لا جدولة). */
  let nextDelay: number | null = null;
  /** هل تأكد قبول الدفعة وحفظ حالتها فعلاً؟ */
  let sent = false;
  try {
    const { error } = await supabase
      .from('post_impressions')
      .upsert(batch, { onConflict: 'user_id,event_id', ignoreDuplicates: true });
    if (error) {
      nextDelay = RETRY_DELAY_MS;
    } else if (markRecorded(batch)) {
      // تأكد حفظ المسجَّل: عندها فقط تُحذف أحداث الدفعة من المعلّق ويُحفظ الطابور.
      const sentEventIds = new Set(batch.map(event => event.event_id));
      pending = pending.filter(event => !sentEventIds.has(event.event_id));
      persistPending();
      sent = true;
      // أحداث معلّقة متبقية: تُرسل في دفعة تالية قريبة بحدود BATCH_MAX.
      if (pending.length > 0) nextDelay = DRAIN_DELAY_MS;
    } else {
      // فشل حفظ المسجَّل: لا حذف من الطابور ولا حفظ له، والأحداث تبقى معلّقة
      // بنفس event_id. إعادة إرسالها لاحقاً آمنة بسبب القيد الفريد
      // (user_id, event_id)، وevent_id لا يُعاد توليده أبداً.
      nextDelay = RETRY_DELAY_MS;
    }
  } catch {
    nextDelay = RETRY_DELAY_MS;
  } finally {
    flushing = false;
  }
  // الجدولة بعد إنهاء الإرسال: scheduleFlush لا يجدول أثناء flushing.
  if (nextDelay !== null) scheduleFlush(nextDelay);
  return sent;
}

/**
 * محاولة إرسال عند مغادرة الصفحة أو إخفائها: دفعات متتالية ضمن ميزانية
 * زمنية قصيرة، وتتوقف **عند أول فشل** فلا تتكرر الطلبات الفاشلة فوراً.
 * لا تُرسل الدفعة التالية إلا إذا تأكد قبول السابقة، وضمن حدود الخروج نفسها
 * (EXIT_MAX_BATCHES و EXIT_BUDGET_MS).
 * الأحداث التي لم تُقبل (أو لم تُحفظ حالتها) تبقى معلّقة بنفس event_id في
 * sessionStorage، لتُرسل عند العودة أو بعد مهلة إعادة المحاولة العادية.
 * أفضل محاولة ممكنة فقط — لا ضمان تسليم عند إغلاق المتصفح.
 */
async function flushOnExit(): Promise<void> {
  const startedAt = Date.now();
  for (let index = 0; index < EXIT_MAX_BATCHES; index += 1) {
    if (pending.length === 0) return;
    if (Date.now() - startedAt > EXIT_BUDGET_MS) return;
    if (flushing) return;
    // eslint-disable-next-line no-await-in-loop
    const sent = await flushImpressions();
    // فشل الدفعة: توقّف الآن — الباقي يُترك لإعادة المحاولة العادية، لا طلبات
    // فاشلة متتالية.
    if (!sent) return;
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

/** نتيجة محاولة قبول Impression في الطابور. */
type EnqueueOutcome =
  /** قُبل فعلاً وصار معلّقاً. */
  | 'accepted'
  /** مسجَّل سابقاً أو معلّق بالفعل: لا تكرار. */
  | 'duplicate'
  /** الطابور بلغ الحد التشغيلي: لم يُقبل، ولم يُخزَّن له مفتاح منع تكرار. */
  | 'full'
  /** التتبع غير متاح (لا عميل Supabase أو مدخلات ناقصة). */
  | 'unavailable';

function enqueueImpression(input: {
  userId: string;
  postId: string;
  contentType: ImpressionContentType;
}): EnqueueOutcome {
  try {
    if (!input.userId || !input.postId) return 'unavailable';
    if (!supabaseConfigured) return 'unavailable';

    loadPending();
    const sessionId = readSessionId();
    const key = `${sessionId}:${input.userId}:${input.postId}`;
    // مسجَّل سابقاً: لا تكرار.
    if (recordedImpressions.has(key)) return 'duplicate';
    // معلّق بالفعل: لا حدث ثانٍ لنفس المنشور، ولا يُفقد الأول.
    if (pending.some(event => dedupeKeyOf(event) === key)) return 'duplicate';
    // الطابور بلغ الحد: لا نقبل الحدث ولا نخزّن له مفتاح منع تكرار، ولا نحذف
    // شيئاً من المعلّق. يُعاد الاحتساب لاحقاً ما دامت البطاقة ظاهرة.
    if (pending.length >= MAX_PENDING) {
      scheduleFlush(DRAIN_DELAY_MS);
      return 'full';
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
    return 'accepted';
  } catch {
    // التتبع لا يكسر العرض أبداً
    return 'unavailable';
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
  /** مؤقّت إعادة المحاولة بعد رفض الطابور الممتلئ. */
  let retryTimer: number | null = null;
  /** آخر نسبة ظهور معروفة للبطاقة — تُستخدم عند العودة من الإخفاء. */
  let lastRatio = 0;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  /**
   * محاولة قبول الاحتساب. إن رفض الطابورُ الممتلئ الحدث، يُعاد التخطيط لمحاولة
   * أخرى ما دامت البطاقة لا تزال مستوفية شرط الظهور ولم تُصبح الصفحة مخفية —
   * فلا يُفقد Impression بعد انتهاء 500ms بسبب الامتلاء وحده.
   */
  const attempt = () => {
    if (isHidden() || lastRatio < MIN_VISIBLE_RATIO) return;
    if (enqueueImpression(input) === 'full') scheduleRetry();
  };

  const scheduleRetry = () => {
    if (retryTimer !== null || typeof window === 'undefined') return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      attempt();
    }, FULL_RETRY_MS);
  };

  const startTimer = () => {
    if (timer !== null) return;
    if (isHidden()) return;
    timer = window.setTimeout(() => {
      timer = null;
      attempt();
    }, MIN_VISIBLE_MS);
  };

  const applyRatio = (ratio: number) => {
    lastRatio = ratio;
    if (ratio >= MIN_VISIBLE_RATIO) {
      startTimer();
    } else {
      clearTimer();
      clearRetryTimer();
    }
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
      // إخفاء الصفحة: إلغاء المحاولة الجارية وإعادة المحاولة المعلّقة، فلا
      // تُحتسب مدة الإخفاء ولا يُحاول القبول والصفحة مخفية.
      clearTimer();
      clearRetryTimer();
      return;
    }
    // العودة للظهور: إعادة تقييم بآخر نسبة معروفة، وعدّ جديد كامل.
    clearRetryTimer();
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
    clearRetryTimer();
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
