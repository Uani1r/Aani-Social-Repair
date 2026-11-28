/**
 * حراسة صلاحيات الإدارة اليومية.
 *
 * المسؤول (والمؤسس) فقط يُسمح له بدخول لوحة الإدارة وإدارة المستخدمين
 * والبلاغات والمحتوى وقراءة التدقيق. المسؤول ممنوع صراحة من أي عملية تمنحه
 * صلاحيات المؤسس أو تمس جدول المؤسسين (يُفرض ذلك أيضًا في الخادم).
 */

import type { CoreAccountRole } from '../types/account';
import type { CorePermissionKey } from '../roles/definitions';
import {
  coreCanAccessAdminPanel,
  coreIsForbiddenForNonFounder,
} from '../roles/definitions';

export function isAdminPanelAllowed(role: CoreAccountRole | null): boolean {
  return Boolean(role) && coreCanAccessAdminPanel(role as CoreAccountRole);
}

export function isAdminActionAllowed(role: CoreAccountRole | null, permissionKey: CorePermissionKey): boolean {
  if (!role) return false;
  // حتى المسؤول لا يُنفّذ أي صلاحية محصورة في المؤسس.
  if (coreIsForbiddenForNonFounder(role, permissionKey)) return false;
  return true;
}

export function assertAdmin(role: CoreAccountRole | null): { allowed: boolean; reason?: string } {
  if (!role) return { allowed: false, reason: 'الجلسة غير محسومة أو غير مصادقة' };
  if (!coreCanAccessAdminPanel(role)) {
    return {
      allowed: false,
      reason: 'دخول لوحة الإدارة محصور في المؤسس والمسؤول فقط؛ دورك الحالي: ' + role,
    };
  }
  return { allowed: true };
}
