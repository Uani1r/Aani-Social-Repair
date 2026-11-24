import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySendError,
  interpretSendResponse,
  resolveSendAttempt,
  type SendAttempt,
} from './gifts';

const RECIPIENT = 'recipient-1';
const GIFT = 'gift-1';

test('classifySendError: أكواد SQL/business المعروفة = رفض مؤكد', () => {
  // الأكواد التي ترفعها الدالة aani_send_gift صراحةً.
  assert.equal(classifySendError({ code: '42501', message: 'forbidden' }), 'definitive');
  assert.equal(classifySendError({ code: '42001', message: 'insufficient balance' }), 'definitive');
  assert.equal(classifySendError({ code: '42704', message: 'gift unavailable' }), 'definitive');
  assert.equal(classifySendError({ code: '22023', message: 'self' }), 'definitive');
});

test('classifySendError: كود غير معروف (كود API) = غير محسوم', () => {
  // كود من طبقة API أو غير معروف لا يثبت أن المعاملة لم تُنفَّذ.
  assert.equal(classifySendError({ code: 'PGRST202', message: 'no function' }), 'inconclusive');
  assert.equal(classifySendError({ code: '99999', message: 'weird' }), 'inconclusive');
  assert.equal(classifySendError({ code: 'XX000', message: 'internal' }), 'inconclusive');
});

test('classifySendError: بلا code أو غير كائن = غير محسوم', () => {
  assert.equal(classifySendError({ message: 'Failed to fetch' }), 'inconclusive');
  assert.equal(classifySendError(new Error('network down')), 'inconclusive');
  assert.equal(classifySendError(null), 'inconclusive');
  assert.equal(classifySendError('42501'), 'inconclusive');
});

test('interpretSendResponse: خطأ معروف = رفض مؤكد', () => {
  const result = interpretSendResponse({ code: '42001', message: 'insufficient balance' }, null);
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, false);
});

test('interpretSendResponse: خطأ كود غير معروف = غير محسوم (لا يمسح المفتاح)', () => {
  const result = interpretSendResponse({ code: 'PGRST999', message: 'api layer' }, null);
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, true);
});

test('interpretSendResponse: خطأ نقل/شبكة (بلا code) = غير محسوم', () => {
  const result = interpretSendResponse({ message: 'Failed to fetch' }, null);
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, true);
});

test('interpretSendResponse: استجابة RPC فارغة = غير محسوم (لا يمسح المفتاح)', () => {
  for (const data of [null, undefined, {}, { ok: 'yes' }, 42, 'x']) {
    const result = interpretSendResponse(null, data);
    assert.equal(result.ok, false, `data=${JSON.stringify(data)}`);
    assert.equal(result.inconclusive, true, `data=${JSON.stringify(data)}`);
  }
});

test('interpretSendResponse: ok:true = نجاح مؤكد', () => {
  const result = interpretSendResponse(null, { ok: true, transaction_id: 't1', balance: 5 });
  assert.equal(result.ok, true);
  assert.ok(!result.inconclusive);
});

test('interpretSendResponse: ok:false = رفض مؤكد من الدالة', () => {
  const result = interpretSendResponse(null, { ok: false, error: 'nope' });
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, false);
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
});

test('كود غير معروف لا يمسح المفتاح: إعادة المحاولة تستخدم نفس المفتاح', () => {
  const first = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'stable-key',
  });
  // خطأ بكود غير معروف → غير محسوم.
  const result = interpretSendResponse({ code: 'PGRST999', message: 'api' }, null);
  assert.equal(result.inconclusive, true);
  const afterUnknownError: SendAttempt = { ...first, status: 'inconclusive' };

  let generated = 0;
  const retry = resolveSendAttempt(afterUnknownError, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => {
      generated += 1;
      return `new-key-${generated}`;
    },
  });
  assert.equal(generated, 0, 'لا يجوز توليد مفتاح جديد بعد خطأ غير محسوم');
  assert.equal(retry.key, 'stable-key');
});

test('استجابة RPC فارغة لا تمسح المفتاح: إعادة المحاولة تستخدم نفس المفتاح', () => {
  const first = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'empty-resp-key',
  });
  const result = interpretSendResponse(null, null);
  assert.equal(result.inconclusive, true);
  const afterEmpty: SendAttempt = { ...first, status: 'inconclusive' };

  let generated = 0;
  const retry = resolveSendAttempt(afterEmpty, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => {
      generated += 1;
      return `new-key-${generated}`;
    },
  });
  assert.equal(generated, 0);
  assert.equal(retry.key, 'empty-resp-key');
});

test('الرفض المؤكد وحده يسمح بإنشاء محاولة جديدة', () => {
  // نتيجة غير محسومة → لا محاولة جديدة.
  const inconclusive = interpretSendResponse({ code: 'PGRST999' }, null);
  assert.equal(inconclusive.inconclusive, true);

  // رفض مؤكد → inconclusive:false، والواجهة تُصفّر المحاولة (null) → مفتاح جديد.
  const definitive = interpretSendResponse({ code: '42001', message: 'insufficient balance' }, null);
  assert.equal(definitive.inconclusive, false);
  assert.equal(definitive.ok, false);

  let generated = 0;
  const fresh = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => `fresh-${++generated}`,
  });
  assert.equal(fresh.key, 'fresh-1');
});

test('الرفض المؤكد (رصيد غير كافٍ/محظور/غير متاح) = inconclusive:false ويسمح بمحاولة جديدة', () => {
  for (const [code, message] of [
    ['42001', 'insufficient balance'],
    ['42501', 'blocked'],
    ['42704', 'gift unavailable'],
  ] as const) {
    const result = interpretSendResponse({ code, message }, null);
    assert.equal(result.ok, false, code);
    assert.equal(result.inconclusive, false, `${code} يجب أن يكون رفضاً مؤكداً`);
  }
  // بعد رفض مؤكد تُصفّر المحاولة → مفتاح جديد.
  let generated = 0;
  const fresh = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => `k-${++generated}`,
  });
  assert.equal(fresh.key, 'k-1');
});

test('السلسلة الكاملة: خطأ شبكة يبقي المفتاح، ونجاح مؤكد يصفّر المحاولة', () => {
  let attempt = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'K',
  });

  // نتيجة غير محسومة (شبكة) → inconclusive بنفس المفتاح.
  const net = interpretSendResponse({ message: 'Failed to fetch' }, null);
  assert.equal(net.inconclusive, true);
  attempt = { ...attempt, status: 'inconclusive' };
  const retried = resolveSendAttempt(attempt, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'SHOULD-NOT-BE-USED',
  });
  assert.equal(retried.key, 'K');

  // نجاح مؤكد → الواجهة تُصفّر (null)، ومحاولة جديدة بمفتاح جديد.
  const ok = interpretSendResponse(null, { ok: true, transaction_id: 't' });
  assert.equal(ok.ok, true);
  const afterSuccess = resolveSendAttempt(null, {
    recipientId: RECIPIENT,
    giftId: GIFT,
    generateKey: () => 'K2',
  });
  assert.equal(afterSuccess.key, 'K2');
});