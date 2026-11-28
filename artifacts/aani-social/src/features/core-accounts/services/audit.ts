/**
 * خدمة سجل التدقيق للعمليات الإدارية الحساسة.
 *
 * العمليات الحساسة (منح عملات، استرداد شحن، إدارة أدوار، إشراف محتوى، إلخ)
 * تُسجل في جدول sandbox.admin_actions عبر دالة RPC مؤمنة (security-definer)
 * تُستمد فيها هوية الفاعل من auth.uid() داخل الدالة، ولا يُوثق في إدخال
 * المتصفح.
 *
 * عقد التدقيق المطلوب (يُضاف مع ترحيل الصلاحيات أو عامل حافة مخصص):
 *   public.aani_core_audit_log(
 *     p_action text, p_target_type text, p_target_id uuid,
 *     p_reason text, p_result text
 *   ) returns void
 *   - security definer، يُInsert في جدول التدقيق (يُفترض aani_private.account_role_audit
 *     على الإنتاج؛ تُسجّل الدوال المالية للساند박س في sandbox.admin_actions من الخادم).
 *   - يمكّن تنفيذه لـ authenticated.
 *
 * في حال عدم توفر الدالة/الجدول، تُسجل المحاولة في وحدة التحكم ولا تُخفق العملية
 * الأساسية نفسها (التدقيق مكمل وليس حارسًا)، مع تحذير واضح حتى تُستكمل
 * الربط من جانب قاعدة البيانات.
 */

import type { CoreAuditInput, CoreAuditResult } from '../types/audit';
export type { CoreAuditInput, CoreAuditResult };
import { getCoreAccountsSupabaseClient } from './supabase';

export const CORE_AUDIT_RPC = 'aani_core_audit_log';

export async function logCoreAudit(input: CoreAuditInput): Promise<{ ok: boolean; error?: Error | null }> {
  const supabase = getCoreAccountsSupabaseClient();
  if (!supabase) {
    console.warn('[core-accounts] عميل Supabase غير متاح؛ لم يُسجل التدقيق:', input.action);
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
      // التدقيق مكمل: لا نُفشل العملية الأساسية بسبب欠缺 الربط الخادمي، لكن نُحذّر.
      console.warn('[core-accounts] فشل تسجيل التدقيق عبر RPC:', error.message);
      return { ok: false, error };
    }
    return { ok: true, error: null };
  } catch (error) {
    console.warn('[core-accounts] استثناء أثناء تسجيل التدقيق:', error);
    return { ok: false, error: error as Error };
  }
}

/** سجّل نتيجة عملية إدارية حساسة (مريح للاستخدام في الخدمات). */
export async function auditAdminAction(params: {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason: string;
  ok: boolean;
}): Promise<void> {
  await logCoreAudit({
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId ?? null,
    reason: params.reason,
    result: params.ok ? 'ok' : 'error',
  });
}
