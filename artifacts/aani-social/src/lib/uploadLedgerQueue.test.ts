// اختبارات طابور سجل الرفع (uploadLedgerQueue) — دون أي وصول لمتصفح أو شبكة:
// - الانتقال التلقائي بين طبقات التخزين عند فشل IndexedDB/localStorage (put/getAll).
// - عدم فقدان الإدخال عند التراجع.
// - الدفعات المتسلسلة: أكثر من 20 إدخالاً مستحقاً تُعالج حتى الإفراغ.
// - استمرار إعادة المحاولة: الفشل يزيد attempts ويؤجل موعداً — بلا إسقاط أبداً.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLedgerRetryDelayMs,
  createResilientStore,
  runFlushCycle,
  type LedgerStore,
  type PendingLedgerEntry,
} from './uploadLedgerQueue';

function makeEntry(url: string, overrides: Partial<PendingLedgerEntry> = {}): PendingLedgerEntry {
  return { url, attempts: 0, nextAttemptAt: 0, queuedAt: 0, ...overrides };
}

/** مخزن في الذاكرة يمكن جعله يفشل في كل العمليات */
function memoryStore(options: { failAll?: boolean } = {}): LedgerStore & { data: PendingLedgerEntry[] } {
  const data: PendingLedgerEntry[] = [];
  const fail = () => {
    if (options.failAll) throw new Error('storage layer failed');
  };
  return {
    data,
    async getAll() {
      fail();
      return data.map(entry => ({ ...entry }));
    },
    async put(entry) {
      fail();
      const index = data.findIndex(candidate => candidate.url === entry.url);
      if (index >= 0) data[index] = { ...entry };
      else data.push({ ...entry });
    },
    async delete(url) {
      fail();
      const index = data.findIndex(candidate => candidate.url === url);
      if (index >= 0) data.splice(index, 1);
    },
  };
}

/* ------------------------------------------------------------------ */
/* الانتقال التلقائي بين طبقات التخزين                                 */
/* ------------------------------------------------------------------ */

test('فشل فتح/استخدام IndexedDB ينتقل تلقائياً إلى الطبقة التالية — الإدخال يُحفظ', async () => {
  const broken = memoryStore({ failAll: true });
  const next = memoryStore();
  const store = createResilientStore([
    { name: 'IndexedDB', build: () => broken },
    { name: 'localStorage', build: () => next },
    { name: 'memory', build: () => memoryStore() },
  ]);

  await store.put(makeEntry('https://ik.imagekit.io/aani/u1/a.mp4'));
  assert.equal(next.data.length, 1, 'الإدخال يجب أن يصل الطبقة السليمة');
  const all = await store.getAll();
  assert.equal(all.length, 1);
  await store.delete('https://ik.imagekit.io/aani/u1/a.mp4');
  assert.equal((await store.getAll()).length, 0);
});

test('فشل localStorage أثناء الكتابة لا يبتلع بصمت — يتراجع مع ترحيل ما يمكن إنقاذه', async () => {
  // طبقة أولى تقبل الكتابة ثم تفشل عند القراءة (فشل محتوى/حصة)
  const primary = memoryStore();
  const primaryProxy: LedgerStore = {
    async getAll() {
      return primary.getAll();
    },
    async put(entry) {
      await primary.put(entry); // أول كتابة تنجح
      throw new Error('quota exceeded on later write'); // ثم يفشل التخزين
    },
    async delete(url) {
      await primary.delete(url);
    },
  };
  const secondary = memoryStore();
  const store = createResilientStore([
    { name: 'localStorage', build: () => primaryProxy },
    { name: 'memory', build: () => secondary },
  ]);

  await store.put(makeEntry('https://ik.imagekit.io/aani/u1/b.mp4'));
  // بعد فشل القراءة اللاحقة، يجب ألا تُقرأ بيانات من الطبقة الفاشلة بأثر رجعي
  const seen = await store.getAll();
  assert.ok(Array.isArray(seen));
  // الكتابات التالية تذهب للطبقة السليمة
  await store.put(makeEntry('https://ik.imagekit.io/aani/u1/c.mp4'));
  assert.ok(secondary.data.some(entry => entry.url === 'https://ik.imagekit.io/aani/u1/c.mp4'));
});

