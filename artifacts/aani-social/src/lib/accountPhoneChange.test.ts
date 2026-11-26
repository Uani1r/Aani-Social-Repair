import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginPendingPhoneChange,
  clearPendingPhoneChange,
  decidePhoneChangeRequest,
  planPhoneChangeStart,
  promotePendingPhoneChange,
  readPendingPhoneChange,
  type PendingPhoneChange,
} from './accountPhoneChange';

const USER_ID = 'user-test-1';
const OTHER_USER_ID = 'user-test-2';
const NEW_PHONE = '+9647701234567';
const OTHER_PHONE = '+9647709876543';
const CURRENT_PHONE = '+9647700000000';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** تخزين في الذاكرة يشترك فيه "تحميلان" للصفحة، لمحاكاة إعادة التحميل. */
function memoryStorage(): StorageLike {
  const rows = new Map<string, string>();
  return {
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); },
    removeItem: key => { rows.delete(key); },
  };
}

/** تخزين يرفض كل كتابة — لاختبار فشل الحفظ. */
function unwritableStorage(): StorageLike {
  const rows = new Map<string, string>();
  return {
    getItem: key => rows.get(key) ?? null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: (key) => { rows.delete(key); },
  };
}

function pendingOf(phone: string, requestedAt: number, state: 'pending' | 'requesting' = 'pending'): PendingPhoneChange {
  return { phone, requestedAt, state };
}

test('no pending request allows a new number', () => {
  assert.deepEqual(
    decidePhoneChangeRequest({ pending: null, nextPhone: NEW_PHONE, currentPhone: CURRENT_PHONE }),
    { allowed: true, reason: 'new' },
  );
});

test('the current number is rejected even with no pending request', () => {
  assert.deepEqual(
    decidePhoneChangeRequest({ pending: null, nextPhone: CURRENT_PHONE, currentPhone: CURRENT_PHONE }),
    { allowed: false, reason: 'unchanged' },
  );
});

test('a pending request for the same number is a resend, not a new request', () => {
  assert.deepEqual(
    decidePhoneChangeRequest({
      pending: pendingOf(NEW_PHONE, NOW),
      nextPhone: NEW_PHONE,
      currentPhone: CURRENT_PHONE,
    }),
    { allowed: true, reason: 'resend' },
  );
});

test('a second number stays blocked with no time limit, even five years later', () => {
  const decision = decidePhoneChangeRequest({
    pending: pendingOf(NEW_PHONE, NOW - FIVE_YEARS_MS),
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.reason, 'pending-other');
});

test('an unresolved (requesting) record also blocks a second number and still resends to itself', () => {
  const record = pendingOf(NEW_PHONE, NOW, 'requesting');
  assert.equal(
    decidePhoneChangeRequest({ pending: record, nextPhone: OTHER_PHONE, currentPhone: CURRENT_PHONE }).allowed,
    false,
  );
  assert.deepEqual(
    decidePhoneChangeRequest({ pending: record, nextPhone: NEW_PHONE, currentPhone: CURRENT_PHONE }),
    { allowed: true, reason: 'resend' },
  );
});

test('planning a second number is refused without touching the stored record', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  const plan = planPhoneChangeStart({
    userId: USER_ID,
    pending: readPendingPhoneChange(USER_ID, storage),
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW + 1_000,
    storage,
  });
  assert.equal(plan.canStart, false);
  if (plan.canStart) return;
  assert.equal(plan.reason, 'pending-other');
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), pendingOf(NEW_PHONE, NOW, 'requesting'));
});

test('the write-ahead record is saved before any request and survives a reload', () => {
  const storage = memoryStorage();
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    pending: null,
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.equal(plan.canStart, true);
  if (!plan.canStart) return;
  assert.deepEqual(plan.record, pendingOf(NEW_PHONE, NOW, 'requesting'));

  // "تحميل جديد" يقرأ من نفس التخزين، لا من React state.
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), pendingOf(NEW_PHONE, NOW, 'requesting'));

  // وبعده يُمنع رقم ثانٍ.
  assert.equal(
    decidePhoneChangeRequest({
      pending: readPendingPhoneChange(USER_ID, storage),
      nextPhone: OTHER_PHONE,
      currentPhone: CURRENT_PHONE,
    }).allowed,
    false,
  );
});

