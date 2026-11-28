import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { resetMessagesConversationMembershipCache } from '@/lib/messagesConversationMembership';
import { fetchConditionalProfileFields, fetchMyPreferences, PUBLIC_PROFILE_COLUMNS, type PublicProfileRow } from '@/lib/profileFields';
import { STORY_VIEWER_PLACEHOLDER_NAMES } from '@/lib/appShared';
import { flushUploadLedgerQueue } from '@/lib/uploadLedgerQueue';
import { deviceSignOutDeps } from '@/lib/pushNotifications';
import {
  PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE,
  signOutThisDevice,
  type DeviceSignOutOutcome,
} from '@/lib/pushSignOut';
import type { ProfileLoadState } from '@/lib/authGate';
import { fetchMyOnboardingState, onboardingIsComplete, type OnboardingSnapshot } from '@/lib/onboarding';
import type { Profile } from '@/lib/types';

/**
 * نتيجة تحميل الملف: تُعاد للمستدعي بعد كل تحميل فعلي، فلا يعتمد أي قرار
 * توجيه (لا اكتمال التسجيل ولا فتح التطبيق) على حالة قديمة.
 */
export type ProfileLoadOutcome = {
  ok: boolean;
  profileState: ProfileLoadState;
  onboardingComplete: boolean;
};

