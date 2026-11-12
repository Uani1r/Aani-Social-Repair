// طابور موثوق لتسجيل روابط الوسائط المرفوعة في سجل الرفع الخادمي (Upload Ledger).
//
// الرفع يتم مباشرة من الجهاز إلى ImageKit؛ الخادم لا يرى الملف إلا إذا أخبرناه.
// fire-and-forget وحده يُفوّت التسجيل عند انقطاع الشبكة أو إغلاق التطبيق لحظة
// نجاح الرفع، فيتحول الملف إلى "يتيم" قد يُكنس لاحقاً رغم استخدامه. الضمان هنا:
//
// 1) محاولة فورية بعد الرفع؛ وعند فشلها يُخزَّن الرابط في سلسلة تخزين مرنة:
//    IndexedDB → localStorage → الذاكرة. فشل فتح IndexedDB أو فشل أي عملية
//    كتابة فيه يُنتقل بعدها تلقائياً إلى التخزين التالي (وليس صمتاً) — وكل
//    تراجع يُعلن بتحذير واضح في الـ console.
// 2) الإدخال مفتاحه الرابط نفسه (upsert idempotent) — التكرار لا يضاعف السجل،
//    والخادم أيضاً يمنع التكرار عبر unique(media_url).
// 3) إعادة إرسال تلقائية عند أربعة محفزات: الموعد المستحق (setTimeout)،
//    عودة الاتصال (online)، عودة التطبيق للواجهة (visibilitychange)،
//    وتسجيل الدخول/الإقلاع (من useAppSession).
// 4) الدفعات متسلسلة: إن بقي عدد مستحق أكبر من حجم الدفعة (20) تُعالج دفعة
//    تلو الأخرى داخل نفس الاستدعاء — لا يبقى شيء معلقاً حتى حدث خارجي جديد.
// 5) السجل لا يُعد ناجحاً ويُحذف من الطابور إلا بعد تأكيد الخادم صراحةً
//    (HTTP 2xx). الإدخالات لا تُسقط أبداً مهما عددت المحاولات — Backoff
//    أُسّي يسقف عند 6 ساعات والمحاولة تستمر إلى الأبد.
// 6) صافي الشبكة الثاني: كنس اليتامى الخادمي (Orphan Sweep) يعيد فحص كل
//    المراجع الحية قبل حذف أي ملف أصلاً — فقدان محتمل للسجل لا يعني حذفاً.
//
// فشل التسجيل لا يفشل الرفع أبداً — الدوال هنا تبتلع أخطائها داخلياً (مع تحذير).

import { supabase } from '@/lib/supabase';

const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000; // سقف الـ Backoff: 6 ساعات
const BASE_RETRY_DELAY_MS = 30 * 1000;
const FLUSH_BATCH = 20;
const MAX_FLUSH_CYCLES = 10; // 10 دفعات × 20 = 200 إدخال كحد أقصى لكل استدعاء
const MAX_SINGLE_TIMER_MS = 60 * 60 * 1000; // أطول مؤقت استحقاق (يُعاد جدولته لاحقاً)

export type PendingLedgerEntry = {
  url: string;
  attempts: number;
  nextAttemptAt: number;
  queuedAt: number;
};

export interface LedgerStore {
  getAll(): Promise<PendingLedgerEntry[]>;
  put(entry: PendingLedgerEntry): Promise<void>;
  delete(url: string): Promise<void>;
}

/** Backoff أُسّي بسقف 6 ساعات — الإدخال لا يُسقط أبداً (دالة صرفة قابلة للاختبار). */
export function computeLedgerRetryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, Math.floor(attempts)) * BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
}

/* ------------------------------------------------------------------ */
/* دوال صرفة قابلة للاختبار (بدون أي وصول لمتصفح)                      */
/* ------------------------------------------------------------------ */

