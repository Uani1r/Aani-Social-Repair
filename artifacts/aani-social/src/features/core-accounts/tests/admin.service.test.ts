import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coreAdminBanUser,
  coreAdminModerateContent,
  coreAdminReadAudit,
} from '../admin/service';
import { setCoreAccountsSupabaseClient } from '../services/supabase';
import type { CoreAccountRole } from '../types/account';
import type { SupabaseClient } from '@supabase/supabase-js';

type RpcImpl = (name: string, params: unknown) => Promise<{ data: unknown; error: unknown | null }>;

function makeClient(impl: RpcImpl): SupabaseClient {
  return { rpc: impl } as unknown as SupabaseClient;
}

function resetClient(): void {
  setCoreAccountsSupabaseClient(null);
}

/**
 * يُنشئ عميلاً يُعيد دوراً محدداً من aani_current_account_role، وخيارياً
 * نتيجة لـ aani_is_admin.
 */
function clientWithRole(role: CoreAccountRole | null, isAdminResult?: boolean): SupabaseClient {
  return makeClient(async (name) => {
    if (name === 'aani_current_account_role') {
      return { data: role, error: null };
    }
    if (name === 'aani_is_admin' && isAdminResult !== undefined) {
      return { data: isAdminResult, error: null };
    }
    return { data: null, error: new Error(`RPC غير متوقع: ${name}`) };
  });
}

const nonAdminRoles: CoreAccountRole[] = ['official', 'user'];

for (const role of nonAdminRoles) {
  test(`حظر المستخدمين يُمرَّض لـ ${role} (لا reaches RPC الحظر)`, async () => {
    setCoreAccountsSupabaseClient(clientWithRole(role));
    const result = await coreAdminBanUser({
      userId: 'u-target',
      actorRole: role,
      reason: 'محاولة حظر',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error?.message);
    resetClient();
  });
}

for (const role of nonAdminRoles) {
  test(`الإشراف على المحتوى يُمرَّض لـ ${role}`, async () => {
    setCoreAccountsSupabaseClient(clientWithRole(role));
    const result = await coreAdminModerateContent({
      targetType: 'post',
      targetId: 'p-1',
      action: 'hide',
      reason: 'محاولة إشراف',
      actorRole: role,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error?.message);
    resetClient();
  });
}

for (const role of nonAdminRoles) {
  test(`قراءة التدقيق تُمرَّض لـ ${role}`, async () => {
    setCoreAccountsSupabaseClient(clientWithRole(role));
    const result = await coreAdminReadAudit({ actorRole: role });
    assert.equal(result.ok, false);
    assert.ok(result.error?.message);
    resetClient();
  });
}

test('المؤسس الموثق خادمياً يُسمح له بدخول عمليات الإدارة (حظر)', async () => {
  setCoreAccountsSupabaseClient(clientWithRole('founder'));
  const result = await coreAdminBanUser({
    userId: 'u-target',
    actorRole: 'founder',
    reason: 'حظر مستخدم مخترق',
  });
  // لا دالة RPC آمنة للحظر → تُعاد ok:false مع توضيح، ولكن التحقق من الصلاحية نجح.
  assert.equal(result.ok, false);
  assert.ok(result.error?.message.includes('غير مربوطة بخادم آمن'));
  resetClient();
});

test('المسؤول المؤكد عبر aani_is_admin() يُسمح له بدخول عمليات الإدارة (حظر)', async () => {
  setCoreAccountsSupabaseClient(clientWithRole('admin', true));
  const result = await coreAdminBanUser({
    userId: 'u-target',
    actorRole: 'admin',
    reason: 'حظر مستخدم مخترق',
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.message.includes('غير مربوطة بخادم آمن'));
  resetClient();
});

test('المسؤول غير المؤكد عبر aani_is_admin() يُمرَّض (فشل التحقق من الخادم)', async () => {
  setCoreAccountsSupabaseClient(clientWithRole('admin', false));
  const result = await coreAdminBanUser({
    userId: 'u-target',
    actorRole: 'admin',
    reason: 'حظر مستخدم مخترق',
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.message.includes('لم يؤكد الخادم'));
  resetClient();
});

test('فشل جلب الدور من الخادم يُمرَّض جميع عمليات الإدارة', async () => {
  // aani_current_account_role يعيد خطأ → getCoreAccountRole يعيد null → مرفوض.
  setCoreAccountsSupabaseClient(makeClient(async () => ({
    data: null,
    error: new Error('فشل الخادم'),
  })));
  const result = await coreAdminBanUser({
    userId: 'u-target',
    actorRole: 'admin',
    reason: 'حظر',
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.message.includes('غير محسومة'));
  resetClient();
});

test('الدور غير الصالح من الخادم يُمرَّض (لا يُمنح دور إداري)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: 'superuser', error: null })));
  const result = await coreAdminBanUser({
    userId: 'u-target',
    actorRole: 'admin',
    reason: 'حظر',
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.message.includes('غير محسومة'), 'يجب أن يُرفض الدور غير الصالح لأن getCoreAccountRole أعاد null');
  resetClient();
});

test('عمليات الإدارة غير المربوطة لا تدّعي نجاحاً حتى لدور صالح', async () => {
  setCoreAccountsSupabaseClient(clientWithRole('founder'));

  const ban = await coreAdminBanUser({ userId: 'u-1', actorRole: 'founder', reason: 'x' });
  assert.equal(ban.ok, false);
  assert.ok(ban.error);

  const mod = await coreAdminModerateContent({
    targetType: 'post',
    targetId: 'p-1',
    action: 'hide',
    reason: 'x',
    actorRole: 'founder',
  });
  assert.equal(mod.ok, false);
  assert.ok(mod.error);

  resetClient();
});
