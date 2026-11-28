/**
 * خدمات الإدارة اليومية (المسؤول).
 *
 * المسؤول يدير المستخدمين والبلاغات والمحتوى والإشراف. لا توجد هنا أي عملية
 * تمنح صلاحيات المؤسس ولا تمس جدول المؤسسين. تُؤكّد هوية المسؤول من الخادم
 * عبر RPC مؤمن قبل السماح بأي إجراء.
 *
 * ما هو مربوط فعلياً من جانب الخادم:
 *   - قراءة سجل التدقيق: تُقرأ إدخالات sandbox.admin_actions عبر Supabase مع
 *     تفعيل RLS (الفاعل هو الجلسة أو مؤسس)، بدون كتابة مباشرة من العميل.
 *
 * ما هو معطل بوضوح لعدم وجود آلية خادمية آمنة في هذا المستودع:
 *   - حظر المستخدمين: لا دالة RPC آمنة للحظر → تُعاد ok:false مع توضيح.
 *   - الإشراف على المنشورات/التعليقات: لا دالة RPC آمنة للإشراف → تُعاد ok:false.
 *
 * لا تُنفذ أي كتابة مباشرة من العميل، ولا تُتجاوز تحقق الخادم.
 */

import type { CoreAccountRole } from '../types/account';
import { assertAdmin, isAdminActionAllowed } from './guard';
import { auditAdminAction, fetchCoreAuditEntries } from '../services/audit';
import { coreIsAdminServer } from '../services/rbac';

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

  // لا دالة RPC آمنة للحظر في هذا المستودع. لا نُنفّذ كتابة من العميل.
  await auditAdminAction({ action: 'ban_user', targetType: 'user', targetId: params.userId, reason: params.reason, ok: false });
  return { ok: false, error: new Error('آلية حظر المستخدمين غير مربوطة بخادم آمن — العملية لم تُنفذ') };
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

  // لا دالة RPC آمنة للإشراف في هذا المستودع. لا نُنفّذ كتابة من العميل.
  await auditAdminAction({ action: 'moderate_content', targetType: params.targetType, targetId: params.targetId, reason: params.reason, ok: false });
  return { ok: false, error: new Error('آلية الإشراف على المحتوى غير مربوطة بخادم آمن — العملية لم تُنفذ') };
}

export async function coreAdminReadAudit(params: { actorRole: CoreAccountRole | null }): Promise<{ ok: boolean; entries: unknown[]; error?: Error | null }> {
  const serverCheck = await verifyServerAdmin(params.actorRole);
  if (!serverCheck.allowed) {
    return { ok: false, entries: [], error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }
  if (!isAdminActionAllowed(params.actorRole, 'core.admin.audit.read')) {
    return { ok: false, entries: [], error: new Error('قراءة التدقيق محصورة في المؤسس فقط') };
  }

  // ربط فعلي للقراءة من sandbox.admin_actions عبر RLS (الفاعل أو مؤسس فقط).
  const { data, error } = await fetchCoreAuditEntries({ page: 0, pageSize: 100 });
  if (error) {
    return { ok: false, entries: [], error };
  }
  return { ok: true, entries: data ?? [], error: null };
}
