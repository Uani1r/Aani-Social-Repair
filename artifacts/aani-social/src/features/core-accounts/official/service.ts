/**
 * خدمات الحساب الرسمي.
 *
 * الحساب الرسمي ينشر المنشورات والإعلانات والتنبيهات فقط. لا يمتلك صلاحيات
 * المؤسس أو الإدارة العليا. تُؤكّد هوية الحساب الرسمي من الخادم عبر RPC مؤمن
 * قبل السماح بأي إجراء.
 *
 * ما هو معطل بوضوح لعدم وجود آلية خادمية آمنة في هذا المستودع:
 *   - إنشاء منشورات رسمية: لا دالة RPC آمنة للنشر → تُعاد ok:false.
 *   - إرسال الإعلانات والتنبيهات: لا دالة RPC آمنة للإرسال → تُعاد ok:false.
 *
 * لا تُنفذ أي كتابة مباشرة من العميل، ولا تُتجاوز تحقق الخادم.
 */

import type { CoreAccountRole } from '../types/account';
import { assertOfficial } from './guard';
import { auditAdminAction } from '../services/audit';
import { coreIsOfficialServer } from '../services/rbac';

export interface OfficialPublishParams {
  content: string;
  actorRole: CoreAccountRole | null;
  reason?: string;
  targetId?: string | null;
}

/** التحقق من أن الممثل حساب رسمي من الخادم (fail-closed). */
async function verifyServerOfficial(actorRole: CoreAccountRole | null): Promise<{ allowed: boolean; reason?: string }> {
  if (!actorRole || !assertOfficial(actorRole).allowed) {
    return { allowed: false, reason: 'دخول واجهة الحساب الرسمي محصور في الحساب الرسمي (والمؤسس/المسؤول)؛ دورك الحالي: ' + (actorRole ?? 'غير محدد') };
  }
  const isOfficial = await coreIsOfficialServer();
  if (!isOfficial) {
    return { allowed: false, reason: 'لم يُؤكد الخادم صلاحية الحساب الرسمي لهذه الجلسة.' };
  }
  return { allowed: true };
}

export async function coreOfficialCreatePost(params: OfficialPublishParams): Promise<{ ok: boolean; postId?: string; error?: Error | null }> {
  const serverCheck = await verifyServerOfficial(params.actorRole);
  if (!serverCheck.allowed) {
    await auditAdminAction({ action: 'create_post', targetType: 'post', targetId: null, reason: serverCheck.reason ?? '', ok: false });
    return { ok: false, error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }

  // لا دالة RPC آمنة لنشر منشورات رسمية في هذا المستودع. لا نُنشئ كتابة من العميل.
  await auditAdminAction({ action: 'create_post', targetType: 'post', targetId: null, reason: params.reason ?? 'منشور رسمي', ok: false });
  return { ok: false, error: new Error('آلية نشر المنشورات الرسمية غير مربوطة بخادم آمن — العملية لم تُنفذ') };
}

export async function coreOfficialSendAnnouncement(params: {
  content: string;
  actorRole: CoreAccountRole | null;
  reason?: string;
}): Promise<{ ok: boolean; error?: Error | null }> {
  const serverCheck = await verifyServerOfficial(params.actorRole);
  if (!serverCheck.allowed) {
    await auditAdminAction({ action: 'send_announcement', targetType: 'announcement', targetId: null, reason: serverCheck.reason ?? '', ok: false });
    return { ok: false, error: new Error(serverCheck.reason ?? 'غير مصرح') };
  }

  // لا دالة RPC آمنة لإرسال إعلانات رسمية في هذا المستودع. لا نُنشئ كتابة من العميل.
  await auditAdminAction({ action: 'send_announcement', targetType: 'announcement', targetId: null, reason: params.reason ?? 'إعلان رسمي', ok: false });
  return { ok: false, error: new Error('آلية إرسال الإعلانات الرسمية غير مربوطة بخادم آمن — العملية لم تُنفذ') };
}
