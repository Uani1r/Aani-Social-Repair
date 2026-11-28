/**
 * حراسة صلاحيات المؤسس.
 *
 * المؤسس هو الوحيد المسموح له بدخول اللوحة السرية وتنفيذ العمليات المالية
 * وإدارة الأدوار. كل دالة هنا منطق خالص يُبنى على الدور المحلول من الخادم
 * (انظر roles/definitions.ts)، ولا تُقرر الدور بنفسها.
 */

import type { CoreAccountRole } from '../types/account';
import {
  coreCanAccessFounderPanel,
  coreCanAccessFounderFinancial,
  coreCanManageRoles,
} from '../roles/definitions';

export function isFounderPanelAllowed(role: CoreAccountRole | null): boolean {
  return Boolean(role) && coreCanAccessFounderPanel(role as CoreAccountRole);
}

export function isFounderFinancialAllowed(role: CoreAccountRole | null): boolean {
  return Boolean(role) && coreCanAccessFounderFinancial(role as CoreAccountRole);
}

export function isFounderRoleManagementAllowed(role: CoreAccountRole | null): boolean {
  return Boolean(role) && coreCanManageRoles(role as CoreAccountRole);
}

/** حارس مركب لكل عمليات المؤسس الحساسة (يُستدعى قبل كل عملية مؤسس). */
export function assertFounder(role: CoreAccountRole | null): { allowed: boolean; reason?: string } {
  if (!role) return { allowed: false, reason: 'الجلسة غير محسومة أو غير مصادقة' };
  if (role !== 'founder') {
    return {
      allowed: false,
      reason: 'هذه العملية محصورة في المؤسس فقط؛ دورك الحالي: ' + role,
    };
  }
  return { allowed: true };
}
