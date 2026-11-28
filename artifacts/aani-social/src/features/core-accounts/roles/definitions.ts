/**
 * تعريف أدوار وحدة الحسابات الأساسية والصلاحيات المرتبطة بكل دور.
 *
 * هذا الملف منطق خالص (Pure): لا يعتمد على Supabase، ولا على DOM، ولا على
 * user_metadata. يُستخدم لتحديد ما يُسمح به لكل دور على مستوى العميل、
 * وتُعاد المطابقة من جانب الخادم لكل عملية حساسة (انظر services/rbac.ts).
 *
 * تسلسل الصلاحية:
 *   founder > admin > official > user
 * المؤسس يمتلك كل الصلاحيات بما في ذلك المالية وإدارة الأدوار.
 * المسؤول يمتلك المستخدمين والبلاغات والمحتوى والتدقيق فقط، ولا يمس المؤسسين.
 * الحساب الرسمي يمتلك النشر والإعلانات والتنبيهات فقط.
 * المستخدم العادي يمتلك إجراءات حسابه الخاص فقط.
 */

import type { CoreAccountRole } from '../types/account';

export type CorePermissionKey =
  // الحسابات الأساسية (قراءة/كتابة دورية)
  | 'core.accounts.read'
  | 'core.accounts.write'
  // المؤسس — مالي (مصدر الحقيقة: sandbox.founders)
  | 'core.founder.financial.read'
  | 'core.founder.financial.write'
  | 'core.founder.roles.manage'
  // الإدارة اليومية
  | 'core.admin.users.manage'
  | 'core.admin.reports.manage'
  | 'core.admin.content.moderate'
  | 'core.admin.audit.read'
  // الحساب الرسمي
  | 'core.official.posts.create'
  | 'core.official.announcements.create'
  | 'core.official.notifications.send';

export interface CorePermissionDefinition {
  key: CorePermissionKey;
  label: string;
  description: string;
  /** الأدوار المسموح لها بهذه الصلاحية. */
  allowedRoles: ReadonlySet<CoreAccountRole>;
}

export const CORE_PERMISSIONS: ReadonlyArray<CorePermissionDefinition> = Object.freeze<ReadonlyArray<CorePermissionDefinition>>([
  {
    key: 'core.accounts.read',
    label: 'عرض الحسابات الأساسية',
    description: 'الاطلاع على قائمة الحسابات الأساسية وأدوارها.',
    allowedRoles: new Set(['founder', 'admin', 'official']),
  },
  {
    key: 'core.accounts.write',
    label: 'تعديل الحسابات الأساسية',
    description: 'تعديل بيانات الحسابات الأساسية (باستثناء دور المؤسس).',
    allowedRoles: new Set(['founder']),
  },
  {
    key: 'core.founder.financial.read',
    label: 'قراءة البيانات المالية للمؤسس',
    description: 'الاطلاع على السجل المالي والإجماليات عبر sandbox.founders.',
    allowedRoles: new Set(['founder']),
  },
  {
    key: 'core.founder.financial.write',
    label: 'كتابة العمليات المالية للمؤسس',
    description: 'منح عملات، استرداد، تفعيل اشتراكات، إلخ (مؤسس فقط).',
    allowedRoles: new Set(['founder']),
  },
  {
    key: 'core.founder.roles.manage',
    label: 'إدارة أدوار المؤسسين',
    description: 'إضافة/إزالة المؤسسين من sandbox.founders (مؤسس فقط).',
    allowedRoles: new Set(['founder']),
  },
  {
    key: 'core.admin.users.manage',
    label: 'إدارة المستخدمين',
    description: 'عرض وتعديل وحظر المستخدمين العاديين.',
    allowedRoles: new Set(['founder', 'admin']),
  },
  {
    key: 'core.admin.reports.manage',
    label: 'إدارة البلاغات',
    description: 'مراجعة البلاغات وحلها وحذف المحتوى المخالف.',
    allowedRoles: new Set(['founder', 'admin']),
  },
  {
    key: 'core.admin.content.moderate',
    label: 'الإشراف على المحتوى',
    description: 'إخفاء/حذف المنشورات والتعليقات والإبلاغات.',
    allowedRoles: new Set(['founder', 'admin']),
  },
  {
    key: 'core.admin.audit.read',
    label: 'قراءة سجل التدقيق الإداري',
    description: 'الاطلاع على إجراءات المسؤولين المسجلة.',
    allowedRoles: new Set(['founder', 'admin']),
  },
  {
    key: 'core.official.posts.create',
    label: 'إنشاء منشورات رسمية',
    description: 'نشر منشورات باسم الحساب الرسمي.',
    allowedRoles: new Set(['founder', 'admin', 'official']),
  },
  {
    key: 'core.official.announcements.create',
    label: 'إنشاء إعلانات رسمية',
    description: 'نشر إعلانات وتنبيهات رسمية تصل للمستخدمين.',
    allowedRoles: new Set(['founder', 'admin', 'official']),
  },
  {
    key: 'core.official.notifications.send',
    label: 'إرسال تنبيهات رسمية',
    description: 'إرسال إشعارات نظامية للمستخدمين.',
    allowedRoles: new Set(['founder', 'admin', 'official']),
  },
]);

