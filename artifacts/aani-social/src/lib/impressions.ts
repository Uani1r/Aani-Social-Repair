// تتبع صامت لظهور المنشورات في الـFeed الرئيسي (المرحلة الثانية من خوارزمية آني).
//
// القاعدة: بطاقة المنشور تُحتسب Impression واحداً عندما يظهر 50% منها على الأقل
// داخل نافذة العرض مدةً متصلة قدرها 500ms، مرة واحدة لكل منشور في جلسة التصفح
// الحالية. إن انخفضت النسبة قبل اكتمال المدة تُلغى المحاولة ويُعاد القياس عند
// ظهور البطاقة مجدداً.
//
// ما لا يفعله هذا الملف:
//   * لا يغيّر ترتيب المنشورات ولا استعلامات usePosts، ولا يعرض أي عنصر مرئي.
//   * لا يرسل محتوى المنشور ولا أي بيانات حساسة: الحمولة هي الأعمدة السبعة
//     المطلوبة فقط (event_id, user_id, post_id, surface, content_type,
//     session_id) و impression_at يتركه الخادم على قيمته الافتراضية.
//   * لا يعطّل العرض أو التفاعل عند الفشل: كل شيء محمي، وفشل الإرسال يبقي
//     الأحداث في الطابور لإعادة المحاولة بنفس event_id.
//   * منطق الصوت في FeedPostCard مستقل تماماً ولا علاقة له بهذا الملف.

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
/** تأخير إعادة المحاولة بعد فشل الإرسال (ms). */
const RETRY_DELAY_MS = 15000;
/** سقف الطابور: لا ينمو بلا حدّ إن طال انقطاع الشبكة. */
const MAX_QUEUE = 100;
/** سقف قائمة المنشورات المسجّلة في الجلسة داخل sessionStorage. */
const MAX_RECORDED = 500;

const SESSION_STORAGE_KEY = 'aani:impression-session-id';
const RECORDED_STORAGE_KEY = 'aani:impression-recorded';

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

// ---------------------------------------------------------------------
// منع التكرار: (الجلسة + المستخدم + المنشور) تُسجَّل مرة واحدة فقط، في الذاكرة
// لتصمد أمام إعادة تركيب مكوّنات React، وفي sessionStorage لتصمد أمام إعادة
// تحميل الصفحة داخل نفس الجلسة.
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

function markRecorded(key: string): void {
  recordedImpressions.add(key);
  if (typeof window === 'undefined') return;
  try {
    const list = Array.from(recordedImpressions).slice(-MAX_RECORDED);
    window.sessionStorage.setItem(RECORDED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // التخزين ممتلئ أو غير متاح: الذاكرة وحدها تكفي لهذه الصفحة
  }
}

// ---------------------------------------------------------------------
// EventBatcher: طابور مستقل يجمّع الأحداث ويرسلها على دفعات.
// ---------------------------------------------------------------------
let queue: ImpressionEvent[] = [];
let flushTimer: number | null = null;
let flushing = false;
let flushListenersInstalled = false;

function scheduleFlush(delay: number): void {
  if (typeof window === 'undefined') return;
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushImpressions();
  }, delay);
}

function installFlushListeners(): void {
  if (flushListenersInstalled || typeof window === 'undefined') return;
  flushListenersInstalled = true;
  try {
    // مغادرة الصفحة أو إخفاؤها: محاولة إرسال ما تبقّى بدل انتظار المؤقّت.
    window.addEventListener('pagehide', () => {
      void flushImpressions();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushImpressions();
    });
  } catch {
    // بلا مستمعين: المؤقّت وحده يكفي
  }
}

/**
 * إرسال دفعة واحدة. عند النجاح تُحذف أحداثها من الطابور، وعند الفشل تبقى
 * كما هي بنفس event_id لتُعاد المحاولة.
 *
 * upsert مع ignoreDuplicates: الإرسال المكرر لنفس event_id (بعد مهلة وصل
 * طلبها فعلاً) لا يُفشل الدفعة، لأن القيد الفريد (user_id, event_id) يمنع
 * التكرار على الخادم. مسار DO NOTHING لا يحتاج سياسة UPDATE.
 */
async function flushImpressions(): Promise<void> {
  if (flushing || !supabaseConfigured || queue.length === 0) return;
  flushing = true;
  const batch = queue.slice(0, BATCH_MAX);
  try {
    const { error } = await supabase
      .from('post_impressions')
      .upsert(batch, { onConflict: 'user_id,event_id', ignoreDuplicates: true });
    if (error) {
      scheduleFlush(RETRY_DELAY_MS);
      return;
    }
    const sentEventIds = new Set(batch.map(event => event.event_id));
    queue = queue.filter(event => !sentEventIds.has(event.event_id));
    if (queue.length > 0) scheduleFlush(BATCH_DELAY_MS);
  } catch {
    scheduleFlush(RETRY_DELAY_MS);
  } finally {
    flushing = false;
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

    loadRecordedImpressions();
    const sessionId = readSessionId();
    const key = `${sessionId}:${input.userId}:${input.postId}`;
    if (recordedImpressions.has(key)) return;
    markRecorded(key);

    queue.push({
      event_id: randomUuid(),
      user_id: input.userId,
      post_id: input.postId,
      surface: 'feed',
      content_type: input.contentType,
      session_id: sessionId,
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);

    installFlushListeners();
    if (queue.length >= BATCH_MAX) void flushImpressions();
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
  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  let observer: IntersectionObserver | null = null;
  try {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= MIN_VISIBLE_RATIO) {
          // بدء العدّ إن لم يكن جارياً؛ ظهور متكرر لا يُعيد تصفير المؤقّت.
          if (timer === null) {
            timer = window.setTimeout(() => {
              timer = null;
              // الصفحة المخفية ليست ظهوراً حقيقياً للمستخدم.
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
              enqueueImpression(input);
            }, MIN_VISIBLE_MS);
          }
        } else {
          // انخفضت النسبة قبل اكتمال المدة: إلغاء المحاولة وإعادة القياس لاحقاً.
          clearTimer();
        }
      }
    }, { threshold: [0, MIN_VISIBLE_RATIO, 1] });
    observer.observe(element);
  } catch {
    return () => undefined;
  }

  if (!observer) return () => undefined;
  const activeObserver = observer;
  return () => {
    clearTimer();
    try {
      activeObserver.disconnect();
    } catch {
      // لا شيء
    }
  };
}
