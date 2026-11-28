import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCoreAccountRole,
  CORE_ACCOUNT_ROLE_RPC,
  CORE_ACCOUNT_ROLE_RPC_LEGACY,
} from '../services/rbac';
import { logCoreAudit, CORE_AUDIT_RPC } from '../services/audit';
import { setCoreAccountsSupabaseClient } from '../services/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeSupabaseClient(rpcResults: Record<string, unknown>): SupabaseClient {
  return {
    rpc: async (_name: string, _params: unknown) => {
      const name = String(_name);
      if (rpcResults[name] === undefined) {
        return { data: null, error: new Error(`RPC غير معروف: ${name}`) };
      }
      return { data: rpcResults[name], error: null };
    },
  } as unknown as SupabaseClient;
}

test('عقد RPC الدور: يستخدم aani_current_account_role كعقد أساسي (أو aani_core_account_role كبديل)', () => {
  assert.equal(CORE_ACCOUNT_ROLE_RPC, 'aani_current_account_role');
  assert.equal(CORE_ACCOUNT_ROLE_RPC_LEGACY, 'aani_core_account_role');
});

test('getCoreAccountrole يُرجع الدور من الخادم عند نجاح RPC', async () => {
  setCoreAccountsSupabaseClient(makeSupabaseClient({ [CORE_ACCOUNT_ROLE_RPC]: { role: 'admin' } }));
  const role = await getCoreAccountRole();
  assert.equal(role, 'admin');
  setCoreAccountsSupabaseClient(null);
});

test('getCoreAccountrole يُرجع founder للمؤسس', async () => {
  setCoreAccountsSupabaseClient(makeSupabaseClient({ [CORE_ACCOUNT_ROLE_RPC]: { role: 'founder' } }));
  const role = await getCoreAccountRole();
  assert.equal(role, 'founder');
  setCoreAccountsSupabaseClient(null);
});

test('getCoreAccountrole يُرجع null عند خطأ الخادم (fail-closed، لا يُمنح دور)', async () => {
  setCoreAccountsSupabaseClient(makeSupabaseClient({ [CORE_ACCOUNT_ROLE_RPC]: null }));
  // makeSupabaseClient يعيد error للرpc؟ هنا نُجبر عبر كائن مخصص.
  const failing = {
    rpc: async () => ({ data: null, error: new Error('خطأ خادم') }),
  } as unknown as SupabaseClient;
  setCoreAccountsSupabaseClient(failing);
  const role = await getCoreAccountRole();
  assert.equal(role, null);
  setCoreAccountsSupabaseClient(null);
});

test('getCoreAccountrole يُرجع null عند غياب عميل Supabase', async () => {
  setCoreAccountsSupabaseClient(null);
  const role = await getCoreAccountRole();
  assert.equal(role, null);
});

test('عقد التدقيق: يستخدم اسم الدالة aani_core_audit_log', () => {
  assert.equal(CORE_AUDIT_RPC, 'aani_core_audit_log');
});

test('logCoreAudit يُستدعي RPC التدقيق بالparaaterات المتوقعة', async () => {
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
  assert.equal((captured?.params as any)?.p_result, 'ok');
  setCoreAccountsSupabaseClient(null);
});

test('logCoreAudit لا يُفشل عند غياب العميل (يعيد ok=false)', async () => {
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
