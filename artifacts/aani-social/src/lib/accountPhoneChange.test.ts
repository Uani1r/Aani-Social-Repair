import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginPendingPhoneChange,
  clearPendingPhoneChange,
  decidePhoneChangeRequest,
  planPhoneChangeStart,
  promotePendingPhoneChange,
  readPendingPhoneChange,
  reconcileCompletedPhoneChange,
  runWithPhoneChangeLock,
  type PendingPhoneChange,
  type PhoneChangeLockManager,
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

/** تخزين لا يمكن قراءته — لاختبار تعذر الوصول. */
function unreadableStorage(): StorageLike {
  return {
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

function pendingOf(phone: string, requestedAt: number, state: 'pending' | 'requesting' = 'pending'): PendingPhoneChange {
  return { phone, requestedAt, state };
}

/** قفل يمنح العملية — لاختبار التنفيذ. */
function grantingLockManager(onRun?: () => void): PhoneChangeLockManager {
  return {
    request: async (_name, _options, callback) => {
      onRun?.();
      return callback({ name: 'aani:phone-change:test' });
    },
  };
}

/** قفل مشغول بتبويب آخر. */
function busyLockManager(): PhoneChangeLockManager {
  return {
    request: async (_name, _options, callback) => callback(null),
  };
}

/** متصفح لا يوفّر Web Locks. */
function throwingLockManager(): PhoneChangeLockManager {
  return {
    request: () => { throw new Error('locks unsupported'); },
  };
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

test('reading distinguishes no record from a valid record', () => {
  const storage = memoryStorage();
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'absent' });

  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'requesting') },
  );
});

test('a record that cannot be read is unreadable, never treated as no record', () => {
  const storage = memoryStorage();
  const key = `aani:phone-change:${USER_ID}`;

  storage.setItem(key, '{not json');
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'unreadable', reason: 'invalid-record' });

  storage.setItem(key, JSON.stringify({ phone: '07701234567', requestedAt: NOW }));
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'unreadable', reason: 'invalid-record' });

  storage.setItem(key, JSON.stringify({ phone: NEW_PHONE, requestedAt: 'now' }));
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'unreadable', reason: 'invalid-record' });

  storage.setItem(key, JSON.stringify({ phone: NEW_PHONE, requestedAt: NOW, state: 'weird' }));
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'unreadable', reason: 'invalid-record' });

  storage.setItem(key, JSON.stringify('record'));
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'unreadable', reason: 'invalid-record' });
});

test('an older record without a state field is still valid and unresolved', () => {
  const storage = memoryStorage();
  storage.setItem(`aani:phone-change:${USER_ID}`, JSON.stringify({ phone: NEW_PHONE, requestedAt: NOW }));
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'requesting') },
  );
});

test('unavailable or blocked storage is unreadable, not empty', () => {
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, null),
    { status: 'unreadable', reason: 'storage-unavailable' },
  );
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, unreadableStorage()),
    { status: 'unreadable', reason: 'storage-unavailable' },
  );
});

test('an unreadable record blocks a new number and is not overwritten', () => {
  const storage = memoryStorage();
  const key = `aani:phone-change:${USER_ID}`;
  const corrupt = JSON.stringify({ phone: NEW_PHONE, requestedAt: 'tomorrow' });
  storage.setItem(key, corrupt);

  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.deepEqual(plan, { canStart: false, reason: 'unreadable', read: 'invalid-record' });

  // لا كتابة فوق سجل لا يمكن التحقق منه، ولا رقم جديد.
  assert.equal(storage.getItem(key), corrupt);
});

test('an empty stored value is unreadable: it blocks a new number and is not overwritten', () => {
  const storage = memoryStorage();
  const key = `aani:phone-change:${USER_ID}`;
  // القيمة الفارغة سجل موجود لا يمكن التحقق منه، وليست "لا سجل".
  storage.setItem(key, '');

  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'unreadable', reason: 'invalid-record' },
  );

  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.deepEqual(plan, { canStart: false, reason: 'unreadable', read: 'invalid-record' });

  // لم يبدأ رقم جديد، ولم يُكتب سجل جديد مكان القيمة الفارغة.
  assert.equal(storage.getItem(key), '');
});

test('unreadable storage refuses a new number without writing', () => {
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, unreadableStorage()),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage: unreadableStorage(),
  });
  assert.deepEqual(plan, { canStart: false, reason: 'unreadable', read: 'storage-unavailable' });
});

