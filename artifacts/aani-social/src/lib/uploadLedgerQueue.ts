// طابور موثوق لتسجيل روابط الوسائط المرفوعة في سجل الرفع الخادمي (Upload Ledger).
//
// الرفع يتم مباشرة من الجهاز إلى ImageKit؛ الخادم لا يرى الملف إلا إذا أخبرناه.
// fire-and-forget وحده يُفوّت التسجيل عند انقطاع الشبكة أو إغلاق التطبيق لحظة
// نجاح الرفع، فيتحول الملف إلى "يتيم" قد يُكنس لاحقاً رغم استخدامه. لذلك:
// - محاولة فورية بعد الرفع، وعند فشلها يبقى الرابط في طابور محلي (localStorage)
//   يُعاد إرساله تلقائياً عند تسجيل الدخول/الإقلاع مع Backoff بسيط.
// - لا يُسقط الإدخال إلا بعد نجاح صريح أو استنفاد عدد المحاولات.
// - فشل التسجيل لا يفشل الرفع أبداً — الدوال هنا تبتلع أخطائها داخلياً.

import { supabase } from '@/lib/supabase';

const STORAGE_KEY = 'aani-upload-ledger-pending';
const MAX_ATTEMPTS = 8;
const BASE_RETRY_DELAY_MS = 30 * 1000;
const FLUSH_BATCH = 20;

type PendingLedgerEntry = { url: string; attempts: number; nextAttemptAt: number };

function readPendingQueue(): PendingLedgerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
}

function writePendingQueue(entries: PendingLedgerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* التخزين المحلي غير متاح — تُفقد إعادة المحاولة لكن الرفع نفسه سليم */
  }
}

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
    return response.ok;
  } catch {
    return false;
  }
}

/** تسجيل موثوق: محاولة فورية، وعند فشلها يبقى الرابط في الطابور لإعادة الإرسال. */
export async function recordUploadLedgerReliably(url: string): Promise<void> {
  if (typeof url !== 'string' || !url) return;

  const token = await getSessionToken();
  if (token && await postLedgerEntry(url, token)) return;

  const queue = readPendingQueue();
  queue.push({ url, attempts: 0, nextAttemptAt: Date.now() });
  writePendingQueue(queue);
}

/** إعادة إرسال الروابط المعلقة في الطابور (يُستدعى عند تسجيل الدخول وعند الإقلاع). */
export async function flushUploadLedgerQueue(): Promise<void> {
  if (typeof localStorage === 'undefined') return;

  const token = await getSessionToken();
  if (!token) return;

  const now = Date.now();
  const queue = readPendingQueue();
  const due = queue.filter(entry => entry.nextAttemptAt <= now).slice(0, FLUSH_BATCH);
  if (due.length === 0) return;

  const remaining = queue.filter(entry => !due.includes(entry));

  for (const entry of due) {
    if (await postLedgerEntry(entry.url, token)) continue;
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      console.warn('[upload-ledger] استُنفدت إعادة محاولة تسجيل الرابط — سيبقى مغطياً بفحص المراجع عند الحذف:', entry.url);
      continue;
    }
    remaining.push({
      url: entry.url,
      attempts,
      nextAttemptAt: Date.now() + 2 ** attempts * BASE_RETRY_DELAY_MS,
    });
  }

  writePendingQueue(remaining);
}
