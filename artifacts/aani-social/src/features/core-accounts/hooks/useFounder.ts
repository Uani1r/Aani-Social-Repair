/**
 * خطاف المؤسس: يوفر التحقق من صلاحيات المؤسس المالية عبر جدول sandbox.founders
 * (مصدر الحقيقة) دون تكرار أي دالة RPC قائمة.
 */

import { useCallback, useState, useEffect } from 'react';
import { isCoreFounder } from '../founder/service';
import type { SandboxReadResult } from '@/lib/sandbox';

export interface UseFounderResult {
  isFounder: boolean | null;
  loading: boolean;
  error: Error | null;
  checkFounder: () => Promise<void>;
}

export function useFounder(): UseFounderResult {
  const [isFounder, setIsFounder] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const checkFounder = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res: SandboxReadResult<boolean> = await isCoreFounder();
      if (res.error) {
        setIsFounder(false);
        setError(res.error);
      } else {
        setIsFounder(Boolean(res.data));
      }
    } catch (err) {
      setIsFounder(false);
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkFounder();
  }, [checkFounder]);

  return { isFounder, loading, error, checkFounder };
}
