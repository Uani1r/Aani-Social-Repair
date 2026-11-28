/**
 * خدمة RBAC لخادم الحسابات الأساسية.
 *
 * دور المستخدم وصلاحياته تُحلّ من جانب الخادم وحده عبر دوال RPC مؤمنة (security-definer)
 * تُقرّر الدور والصلاحية استنادًا إلى auth.uid() وجداول الصلاحيات في قاعدة البيانات،
 * وليس استنادًا إلى user_metadata أو أي قيمة يرسلها المتصفح.
 *
 * عقود RPC الفعلية في Supabase (يُفترض وجودها على المشروع الإنتاجي):
 *   public.aani_current_account_role() returns text
 *     - يُمكّن تنفيذه لـ authenticated فقط.
 *     - يرجع أحد القيم: 'founder' | 'admin' | 'official' | 'user'.
 *   public.aani_has_permission(p_key text) returns boolean
 *   public.aani_is_admin() returns boolean
 *   public.aani_is_official() returns boolean
 *
 * اسم الربط السابق aani_core_account_role يُحتفظ به كبديل للعقد القديم في حال كان
 * المنتج منشوراً به؛ تُجرّب الدالة الجديدة أولاً ثم تُسقط إلى البديل فقط عند خطأ
 * "الدالة غير موجودة". أي فشل يُعامل الجلسة كدور مستخدم عادي (fail-closed) ولا تُمنح
 * أي صلاحية إدارية بناءً على فشل الخادم.
 */

import type { CoreAccountRole } from '../types/account';
import { getCoreAccountsSupabaseClient } from './supabase';

export const CORE_ACCOUNT_ROLE_RPC = 'aani_current_account_role';
export const CORE_ACCOUNT_ROLE_RPC_LEGACY = 'aani_core_account_role';

export const CORE_HAS_PERMISSION_RPC = 'aani_has_permission';
export const CORE_IS_ADMIN_RPC = 'aani_is_admin';
export const CORE_IS_OFFICIAL_RPC = 'aani_is_official';

export type CoreRoleRpcResult = { role: CoreAccountRole | null } | null;

/** حل دور الجلسة الحالية من الخادم (fail-closed). */
export async function getCoreAccountRole(): Promise<CoreAccountRole | null> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) return null;

  const candidates = [CORE_ACCOUNT_ROLE_RPC, CORE_ACCOUNT_ROLE_RPC_LEGACY];
  let lastError: unknown | null = null;

  for (const name of candidates) {
    try {
      // العميل عام (Database = any) لذا يُمرّر اسم الدالة كنص في الموضع الأول.
      const { data, error } = await supabase.rpc(name, {});
      if (error) {
        lastError = error;
        continue;
      }
      const role = ((data as unknown as { role: CoreAccountRole | null } | null)?.role) ?? null;
      if (role && ['founder', 'admin', 'official', 'user'].includes(role)) {
        return role as CoreAccountRole;
      }
      return null;
    } catch (error) {
      lastError = error;
      const message = String(error ?? '');
      // إذا كانت الدالة غير موجودة، جرّب العقد البديل؛ أي فشل آخر يُعامل fail-closed.
      if (!message.toLowerCase().includes('function') && !message.toLowerCase().includes('does not exist')) {
        break;
      }
      continue;
    }
  }

  console.warn('[core-accounts] فشل حل الدور من الخادم:', lastError);
  return null;
}

/** التحقق من صلاحية معينة من الخادم (fail-closed). */
export async function coreHasPermissionServer(key: string): Promise<boolean> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc(CORE_HAS_PERMISSION_RPC, { p_key: key });
    if (error) {
      console.warn('[core-accounts] فشل التحقق من الصلاحية من الخادم:', error);
      return false;
    }
    return Boolean(data);
  } catch (error) {
    console.warn('[core-accounts] استثناء أثناء التحقق من الصلاحية:', error);
    return false;
  }
}

/** هل الجلسة الحالية مسؤول (من الخادم، fail-closed)? */
export async function coreIsAdminServer(): Promise<boolean> {
  return coreCheckFlagServer(CORE_IS_ADMIN_RPC);
}

/** هل الجلسة الحالية حساب رسمي (من الخادم، fail-closed)? */
export async function coreIsOfficialServer(): Promise<boolean> {
  return coreCheckFlagServer(CORE_IS_OFFICIAL_RPC);
}

async function coreCheckFlagServer(name: string): Promise<boolean> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc(name, {});
    if (error) {
      console.warn(`[core-accounts] فشل التحقق من ${name} من الخادم:`, error);
      return false;
    }
    return Boolean(data);
  } catch (error) {
    console.warn(`[core-accounts] استثناء أثناء التحقق من ${name}:`, error);
    return false;
  }
}
