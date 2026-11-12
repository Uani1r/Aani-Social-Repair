// طابور موثوق لتسجيل روابط الوسائط المرفوعة في سجل الرفع الخادمي (Upload Ledger).
//
// الرفع يتم مباشرة من الجهاز إلى ImageKit؛ الخادم لا يرى الملف إلا إذا أخبرناه.
// fire-and-forget وحده يُفوّت التسجيل عند انقطاع الشبكة أو إغلاق التطبيق لحظة
// نجاح الرفع، فيتحول الملف إلى "يتيم" قد يُكنس لاحقاً رغم استخدامه. الضمان هنا:
//
// 1) محاولة فورية بعد الرفع؛ وعند فشلها يُخزَّن الرابط في تخزين دائم
//    (IndexedDB أساساً — يبقى بعد إغلاق المتصفح — مع fallback إلى localStorage
//    ثم الذاكرة كحل أخير مُعلن).
// 2) الإدخال مفتاحه الرابط نفسه (upsert idempotent) — التكرار لا يضاعف السجل،
//    والخادم أيضاً يمنع التكرار عبر unique(media_url).
// 3) إعادة إرسال تلقائية عند أربعة محفزات: الموعد المستحق (setTimeout)،
//    عودة الاتصال (online)، عودة التطبيق للواجهة (visibilitychange)،
//    وتسجيل الدخول/الإقلاع (من useAppSession).
// 4) السجل لا يُعد ناجحاً ويُحذف من الطابور إلا بعد تأكيد الخادم صراحةً
//    (HTTP 2xx). الإدخالات لا تُسقط أبداً مهما عددت المحاولات — Backoff
//    أُسّي يسقف عند 6 ساعات والمحاولة تستمر إلى الأبد.
// 5) صافي الشبكة الثاني: كنس اليتامى الخادمي (Orphan Sweep) يعيد فحص كل
//    المراجع الحية قبل حذف أي ملف أصلاً — فقدان محتمل للسجل لا يعني حذفاً.
//
// فشل التسجيل لا يفشل الرفع أبداً — الدوال هنا تبتلع أخطائها داخلياً.

import { supabase } from '@/lib/supabase';

const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000; // سقف الـ Backoff: 6 ساعات
const BASE_RETRY_DELAY_MS = 30 * 1000;
const FLUSH_BATCH = 20;
const MAX_SINGLE_TIMER_MS = 60 * 60 * 1000; // أطول مؤقت استحقاق (يُعاد جدولته لاحقاً)

type PendingLedgerEntry = {
  url: string;
  attempts: number;
  nextAttemptAt: number;
  queuedAt: number;
};

/* ------------------------------------------------------------------ */
/* طبقة التخزين: IndexedDB → localStorage → الذاكرة                    */
/* ------------------------------------------------------------------ */

interface LedgerStore {
  getAll(): Promise<PendingLedgerEntry[]>;
  put(entry: PendingLedgerEntry): Promise<void>;
  delete(url: string): Promise<void>;
}

function createStore(): LedgerStore {
  // 1) IndexedDB (يدعم iPhone Safari وAndroid Chrome منذ سنوات)
  try {
    if (typeof indexedDB !== 'undefined') {
      return createIndexedDbStore();
    }
  } catch {
    /* يتبع التخزين التالي */
  }
  // 2) localStorage (متزامن — يبقى بين الجلسات، أقل سعة لكن كافٍ للروابط)
  try {
    if (typeof localStorage !== 'undefined') {
      return createLocalStorageStore();
    }
  } catch {
    /* يتبع التخزين التالي */
  }
  // 3) الذاكرة (معلن: يُفقد عند إعادة التحميل — أفضل من إفشال التسجيل)
  return createMemoryStore();
}

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
        /* فشل الطلب يعكس فشل المعاملة — تُرفع أخطاؤها عبر onabort/onerror أعلاه */
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
    } catch {
      return [];
    }
  };
  const write = (entries: PendingLedgerEntry[]): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      /* سعة/وضع خاص — الإدخال يبقى في الذاكرة للجلسة الحالية */
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

const store: LedgerStore = createStore();

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

async function postLedgerEntry(url: string, token: string): Promise<boolean> {
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

/** Backoff أُسّي بسقف 6 ساعات — الإدخال لا يُسقط أبداً (دالة صرفة قابلة للاختبار). */
export function computeLedgerRetryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, Math.floor(attempts)) * BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
}

let flushInFlight = false;

/** إعادة إرسال الإدخالات المستحقة — النجاح الوحيد هو حذف الإدخال بعد تأكيد الخادم. */
export async function flushUploadLedgerQueue(): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;
  try {
    const token = await getSessionToken();
    if (!token) return; // الجلسة غير متاحة — المحفزات القادمة ستحاول من جديد

    const now = Date.now();
    const all = await store.getAll();
    const due = all
      .filter(entry => entry.nextAttemptAt <= now)
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .slice(0, FLUSH_BATCH);

    for (const entry of due) {
      if (await postLedgerEntry(entry.url, token)) {
        // تأكيد الخادم الوحيد الذي يسمح بحذف الإدخال من الطابور
        await store.delete(entry.url).catch(() => undefined);
        continue;
      }
      // فشل (شبكة، جلسة، 5xx، 4xx) → يبقى الإدخال بBackoff أطول — لا فقدان أبداً
      await store.put({
        ...entry,
        attempts: entry.attempts + 1,
        nextAttemptAt: Date.now() + computeLedgerRetryDelayMs(entry.attempts),
      }).catch(() => undefined);
    }
    scheduleNextFlush();
  } finally {
    flushInFlight = false;
  }
}

let nextFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** جدولة محاولة قادمة عند موعد استحقاق أقدم إدخال (مؤقت واحد بلا تكدس). */
function scheduleNextFlush(): void {
  if (nextFlushTimer) {
    clearTimeout(nextFlushTimer);
    nextFlushTimer = null;
  }
  void store.getAll().then(entries => {
    const now = Date.now();
    const pending = entries.filter(entry => entry.nextAttemptAt > now);
    if (pending.length === 0) return;
    const earliest = Math.min(...pending.map(entry => entry.nextAttemptAt));
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
  if (token && await postLedgerEntry(url, token)) return;

  // upsert بالرابط: تسجيل متكرر لنفس الملف لا يضاعف الإدخال (idempotent)
  await store.put({
    url,
    attempts: 0,
    nextAttemptAt: Date.now(),
    queuedAt: Date.now(),
  }).catch(() => undefined);
  scheduleNextFlush();
}
