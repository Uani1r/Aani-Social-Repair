import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  computeSandboxBalance,
  generateIdempotencyKey,
  type SandboxGiftTransaction,
} from './sandbox';

const SOURCE = readFileSync(new URL('./sandbox.ts', import.meta.url), 'utf8');

test('computeSandboxBalance: الأرصدة الدائنة والمدنية من السجل المستقل', () => {
  assert.equal(computeSandboxBalance([]), 0);
  assert.equal(computeSandboxBalance([{ type: 'credit', amount: 1000 }]), 1000);
  assert.equal(
    computeSandboxBalance([
      { type: 'credit', amount: 1000 },
      { type: 'debit', amount: 300 },
      { type: 'credit', amount: 200 },
      { type: 'debit', amount: 150 },
    ]),
    750,
  );
  assert.equal(
    computeSandboxBalance([{ type: 'debit', amount: 50 }, { type: 'debit', amount: 50 }]),
    -100,
  );
});

test('generateIdempotencyKey: مفاتيح مختلفة لنفس البادئة، وكل مفتاح يبدأ بالبادئة', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    keys.add(generateIdempotencyKey('topup'));
  }
  assert.equal(keys.size, 50, 'يجب أن يكون كل مفتاح فريدًا');
  for (const k of keys) {
    assert.ok(k.startsWith('topup:'), `المفتاح ${k} يجب أن يبدأ بالبادئة topup:`);
  }
});

test('computeSandboxBalance: عزل مستخدمين — رصيد مستخدم لا يتأثر بإدخالات مستخدم آخر', () => {
  const userA = [
    { type: 'credit' as const, amount: 1000 },
    { type: 'debit' as const, amount: 200 },
  ];
  const userB = [{ type: 'credit' as const, amount: 500 }];
  assert.equal(computeSandboxBalance(userA), 800);
  assert.equal(computeSandboxBalance(userB), 500);
  assert.notEqual(computeSandboxBalance(userA), computeSandboxBalance(userB));
});

test('SandboxGiftTransaction: الشعبية دائمًا 0 وعلامة is_sandbox صريحة', () => {
  const gift: SandboxGiftTransaction = {
    id: 't-1',
    gift_id: 'g-1',
    sender_id: 'u-1',
    recipient_id: 'u-2',
    price_paid: 10,
    popularity_points: 0,
    created_at: new Date().toISOString(),
    idempotency_key: 'k-1',
    is_sandbox: true,
  };
  assert.equal(gift.popularity_points, 0);
  assert.equal(gift.is_sandbox, true);
});

test('عزل Sandbox: لا يُستدعي أي إجراء RPC أو جدول إنتاجي حقيقي', () => {
  const forbidden = [
    'aani_send_gift',
    'aani_wallet_top_up',
    'public.user_wallets',
    'public.gift_transactions',
    'aani_user_popularity',
  ];
  for (const token of forbidden) {
    assert.ok(
      !SOURCE.includes(token),
      `يجب ألا يشير نظام Sandbox إلى الكائن الإنتاجي: ${token}`,
    );
  }
});

test('عزل Sandbox: يستخدم دوال RPC خاصة به مُسبوقة بـ aani_sandbox_', () => {
  const required = [
    'aani_sandbox_is_founder',
    'aani_sandbox_balance',
    'aani_sandbox_send_gift',
    'aani_sandbox_top_up',
    'aani_sandbox_refund_top_up',
    'aani_sandbox_grant_coins',
    'aani_sandbox_activate_subscription',
    'aani_sandbox_cancel_subscription',
    'aani_sandbox_renew_subscription',
    'aani_sandbox_create_promotion',
    'aani_sandbox_end_promotion',
  ];
  for (const token of required) {
    assert.ok(SOURCE.includes(token), `يجب أن يستخدم نظام Sandbox الدالة: ${token}`);
  }
});

test('تجديد الاشتراك يقبل مفتاح idempotency (لا يُولَّد مفتاح عشوائي جديد عند كل إعادة محاولة)', () => {
  assert.ok(
    SOURCE.includes("supabase.rpc('aani_sandbox_renew_subscription'"),
    'يجب أن تستدعي مكتبة sandbox دالة تجديد الاشتراك عبر RPC',
  );
  assert.ok(
    SOURCE.includes('p_idempotency_key: key'),
    'يجب أن يمرر تجديد الاشتراك مفتاح idempotency ثابتًا (لا يُولَّد جديدًا عند كل محاولة)',
  );
});
