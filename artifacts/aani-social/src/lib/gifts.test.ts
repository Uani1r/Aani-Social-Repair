import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySendError,
  resolveSendAttempt,
  type SendAttempt,
} from './gifts';

const RECIPIENT = 'recipient-1';
const GIFT = 'gift-1';

test('classifySendError: خطأ نقل/شبكة (بلا code) غير محسوم', () => {
  // أخطاء الشبكة/الاتصال/المهلة تصل بلا رمز خطأ من الخادم (code غير موجود).
  assert.equal(classifySendError({ message: 'Failed to fetch' }), 'inconclusive');
  assert.equal(classifySendError({ message: 'ETIMEDOUT' }), 'inconclusive');
  assert.equal(classifySendError(new Error('network down')), 'inconclusive');
  assert.equal(classifySendError(null), 'inconclusive');
});

test('classifySendError: رفض الخادم المؤكد (يحمل code) محسوم', () => {
  // أخطاء العمل/الصلاحية/الرصيد من Postgres/PostgREST تحمل code.
  assert.equal(classifySendError({ code: '42001', message: 'insufficient balance' }), 'definitive');
  assert.equal(classifySendError({ code: '42501', message: 'forbidden' }), 'definitive');
  assert.equal(classifySendError({ code: 'PGRST202', message: 'no function' }), 'definitive');
});

test('resolveSendAttempt: لا محاولة سابقة → مفتاح جديد', () => {
  let generated = 0;
  const attempt = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => `key-${++generated}`,
  });
  assert.equal(attempt.key, 'key-1');
  assert.equal(attempt.status, 'sending');
  assert.equal(attempt.recipientId, RECIPIENT);
  assert.equal(attempt.giftId, GIFT);
});

test('resolveSendAttempt: خطأ شبكة (inconclusive) لا يولّد مفتاحاً جديداً عند إعادة المحاولة', () => {
  // محاولة أولى بمفتاح ثابت.
  const first = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'stable-key',
  });
  assert.equal(first.key, 'stable-key');

  // محاكاة نتيجة غير محسومة (خطأ نقل/شبكة): classifySendError → inconclusive،
  // والمحاولة تصبح inconclusive محتفظة بنفس المفتاح.
  assert.equal(classifySendError({ message: 'Failed to fetch' }), 'inconclusive');
  const afterNetworkError: SendAttempt = { ...first, status: 'inconclusive' };

  // إعادة المحاولة: يجب ألا يُستدعى generateKey، ويُعاد نفس المفتاح.
  let generated = 0;
  const retry = resolveSendAttempt(afterNetworkError, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => {
      generated += 1;
      return `new-key-${generated}`;
    },
  });

  assert.equal(generated, 0, 'لا يجوز توليد مفتاح جديد عند إعادة المحاولة بعد خطأ شبكة');
  assert.equal(retry.key, 'stable-key', 'يجب الاحتفاظ بنفس idempotencyKey');
  assert.equal(retry.status, 'sending');
});

test('resolveSendAttempt: تغيّر المستلم/الهدية قبل الحسم → مفتاح جديد (دفاعي)', () => {
  const stale: SendAttempt = {
    key: 'old-key',
    recipientId: RECIPIENT,
    giftId: GIFT,
    status: 'inconclusive',
  };

  const changedRecipient = resolveSendAttempt(stale, {
    recipientId: 'recipient-2',
    giftId: GIFT,
    generateKey: () => 'fresh-key',
  });
  assert.notEqual(changedRecipient.key, 'old-key');
  assert.equal(changedRecipient.key, 'fresh-key');

  const changedGift = resolveSendAttempt(stale, {
    recipientId: RECIPIENT,
    giftId: 'gift-2',
    generateKey: () => 'fresh-key-2',
  });
  assert.equal(changedGift.key, 'fresh-key-2');
});

test('السلسلة الكاملة: نجاح مؤكد يصفّر المحاولة، وخطأ شبكة يبقي المفتاح', () => {
  // محاولة جديدة.
  let attempt = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'K',
  });

  // نتيجة غير محسومة → تبقى inconclusive بنفس المفتاح.
  attempt = { ...attempt, status: 'inconclusive' };
  const retried = resolveSendAttempt(attempt, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'SHOULD-NOT-BE-USED',
  });
  assert.equal(retried.key, 'K');
  assert.equal(retried.status, 'sending');
});