/**
 دورة دفع واحدة: تعالج حتى FLUSH_BATCH إدخالاً مستحقاً. النجاح الوحيد
 (حذف الإدخال من الطابور) هو تأكيد الخادم عبر post() → true. الفشل يعيد
 الإدخال بBackoff أطول — بلا إسقاط أبداً. remainingDue يخبر المتصل إن كان
 لا بد من دورة تالية فورية (الطابور أكبر من الدفعة) — دالة صرفة.
 */
export async function runFlushCycle(
  store: LedgerStore,
  post: (url: string) => Promise<boolean>,
  now: number,
): Promise<{ processed: number; confirmed: number; remainingDue: number }> {
  const all = await store.getAll();
  const due = all
    .filter(entry => entry.nextAttemptAt <= now)
    .sort((a, b) => a.queuedAt - b.queuedAt);
  const batch = due.slice(0, FLUSH_BATCH);

  let confirmed = 0;
  for (const entry of batch) {
    if (await post(entry.url)) {
      // تأكيد الخادم الوحيد الذي يسمح بحذف الإدخال من الطابور
      await store.delete(entry.url);
      confirmed += 1;
      continue;
    }
    // فشل (شبكة، جلسة، 5xx، 4xx) → يبقى الإدخال بBackoff أطول — لا فقدان أبداً
    await store.put({
      ...entry,
      attempts: entry.attempts + 1,
      nextAttemptAt: Date.now() + computeLedgerRetryDelayMs(entry.attempts),
    });
  }

  const remainingDue = due.length > batch.length ? due.length - batch.length : 0;
  return { processed: batch.length, confirmed, remainingDue };
}

/**
 سلسلة تخزين مرنة: يُجرَّب كل مُنشئ بالترتيب عند أول استخدام؛ وفشل أي عملية
 على المخزن الحالي (فشل فتح IndexedDB، فشل كتابة، حصة ممتلئة...) يتراجع
 تلقائياً للمخزن التالي ويُعلن بتحذير — مع ترحيل ما يمكن قراءته من المخزن
 الفاشل قبل التخلي عنه، فلا يُفقد إدخال بسبب الانتقال نفسه.
 */
export function createResilientStore(builders: Array<{ name: string; build: () => LedgerStore }>): LedgerStore {
  type Layer = { name: string; store: LedgerStore };
  const layers: Layer[] = [];
  let active: Layer | null = null;

  function getActive(): Layer {
    if (active) return active;
    const nextBuilder = builders[layers.length];
    if (!nextBuilder) {
      // آخر مخزن في السلسلة (الذاكرة) — لا يمكن أن يفشل
      throw new Error('No storage layer available');
    }
    const layer: Layer = { name: nextBuilder.name, store: nextBuilder.build() };
    layers.push(layer);
    active = layer;
    return layer;
  }

  async function degradeToNext(reason: unknown, operation: string): Promise<Layer> {
    if (active) {
      console.warn(
        `[upload-ledger] فشلت عملية ${operation} في ${active.name} — الانتقال إلى التخزين البديل:`,
        reason,
      );
      // ترحيل ما يمكن قراءته من المخزن الفاشل قبل التخلي عنه
      try {
        const salvaged = await active.store.getAll();
        const failedIndex = layers.indexOf(active);
        for (const entry of salvaged) {
          for (let index = failedIndex + 1; index < builders.length; index += 1) {
            try {
              const nextLayer: Layer = layers[index] ?? { name: builders[index].name, store: builders[index].build() };
              if (!layers[index]) layers[index] = nextLayer;
              const existing = await nextLayer.store.getAll();
              if (!existing.some(candidate => candidate.url === entry.url)) {
                await nextLayer.store.put(entry);
              }
            } catch {
              continue;
            }
          }
        }
      } catch {
        /* ما لا يمكن إنقاذه يبقى محفوظاً في الطبقة التالية عند الكتابات القادمة */
      }
      active = layers[layers.indexOf(active) + 1] ?? null;
      if (!active) {
        // أنشئ الطبقة التالية (حتى ما بعد الفاشل) — يجب أن يوجد بُنّاء للذاكرة
        const nextBuilder = builders[layers.length];
        if (!nextBuilder) throw reason instanceof Error ? reason : new Error('All storage layers failed');
        const layer: Layer = { name: nextBuilder.name, store: nextBuilder.build() };
        layers.push(layer);
        active = layer;
      }
    }
    return active!;
  }

  return {
    async getAll() {
      let current = getActive();
      while (true) {
        try {
          return await current.store.getAll();
        } catch (error) {
          current = await degradeToNext(error, 'getAll');
        }
      }
    },
    async put(entry) {
      let current = getActive();
      while (true) {
        try {
          await current.store.put(entry);
          return;
        } catch (error) {
          current = await degradeToNext(error, 'put');
        }
      }
    },
    async delete(url) {
      let current = getActive();
      while (true) {
        try {
          await current.store.delete(url);
          return;
        } catch (error) {
          current = await degradeToNext(error, 'delete');
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* طبقات التخزين الفعلية: IndexedDB → localStorage → الذاكرة           */
/* ------------------------------------------------------------------ */

function createIndexedDbStore(): LedgerStore {
  const DB_NAME = 'aani-media-ledger';
  const STORE_NAME = 'pending';
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'url' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      });
    }
    return dbPromise;
  };

  const withStore = async (mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<void> => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      request.onerror = () => {
        /* فشل الطلب ينعكس على المعاملة — تُرفع عبر onabort/onerror أعلاه */
      };
    });
  };

  return {
    async getAll() {
      const db = await open();
      return await new Promise<PendingLedgerEntry[]>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as PendingLedgerEntry[] : []);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB getAll failed'));
      });
    },
    async put(entry) {
      await withStore('readwrite', store => store.put(entry)); // upsert — idempotent بالرابط
    },
    async delete(url) {
      await withStore('readwrite', store => store.delete(url));
    },
  };
}

