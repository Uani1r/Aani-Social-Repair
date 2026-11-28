/**
 * بوابة التوجيه: قرار واحد بين الانتظار وتسجيل الدخول وخطأ الملف والإكمال
 * والتطبيق. تُستدعى من App بعد كل تحديث للجلسة وللملف، ومن الاختبارات مباشرة.
 *
 * القواعد الصارمة:
 *   1. لا يُعرض التطبيق قبل حسم الجلسة (authResolved).
 *   2. لا يُعرض قبل تحميل الملف الشخصي فعلياً (ليس أثناء التحميل).
 *   3. غياب الملف (missing) أو فشل تحميله (failed) ليس اكتمالاً: لا يُفتح
 *      التطبيق ولا تُعدّ الحالة مكتملة.
 *   4. المستخدم غير المكتمل يرى الإكمال وحده، ولو كان الطلب على /feed.
 *   5. تحديث الصفحة لا يتجاوز الحماية: القرار يُحسب من الجلب الجديد للملف،
 *      لا من أي علامة محفوظة في المتصفح.
 *   6. المستخدم المكتمل والمستخدم غير المسجل لا يتأثران.
 *
 * لا قرار هنا يعتمد على `user_metadata` ولا على وجود صف وهمي: الحالة تأتي من
 * `profiles.onboarding_completed_at` عبر aani_my_onboarding_state وحدها.
 */

export type ProfileLoadState = 'idle' | 'loading' | 'ready' | 'missing' | 'failed';

export type AuthGate = 'loading' | 'signin' | 'profile_error' | 'onboarding' | 'app';

export type AuthGateInput = {
  authLoading: boolean;
  authResolved: boolean;
  hasUser: boolean;
  profileState: ProfileLoadState;
  onboardingComplete: boolean;
};

export function resolveAuthGate(input: AuthGateInput): AuthGate {
  if (input.authLoading || !input.authResolved) return 'loading';
  if (!input.hasUser) return 'signin';

  // لا يُعامل غياب الملف ولا فشل تحميله اكتمالاً.
  if (input.profileState === 'idle' || input.profileState === 'loading') return 'loading';
  if (input.profileState === 'failed') return 'profile_error';

  // ملف غائب أو حالة إكمال غير مثبتة → واجهة الإكمال فقط، لا صفحات داخلية.
  if (input.profileState === 'missing' || !input.onboardingComplete) return 'onboarding';

  return 'app';
}

export const AUTH_GATE_MESSAGES = {
  profileLoadFailed: 'تعذر تحميل ملفك الشخصي، ولا يمكن فتح التطبيق قبل تحميله. تحقق من اتصالك ثم أعد المحاولة.',
  retry: 'إعادة المحاولة',
  signOut: 'تسجيل الخروج',
  loading: 'جارٍ تحميل حسابك…',
} as const;