test('planning a second number is refused without touching the stored record', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW + 1_000,
    storage,
  });
  assert.equal(plan.canStart, false);
  if (plan.canStart) return;
  assert.equal(plan.reason, 'pending-other');
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'requesting') },
  );
});

test('a pending request for the same number is planned as a resend, not rewritten', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW + 60_000,
    storage,
  });
  assert.deepEqual(plan, { canStart: false, reason: 'resend', pending: pendingOf(NEW_PHONE, NOW, 'pending') });
  // وقت الطلب القائم لم يُستبدل بوقت جديد.
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'pending') },
  );
});

test('the write-ahead record is saved before any request and survives a reload', () => {
  const storage = memoryStorage();
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.equal(plan.canStart, true);
  if (!plan.canStart) return;
  assert.deepEqual(plan.record, pendingOf(NEW_PHONE, NOW, 'requesting'));

  // "تحميل جديد" يقرأ من نفس التخزين، لا من React state.
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'requesting') },
  );

  // وبعده يُمنع رقم ثانٍ.
  assert.equal(
    planPhoneChangeStart({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, storage),
      nextPhone: OTHER_PHONE,
      currentPhone: CURRENT_PHONE,
      storage,
    }).canStart,
    false,
  );
});

test('promoting after a successful request keeps the record pending across a reload', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  assert.equal(promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage), true);
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'pending') },
  );
});

test('no request is allowed when writing the record fails', () => {
  const storage = unwritableStorage();
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.deepEqual(plan, { canStart: false, reason: 'storage' });
  assert.equal(beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage), false);
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'absent' });
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
  const record = readPendingPhoneChange(USER_ID, readable);
  assert.deepEqual(record, { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'requesting') });
  assert.equal(
    planPhoneChangeStart({
      userId: USER_ID,
      record,
      nextPhone: OTHER_PHONE,
      currentPhone: CURRENT_PHONE,
      storage: readable,
    }).canStart,
    false,
  );
});

test('only a confirmation or documented handling clears the record; a notice does not', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  // "إغلاق التنبيه" لا يمسّ التخزين: لا يوجد أي مسار زمني يمسحه.
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'pending') },
  );

  // المسح بعد تأكيد Supabase فقط.
  assert.equal(clearPendingPhoneChange(USER_ID, storage), true);
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'absent' });
});

test('a failed clear is reported and the record keeps blocking', () => {
  const readable = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), readable);
  promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), readable);

  const failing = {
    getItem: readable.getItem,
    setItem: readable.setItem,
    removeItem: () => { throw new Error('storage blocked'); },
  };

  // المسح فشل: لا يُقال إن السجل مُسح.
  assert.equal(clearPendingPhoneChange(USER_ID, failing), false);
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, readable),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'pending') },
  );

  // ومطابقة الرقم المؤكد فشل مسحها أيضاً: السجل يبقى ويبقى منعه.
  assert.deepEqual(
    reconcileCompletedPhoneChange({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, readable),
      currentPhone: NEW_PHONE,
      currentPhoneConfirmed: true,
      storage: failing,
    }),
    { cleared: false },
  );
  assert.equal(
    planPhoneChangeStart({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, readable),
      nextPhone: OTHER_PHONE,
      currentPhone: NEW_PHONE,
      storage: readable,
    }).canStart,
    false,
  );
});

test('a failed request keeps the unresolved record instead of clearing it', () => {
  const storage = memoryStorage();
  const plan = planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.equal(plan.canStart, true);
  if (!plan.canStart) return;

  // فشل الطلب لا يُثبت أن الخادم لم يُنشئ سجل phone_change: السجل يبقى
  // غير محسوم ويمنع أي رقم آخر.
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'requesting') },
  );
  assert.equal(
    planPhoneChangeStart({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, storage),
      nextPhone: OTHER_PHONE,
      currentPhone: CURRENT_PHONE,
      storage,
    }).canStart,
    false,
  );
});

test('a record written after the screen was loaded blocks the request inside the lock', async () => {
  const storage = memoryStorage();
  // ما قرأته الشاشة عند التحميل: لا سجل.
  const loadedRead = readPendingPhoneChange(USER_ID, storage);
  assert.deepEqual(loadedRead, { status: 'absent' });

  // تبويب آخر بدأ طلباً بعد التحميل.
  beginPendingPhoneChange(USER_ID, pendingOf(OTHER_PHONE, NOW), storage);

  const outcome = await runWithPhoneChangeLock(USER_ID, async () => {
    // القراءة داخل القفل من التخزين لا من الحالة المحمّلة.
    const record = readPendingPhoneChange(USER_ID, storage);
    return planPhoneChangeStart({
      userId: USER_ID,
      record,
      nextPhone: NEW_PHONE,
      currentPhone: CURRENT_PHONE,
      now: NOW + 1_000,
      storage,
    });
  }, grantingLockManager());

  assert.equal(outcome.status, 'ran');
  if (outcome.status !== 'ran') return;
  assert.equal(outcome.value.canStart, false);
  if (outcome.value.canStart) return;
  assert.equal(outcome.value.reason, 'pending-other');

  // سجل الطلب الآخر لم يُكتب فوقه سجل لهذا الرقم.
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(OTHER_PHONE, NOW, 'requesting') },
  );
});