function createLocalStorageStore(): LedgerStore {
  const KEY = 'aani-upload-ledger-pending';
  const read = (): PendingLedgerEntry[] => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is PendingLedgerEntry =>
        typeof (entry as PendingLedgerEntry)?.url === 'string'
        && typeof (entry as PendingLedgerEntry)?.attempts === 'number'
        && typeof (entry as PendingLedgerEntry)?.nextAttemptAt === 'number');
    } catch (error) {
      // بيانات تالفة — نُعلن ثم نبدأ طابوراً فارغاً (لا نُخفي المشكلة بصمت)
      console.warn('[upload-ledger] محتوى التخزين المحلي تالف — بدء طابور جديد:', error);
      return [];
    }
  };
  const write = (entries: PendingLedgerEntry[]): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch (error) {
      // فشل الكتابة (حصة/وضع خاص) يُعلن ويُرمى — الطبقة المرنة تلتقطه وتتراجع للذاكرة
      console.warn('[upload-ledger] فشلت كتابة التخزين المحلي:', error);
      throw error;
    }
  };
  return {
    async getAll() { return read(); },
    async put(entry) {
      const entries = read().filter(existing => existing.url !== entry.url);
      entries.push(entry);
      write(entries);
    },
    async delete(url) {
      write(read().filter(existing => existing.url !== url));
    },
  };
}

function createMemoryStore(): LedgerStore {
  const entries = new Map<string, PendingLedgerEntry>();
  return {
    async getAll() { return [...entries.values()]; },
    async put(entry) { entries.set(entry.url, entry); },
    async delete(url) { entries.delete(url); },
  };
}

const store: LedgerStore = createResilientStore([
  { name: 'IndexedDB', build: createIndexedDbStore },
  { name: 'localStorage', build: createLocalStorageStore },
  { name: 'memory', build: createMemoryStore },
]);

/* ------------------------------------------------------------------ */
/* الإرسال والجدولة                                                    */
/* ------------------------------------------------------------------ */

async function getSessionToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

let flushInFlight = false;

/**
 إعادة إرسال الإدخالات المستحقة — دفعة تلو دفعة حتى إفراغ الطابور المستحق
 أو بلوغ سقف الدورات، ثم جدولة فورية لأي فائض بدل انتظار حدث خارجي.
 النجاح الوحيد هو حذف الإدخال بعد تأكيد الخادم.
 */