test('promoting after a successful request keeps the record pending across a reload', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  assert.equal(promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage), true);
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), pendingOf(NEW_PHONE, NOW, 'pending'));
});

test('no request is allowed when the storage is unavailable', () => {
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    pending: null,
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage: null,
  });
  assert.deepEqual(plan, { canStart: false, reason: 'storage' });
  assert.equal(readPendingPhoneChange(USER_ID, null), null);
});

test('no request is allowed when writing the record fails', () => {
  const storage = unwritableStorage();
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    pending: null,
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.deepEqual(plan, { canStart: false, reason: 'storage' });
  assert.equal(beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage), false);
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
});

test('a failed promotion keeps the unresolved record and keeps blocking', () => {
  const readable = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), readable);
  // الكتابة الثانية تفشل: السجل السابق (requesting) يبقى.
  const failing = {
    getItem: readable.getItem,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: readable.removeItem,
  };
  assert.equal(promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), failing), false);
  assert.deepEqual(readPendingPhoneChange(USER_ID, readable), pendingOf(NEW_PHONE, NOW, 'requesting'));
  assert.equal(
    decidePhoneChangeRequest({
      pending: readPendingPhoneChange(USER_ID, readable),
      nextPhone: OTHER_PHONE,
      currentPhone: CURRENT_PHONE,
    }).allowed,
    false,
  );
});

test('only a confirmation or documented handling clears the record; a notice does not', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  // "إغلاق التنبيه" لا يمسّ التخزين: لا يوجد أي مسار زمني يمسحه.
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), pendingOf(NEW_PHONE, NOW, 'pending'));

  // المسح بعد تأكيد Supabase فقط.
  clearPendingPhoneChange(USER_ID, storage);
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
});

test('a failed request keeps the unresolved record instead of clearing it', () => {
  const storage = memoryStorage();
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    pending: null,
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.equal(plan.canStart, true);
  if (!plan.canStart) return;

  // فشل الطلب لا يُثبت أن الخادم لم يُنشئ سجل phone_change: السجل يبقى
  // غير محسوم ويمنع أي رقم آخر.
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), pendingOf(NEW_PHONE, NOW, 'requesting'));
  assert.equal(
    decidePhoneChangeRequest({
      pending: readPendingPhoneChange(USER_ID, storage),
      nextPhone: OTHER_PHONE,
      currentPhone: CURRENT_PHONE,
    }).allowed,
    false,
  );
});

test('the pending record is per user and is not shared', () => {
  const storage = memoryStorage();
  planPhoneChangeStart({
    userId: USER_ID,
    pending: null,
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.equal(readPendingPhoneChange(OTHER_USER_ID, storage), null);
  clearPendingPhoneChange(USER_ID, storage);
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
});

test('corrupt or invalid stored values are ignored, and an unknown state stays unresolved', () => {
  const storage = memoryStorage();
  storage.setItem(`aani:phone-change:${USER_ID}`, '{not json');
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);

  storage.setItem(`aani:phone-change:${USER_ID}`, JSON.stringify({ phone: '07701234567', requestedAt: NOW }));
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);

  storage.setItem(`aani:phone-change:${USER_ID}`, JSON.stringify({ phone: NEW_PHONE, requestedAt: 'now' }));
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);

  storage.setItem(`aani:phone-change:${USER_ID}`, JSON.stringify({ phone: NEW_PHONE, requestedAt: NOW }));
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), pendingOf(NEW_PHONE, NOW, 'requesting'));
});

test('a write with an invalid phone number is refused', () => {
  const storage = memoryStorage();
  assert.equal(beginPendingPhoneChange(USER_ID, pendingOf('07701234567', NOW), storage), false);
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
});
