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
import { setCoreAccountsSupabaseClient } from '../services/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

type RpcImpl = (name: string, params: unknown) => Promise<{ data: unknown; error: unknown | null }>;

function makeClient(impl: RpcImpl): SupabaseClient {
  return { rpc: impl } as unknown as SupabaseClient;
}

function resetClient(): void {
  setCoreAccountsSupabaseClient(null);
}

test('عقد الدور: يستخدم aani_current_account_role كعقد أساسي', () => {
  assert.equal(CORE_ACCOUNT_ROLE_RPC, 'aani_current_account_role');
  assert.equal(CORE_ACCOUNT_ROLE_RPC_LEGACY, 'aani_core_account_role');
});

test('getCoreAccountrole يُرجع الدور من aani_current_account_role عند النجاح', async () => {
  setCoreAccountsSupabaseClient(makeClient(async (name) => {
    assert.equal(name, CORE_ACCOUNT_ROLE_RPC);
    return { data: 'admin', error: null };
  }));
  const role = await getCoreAccountRole();
  assert.equal(role, 'admin');
  resetClient();
});

test('getCoreAccountrole يرجع founder من العقد الأساسي', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: 'founder', error: null })));
  const role = await getCoreAccountRole();
  assert.equal(role, 'founder');
  resetClient();
});

test('getCoreAccountrole يسقط إلى العقد الأlegacy عند خطأ PGRST202 مع اسم الدالة الأساسية', async () => {
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

test('getCoreAccountrole يسقط إلى العقد الأlegacy عند خطأ 42883 مع اسم الدالة الأساسية', async () => {
  let calls: string[] = [];
  setCoreAccountsSupabaseClient(makeClient(async (name) => {
    calls.push(name);
    if (name === CORE_ACCOUNT_ROLE_RPC) {
      throw { code: '42883', message: `function public.${CORE_ACCOUNT_ROLE_RPC}() does not exist` };
    }
    return { data: 'admin', error: null };
  }));
  const role = await getCoreAccountRole();
  assert.equal(role, 'admin');
  assert.deepEqual(calls, [CORE_ACCOUNT_ROLE_RPC, CORE_ACCOUNT_ROLE_RPC_LEGACY]);
  resetClient();
});

test('getCoreAccountrole لا يسقط عند خطأ اتصال (رمز خطأ غير معروف)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => {
    throw { code: 'UNKNOWN_ERROR', message: 'network failure' };
  }));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole لا يسقط عند خطأ صلاحيات (رمز 42501)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => {
    throw { code: '42501', message: 'permission denied for function aani_current_account_role' };
  }));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole يرجع null للدور غير الصالح حتى لو حققت RPC', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: 'superuser', error: null })));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole يرجع null عند خطأ الخادم (fail-closed، لا يُمنح دور)', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: null, error: new Error('خطأ خادم') })));
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  resetClient();
});

test('getCoreAccountrole يرجع null عند غياب عميل Supabase', async () => {
  setCoreAccountsSupabaseClient(null);
  const role = await getCoreAccountRole();
  assert.equal(role, null);
});

test('getCoreAccountrole يرجع null عند غياب عميل Supabase', async () => {
  setCoreAccountsSupabaseClient(null);
  const role = await getCoreAccountRole();
  assert.equal(role, null);
});

test('عقد الصلاحية: يستخدم aani_has_permission', () => {
  assert.equal(CORE_HAS_PERMISSION_RPC, 'aani_has_permission');
});

test('coreHasPermissionServer يُرجع نتيجة التحقق من الخادم', async () => {
  setCoreAccountsSupabaseClient(makeClient(async (name) => {
    assert.equal(name, CORE_HAS_PERMISSION_RPC);
    return { data: true, error: null };
  }));
  const ok = await coreHasPermissionServer('core.admin.users.manage');
  assert.equal(ok, true);
  resetClient();
});

test('coreHasPermissionServer يُرجع false عند خطأ الخادم', async () => {
  setCoreAccountsSupabaseClient(makeClient(async () => ({ data: null, error: new Error('فشل') })));
  const ok = await coreHasPermissionServer('core.admin.users.manage');
  assert.equal(ok, false);
  resetClient();
});

test('عقد المسؤول: يستخدم aani_is_admin', () => {
  assert.equal(CORE_IS_ADMIN_RPC, 'aani_is_admin');
});

test('coreIsAdminServer يُرجع boolean من الخادم', async () => {
  setCoreAccountsSupabaseClient(makeClient(async (name) => {
    assert.equal(name, CORE_IS_ADMIN_RPC);
    return { data: true, error: null };
  }));
  assert.equal(await coreIsAdminServer(), true);
  resetClient();
});

test('عقد الحساب الرسمي: يستخدم aani_is_official', () => {
  assert.equal(CORE_IS_OFFICIAL_RPC, 'aani_is_official');
});

test('coreIsOfficialServer يُرجع boolean من الخادم', async () => {
  setCoreAccountsSupabaseClient(makeClient(async (name) => {
    assert.equal(name, CORE_IS_OFFICIAL_RPC);
    return { data: false, error: null };
  }));
  assert.equal(await coreIsOfficialServer(), false);
  resetClient();
});
