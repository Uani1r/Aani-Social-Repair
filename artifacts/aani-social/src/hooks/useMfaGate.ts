/**
 * فرض التحقق بخطوتين في التطبيق: لا يُعرض المحتوى المحمي لمستخدم فعّل MFA
 * قبل أن يصل إلى aal2.
 *
 * - مصدر الحقيقة: `mfa.getAuthenticatorAssuranceLevel` و`mfa.listFactors`
 *   و`user.app_metadata.mfa_enabled` (يُكتب من الخادم فقط).
 * - لا قرار من `user_metadata`، ولا من حالة محلية، ولا تجاهل عند فشل القراءة:
 *   فشل القراءة يمنع العرض (fail-closed) ولا يفتح التطبيق.
 * - أي طريقة دخول (بريد، اسم مستخدم، هاتف، Google، Apple) تنتهي بنفس الجلسة،
 *   فتخضع لنفس البوابة.
 */
import { useCallback, useEffect, useState } from 'react';

import { resolveMfaGate, type AssuranceLevel, type MfaFactor } from '@/lib/accountMfa';
import { supabase, supabaseConfigured } from '@/lib/supabase';

export type MfaGateStatus = 'resolving' | 'allowed' | 'blocked' | 'unavailable';

export type MfaGateState = {
  status: MfaGateStatus;
  level: AssuranceLevel;
  enabled: boolean;
  factors: MfaFactor[];
  reason: 'challenge' | 'enroll' | null;
  message: string;
};

const RESOLVING: MfaGateState = {
  status: 'resolving',
  level: 'unknown',
  enabled: false,
  factors: [],
  reason: null,
  message: '',
};

function mapFactors(data: unknown): MfaFactor[] {
  const all = (data as { all?: unknown } | null)?.all;
  if (!Array.isArray(all)) return [];
  const factors: MfaFactor[] = [];
  for (const item of all) {
    if (!item || typeof item !== 'object') continue;
    const record = item as {
      id?: unknown;
      factor_type?: unknown;
      status?: unknown;
      friendly_name?: unknown;
      created_at?: unknown;
    };
    if (typeof record.id !== 'string' || !record.id) continue;
    factors.push({
      id: record.id,
      factorType: typeof record.factor_type === 'string' ? record.factor_type : '',
      status: record.status === 'verified' ? 'verified' : 'unverified',
      friendlyName: typeof record.friendly_name === 'string' && record.friendly_name
        ? record.friendly_name
        : 'تطبيق المصادقة',
      createdAt: typeof record.created_at === 'string' ? record.created_at : '',
    });
  }
  return factors;
}

export default function useMfaGate(userId: string | undefined) {
  const [state, setState] = useState<MfaGateState>(RESOLVING);

  const evaluate = useCallback(async () => {
    if (!supabaseConfigured || !userId) {
      setState({ ...RESOLVING, status: 'allowed' });
      return;
    }

    try {
      const [levelResult, factorsResult, userResult] = await Promise.all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        supabase.auth.mfa.listFactors(),
        supabase.auth.getUser(),
      ]);

      if (levelResult.error || factorsResult.error || userResult.error) {
        // فشل القراءة لا يعني «مسموح»: البوابة تُغلق حتى تُحسم الحالة.
        setState({
          status: 'unavailable',
          level: 'unknown',
          enabled: false,
          factors: [],
          reason: null,
          message: 'تعذر التحقق من حالة الحماية. أعد تحميل التطبيق، وإذا تكرر فسجّل الخروج وادخل مجددًا.',
        });
        return;
      }

      const current = levelResult.data?.currentLevel;
      const level: AssuranceLevel = current === 'aal2' ? 'aal2' : current === 'aal1' ? 'aal1' : 'unknown';
      const appMetadata = userResult.data?.user?.app_metadata as { mfa_enabled?: unknown } | undefined;
      const enabled = appMetadata?.mfa_enabled === true;
      const factors = mapFactors(factorsResult.data);

      const gate = resolveMfaGate({ enabled, level, factors });
      if (gate.allow) {
        setState({ status: 'allowed', level, enabled, factors, reason: null, message: '' });
        return;
      }
      setState({
        status: 'blocked',
        level,
        enabled,
        factors,
        reason: gate.reason,
        message: gate.message,
      });
    } catch {
      setState({
        status: 'unavailable',
        level: 'unknown',
        enabled: false,
        factors: [],
        reason: null,
        message: 'تعذر التحقق من حالة الحماية. أعد تحميل التطبيق، وإذا تكرر فسجّل الخروج وادخل مجددًا.',
      });
    }
  }, [userId]);

  useEffect(() => {
    void evaluate();
    if (!supabaseConfigured) return undefined;
    // أي تغيير في الجلسة (تحقق، تعطيل عامل، تبديل حساب) يعيد التقييم فوراً.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      void evaluate();
    });
    return () => subscription.unsubscribe();
  }, [evaluate]);

  return { state, refresh: evaluate };
}
