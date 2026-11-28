import assert from 'node:assert/strict';
import test from 'node:test';

import { checkUsernameAvailability, parseUsernameStatePayload } from './usernameAvailability';
import { USERNAME_MESSAGES } from './usernameRules';

/**
 * توفر اسم المستخدم: لا تقرر الواجهة الإتاحة. الجواب يأتي من الخادم، وأي شك
 * (خطأ، دالة غير مثبتة، قيمة غير مفهومة، إدخال غير صالح) يعني `available:
 * false`، فلا يُطمئن المستخدم إلى اسم سيُرفض عند الحفظ.
 */

type Call = { fn: string; args?: Record<string, unknown> };

function makeClient(options: {
  data?: unknown;
  error?: { code?: string | null; message?: string | null } | null;
  throws?: boolean;
  calls?: Call[];
} = {}) {
  const calls = options.calls ?? [];
  return {
    calls,
    async rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      if (options.throws) throw new Error('network down');
      return { data: options.data ?? null, error: options.error ?? null };
    },
  };
}

test('قراءة الحالة من أشكال الاستجابة المختلفة', () => {
  assert.equal(parseUsernameStatePayload([{ status: 'available' }]), 'available');
  assert.equal(parseUsernameStatePayload({ status: 'reserved' }), 'reserved');
  assert.equal(parseUsernameStatePayload([{ state: 'blocked' }]), 'blocked');
  assert.equal(parseUsernameStatePayload('claimed'), 'claimed');
  assert.equal(parseUsernameStatePayload([{ status: 'self' }]), 'self');
  assert.equal(parseUsernameStatePayload([{ status: 'something-else' }]), 'unknown');
  assert.equal(parseUsernameStatePayload(null), 'unknown');
  assert.equal(parseUsernameStatePayload([]), 'unknown');
  assert.equal(parseUsernameStatePayload({}), 'unknown');
});

test('اسم متاح: متاح فعلاً ورسالة الإتاحة', async () => {
  const client = makeClient({ data: [{ status: 'available' }] });
  const result = await checkUsernameAvailability('a', client);

  assert.deepEqual(client.calls, [{ fn: 'aani_username_status', args: { p_username: 'a' } }]);
  assert.equal(result.verified, true);
  assert.equal(result.state, 'available');
  assert.equal(result.available, true);
  assert.equal(result.message, USERNAME_MESSAGES.available);
});

test('اسم محجوز أو ممنوع أو مأخوذ من غيري: غير متاح', async () => {
  for (const [status, message, state] of [
    ['reserved', USERNAME_MESSAGES.reserved, 'reserved'],
    ['blocked', USERNAME_MESSAGES.blocked, 'blocked'],
    ['claimed', USERNAME_MESSAGES.taken, 'claimed'],
  ] as const) {
    const client = makeClient({ data: [{ status }] });
    const result = await checkUsernameAvailability('vip', client);
    assert.equal(result.available, false, status);
    assert.equal(result.verified, true, status);
    assert.equal(result.state, state);
    assert.equal(result.message, message);
  }
});

test('اسمي الحالي: متاح لحامله (لا يُعامل كاسم محجوز لغيره)', async () => {
  const client = makeClient({ data: [{ status: 'self' }] });
  const result = await checkUsernameAvailability('AA', client);

  assert.deepEqual(client.calls[0].args, { p_username: 'aa' }, 'the username is normalized before the call');
  assert.equal(result.available, true);
  assert.equal(result.state, 'self');
  assert.equal(result.message, USERNAME_MESSAGES.own);
});

test('فشل الخدمة أو الدالة غير المثبتة: لا ادعاء إتاحة', async () => {
  for (const error of [
    { code: '42883', message: 'function does not exist' },
    { code: 'PGRST202', message: 'not found' },
    { code: '500', message: 'boom' },
  ]) {
    const client = makeClient({ error });
    const result = await checkUsernameAvailability('user1', client);
    assert.equal(result.available, false, `error ${error.code}`);
    assert.equal(result.verified, false);
    assert.equal(result.state, 'unknown');
    assert.equal(result.message, USERNAME_MESSAGES.checkUnavailable);
  }

  const throwing = await checkUsernameAvailability('user1', makeClient({ throws: true }));
  assert.equal(throwing.available, false);
  assert.equal(throwing.verified, false);
});

test('قيمة غير مفهومة من الخادم: غير متحقق وليست متاحة', async () => {
  const client = makeClient({ data: [{ status: 'maybe' }] });
  const result = await checkUsernameAvailability('ab', client);
  assert.equal(result.state, 'unknown');
  assert.equal(result.available, false);
  assert.equal(result.verified, false);
});

test('إدخال غير صالح لا يستهلك طلباً على الخادم', async () => {
  const client = makeClient({ data: [{ status: 'available' }] });
  for (const value of ['', 'a b', 'user-name', 'مستخدم', 'a'.repeat(33)]) {
    const result = await checkUsernameAvailability(value, client);
    assert.equal(result.available, false, JSON.stringify(value));
    assert.equal(result.verified, false);
  }
  assert.deepEqual(client.calls, [], 'no server call for an invalid input');
});