/** خريطة سريعة من الصلاحية إلى تعريفها. */
export const CORE_PERMISSION_BY_KEY: ReadonlyMap<CorePermissionKey, CorePermissionDefinition> =
  new Map(CORE_PERMISSIONS.map((p) => [p.key, p]));

/** الأدوار مرتبة من الأعلى إلى الأدنى. */
export const CORE_ROLE_HIERARCHY: ReadonlyArray<CoreAccountRole> = [
  'founder',
  'admin',
  'official',
  'user',
];

/** رتبة عددية للمقارنة (أعلى رقم = صلاحية أعلى). */
export function coreRoleRank(role: CoreAccountRole): number {
  switch (role) {
    case 'founder': return 4;
    case 'admin': return 3;
    case 'official': return 2;
    case 'user': return 1;
    default: return 0;
  }
}

/** هل الدور الأول مساوٍ أو أعلى من الدور الثاني؟ */
export function coreRoleGte(role: CoreAccountRole, minimum: CoreAccountRole): boolean {
  return coreRoleRank(role) >= coreRoleRank(minimum);
}

/** التحقق من أن الدور يملك صلاحية معينة. */
export function coreHasPermission(role: CoreAccountRole, key: CorePermissionKey): boolean {
  const def = CORE_PERMISSION_BY_KEY.get(key);
  if (!def) return false;
  return def.allowedRoles.has(role);
}

/** هل الدور يؤهل لدخول لوحة المؤسس (السرية)? */
export function coreCanAccessFounderPanel(role: CoreAccountRole): boolean {
  return role === 'founder';
}

/** هل الدور يؤهل لدخول لوحة الإدارة اليومية؟ */
export function coreCanAccessAdminPanel(role: CoreAccountRole): boolean {
  return role === 'founder' || role === 'admin';
}

/** هل الدور يؤهل لدخول واجهة الحساب الرسمي؟ */
export function coreCanAccessOfficialPanel(role: CoreAccountRole): boolean {
  return role === 'founder' || role === 'admin' || role === 'official';
}

/** هل الدور يمتلك صلاحيات المؤسس المالية (قراءة/كتابة)? */
export function coreCanAccessFounderFinancial(role: CoreAccountRole): boolean {
  return role === 'founder';
}

/** هل الدور يستطيع إدارة الأدوار/جدولة المؤسسين؟ */
export function coreCanManageRoles(role: CoreAccountRole): boolean {
  return role === 'founder';
}

/** جميع الصلاحيات الممنوحة لدور معين. */
export function corePermissionsForRole(role: CoreAccountRole): ReadonlySet<CorePermissionKey> {
  const granted = new Set<CorePermissionKey>();
  for (const def of CORE_PERMISSIONS) {
    if (def.allowedRoles.has(role)) granted.add(def.key);
  }
  return granted;
}

/**
 * الصلاحيات المحظورة صراحة على أدوار غير المؤسس (حماية مزدوجة).
 * حتى لوaport给ت دورًا vyšrًا عن طريق الخطأ، هذه الصلاحيات تظل محصورة في المؤسس.
 */
export const CORE_FOUNDER_ONLY_PERMISSIONS: ReadonlySet<CorePermissionKey> = new Set([
  'core.founder.financial.read',
  'core.founder.financial.write',
  'core.founder.roles.manage',
  'core.accounts.write',
]);

/** التحقق من أن دورًا غير مؤسس يحاول الوصول لصلاحيات المؤسس المحظورة. */
export function coreIsForbiddenForNonFounder(role: CoreAccountRole, key: CorePermissionKey): boolean {
  return role !== 'founder' && CORE_FOUNDER_ONLY_PERMISSIONS.has(key);
}
