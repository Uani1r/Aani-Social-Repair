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
 *     - يرجع نصاً واحداً: 'founder' | 'admin' | 'official' | 'user'.
 *   public.aani_has_permission(p_permission text) returns boolean
 *     - الوسيط هو p_permission (ليس p_key).
 *   public.aani_is_admin() returns boolean
 *   public.aani_is_official() returns boolean
 *
 * اسم الربط السابق aani_core_account_role يُحتفظ به كمرجع للتوافق العكسي فقط.
 * لا يُستخدم كبديل تلقائي إلا عند تأكيد غياب الدالة الأساسية في وقت التشغيل
 * (خطأ "الدالة غير موجودة")، وحتى ذلك الحين يُجرّب ويُتأكد من استجابته.
 * أي فشل يُعامل الجلسة كدور مستخدم عادي (fail-closed) ولا تُمنح أي صلاحية إدارية
 * بناءً على فشل الخادم.
 */

import type { CoreAccountRole } from '../types/account';
import { getCoreAccountsSupabaseClient } from './supabase';

export const CORE_ACCOUNT_ROLE_RPC = 'aani_current_account_role';
export const CORE_ACCOUNT_ROLE_RPC_LEGACY = 'aani_core_account_role';

export const CORE_HAS_PERMISSION_RPC = 'aani_has_permission';
export const CORE_IS_ADMIN_RPC = 'aani_is_admin';
export const CORE_IS_OFFICIAL_RPC = 'aani_is_official';

export type CoreRoleRpcResult = string | null;

/** الأدوار المسموحة من قبل النظام. */
const ALLOWED_ROLES: ReadonlySet<CoreAccountRole> = new Set([
  'founder',
  'admin',
  'official',
  'user',
]);

/** حل دور الجلسة الحالية من الخادم كنص مباشر (fail-closed). */
export async function getCoreAccountRole(): Promise<CoreAccountRole | null> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) return null;

  // جرّب الدالة الأساسية أولاً.
  try {
    const role = await readRoleText(supabase, CORE_ACCOUNT_ROLE_RPC);
    if (role !== null) return role;
  } catch (error) {
    const message = String(error ?? '');
    // فقط إذا كانت الدالة الأساسية غير موجودة، جرّب الربط القديم كتأكيد وجود في وقت التشغيل.
    if (!message.toLowerCase().includes('function') && !message.toLowerCase().includes('does not exist')) {
      console.warn('[core-accounts] فشل حل الدور من الخادم:', error);
      return null;
    }
    try {
      const role = await readRoleText(supabase, CORE_ACCOUNT_ROLE_RPC_LEGACY);
      if (role !== null) return role;
    } catch (legacyError) {
      // الربط القديم غائب أيضاً أو فشل → fail-closed.
      console.warn('[core-accounts] الربط القديم للدور غير متاح:', legacyError);
    }
    return null;
  }

  // الدالة الأساسية موجودة لكنها أعادت قيمة غير صالحة → معامل كالمستخدم العادي.
  return null;
}

/** اقرأ نص الدور من دالة RPC (تُرجع text وليس كائناً). */
async function readRoleText(
  supabase: ReturnType<typeof getCoreAccountsSupabaseClient> | null,
  name: string,
): Promise<CoreAccountRole | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc(name, {});
  if (error) throw error;
  const roleText = data as unknown as string;
  if (typeof roleText === 'string' && ALLOWED_ROLES.has(roleText as CoreAccountRole)) {
    return roleText as CoreAccountRole;
  }
  return null;
}

/** التحقق من صلاحية معينة من الخادم (fail-closed). الوسيط p_permission. */
export async function coreHasPermissionServer(permission: string): Promise<boolean> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc(CORE_HAS_PERMISSION_RPC, {
      p_permission: permission,
    });
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
