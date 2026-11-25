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

test('generateIdempotencyKey: مدفوع ببادئة وفريد لكل استدعاء', () => {
  const k1 = generateIdempotencyKey('topup');
  const k2 = generateIdempotencyKey('topup');
  assert.ok(k1.startsWith('topup:'));
  assert.ok(k2.startsWith('topup:'));
  assert.notEqual(k1, k2);
  assert.ok(generateIdempotencyKey('gift').startsWith('gift:'));
  assert.ok(generateIdempotencyKey('grant').startsWith('grant:'));
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
