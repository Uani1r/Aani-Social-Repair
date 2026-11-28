/**
 * خدمات الإدارة اليومية (المسؤول).
 *
 * المسؤول يدير المستخدمين والبلاغات والمحتوى والإشراف. لا توجد هنا أي عملية
 * تمنح صلاحيات المؤسس ولا تمس جدول المؤسسين. تُؤكّد هوية الممثل من الخادم
 * عبر RPC مؤمن قبل السماح بأي إجراء:
 *   - يُجلب الدور من aani_current_account_role() (نص مباشر، fail-closed).
 *   - يُسمح للمؤسس الموثق خادمياً بالدخول إلى عمليات لوحة الإدارة.
 *   - يُسمح للمسؤول فقط إذا أكد aani_is_admin() دوره.
 *   - يُحظر الحساب الرسمي والمستخدم العادي صراحة.
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
import { isAdminActionAllowed } from './guard';
import { auditAdminAction, fetchCoreAuditEntries } from '../services/audit';
import {
  coreIsAdminServer,
  getCoreAccountRole,
} from '../services/rbac';

export interface AdminUserAction {
  userId: string;
  actorRole: CoreAccountRole | null;
  reason: string;
}

/**
 * التحقق من أن الممثل مؤهل لدخول لوحة الإدارة من الخادم (fail-closed).
 * لا تثق بالدور القادم من واجهة المستخدم؛ يُجلب الدور من RPC الخادم.
 *
 * القواعد:
 *   - founder (من الخادم) → مسموح.
 *   - admin (من الخادم) + تأكيد aani_is_admin() → مسموح.
 *   - official / user / null → مرفوض.
 */
async function verifyServerAdmin(): Promise<{ allowed: boolean; reason?: string }> {
  // جلب الدور من الخادم، لا ثقة في valore واجهة المستخدم.
  const serverRole = await getCoreAccountRole();
  if (!serverRole) {
    return { allowed: false, reason: 'فشل جلب الدور من الخادم؛ الجلسة غير محسومة.' };
  }

  // المؤسس الموثق خادمياً يُسمح له بدخول لوحة الإدارة.
  if (serverRole === 'founder') {
    return { allowed: true };
  }

  // المسؤول يُسمح له فقط إذا أكد aani_is_admin() دوره من الخادم.
  if (serverRole === 'admin') {
    const isAdmin = await coreIsAdminServer();
    if (isAdmin) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'لم يؤكد الخادم صلاحية المسؤول لهذه الجلسة.' };
  }

  // الحساب الرسمي والمستخدم العادي محظوران صراحة.
  return {
    allowed: false,
    reason: 'دخول لوحة الإدارة محصور في المؤسس والمسؤول فقط؛ دورك الحالي: ' + serverRole,
  };
}

export async function coreAdminBanUser(params: AdminUserAction): Promise<{ ok: boolean; error?: Error | null }> {
  const serverCheck = await verifyServerAdmin();
  if (!serverCheck.allowed) {
    await auditAdminAction({ action: 'ban_user', targetType: 'user', targetId: params.userId, reason: serverCheck.reason ?? '', ok: false });
    return { ok: false, error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }
  // حتى المؤسس/المسؤول لا يُنفّذ أي صلاحية محصورة في المؤسس عبر هذه الدالة المعطلة.
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
  const serverCheck = await verifyServerAdmin();
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
  const serverCheck = await verifyServerAdmin();
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