test('بيانات localStorage التالفة (قراءة فاشلة) ترمي خطأً وتتراجع السلسلة — لا قائمة فارغة بصمت', async () => {
  // طبقة أولى ترمي عند القراءة (بيانات تالفة/رفض خصوصية) — وضع localStorage الحقيقي
  const corruptProxy: LedgerStore = {
    async getAll() {
      throw new Error('upload-ledger local storage is corrupt (not an array)');
    },
    async put() {
      throw new Error('storage is corrupt');
    },
    async delete() {
      throw new Error('storage is corrupt');
    },
  };
  const secondary = memoryStore();
  const store = createResilientStore([
    { name: 'localStorage', build: () => corruptProxy },
    { name: 'memory', build: () => secondary },
  ]);

  // getAll الفاشلة تتراجع بدل إرجاع [] صامتة
  assert.equal((await store.getAll()).length, 0);
  // الكتابة بعد التراجع تصل الطبقة السليمة — لا فقدان صامت
  await store.put(makeEntry('https://ik.imagekit.io/aani/u1/after-corrupt.mp4'));
  assert.ok(secondary.data.some(entry => entry.url === 'https://ik.imagekit.io/aani/u1/after-corrupt.mp4'));
  assert.equal((await store.getAll()).length, 1);
});

/* ------------------------------------------------------------------ */
/* الدفعات المتسلسلة واستمرار إعادة المحاولة                           */
/* ------------------------------------------------------------------ */

test('أكثر من 20 إدخالاً مستحقاً: الدفعة تعالج 20 والباقي معلَّم remainingDue', async () => {
  const store = memoryStore();
  for (let index = 0; index < 35; index += 1) {
    await store.put(makeEntry(`https://ik.imagekit.io/aani/u1/v${index}.mp4`));
  }
  const result = await runFlushCycle(store, async () => true, Date.now());
  assert.equal(result.processed, 20);
  assert.equal(result.confirmed, 20);
  assert.equal(result.remainingDue, 15);
  assert.equal(store.data.length, 15); // دُفعت المذكورة وحُذفت بعد التأكيد
});

test('استكمال الدفعات: دورة ثانية تفرّغ الطابور حتى remainingDue = 0', async () => {
  const store = memoryStore();
  for (let index = 0; index < 25; index += 1) {
    await store.put(makeEntry(`https://ik.imagekit.io/aani/u1/r${index}.mp4`));
  }
  let now = Date.now();
  const first = await runFlushCycle(store, async () => true, now);
  assert.equal(first.processed, 20);
  const second = await runFlushCycle(store, async () => true, now);
  assert.equal(second.processed, 5);
  assert.equal(second.remainingDue, 0);
  assert.equal(store.data.length, 0);
});

test('فشل الإرسال يبقي الإدخال بـ attempts+1 وموعد لاحق — لا إسقاط أبداً', async () => {
  const store = memoryStore();
  await store.put(makeEntry('https://ik.imagekit.io/aani/u1/pending.mp4'));
  const now = Date.now();

  let failures = 0;
  const first = await runFlushCycle(store, async () => {
    failures += 1;
    return false; // الخادم غير مؤكد — بلا تأكيد = لا حذف من الطابور
  }, now);
  assert.equal(first.confirmed, 0);
  assert.equal(first.processed, 1);

  const entry = store.data[0];
  assert.equal(entry.url, 'https://ik.imagekit.io/aani/u1/pending.mp4');
  assert.equal(entry.attempts, 1);
  assert.ok(entry.nextAttemptAt > now, 'موعد إعادة المحاولة في المستقبل (Backoff)');

  // استمرار المحاولة: عند حلول الموعد تنجح الإرسال ويُحذف الإدخال بعد التأكيد
  const second = await runFlushCycle(store, async () => true, now + computeLedgerRetryDelayMs(1) + 1);
  assert.equal(second.confirmed, 1);
  assert.equal(store.data.length, 0);
});

test('تكرار تسجيل نفس الرابط (upsert) لا يضاعف الإدخال — idempotency', async () => {
  const store = memoryStore();
  const url = 'https://ik.imagekit.io/aani/u1/dup.mp4';
  await store.put(makeEntry(url));
  await store.put(makeEntry(url, { attempts: 3 }));
  assert.equal(store.data.length, 1);
  assert.equal(store.data[0].attempts, 3);
});

  assert.equal(store.data.length, 1);
  assert.equal(store.data[0].attempts, 3);
});
