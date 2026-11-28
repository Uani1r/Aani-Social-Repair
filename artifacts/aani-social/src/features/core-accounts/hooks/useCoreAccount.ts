/**
 * خطاف الحساب الأساسي الحالي.
 *
 * يُحل دور الجلسة من الخادم عبر getCoreAccountRole() (RPC مؤمن) ويُوفر دوال
 * التحقق من الصلاحية لاستخدامها في الواجهة. ملاحظة أساسية: تحقق الواجهة هنا
 * غرضه تجربة المستخدم وإخفاء الواجهات غير ذات الصلة؛ كل عملية حساسة تُعاد
 * التحقق منها في الخادم/RPC قبل التنفيذ (fail-closed). لا يُستخدم
 * user_metadata أبدًا لتحديد الدور.
 */

import { useCallback, useState, useEffect } from 'react';
import type { CoreAccountRole, CoreAccount } from '../types/account';
import type { CorePermissionKey } from '../roles/definitions';
import { getCoreAccountRole } from '../services/rbac';
import { coreHasPermission } from '../roles/definitions';

export interface UseCoreAccountResult {
  role: CoreAccountRole | null;
  account: CoreAccount;
  loading: boolean;
  error: Error | null;
  isFounder: boolean;
  isAdmin: boolean;
  isOfficial: boolean;
  isUser: boolean;
  hasPermission: (key: CorePermissionKey) => boolean;
  canAccessFounderPanel: () => boolean;
  canAccessAdminPanel: () => boolean;
  canAccessOfficialPanel: () => boolean;
  refetch: () => Promise<void>;
}

export function useCoreAccount(): UseCoreAccountResult {
  const [role, setRole] = useState<CoreAccountRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchRole = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await getCoreAccountRole();
      setRole(next);
    } catch (err) {
      setRole(null);
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRole();
  }, [fetchRole]);

  const account: CoreAccount = {
    id: '',
    email: null,
    role: role ?? 'user',
  };

  const isFounder = role === 'founder';
  const isAdmin = role === 'admin';
  const isOfficial = role === 'official';
  const isUser = role === 'user';

  const hasPermission = useCallback((key: CorePermissionKey): boolean => {
    if (!role) return false;
    return coreHasPermission(role, key);
  }, [role]);

  const canAccessFounderPanel = useCallback((): boolean => isFounder, [isFounder]);

  const canAccessAdminPanel = useCallback((): boolean => isFounder || isAdmin, [
    isFounder,
    isAdmin,
  ]);

  const canAccessOfficialPanel = useCallback((): boolean => isFounder || isAdmin || isOfficial, [
    isFounder,
    isAdmin,
    isOfficial,
  ]);

  return {
    role,
    account,
    loading,
    error,
    isFounder,
    isAdmin,
    isOfficial,
    isUser,
    hasPermission,
    canAccessFounderPanel,
    canAccessAdminPanel,
    canAccessOfficialPanel,
    refetch: fetchRole,
  };
}
