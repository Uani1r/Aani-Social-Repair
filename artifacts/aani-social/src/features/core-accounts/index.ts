/**
 * التصدير العام لوحدة الحسابات الأساسية والصلاحيات (Core Accounts).
 *
 * 모든 الوحدات الفرعية تُصدر عبر هذا الملف لسهولة الاستيراد من التطبيق الرئيسي
 * مع Keeping جميع الملفات المتعلقة بالمنظومة داخل مجلد الوحدة.
 */

// الأنواع
export type { CoreAccountRole } from './types/account';
export type { CoreAccount, CoreAccountRoleSnapshot, DEFAULT_ACCOUNT, ROOT_ACCOUNT_EMAILS } from './types/account';
export type { CORE_ACCOUNTS_DOCUMENTATION } from './types/account';
export type { CoreAuditEntry } from './types/audit';

// الأدوار والصلاحيات
export type { CorePermissionKey } from './roles/definitions';
export {
  CORE_PERMISSIONS,
  CORE_PERMISSION_BY_KEY,
  CORE_ROLE_HIERARCHY,
  CORE_FOUNDER_ONLY_PERMISSIONS,
  coreRoleRank,
  coreRoleGte,
  coreHasPermission,
  coreCanAccessFounderPanel,
  coreCanAccessAdminPanel,
  coreCanAccessOfficialPanel,
  coreCanAccessFounderFinancial,
  coreCanManageRoles,
  corePermissionsForRole,
  coreIsForbiddenForNonFounder,
} from './roles/definitions';

// المؤسس
export {
  isFounderPanelAllowed,
  isFounderFinancialAllowed,
  isFounderRoleManagementAllowed,
  assertFounder,
} from './founder/guard';
export {
  isCoreFounder,
  requireFounderRole,
  coreGrantSandboxCoins,
  coreRefundSandboxTopUp,
} from './founder/service';

// الإدارة
export {
  isAdminPanelAllowed,
  isAdminActionAllowed,
  assertAdmin,
} from './admin/guard';
export type { AdminUserAction } from './admin/service';
export { coreAdminBanUser, coreAdminModerateContent, coreAdminReadAudit } from './admin/service';

// الحساب الرسمي
export {
  isOfficialPanelAllowed,
  assertOfficial,
} from './official/guard';
export type { OfficialPublishParams } from './official/service';
export { coreOfficialCreatePost, coreOfficialSendAnnouncement } from './official/service';

// الخطافات
export { useCoreAccount, type UseCoreAccountResult } from './hooks/useCoreAccount';
export { useFounder, type UseFounderResult } from './hooks/useFounder';

// الخدمات
export {
  setCoreAccountsSupabaseClient,
  getCoreAccountsSupabaseClient,
} from './services/supabase';
export {
  CORE_ACCOUNT_ROLE_RPC,
  CORE_ACCOUNT_ROLE_RPC_LEGACY,
  CORE_HAS_PERMISSION_RPC,
  CORE_IS_ADMIN_RPC,
  CORE_IS_OFFICIAL_RPC,
  type CoreRoleRpcResult,
  getCoreAccountRole,
  coreHasPermissionServer,
  coreIsAdminServer,
  coreIsOfficialServer,
} from './services/rbac';
export {
  CORE_AUDIT_RPC,
  type CoreAuditInput,
  type CoreAuditResult,
  logCoreAudit,
  auditAdminAction,
} from './services/audit';

// المكونات
export { default as RoleGate } from './components/RoleGate';
export { default as FounderPanel } from './components/FounderPanel';
export { default as AdminDashboard } from './components/AdminDashboard';
export { default as OfficialComposer } from './components/OfficialComposer';
export { default as CoreAccountNav } from './components/CoreAccountNav';
