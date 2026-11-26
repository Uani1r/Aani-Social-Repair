import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PENDING_PHONE_CHANGE_MAX_AGE_MS,
  clearPendingPhoneChange,
  decidePhoneChangeRequest,
  pendingPhoneChangeRemainingMs,
  readPendingPhoneChange,
  savePendingPhoneChange,
  type PendingPhoneChange,
} from './accountPhoneChange';

const USER_ID = 'user-test-1';
const OTHER_USER_ID = 'user-test-2';
const NEW_PHONE = '+9647701234567';
const OTHER_PHONE = '+9647709876543';
const CURRENT_PHONE = '+9647700000000';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

/** تخزين في الذاكرة يشترك فيه "تحميلان" للصفحة، لمحاكاة إعادة التحميل. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const rows = new Map<string, string>();
  return {
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); },
    removeItem: key => { rows.delete(key); },
  };
}

function pendingOf(phone: string, requestedAt: number): PendingPhoneChange {
  return { phone, requestedAt };
}

test('no pending request allows a new number', () => {
  const decision = decidePhoneChangeRequest({
    pending: null,
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.deepEqual(decision, { allowed: true, reason: 'new' });
});

test('the current number is rejected even with no pending request', () => {
  const decision = decidePhoneChangeRequest({
    pending: null,
    nextPhone: CURRENT_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.deepEqual(decision, { allowed: false, reason: 'unchanged' });
});

test('a pending request for the same number is a resend, not a new request', () => {
  const decision = decidePhoneChangeRequest({
    pending: pendingOf(NEW_PHONE, NOW - 60_000),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.deepEqual(decision, { allowed: true, reason: 'resend' });
});

test('a second number is blocked while the pending request may still be valid', () => {
  const pending = pendingOf(NEW_PHONE, NOW - 60_000);
  const decision = decidePhoneChangeRequest({
    pending,
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.reason, 'pending-other');
  if (decision.reason !== 'pending-other') return;
  assert.deepEqual(decision.pending, pending);
  assert.ok(decision.remainingMs > 0);
  assert.ok(decision.remainingMs <= PENDING_PHONE_CHANGE_MAX_AGE_MS);
});

test('a second number is blocked just before the documented expiry', () => {
  const decision = decidePhoneChangeRequest({
    pending: pendingOf(NEW_PHONE, NOW - PENDING_PHONE_CHANGE_MAX_AGE_MS + 1_000),
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.reason, 'pending-other');
});

test('after the documented expiry the local block is lifted and labelled as such', () => {
  const decision = decidePhoneChangeRequest({
    pending: pendingOf(NEW_PHONE, NOW - PENDING_PHONE_CHANGE_MAX_AGE_MS - 1_000),
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.deepEqual(decision, { allowed: true, reason: 'previous-may-have-expired' });
});

test('an expired pending record still resends to its own number', () => {
  const decision = decidePhoneChangeRequest({
    pending: pendingOf(NEW_PHONE, NOW - PENDING_PHONE_CHANGE_MAX_AGE_MS - 1_000),
    nextPhone: NEW_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW,
  });
  assert.deepEqual(decision, { allowed: true, reason: 'resend' });
});

test('a pending request survives a reload of the app', () => {
  const storage = memoryStorage();
  const record = pendingOf(NEW_PHONE, NOW);
  assert.equal(savePendingPhoneChange(USER_ID, record, storage), true);

  // "تحميل جديد" يقرأ من نفس التخزين، لا من React state.
  const reloaded = readPendingPhoneChange(USER_ID, storage);
  assert.deepEqual(reloaded, record);

  // وعلى أساسه يُمنع رقم ثانٍ بعد إعادة التحميل.
  assert.ok(reloaded);
  const decision = decidePhoneChangeRequest({
    pending: reloaded,
    nextPhone: OTHER_PHONE,
    currentPhone: CURRENT_PHONE,
    now: NOW + 60_000,
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.reason, 'pending-other');
});

test('the pending record is per user and is not shared', () => {
  const storage = memoryStorage();
  savePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);
  assert.equal(readPendingPhoneChange(OTHER_USER_ID, storage), null);
  clearPendingPhoneChange(USER_ID, storage);
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
});

test('dismissing the notice does not remove the block: only a confirmation clears it', () => {
  const storage = memoryStorage();
  savePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), storage);

  // "إغلاق التنبيه" لا يمسّ التخزين، فيبقى المنع.
  const stillPending = readPendingPhoneChange(USER_ID, storage);
  assert.deepEqual(stillPending, pendingOf(NEW_PHONE, NOW));

  // المسح لا يحدث إلا بعد تأكيد Supabase (clearPendingPhoneChange).
  clearPendingPhoneChange(USER_ID, storage);
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
  assert.deepEqual(
    decidePhoneChangeRequest({ pending: null, nextPhone: OTHER_PHONE, currentPhone: CURRENT_PHONE, now: NOW }),
    { allowed: true, reason: 'new' },
  );
});

test('corrupt or invalid stored values are ignored instead of blocking or crashing', () => {
  const storage = memoryStorage();
  storage.setItem(`aani:phone-change:${USER_ID}`, '{not json');
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);

  storage.setItem(`aani:phone-change:${USER_ID}`, JSON.stringify({ phone: '07701234567', requestedAt: NOW }));
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);

  storage.setItem(`aani:phone-change:${USER_ID}`, JSON.stringify({ phone: NEW_PHONE, requestedAt: 'now' }));
  assert.equal(readPendingPhoneChange(USER_ID, storage), null);
});

test('a missing or unavailable storage never throws', () => {
  assert.equal(readPendingPhoneChange(USER_ID, null), null);
  assert.equal(savePendingPhoneChange(USER_ID, pendingOf(NEW_PHONE, NOW), null), false);
  assert.equal(clearPendingPhoneChange(USER_ID, null), false);
});

test('the remaining time shrinks with the clock and never goes negative', () => {
  const pending = pendingOf(NEW_PHONE, NOW);
  assert.equal(
    pendingPhoneChangeRemainingMs(pending, NOW + 60_000),
    PENDING_PHONE_CHANGE_MAX_AGE_MS - 60_000,
  );
  assert.equal(pendingPhoneChangeRemainingMs(pending, NOW + PENDING_PHONE_CHANGE_MAX_AGE_MS * 2), 0);
});
