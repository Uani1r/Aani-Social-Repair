/**
 * oauthProvider.ts
 * إدارة حالة التحميل المستقلة لمزوّدي OAuth (Google و Apple) في صفحة الدخول.
 *
 * تُفصل حالة التحميل لكل مزوّد عن الأخرى، بحيث لا يؤدي الضغط على زر Google إلى
 * عرض مؤشر تحميل في زر Apple، والعكس صحيح. كما تمنع بدء عمليتي OAuth متزامنتين.
 *
 * `createOAuthProvider` تُدير الحالة في الإغلاق (closure) ويمكن اختبارها مباشرة
 * بدون React أو jsdom. `useOAuthProvider` تُغلّفها كوHook React لعرضها في
 * `AuthPage.tsx`. لا تُخزن أي سر أو تعيين عميل في كود الواجهة.
 */

import { useState, useRef } from 'react';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { getOAuthRedirectUrl } from '@/lib/oauthRedirect';

export type OAuthProvider = 'google' | 'apple';

export interface OAuthProviderState {
  /** المزوّد الذي يُحمّل الآن، أو `null` إن لم يكن هناك تحميل جارٍ. */
  readonly providerLoading: OAuthProvider | null;
  /** هل يوجد تحميل جارٍ لأي من المزودين (لتعطيل الزر الآخر بصرياً). */
  readonly isProviderLoading: boolean;
}

export interface OAuthProviderActions {
  /** بدء دخول OAuth للمزوّد المحدد. يُرفض عند الفشل ليُعالجه المستدعي. */
  signIn: (provider: OAuthProvider) => Promise<void>;
}

/**
 * إنشاء مُدارٍ لحالة تحميل مزودي OAuth. تُدار الحالة في إغلاقٍ خاص، ما يجعلها
 * قابلة للاختبار مباشرة without React. يُمرّر عميل المصادقة ليُسهّل المحاكاة
 * في الاختبارات؛ القيم الافتراضية تستخدم `supabase` الفعلي.
 */
export function createOAuthProvider(authClient = supabase): OAuthProviderState & OAuthProviderActions {
  let providerLoading: OAuthProvider | null = null;

  const signIn = async (provider: OAuthProvider): Promise<void> => {
    if (!supabaseConfigured || providerLoading) return;
    providerLoading = provider;
    try {
      const { error: authError } = await authClient.auth.signInWithOAuth({
        provider,
        options: { redirectTo: getOAuthRedirectUrl() },
      });
      if (authError) throw authError;
      // عند النجاح يقوم المتصفح بإعادة التوجيه إلى مزوّد الخدمة. تُنظّم حالة
      // التحميل في `finally` حتى لا تبقى عالقة حتى لو لم يحدث التوجيه.
    } catch (reason: any) {
      throw reason;
    } finally {
      providerLoading = null;
    }
  };

  return {
    get providerLoading() {
      return providerLoading;
    },
    get isProviderLoading() {
      return providerLoading !== null;
    },
    signIn,
  };
}

/** هوك React يُغلّف `createOAuthProvider` ويحفظ حالته في `useState` لعرضها. */
export function useOAuthProvider(authClient = supabase): OAuthProviderState & OAuthProviderActions {
  const providerRef = useRef(createOAuthProvider(authClient));
  const [providerLoading, setProviderLoading] = useState<OAuthProvider | null>(null);

  const signIn = async (provider: OAuthProvider) => {
    if (providerRef.current.isProviderLoading) return;
    setProviderLoading(provider);
    try {
      await providerRef.current.signIn(provider);
    } finally {
      setProviderLoading(providerRef.current.providerLoading);
    }
  };

  return {
    providerLoading,
    isProviderLoading: providerRef.current.isProviderLoading,
    signIn,
  };
}
