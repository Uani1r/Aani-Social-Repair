export { setCoreAccountsSupabaseClient, getCoreAccountsSupabaseClient } from './supabase';
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
} from './rbac';
export {
  CORE_AUDIT_RPC,
  type CoreAuditInput,
  type CoreAuditResult,
  type CoreAuditEntry,
  logCoreAudit,
  auditAdminAction,
  fetchCoreAuditEntries,
} from './audit';