export default function useAppSession() {
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // الحسم الحقيقي لحالة الجلسة: لا تظهر شاشة تسجيل الدخول إلا بعد حسمها
  // (نجاح getSession/فشله الصريح/حدث onAuthStateChange) — مهلة العرض
  // لا تُحوّل حالة المصادقة غير المحسومة إلى "مستخدم غير مسجل".
  const [authResolved, setAuthResolved] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  // جلسة استعادة كلمة المرور: تصل من رابط التحقق في البريد (PASSWORD_RECOVERY)،
  // وتُستخدم لتعيين كلمة مرور بعد إثبات ملكية البريد — بلا signOut ولا ربط
  // هوية جديد. تُطفأ بعد الحفظ أو الإغلاق.
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const user = session?.user;
  // حالة تحميل الملف الشخصي: 'failed' و'missing' ليستا اكتمالاً، وليستا
  // مدعاةً لفتح التطبيق أو صفحاته الداخلية.
  const [profileState, setProfileState] = useState<ProfileLoadState>('idle');
  // حالة إكمال التسجيل من قاعدة البيانات وحدها (onboarding_completed_at).
  const [onboarding, setOnboarding] = useState<OnboardingSnapshot | null>(null);
  // جلسة المصادقة هي مالك ذاكرة عضوية المحادثات: الخروج أو تبديل الحساب يفرّغها
  // ويقطع أي طلب عضوية جارٍ، فلا تتسرّب نتيجة جلسة سابقة إلى الجلسة الجديدة.
  const authOwnerRef = useRef<string | null>(null);
  const syncMembershipOwner = (nextUserId: string | null) => {
    if (authOwnerRef.current === nextUserId) return;
    authOwnerRef.current = nextUserId;
    resetMessagesConversationMembershipCache(nextUserId);
  };

  // الهوية الحالية كما قرأتها المصادقة: تُقرأ داخل محمّل الملف بدل الاعتماد
  // على إغلاق قديم، فيبقى إعادة التحميل صالحاً بعد أي تغيير في الجلسة.
  const sessionUserRef = useRef<any>(null);
  // رقم الطلب: نتيجة تحميل قديمة لا تُطبَّق على جلسة أحدث.
  const profileRequestRef = useRef(0);

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthLoading(false);
      setAuthResolved(true);
      return;
    }

    let mounted = true;

    const loadSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (mounted) {
          syncMembershipOwner(data.session?.user?.id ?? null);
          setSession(data.session);
          // سجل الرفع: أي روابط فشل تسجيلها سابقاً تُعاد محاولة تسجيلها الآن
          // (فشلها لا يؤثر على الإقلاع أبداً)
          void flushUploadLedgerQueue().catch(() => undefined);
        }
      } catch (error) {
        console.error('تعذر استعادة جلسة المستخدم:', error);
        if (mounted) {
          syncMembershipOwner(null);
          setSession(null);
        }
      } finally {
        if (mounted) {
          setAuthLoading(false);
          setAuthResolved(true);
        }
      }
    };

    void loadSession();

    // مهلة عرض شاشة الانتظار فقط: تحرّر حالة التحميل بعد 2500ms كي لا
    // يعلق الإقلاع على استعادة الجلسة، لكنها لا تحسم حالة المصادقة —
    // جلسة تصل لاحقاً (من loadSession أو onAuthStateChange) تُطبَّق
    // طبيعياً والواجهة تنتقل إلى الحالة الصحيحة دون فقدانها.
    const authLoadingGuard = window.setTimeout(() => {
      if (mounted) setAuthLoading(false);
    }, 2500);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      setAuthResolved(true);
      // رابط استعادة كلمة المرور: يُفتح نموذج التعيين بلا تسجيل خروج.
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      // قبل تطبيق الجلسة الجديدة: أي طلب عضوية تابع للجلسة السابقة يُلغى.
      syncMembershipOwner(nextSession?.user?.id ?? null);
      setSession(nextSession);
      setProfile(null);
      if (event === 'SIGNED_IN' && nextSession?.user?.id) {
        // سجل الرفع: إعادة محاولة تسجيل الروابط المعلقة فور توفر جلسة جديدة
        void flushUploadLedgerQueue().catch(() => undefined);
        // إعادة التفعيل عبر الدالة المعتمدة وحدها (لا كتابة مباشرة على
        // is_deactivated). هذه الخطوة لا تفتح أي بوابة: التحقق بخطوتين يُفرض
        // في App قبل عرض المحتوى، ولا يُتجاوز بحدث SIGNED_IN.
        window.setTimeout(() => {
          void supabase.rpc('aani_reactivate_account').then(({ error }) => {
            if (error) console.error('تعذر إعادة تفعيل الحساب عند تسجيل الدخول.');
          });
        }, 0);
      }
    });

    return () => {
      mounted = false;
      window.clearTimeout(authLoadingGuard);
      subscription.unsubscribe();
    };
  }, []);

  /**
   * تحميل الملف الشخصي وحالة إكمال التسجيل من قاعدة البيانات.
   *   * يُعيد النتيجة الفعلية، فلا يعتمد التوجيه على حالة محفوظة سابقاً.
   *   * فشل القراءة → 'failed' (لا فتح للتطبيق)، وغياب الصف → 'missing'.
   *   * لا يُعتبر الاسم الذي أنشأه مشغّل الحساب اكتمالاً: الفيصل
   *     onboarding_completed_at وحده.
   */
  const loadProfileData = useCallback(async (): Promise<ProfileLoadOutcome> => {
    const sessionUser = sessionUserRef.current;

    if (!supabaseConfigured || !sessionUser?.id) {
      profileRequestRef.current += 1;
      setProfile(null);
      setProfileState('idle');
      setOnboarding(null);
      return { ok: false, profileState: 'idle', onboardingComplete: false };
    }

    const requestId = profileRequestRef.current + 1;
    profileRequestRef.current = requestId;
    const isCurrent = () => profileRequestRef.current === requestId;
    setProfileState('loading');

    const validName = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const name = value.trim();
      return name && !STORY_VIEWER_PLACEHOLDER_NAMES.has(name.toLowerCase()) ? name : null;
    };
    const metadataName = validName(sessionUser.user_metadata?.full_name) || validName(sessionUser.user_metadata?.name);

    const applyProfile = (row: Profile | null) => {
      const username = validName(row?.username) || validName(sessionUser.user_metadata?.username) || sessionUser.email?.split('@')[0] || 'user';
      const storedDisplayName = validName(row?.display_name);
      setProfile({
        ...(row || {}),
        id: sessionUser.id,
        username,
        full_name: validName(row?.full_name) || metadataName || username,
        display_name: storedDisplayName || (row?.display_name ? metadataName : row?.display_name ?? null),
        avatar_url: row?.avatar_url || null,
        bio: row?.bio || '',
      });
    };

    try {
      // الأعمدة العامة فقط: أعمدة التفضيلات الشخصية و city/location/birth_date
      // لم تعد ممنوحة للقراءة عبر REST (ترحيل 20270206000000)، وتُقرأ لصاحب
      // الحساب عبر الدالتين المصرّح بهما أدناه.
      const { data, error } = await supabase.from('profiles')
        .select(PUBLIC_PROFILE_COLUMNS)
        .eq('id', sessionUser.id)
        .returns<PublicProfileRow>()
        .maybeSingle();
      if (error) throw error;

      const [preferences, conditionalFields, onboardingSnapshot] = await Promise.all([
        fetchMyPreferences(),
        fetchConditionalProfileFields(sessionUser.id),
        fetchMyOnboardingState(),
      ]);
      if (!isCurrent()) {
        return { ok: false, profileState: 'loading', onboardingComplete: false };
      }

      applyProfile(data
        ? ({ ...(data as Profile), ...(conditionalFields || {}), ...(preferences || {}) } as Profile)
        : null);

      const nextProfileState: ProfileLoadState = data ? 'ready' : 'missing';
      setProfileState(nextProfileState);
      setOnboarding(onboardingSnapshot);

      const onboardingComplete = onboardingIsComplete(onboardingSnapshot);
      return {
        ok: nextProfileState === 'ready' && onboardingSnapshot !== null && onboardingComplete,
        profileState: nextProfileState,
        onboardingComplete,
      };
    } catch (profileError) {
      // فشل تحميل الملف (شبكة/RLS/انقطاع) لا يُعتبر اكتمالاً ولا يفتح التطبيق.
      console.warn('[app] تعذر تحميل الملف الشخصي — لا يُفتح التطبيق قبل تحميله:', profileError);
      if (!isCurrent()) {
        return { ok: false, profileState: 'loading', onboardingComplete: false };
      }
      setProfile(null);
      setProfileState('failed');
      setOnboarding(null);
      return { ok: false, profileState: 'failed', onboardingComplete: false };
    }
  }, []);

  useEffect(() => {
    sessionUserRef.current = user ?? null;
    void loadProfileData();
  }, [user?.id, user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name, user?.user_metadata?.username, loadProfileData]);

  /**
   * إعادة تحميل الملف من قاعدة البيانات (بعد إكمال التسجيل أو إعادة المحاولة).
   * تُعيد النتيجة الفعلية لا الحالة المحفوظة، فلا يُنقل المستخدم قبل تحققها.
   */
  const reloadProfile = loadProfileData;

  /**
   * تسجيل الخروج: إلغاء رمز جهاز هذا المتصفح أولاً (revoked_at على الخادم)،
   * ثم إنهاء الجلسة — بعد إنهاء الجلسة لا auth.uid() للدالة المحمية، فيبقى
   * الرمز نشطاً ويستمر وصول إشعارات الحساب السابق إلى هذا الجهاز.
   * لا تُمسح الحالة المحلية ولا يُدَّعى الخروج إذا فشل الإلغاء أو إنهاء الجلسة.
   * لا يمسّ رموز أجهزة أخرى: الإلغاء بمعرّف تثبيت هذا المتصفح وحده.
   */
  const signOut = async (): Promise<DeviceSignOutOutcome> => {
    if (!supabaseConfigured) {
      syncMembershipOwner(null);
      setSession(null);
      setProfile(null);
      return { ok: true, revoked: false, message: PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE };
    }

    const outcome = await signOutThisDevice(deviceSignOutDeps(() => supabase.auth.signOut()));

    if (outcome.ok) {
      syncMembershipOwner(null);
      setSession(null);
      setProfile(null);
    }
    return outcome;
  };

  const clearPasswordRecovery = () => setPasswordRecovery(false);

  return {
    authLoading,
    authResolved,
    user,
    profile,
    setProfile,
    signOut,
    passwordRecovery,
    clearPasswordRecovery,
    profileState,
    onboarding,
    reloadProfile,
  };
}