test('the task runs inside a granted lock', async () => {
  let ran = 0;
  const outcome = await runWithPhoneChangeLock(USER_ID, async () => 'started', grantingLockManager(() => { ran += 1; }));
  assert.deepEqual(outcome, { status: 'ran', value: 'started' });
  assert.equal(ran, 1);
});

test('no task runs while another tab holds the lock', async () => {
  let ran = 0;
  const outcome = await runWithPhoneChangeLock(USER_ID, async () => { ran += 1; return 'started'; }, busyLockManager());
  assert.deepEqual(outcome, { status: 'busy' });
  assert.equal(ran, 0);
});

test('no task runs when the browser has no cross-tab lock', async () => {
  let ran = 0;
  const task = async () => { ran += 1; return 'started'; };
  assert.deepEqual(await runWithPhoneChangeLock(USER_ID, task, null), { status: 'unavailable' });
  assert.deepEqual(await runWithPhoneChangeLock(USER_ID, task, throwingLockManager()), { status: 'unavailable' });
  assert.equal(ran, 0);
});

test('an error inside the task is rethrown, not reported as missing lock support', async () => {
  await assert.rejects(
    runWithPhoneChangeLock(USER_ID, async () => { throw new Error('request failed'); }, grantingLockManager()),
    /request failed/,
  );
});

test('a record for a number confirmed elsewhere is cleared, an unconfirmed one is not', () => {
  const storage = memoryStorage();
  beginPendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  promotePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  // الرقم نفسه لم يُؤكد في الحساب بعد: السجل يبقى.
  assert.deepEqual(
    reconcileCompletedPhoneChange({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, storage),
      currentPhone: NEW_PHONE,
      currentPhoneConfirmed: false,
      storage,
    }),
    { cleared: false },
  );
  assert.deepEqual(
    readPendingPhoneChange(USER_ID, storage),
    { status: 'valid', pending: pendingOf(NEW_PHONE, NOW, 'pending') },
  );

  // رقم آخر مؤكد: سجل هذا الرقم لا يطابقه، فيبقى.
  assert.deepEqual(
    reconcileCompletedPhoneChange({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, storage),
      currentPhone: OTHER_PHONE,
      currentPhoneConfirmed: true,
      storage,
    }),
    { cleared: false },
  );

  // الرقم المعلّق نفسه صار الرقم المؤكد في الحساب: السجل منتهٍ ويُمسح.
  assert.deepEqual(
    reconcileCompletedPhoneChange({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, storage),
      currentPhone: NEW_PHONE,
      currentPhoneConfirmed: true,
      storage,
    }),
    { cleared: true },
  );
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'absent' });
});

test('an unreadable record is never cleared by reconciliation', () => {
  const storage = memoryStorage();
  const key = `aani:phone-change:${USER_ID}`;
  const corrupt = '{not json';
  storage.setItem(key, corrupt);

  assert.deepEqual(
    reconcileCompletedPhoneChange({
      userId: USER_ID,
      record: readPendingPhoneChange(USER_ID, storage),
      currentPhone: CURRENT_PHONE,
      currentPhoneConfirmed: true,
      storage,
    }),
    { cleared: false },
  );
  assert.equal(storage.getItem(key), corrupt);
});

test('the pending record is per user and is not shared', () => {
  const storage = memoryStorage();
  planPhoneChangeStart({
    userId: USER_ID,
    record: readPendingPhoneChange(USER_ID, storage),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
    storage,
  });
  assert.deepEqual(readPendingPhoneChange(OTHER_USER_ID, storage), { status: 'absent' });
  clearPendingPhoneChange(USER_ID, storage);
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'absent' });
});

test('a write with an invalid phone number is refused', () => {
  const storage = memoryStorage();
  assert.equal(beginPendingPhoneChange(USER_ID, pendingOf('07701234567', NOW), storage), false);
  assert.deepEqual(readPendingPhoneChange(USER_ID, storage), { status: 'absent' });
});
