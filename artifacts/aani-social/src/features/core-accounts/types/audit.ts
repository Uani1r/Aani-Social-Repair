/**
 * أنواع سجل التدقيق للعمليات الإدارية الحساسة.
 *
 * تُسجل العمليات الحساسة (منح عملات، استرداد، تعديل أدوار، حظر محتوى، إلخ)
 * عبر دالة خادمية مؤمنة (security-definer) ولا تعتمد على إدخالات المتصفح
 * لتحديد الفاعل؛ الهوية تُستمد من auth.uid() داخل الدالة نفسها.
 */

export type CoreAuditResult = 'ok' | 'error';

export interface CoreAuditInput {
  action: string; // مثال: 'grant_coins', 'refund_top_up', 'moderate_content', 'manage_role'
  targetType: string; // مثال: 'user', 'top_up', 'post', 'role'
  targetId?: string | null;
  reason: string;
  result: CoreAuditResult;
}

export interface CoreAuditEntry {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id?: string | null;
  reason: string;
  result: CoreAuditResult;
  created_at: string;
}
