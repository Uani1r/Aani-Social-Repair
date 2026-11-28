/**
 * خدمة سجل التدقيق للعمليات الإدارية الحساسة.
 *
 * ملاحظة أمنية إلزامية: دالة aani_core_audit_log غير موجودة في Supabase حالياً.
 * لا تدّعي هذه الوحدة أن التدقيق العام يعمل قبل توفير عقد خادمي فعلي.
 *
 * ما هو موجود فعلياً (من ترحيل 20270306000001_aani_sandbox_financial.sql):
 *   جدول sandbox.admin_actions (id, actor_user_id, action, target_type, target_id,
 *   reason, result, created_at) — سياسة قراءة للمصادقين حيث الفاعل هو auth.uid()
 *   أو المستخدم مؤسس عبر aani_sandbox_is_founder(). لا سياسة إدراج مباشرة للعميل.
 *   دوال RPC المالية (aani_sandbox_grant_coins، aani_sandbox_refund_top_up، إلخ)
 *   تسجل داخل sandbox.admin_actions من جانب الخادم (security definer).
 *
 * لذلك فإن تدقيق العمليات المالية المؤسس يتم بالفعل داخل الدوال RPC الخادمة.
 * تدقيق العمليات العامة (حظر، إشراف، منشورات رسمية، إلخ) يحتاج إلى دالة RPC
 * جديدة لإدراج في sandbox.admin_actions — أضفنا مقترح SQL للمراجعة في
 * migrations/aani_core_audit_log.proposal.sql ولم يُطبَّق على الإنتاج.
 *
 * في غياب aani_core_audit_log، تُعيد دوال التدقيق هنا { ok: false, error }
 * مع تحذير واضح، ولا تُخفي الفشل ولا تُنسب نجاحاً زائفاً.
 */

import type { CoreAuditEntry, CoreAuditInput, CoreAuditResult } from '../types/audit';
import { getCoreAccountsSupabaseClient } from './supabase';

export type { CoreAuditEntry, CoreAuditInput, CoreAuditResult };
export const CORE_AUDIT_RPC = 'aani_core_audit_log';

export type CoreAuditRpcResult = { ok: boolean; error?: Error | null };

/** محاولة تسجيل تدقيق عبر RPC. إذا غابت الدالة، تُعاد { ok: false, error } ولا يُClaim نجاح. */
export async function logCoreAudit(input: CoreAuditInput): Promise<CoreAuditRpcResult> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) {
    console.warn('[core-accounts] عميل Supabase غير متاح؛ التدقيق غير متاح:', input.action);
    return { ok: false, error: new Error('supabase client unavailable') };
  }

  try {
    const { error } = await supabase.rpc(CORE_AUDIT_RPC, {
      p_action: input.action,
      p_target_type: input.targetType,
      p_target_id: input.targetId ?? null,
      p_reason: input.reason,
      p_result: input.result,
    });
    if (error) {
      // الدالة غير موجودة أو فشل — لا نُClaim نجاح التدقيق. نُعيد 실패 بشكل صريح.
      console.warn('[core-accounts] دالة التدقيق aani_core_audit_log غير متاحة أو فشلت:', error.message);
      return { ok: false, error };
    }
    return { ok: true, error: null };
  } catch (error) {
    console.warn('[core-accounts] استثناء أثناء تسجيل التدقيق:', error);
    return { ok: false, error: error as Error };
  }
}

/** سجّل نتيجة عملية إدارية حساسة. يُعيد نتيجة RPC كما هي (لا يُخفي فشلاً). */
export async function auditAdminAction(params: {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason: string;
  ok: boolean;
}): Promise<CoreAuditRpcResult> {
  return logCoreAudit({
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId ?? null,
    reason: params.reason,
    result: params.ok ? ('ok' as CoreAuditResult) : ('error' as CoreAuditResult),
  });
}

/** اقرأ إدخالات التدقيق من sandbox.admin_actions عبر RLS (الفاعل هو الجلسة أو مؤسس). */
export async function fetchCoreAuditEntries(params: {
  page?: number;
  pageSize?: number;
  actorId?: string | null;
}): Promise<{ data: CoreAuditEntry[] | null; error: Error | null }> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) {
    return { data: null, error: new Error('supabase client unavailable') };
  }
  const pageSize = params.pageSize ?? 50;
  const from = ((params.page ?? 0) * pageSize);
  let q = supabase
    .from('sandbox.admin_actions')
    .select('id, actor_user_id, action, target_type, target_id, reason, result, created_at')
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);
  if (params.actorId) q = q.eq('actor_user_id', params.actorId);
  const { data, error } = await q;
  if (error) return { data: null, error };
  return {
    data: (data as unknown as CoreAuditEntry[] ?? []),
    error: null,
  };
}
