/**
 * خدمات الإدارة اليومية (المسؤول).
 *
 * المسؤول يدير المستخدمين والبلاغات والمحتوى والإشراف. لا توجد هنا أي عملية
 * تمنح صلاحيات المؤسس ولا تمس جدول المؤسسين. تُؤكّد هوية المسؤول من الخادم
 * عبر RPC مؤمن قبل السماح بأي إجراء؛ حتى الربط الخادم للإجراءات نفسها غير
 * مكتمل بعد، تُرفض العملية وتُستبدل بتحذير واضح بدلاً من تنفيذ أي عملية
 * أعلى من الصلاحية الممنوحة.
 */

import type { CoreAccountRole } from '../types/account';
import { assertAdmin, isAdminActionAllowed } from './guard';
import { auditAdminAction } from '../services/audit';
import { coreIsAdminServer, coreHasPermissionServer } from '../services/rbac';

export interface AdminUserAction {
  userId: string;
  actorRole: CoreAccountRole | null;
  reason: string;
}

/** التحقق من أن الممثل مسؤول من الخادم (fail-closed). */
async function verifyServerAdmin(actorRole: CoreAccountRole | null): Promise<{ allowed: boolean; reason?: string }> {
  if (!actorRole || !assertAdmin(actorRole).allowed) {
    return { allowed: false, reason: 'دخول الإدارة محصور في المؤسس والمسؤول فقط؛ دورك الحالي: ' + (actorRole ?? 'غير محدد') };
  }
  const isAdmin = await coreIsAdminServer();
  if (!isAdmin) {
    return { allowed: false, reason: 'لم يُؤكد الخادم صلاحية المسؤول لهذه الجلسة.' };
  }
  return { allowed: true };
}

export async function coreAdminBanUser(params: AdminUserAction): Promise<{ ok: boolean; error?: Error | null }> {
  const serverCheck = await verifyServerAdmin(params.actorRole);
  if (!serverCheck.allowed) {
    await auditAdminAction({ action: 'ban_user', targetType: 'user', targetId: params.userId, reason: serverCheck.reason ?? '', ok: false });
    return { ok: false, error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }
  // حتى المسؤول لا يُنفّذ أي صلاحية محصورة في المؤسس.
  if (!isAdminActionAllowed(params.actorRole, 'core.admin.users.manage')) {
    await auditAdminAction({ action: 'ban_user', targetType: 'user', targetId: params.userId, reason: 'صلاحية محصورة في المؤسس', ok: false });
    return { ok: false, error: new Error('هذه العملية محصورة في المؤسس فقط') };
  }

  // الربط الخادم pending: لا نُنفّذ أي كتابة مباشرة من العميل.
  await auditAdminAction({ action: 'ban_user', targetType: 'user', targetId: params.userId, reason: params.reason, ok: false });
  return { ok: false, error: new Error('الربط الخادم لإدارة المستخدمين غير مكتمل بعد — العملية لم تُنفذ') };
}

export async function coreAdminModerateContent(params: {
  targetType: 'post' | 'comment';
  targetId: string;
  action: 'hide' | 'delete' | 'restore';
  reason: string;
  actorRole: CoreAccountRole | null;
}): Promise<{ ok: boolean; error?: Error | null }> {
  const serverCheck = await verifyServerAdmin(params.actorRole);
  if (!serverCheck.allowed) {
    await auditAdminAction({ action: 'moderate_content', targetType: params.targetType, targetId: params.targetId, reason: serverCheck.reason ?? '', ok: false });
    return { ok: false, error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }
  if (!isAdminActionAllowed(params.actorRole, 'core.admin.content.moderate')) {
    await auditAdminAction({ action: 'moderate_content', targetType: params.targetType, targetId: params.targetId, reason: 'صلاحية محصورة في المؤسس', ok: false });
    return { ok: false, error: new Error('هذه العملية محصورة في المؤسس فقط') };
  }

  await auditAdminAction({ action: 'moderate_content', targetType: params.targetType, targetId: params.targetId, reason: params.reason, ok: false });
  return { ok: false, error: new Error('الربط الخادم للإشراف على المحتوى غير مكتمل بعد — العملية لم تُنفذ') };
}

export async function coreAdminReadAudit(params: { actorRole: CoreAccountRole | null }): Promise<{ ok: boolean; entries: unknown[]; error?: Error | null }> {
  const serverCheck = await verifyServerAdmin(params.actorRole);
  if (!serverCheck.allowed) {
    return { ok: false, entries: [], error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }
  if (!isAdminActionAllowed(params.actorRole, 'core.admin.audit.read')) {
    return { ok: false, entries: [], error: new Error('قراءة التدقيق محصورة في المؤسس فقط') };
  }

  // الربط الخادم pending: قراءة sandbox.admin_actions عبر Supabase بعد إضافة السياسة المناسبة.
  return { ok: false, entries: [], error: new Error('قراءة سجل التدقيق الإداري غير مربوطة بعد — لم تُنفذ عملية قراءة') };
}
