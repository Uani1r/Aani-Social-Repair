import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCoreAccountRole,
  CORE_ACCOUNT_ROLE_RPC,
  CORE_ACCOUNT_ROLE_RPC_LEGACY,
  CORE_HAS_PERMISSION_RPC,
  CORE_IS_ADMIN_RPC,
  CORE_IS_OFFICIAL_RPC,
  coreHasPermissionServer,
  coreIsAdminServer,
  coreIsOfficialServer,
} from '../services/rbac';
import { logCoreAudit, CORE_AUDIT_RPC } from '../services/audit';
import { setCoreAccountsSupabaseClient } from '../services/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

type RpcImpl = (name: string, params: unknown) => Promise<{ data: unknown; error: unknown | null }>;

function makeClient(impl: RpcImpl): SupabaseClient {
  return { rpc: impl } as unknown as SupabaseClient;
}

function resetClient(): void {
  setCoreAccountsSupabaseClient(null);
}

const rolesAsText: Array<[string, 'founder' | 'admin' | 'official' | 'user' | null]> = [
  ['founder', 'founder'],
  ['admin', 'admin'],
  ['official', 'official'],
  ['user', 'user'],
];

test('عقد RPC الدور: يستخدم aani_current_account_role كعقد أساسي', () => {
  assert.equal(CORE_ACCOUNT_ROLE_RPC, 'aani_current_account_role');
  assert.equal(CORE_ACCOUNT_ROLE_RPC_LEGACY, 'aani_core_account_role');
});

test('getCoreAccountrole يُرجع الدور كنص مباشرة من aani_current_account_role', async () => {
  for (const [rpcText, expected] of rolesAsText) {
    setCoreAccountsSupabaseClient(makeClient(async () => ({ data: rpcText, error: null })));
    const role = await getCoreAccountRole();
    assert.equal(role, expected, `يجب أن تُعاد '${expected}' كنص مباشر`);
    resetClient();
  }
});

test('getCoreAccountrole يُرجع null للقيمة غير الصالحة حتى لو نجحت RPC', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: 'superuser', error: null })));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole يسقط إلى الربط القديم فقط عند خطأ PGRST202 مع اسم الدالة الأساسية', async () => {
  let calls: string[] = [];
  setCoreAccountsSupabaseClient(makeClient(async (name) => {
    calls.push(name);
    if (name === CORE_ACCOUNT_ROLE_RPC) {
      throw { code: 'PGRST202', message: `function public.${CORE_ACCOUNT_ROLE_RPC}() does not exist` };
    }
    return { data: 'official', error: null };
  }));
  const role = await getCoreAccountRole();
  assert.equal(role, 'official');
  assert.deepEqual(calls, [CORE_ACCOUNT_ROLE_RPC, CORE_ACCOUNT_ROLE_RPC_LEGACY]);
  resetClient();
});

test('getCoreAccountrole لا يسقط عند خطأ عام بدون رمز غياب دالة', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => {
    throw new Error(`function public.${CORE_ACCOUNT_ROLE_RPC}() does not exist`);
  }));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole يُرجع null عند خطأ الخادم (fail-closed، لا يُمنح دور)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: null, error: new Error('خطأ خادم') })));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole يُرجع null عند غياب عميل Supabase', async () => {
  setCoreAccountsSupabaseClient(null);
  const role = await getCoreAccountRole();
  assert.equal(role, null);
});

test('عقد الصلاحية: يستخدم aani_has_permission mediates p_permission', () => {
  assert.equal(CORE_HAS_PERMISSION_RPC, 'aani_has_permission');
});

test('coreHasPermissionServer يمرّر p_permission بالاسم الصحيح وينقل نتيجة الخادم', async () => {
  let capturedPermission: string | null = null;
  setCoreAccountsSupabaseClient(makeClient(async (name, params) => {
    assert.equal(name, CORE_HAS_PERMISSION_RPC);
    capturedPermission = (params as { p_permission?: string })?.p_permission ?? null;
    return { data: true, error: null };
  }));
  const ok = await coreHasPermissionServer('core.admin.users.manage');
  assert.equal(ok, true);
  assert.equal(capturedPermission, 'core.admin.users.manage');
  resetClient();
});

test('coreHasPermissionServer يُرجع false عند خطأ الخادم (فشل RPC → رفض الصلاحية)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: null, error: new Error('فشل') })));
  const ok = await coreHasPermissionServer('core.admin.users.manage');
  assert.equal(ok, false);
  resetClient();
});

test('coreHasPermissionServer يُرجع false عند غياب العميل', async () => {
  setCoreAccountsSupabaseClient(null);
  const ok = await coreHasPermissionServer('core.admin.users.manage');
  assert.equal(ok, false);
});

test('عقد المسؤول: يستخدم aani_is_admin', () => {
  assert.equal(CORE_IS_ADMIN_RPC, 'aani_is_admin');
});

test('coreIsAdminServer ينقل نتيجة الخادم (true/false)', async () => {
  for (const flag of [true, false]) {
    setCoreAccountsSupabaseClient(makeClient(async () => ({ data: flag, error: null })));
    assert.equal(await coreIsAdminServer(), flag);
    resetClient();
  }
});

test('عقد الحساب الرسمي: يستخدم aani_is_official', () => {
  assert.equal(CORE_IS_OFFICIAL_RPC, 'aani_is_official');
});

test('coreIsOfficialServer ينقل نتيجة الخادم (true/false)', async () => {
  for (const flag of [true, false]) {
    setCoreAccountsSupabaseClient(makeClient(async () => ({ data: flag, error: null })));
    assert.equal(await coreIsOfficialServer(), flag);
    resetClient();
  }
});

test('عقد التدقيق: aani_core_audit_log هو العقد المطلوب (قد لا يكون موجوداً فعلياً)', () => {
  assert.equal(CORE_AUDIT_RPC, 'aani_core_audit_log');
});

test('logCoreAudit يُستدعي aani_core_audit_log بمعاملات صحيحة عند النجاح', async () => {
  let captured: { name: string; params: unknown } | null = null;
  const client = {
    rpc: async (name: string, params: unknown) => {
      captured = { name, params };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  setCoreAccountsSupabaseClient(client);

  const res = await logCoreAudit({
    action: 'grant_coins',
    targetType: 'user',
    targetId: 'u-1',
    reason: 'منح تجريبي',
    result: 'ok',
  });

  assert.equal(res.ok, true);
  assert.equal(captured?.name, CORE_AUDIT_RPC);
  assert.equal((captured?.params as any)?.p_action, 'grant_coins');
  assert.equal((captured?.params as any)?.p_permission, undefined, 'التدقيق لا يستخدم p_permission');
  assert.equal((captured?.params as any)?.p_result, 'ok');
  setCoreAccountsSupabaseClient(null);
});

test('logCoreAudit لا يدّعي النجاح عند غياب الدالة (يعيد ok=false)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({
    data: null,
    error: new Error(`function public.${CORE_AUDIT_RPC}() does not exist`),
  })));
  const res = await logCoreAudit({
    action: 'grant_coins',
    targetType: 'user',
    targetId: null,
    reason: 'x',
    result: 'ok',
  });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  setCoreAccountsSupabaseClient(null);
});

test('logCoreAudit لا يدّعي النجاح عند غياب العميل', async () => {
  setCoreAccountsSupabaseClient(null);
  const res = await logCoreAudit({
    action: 'grant_coins',
    targetType: 'user',
    targetId: null,
    reason: 'x',
    result: 'ok',
  });
  assert.equal(res.ok, false);
});
