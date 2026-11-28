import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coreGrantSandboxCoins,
  coreRefundSandboxTopUp,
  requireFounderRole,
} from '../founder/service';
import { setCoreAccountsSupabaseClient } from '../services/supabase';
import type { CoreAccountRole } from '../types/account';
import type { SandboxMutationResult } from '@/lib/sandbox';

type GrantCall = { userId: string; amount: number; reason: string };

function mockClient(): { rpcCalls: string[] } & { rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: unknown | null }> } {
  const rpcCalls: string[] = [];
  const rpc = async (name: string, params: unknown) => {
    rpcCalls.push(name);
    return { data: null, error: null };
  };
  return { rpcCalls, rpc };
}

function grantOk(): SandboxMutationResult & { amount?: number; balance?: number } {
  return { ok: true, amount: 500, balance: 1500 };
}

function refundOk(): SandboxMutationResult & { status?: string; amount?: number; userId?: string } {
  return { ok: true, status: 'refunded', amount: 300, userId: 'u-1' };
}

const nonFounderRoles: CoreAccountRole[] = ['admin', 'official', 'user'];

for (const role of nonFounderRoles) {
  test(`منح عملات يُرفض لـ ${role} قبل الوصول إلى RPC المالي`, async () => {
    const client = mockClient();
    setCoreAccountsSupabaseClient(client as unknown as never);
    let grantCalled = false;
    const result = await coreGrantSandboxCoins({
      userId: 'u-target',
      amount: 500,
      reason: 'منح تجريبي',
      actorRole: role,
      _grantCoinsFn: async () => { grantCalled = true; return grantOk(); },
    });
    assert.equal(result.ok, false);
    assert.equal(grantCalled, false, 'لا يُستدعى RPC المالي لغير المؤسس');
    // التدقيق يُسجل محاولة الرفض عبر العميل المحقون (mock) — هذا متوقع وليس خطأً.
    assert.ok(result.error?.message);
  });
}

test('منح عملات ينجح للمؤسس ويُستدعى RPC المالي', async () => {
  const client = mockClient();
  setCoreAccountsSupabaseClient(client as unknown as never);
  let grantCalledWith: GrantCall | null = null;
  const result = await coreGrantSandboxCoins({
    userId: 'u-target',
    amount: 500,
    reason: 'منح تجريبي',
    actorRole: 'founder',
    _grantCoinsFn: async (p) => { grantCalledWith = p; return grantOk(); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.amount, 500);
  assert.deepEqual(grantCalledWith, { userId: 'u-target', amount: 500, reason: 'منح تجريبي' });
});

for (const role of nonFounderRoles) {
  test(`استرداد شحن يُرفض لـ ${role} قبل الوصول إلى RPC المالي`, async () => {
    const client = mockClient();
    setCoreAccountsSupabaseClient(client as unknown as never);
    let refundCalled = false;
    const result = await coreRefundSandboxTopUp({
      topUpId: 'tu-1',
      reason: 'استرداد تجريبي',
      actorRole: role,
      _refundFn: async () => { refundCalled = true; return refundOk(); },
    });
    assert.equal(result.ok, false);
    assert.equal(refundCalled, false, 'لا يُستدعاء RPC الاسترداد لغير المؤسس');
    assert.ok(result.error?.message);
  });
}

test('استرداد شحن ينجح للمؤسس ويُستدعى RPC المالي', async () => {
  const client = mockClient();
  setCoreAccountsSupabaseClient(client as unknown as never);
  let refundCalledWith: { topUpId: string; reason: string } | null = null;
  const result = await coreRefundSandboxTopUp({
    topUpId: 'tu-1',
    reason: 'استرداد تجريبي',
    actorRole: 'founder',
    _refundFn: async (p) => { refundCalledWith = p; return refundOk(); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'refunded');
  assert.deepEqual(refundCalledWith, { topUpId: 'tu-1', reason: 'استرداد تجريبي' });
});

test('فشل RPC المالي يُ_propagate خطاً للمؤسس (لا يُClaim نجاحاً)', async () => {
  let threw = false;
  try {
    await coreGrantSandboxCoins({
      userId: 'u-target',
      amount: 500,
      reason: 'منح تجريبي',
      actorRole: 'founder',
      _grantCoinsFn: async () => { throw new Error('فشل RPC مالي'); },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'يجب أن يُPropagate فشل العميل/RPC');
});

test('عمليات الإدارة والنشر غير المربوطة لا تدّعي نجاحاً حتى لدور صالح', async () => {
  // تُستورد ديناميكياً لتجنب تأثيرivial على ملفات أخرى
  const { coreAdminBanUser } = await import('../admin/service');
  const { coreAdminModerateContent } = await import('../admin/service');
  const { coreOfficialCreatePost } = await import('../official/service');
  const { coreOfficialSendAnnouncement } = await import('../official/service');

  const ban = await coreAdminBanUser({ userId: 'u-1', actorRole: 'admin', reason: 'x' });
  assert.equal(ban.ok, false, 'حظر المستخدم لا يجب أن يدّعي نجاحاً');
  assert.ok(ban.error);

  const mod = await coreAdminModerateContent({ targetType: 'post', targetId: 'p-1', action: 'hide', reason: 'x', actorRole: 'admin' });
  assert.equal(mod.ok, false, 'الإشراف لا يجب أن يدّعي نجاحاً');
  assert.ok(mod.error);

  const post = await coreOfficialCreatePost({ content: 'سلام', actorRole: 'official' });
  assert.equal(post.ok, false, 'إنشاء منشور رسمي لا يجب أن يدّعي نجاحاً');
  assert.ok(post.error);

  const ann = await coreOfficialSendAnnouncement({ content: 'تنبيه', actorRole: 'official' });
  assert.equal(ann.ok, false, 'إرسال إعلان رسمي لا يجب أن يدّعي نجاحاً');
  assert.ok(ann.error);
});

test('حارس المؤسس يرفض الأدوار غير المؤسس (منطقه خالص)', () => {
  for (const role of nonFounderRoles) {
    assert.equal(requireFounderRole(role).allowed, false);
    assert.ok(requireFounderRole(role).reason);
  }
  assert.equal(requireFounderRole('founder').allowed, true);
  assert.equal(requireFounderRole(null).allowed, false);
});
