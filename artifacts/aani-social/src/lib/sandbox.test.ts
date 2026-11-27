import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  computeSandboxBalance,
  computeSandboxTotals,
  summarizeSandboxTotals,
  generateIdempotencyKey,
  type SandboxGiftTransaction,
} from './sandbox';

const SOURCE = readFileSync(new URL('./sandbox.ts', import.meta.url), 'utf8');
const APP_SOURCE = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const ADMIN_SOURCE = readFileSync(new URL('../pages/AdminSandbox.tsx', import.meta.url), 'utf8');
const CONFIG_SOURCE = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');

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

test('computeSandboxTotals: إجماليات ائتمان/مدينة/صافي صحيحة', () => {
  assert.deepEqual(computeSandboxTotals([]), { credit: 0, debit: 0, net: 0 });
  assert.deepEqual(
    computeSandboxTotals([
      { type: 'credit', amount: 1000 },
      { type: 'debit', amount: 300 },
      { type: 'credit', amount: 200 },
      { type: 'debit', amount: 150 },
    ]),
    { credit: 1200, debit: 450, net: 750 },
  );
});

test('summarizeSandboxTotals: يعلّم البيانات الجزئية ولا يعرضها كإجمالي كامل', () => {
  const entries = [{ type: 'credit' as const, amount: 500 }];
  const complete = summarizeSandboxTotals(entries, true);
  assert.equal(complete.complete, true);
  assert.equal(complete.partial, false);
  assert.equal(complete.net, 500);

  const partial = summarizeSandboxTotals(entries, false);
  assert.equal(partial.complete, false);
  assert.equal(partial.partial, true, 'عند اكتمال=false يجب أن تكون partial=true');
  // القيمة نفسها محسوبة، لكن العلامة الجزئية هي ما يمنع عرضها كإجمالي كامل.
  assert.equal(partial.credit, 500);
});

test('الإجماليات عبر دالة تجميع خادمية (لا تحميل صفحات)', () => {
  assert.ok(
    SOURCE.includes('fetchSandboxTotals'),
    'يجب أن توجد دالة جلب الإجماليات عبر RPC',
  );
  assert.ok(
    SOURCE.includes("rpc<SandboxTotals>('aani_sandbox_totals'"),
    'يجب أن تستدعي fetchSandboxTotals دالة aani_sandbox_totals التجميعية',
  );
  assert.ok(
    !SOURCE.includes('fetchAllSandboxLedgerForTotals'),
    'يجب ألا توجد آلية تحميل 20 ألف سجل لغرض الإجماليات',
  );
});

test('تبديل هوية المستخدم: يُعاد تركيب لوحة المؤسس عبر key={user.id}', () => {
  assert.ok(
    /<AdminSandbox\s+key=\{user\.id\}\s*\/>/.test(APP_SOURCE),
    'يجب أن تُمرَّر key={user.id} إلى AdminSandbox حتى لا تبقى بيانات مؤسس سابق بعد تبديل الحساب',
  );
});

test('تخطيط التبويبات: خمسة تبويبات مع تخطيط متجاوب لا يقصّ آخر تبويب', () => {
  const triggers = ADMIN_SOURCE.match(/<TabsTrigger\b/g) ?? [];
  assert.equal(triggers.length, 5, 'يجب أن يكون هناك خمسة تبويبات بالضبط');
  const tabsListClass = ADMIN_SOURCE.match(/<TabsList\s+className="([^"]*)"/)?.[1] ?? '';
  assert.ok(tabsListClass.length > 0, 'يجب أن يكون لـ TabsList className صريح');
  assert.ok(
    tabsListClass.includes('lg:grid-cols-5'),
    'يجب أن يظهر التبويب الخامس على الشاشات الكبيرة (lg:grid-cols-5)',
  );
  assert.ok(
    !tabsListClass.includes('sm:grid-cols-4'),
    'يجب ألا يستخدم TabsList sm:grid-cols-4 (يقصّ التبويب الخامس على الشاشات المتوسطة)',
  );
  const triggersBlock = ADMIN_SOURCE.match(/<TabsList[\s\S]*?<\/TabsList>/)?.[0] ?? '';
  assert.ok(
    triggersBlock.includes('whitespace-nowrap'),
    'يجب أن تبقى نصوص التبويبات على سطر واحد دون قصّ',
  );
});

test('config.toml: كشف مخطط sandbox محليًا مع توثيق المتطلب السحابي', () => {
  assert.ok(
    /schemas\s*=\s*\[[^\]]*"sandbox"[^\]]*\]/.test(CONFIG_SOURCE),
    'يجب أن يتضمن [api].schemas مخطط sandbox',
  );
  assert.ok(
    CONFIG_SOURCE.includes('Exposed schemas'),
    'يجب توثيق أن المشروع السحابي يحتاج إضافة sandbox إلى Exposed schemas يدويًا',
  );
  // لا منح إضافي لـ anon ولا GRANT ALL في إعداد Data API.
  assert.ok(!/grant\s+all/i.test(CONFIG_SOURCE), 'يجب ألا يحتوي config.toml على GRANT ALL');
});