export async function flushUploadLedgerQueue(): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;
  try {
    const token = await getSessionToken();
    if (!token) return; // الجلسة غير متاحة — المحفزات القادمة ستحاول من جديد

    const post = (url: string) => fetch('/api/media/upload-ledger', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    }).then(response => response.ok).catch(() => false);

    for (let cycle = 0; cycle < MAX_FLUSH_CYCLES; cycle += 1) {
      const result = await runFlushCycle(store, post, Date.now());
      // الطابور المستحق أُفرغ تماماً
      if (result.processed === 0 && result.remainingDue === 0) return;
      // فشل إدخال واحد على الأقل → البقية أعيدت بـ Backoff مستحق لاحقاً —
      // الخروج مع الجدولة عند موعد الاستحقاق (لا محاولة فورية بلا داعٍ)
      if (result.confirmed < result.processed) break;
      // بقي مستحق أكبر من الدفعة → دورة تالية فورية، ولا انتظار لحدث خارجي
      if (result.remainingDue === 0) return;
    }
    // بلوغ سقف الدورات مع بقاء مستحقين (أو فشل) → متابعة فورية حتى الإفراغ
    scheduleNextFlush(true);
  } finally {
    flushInFlight = false;
  }
}

let nextFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 جدولة محاولة قادمة عند موعد استحقاق أقدم إدخال (مؤقت واحد بلا تكدس).
 hasUnprocessedDue: صحيح فقط حين تبقى إدخالات مستحقة لم تُعالج (فائض دفعات) —
 عندها المحاولة الفورية مسموحة؛ غير ذلك لا مؤقتات فارغة بلا عمل.
 */
function scheduleNextFlush(hasUnprocessedDue = false): void {
  if (nextFlushTimer) {
    clearTimeout(nextFlushTimer);
    nextFlushTimer = null;
  }
  void store.getAll().then(entries => {
    const now = Date.now();
    const future = entries.filter(entry => entry.nextAttemptAt > now);
    const dueNow = entries.length - future.length;
    if (dueNow > 0 && hasUnprocessedDue) {
      // إدخالات مستحقة لم تُعالج → محاولة فورية
      nextFlushTimer = setTimeout(() => {
        nextFlushTimer = null;
        void flushUploadLedgerQueue().catch(() => undefined);
      }, 0);
      return;
    }
    if (future.length === 0) return;
    const earliest = Math.min(...future.map(entry => entry.nextAttemptAt));
    const delay = Math.min(earliest - now, MAX_SINGLE_TIMER_MS);
    nextFlushTimer = setTimeout(() => {
      nextFlushTimer = null;
      void flushUploadLedgerQueue().catch(() => undefined);
    }, delay);
  }).catch(() => undefined);
}

// محفزات تلقائية (المتصفح فقط): عودة الاتصال وعودة التطبيق للواجهة
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushUploadLedgerQueue().catch(() => undefined);
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void flushUploadLedgerQueue().catch(() => undefined);
      }
    });
  }
}

/** تسجيل موثوق: محاولة فورية، وعند فشلها يبقى الرابط في الطابور الدائم لإعادة الإرسال. */
export async function recordUploadLedgerReliably(url: string): Promise<void> {
  if (typeof url !== 'string' || !url) return;

  const token = await getSessionToken();
  if (token && await postDirect(url, token)) return;

  // upsert بالرابط: تسجيل متكرر لنفس الملف لا يضاعف الإدخال (idempotent)
  await store.put({
    url,
    attempts: 0,
    nextAttemptAt: Date.now(),
    queuedAt: Date.now(),
  });
  scheduleNextFlush(false);
}

async function postDirect(url: string, token: string): Promise<boolean> {
  try {
    const response = await fetch('/api/media/upload-ledger', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    });
    return response.ok; // التأكيد الخادمي فقط — 2xx وحده يعني سُجل فعلاً
  } catch {
    return false;
  }
}
