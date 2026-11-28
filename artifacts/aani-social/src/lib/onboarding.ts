/**
 * اكتمال التسجيل: قراءة موثوقة من قاعدة البيانات وحدها.
 *
 * `profiles.onboarding_completed_at` هو الفيصل (لا وجود صف، ولا اسم مستخدم،
 * ولا وجود صف في user_metadata). الاسم الذي ينشئه مشغّل إنشاء الحساب ليس
 * دليلاً على اكتمال التسجيل: مستخدم Google الجديد يصل بـ`onboarding` فارغ
 * فيُوجَّه إلى واجهة الإكمال.
 *
 * الحقول تُقرأ عبر `aani_my_onboarding_state()` لأن أعمدة الحالة والموافقة لم
 * تُمنح للقراءة المباشرة عبر REST (كـ city/birth_date في ترحيل 20270206000000).
 *
 * التوافق: قبل تطبيق ترحيل السجل والحالة لا تكون الدالة موجودة (42883 /
 * PGRST202). في هذه الحالة `supported: false` وتُعامل الحسابات القائمة
 * كاملةً (لا يُفرض على أحد إعادة تسجيل بسبب ترحيل لم يُطبَّق بعد). أما فشل
 * القراءة (شبكة/صلاحيات) فأمر آخر: يُعيد null، ولا يُعامل اكتمالاً.
 */

import { STORY_VIEWER_PLACEHOLDER_NAMES } from '@/lib/appShared';
import { supabase } from '@/lib/supabase';
import { normalizeUsernameInput, validateUsername } from '@/lib/usernameRules';

/** إصدار الشروط الذي يُسجَّل وقت الموافقة. يتغيّر عند نشر شروط جديدة. */
export const ONBOARDING_TERMS_VERSION = 'aani-terms-2026-11';

/** مسار صفحة الشروط الفعلية داخل التطبيق (راجع src/pages/legal.tsx). */
export const TERMS_PATH = '/terms';

/** مسار صفحة سياسة الخصوصية الفعلية داخل التطبيق. */
export const PRIVACY_PATH = '/privacy';

export type OnboardingState = {
  onboardingCompletedAt: string | null;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  username: string | null;
};

export const EMPTY_ONBOARDING_STATE: OnboardingState = {
  onboardingCompletedAt: null,
  termsAcceptedAt: null,
  termsVersion: null,
  username: null,
};

/**
 * `supported: false` يعني أن ترحيل الحالة لم يُطبَّق على قاعدة البيانات بعد.
 * لا يُخلط مع فشل القراءة: ذاك يُعيد null.
 */
export type OnboardingSnapshot = {
  supported: boolean;
  state: OnboardingState | null;
};

type RpcResponse = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

export type OnboardingClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResponse>;
};

const supabaseRpc: OnboardingClient['rpc'] = (fn, args) =>
  (supabase.rpc as unknown as OnboardingClient['rpc'])(fn, args);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** قراءة صف الحالة من استجابة الدالة (صف مفرد أو مصفوفة). */
export function parseOnboardingPayload(data: unknown): OnboardingState | null {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') return null;
  const row = first as Record<string, unknown>;
  return {
    onboardingCompletedAt: readString(row.onboarding_completed_at),
    termsAcceptedAt: readString(row.terms_accepted_at),
    termsVersion: readString(row.terms_version),
    username: readString(row.username),
  };
}

/**
 * هل اكتمل التسجيل؟ اللقطة الغائبة أو غير المقروءة لا تُعدّ اكتمالاً.
 * اللقطة غير المدعومة (لا ترحيل) تُعدّ اكتمالاً للحسابات القائمة فقط.
 */
export function onboardingIsComplete(snapshot: OnboardingSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  if (!snapshot.supported) return true;
  return Boolean(snapshot.state?.onboardingCompletedAt);
}

/**
 * يقرأ حالة المستخدم الحالي.
 *   * `{ supported: false }` — الدالة غير مثبتة (ترحيل لم يُطبَّق).
 *   * `null` — فشل قراءة حقيقي: لا يُعامل اكتمالاً.
 */
export async function fetchMyOnboardingState(
  client?: OnboardingClient,
): Promise<OnboardingSnapshot | null> {
  const rpc = client?.rpc ?? supabaseRpc;

  try {
    const { data, error } = await rpc('aani_my_onboarding_state');
    if (error) {
      const code = String(error.code ?? '');
      if (code === '42883' || code === 'PGRST202') return { supported: false, state: null };
      console.warn('[onboarding] تعذر قراءة حالة إكمال التسجيل:', error.message || code);
      return null;
    }
    const state = parseOnboardingPayload(data);
    if (!state) return null;
    return { supported: true, state };
  } catch (error) {
    console.warn('[onboarding] فشل طلب حالة إكمال التسجيل:', error);
    return null;
  }
}

/**
 * هل الاسم الحالي مجرد بديل أنشأه مشغّل الحساب؟
 *   * معرّف الحساب بلا شرطات (المشغّل يستخدمه عند غياب اسم صالح).
 *   * `user_` + 8 محارف من المعرّف (بعض الترحيلات القديمة).
 * لا يُعرض هذا الاسم على أنه اختيار المستخدم في واجهة الإكمال.
 */
export function looksLikePlaceholderUsername(
  username: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  const name = normalizeUsernameInput(username);
  if (!name) return true;
  const id = typeof userId === 'string' ? userId.replace(/-/g, '').toLowerCase() : '';
  if (!id) return false;
  if (name === id || name === id.slice(0, 32)) return true;
  return /^user_[0-9a-z]{8}$/.test(name);
}

type ProviderUser = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

/** الاسم الكامل من مزوّد الهوية (Google) لتعبئة أولية قابلة للتعديل. */
export function fullNameFromProvider(user: ProviderUser | null | undefined): string {
  const metadata = user?.user_metadata ?? {};
  for (const candidate of [metadata.full_name, metadata.name, metadata.display_name]) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim();
    if (name && !STORY_VIEWER_PLACEHOLDER_NAMES.has(name.toLowerCase())) {
      return name.slice(0, 120);
    }
  }
  return '';
}

/**
 * اقتراح اسم مستخدم من مزوّد الهوية أو البريد — اقتراح فقط، ويبقى قابلاً
 * للتعديل، ولا يعني أن الاسم متاح (المطالبة تتحقق من الخادم).
 */
export function suggestedUsernameFromProvider(user: ProviderUser | null | undefined): string {
  const metadata = user?.user_metadata ?? {};
  const email = typeof user?.email === 'string' ? user.email.split('@')[0] ?? '' : '';

  for (const candidate of [metadata.username, metadata.preferred_username, email]) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    const validation = validateUsername(cleaned);
    if (validation.ok) return validation.username;
  }
  return '';
}
