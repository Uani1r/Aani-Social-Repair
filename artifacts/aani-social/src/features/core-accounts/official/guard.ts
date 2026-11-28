/**
 * حراسة صلاحيات الحساب الرسمي.
 *
 * الحساب الرسمي (والمؤسس والمسؤول) يُسمح له بالنشر والإعلانات والتنبيهات
 * فقط. الحساب الرسمي لا يمتلك صلاحيات المؤسس أو الإدارة العليا، ولا يدخل
 * لوحة المؤسس أو لوحة الإدارة.
 */

import type { CoreAccountRole } from '../types/account';
import { coreCanAccessOfficialPanel } from '../roles/definitions';

export function isOfficialPanelAllowed(role: CoreAccountRole | null): boolean {
  return Boolean(role) && coreCanAccessOfficialPanel(role as CoreAccountRole);
}

export function assertOfficial(role: CoreAccountRole | null): { allowed: boolean; reason?: string } {
  if (!role) return { allowed: false, reason: 'الجلسة غير محسومة أو غير مصادقة' };
  if (!coreCanAccessOfficialPanel(role)) {
    return {
      allowed: false,
      reason: 'واجهة الحساب الرسمي محصورة في الحساب الرسمي والمسؤول والمؤسس فقط؛ دورك الحالي: ' + role,
    };
  }
  return { allowed: true };
}
