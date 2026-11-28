/**
 * إكمال التسجيل: نموذج واحد (تحقق + حفظ) للتسجيل بالبريد ولمستخدم Google.
 *
 * الحفظ لا يكتب على profiles من العميل: كل شيء يمر بدالة واحدة ذرية
 * `aani_complete_onboarding(...)`، وهي التي:
 *   * تطالب باسم المستخدم عبر السجل (available/reserved/blocked/claimed)،
 *   * تضبط الاسم الكامل وتاريخ الميلاد والجنس،
 *   * تسجّل وقت الموافقة على الشروط وإصدارها و`onboarding_completed_at`.
 * لذلك لا يمكن تجاوز قرار الإدارة أو الاسم المحجوز من الواجهة أو من REST.
 *
 * الموافقة إلزامية: لا حفظ بلا موافقة، ووقتها يُحفظ في قاعدة البيانات لا في
 * المتصفح.
 */

import { supabase } from '@/lib/supabase';
import { ONBOARDING_TERMS_VERSION } from '@/lib/onboarding';
import { USERNAME_MESSAGES, normalizeUsernameInput, validateUsername } from '@/lib/usernameRules';

export type ProfileGender = 'male' | 'female';

/** مسودة النموذج كما يراها المستخدم قبل الحفظ. */
export type ProfileDraft = {
  fullName: string;
  username: string;
  birthDate: string;
  gender: ProfileGender | null;
  termsAccepted: boolean;
};

/** الموافقة محددة افتراضياً وقابلة لإلغاء التحديد. */
export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  fullName: '',
  username: '',
  birthDate: '',
  gender: null,
  termsAccepted: true,
};

export const PROFILE_COMPLETION_MESSAGES = {
  fullNameRequired: 'أدخل اسمك الكامل.',
  fullNameTooLong: 'الاسم الكامل لا يزيد عن 120 محرفاً.',
  birthDateRequired: 'أدخل تاريخ ميلادك.',
  birthDateInvalid: 'أدخل تاريخ ميلاد صالحاً بصيغة سنة-شهر-يوم.',
  birthDateRange: 'تاريخ الميلاد يجب أن يكون بين 1900 واليوم.',
  genderRequired: 'اختر الجنس: ذكر أو أنثى.',
  termsRequired: 'يجب الموافقة على الشروط والأحكام وسياسة الخصوصية للمتابعة.',
  saveFailed: 'تعذر حفظ بياناتك. أعد المحاولة.',
  notInstalled: 'بنية إكمال التسجيل لم تُطبَّق على قاعدة البيانات بعد.',
  verifyFailed: 'حُفظت بياناتك، لكن تعذر التحقق من اكتمال ملفك. أعد المحاولة.',
} as const;

export type ProfileDraftField = 'fullName' | 'username' | 'birthDate' | 'gender' | 'terms';

export type ProfileDraftValues = {
  fullName: string;
  username: string;
  birthDate: string;
  gender: ProfileGender;
  termsVersion: string;
};

export type ProfileDraftValidation =
  | { ok: true; value: ProfileDraftValues }
  | { ok: false; field: ProfileDraftField; message: string };

/**
 * يقرأ تاريخ ميلاد بصيغة YYYY-MM-DD: تاريخ حقيقي، بين 1900 واليوم.
 * يُعيد القيمة المطبَّعة أو null.
 */
export function readBirthDate(value: unknown, today: Date = new Date()): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900) return null;

  // تاريخ تقويمي حقيقي: 31 فبراير ليس تاريخاً.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date.getTime() > todayUtc) return null;

  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * تحقق النموذج كاملاً قبل أي طلب: الاسم، اسم المستخدم بقواعد 1–32، تاريخ
 * الميلاد، جنس صريح، وموافقة صريحة.
 */
export function validateProfileDraft(draft: ProfileDraft, today: Date = new Date()): ProfileDraftValidation {
  const fullName = typeof draft.fullName === 'string' ? draft.fullName.trim() : '';
  if (!fullName) {
    return { ok: false, field: 'fullName', message: PROFILE_COMPLETION_MESSAGES.fullNameRequired };
  }
  if (fullName.length > 120) {
    return { ok: false, field: 'fullName', message: PROFILE_COMPLETION_MESSAGES.fullNameTooLong };
  }

  const username = validateUsername(draft.username);
  if (!username.ok) {
    return { ok: false, field: 'username', message: username.message };
  }

  const rawBirthDate = typeof draft.birthDate === 'string' ? draft.birthDate.trim() : '';
  if (!rawBirthDate) {
    return { ok: false, field: 'birthDate', message: PROFILE_COMPLETION_MESSAGES.birthDateRequired };
  }
  const birthDate = readBirthDate(rawBirthDate, today);
  if (!birthDate) {
    const shape = /^\d{4}-\d{2}-\d{2}$/.test(rawBirthDate);
    return {
      ok: false,
      field: 'birthDate',
      message: shape ? PROFILE_COMPLETION_MESSAGES.birthDateRange : PROFILE_COMPLETION_MESSAGES.birthDateInvalid,
    };
  }

  // جنس صريح: لا اختيار افتراضي بدل المستخدم.
  if (draft.gender !== 'male' && draft.gender !== 'female') {
    return { ok: false, field: 'gender', message: PROFILE_COMPLETION_MESSAGES.genderRequired };
  }

  if (draft.termsAccepted !== true) {
    return { ok: false, field: 'terms', message: PROFILE_COMPLETION_MESSAGES.termsRequired };
  }

  return {
    ok: true,
    value: {
      fullName,
      username: username.username,
      birthDate,
      gender: draft.gender,
      termsVersion: ONBOARDING_TERMS_VERSION,
    },
  };
}

type RpcResponse = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

export type ProfileRpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResponse>;
};

const supabaseRpc: ProfileRpcClient['rpc'] = (fn, args) =>
  (supabase.rpc as unknown as ProfileRpcClient['rpc'])(fn, args);

export type CompleteOnboardingResult =
  | { ok: true; username: string }
  | { ok: false; field: ProfileDraftField | 'save'; code: string; message: string };

/**
 * رسالة الخطأ من قاعدة البيانات. ترتيب الفحص مقصود:
 * الحجز والمنع أولاً (42501) ثم التكرار (23505) ثم الإدخال (22023)، وأخيراً
 * «الدالة غير مثبتة» بلا ادعاء نجاح.
 */
function describeCompleteError(
  error: { code?: string | null; message?: string | null } | null,
): { field: ProfileDraftField | 'save'; code: string; message: string } {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '').toLowerCase();

  if (code === '42883' || code === 'PGRST202' || message.includes('could not find the function')) {
    return { field: 'save', code: 'unavailable', message: PROFILE_COMPLETION_MESSAGES.notInstalled };
  }
  if (message.includes('reserved')) {
    return { field: 'username', code: 'reserved', message: USERNAME_MESSAGES.reserved };
  }
  if (message.includes('blocked')) {
    return { field: 'username', code: 'blocked', message: USERNAME_MESSAGES.blocked };
  }
  if (code === '23505' || message.includes('duplicate') || message.includes('already claimed')) {
    return { field: 'username', code: 'taken', message: USERNAME_MESSAGES.taken };
  }
  if (/terms_required|terms required/.test(message)) {
    return { field: 'terms', code: 'terms_required', message: PROFILE_COMPLETION_MESSAGES.termsRequired };
  }
  if (/invalid_gender|invalid gender/.test(message)) {
    return { field: 'gender', code: 'invalid_gender', message: PROFILE_COMPLETION_MESSAGES.genderRequired };
  }
  if (/invalid_birth_date|invalid birth date/.test(message)) {
    return { field: 'birthDate', code: 'invalid_birth_date', message: PROFILE_COMPLETION_MESSAGES.birthDateInvalid };
  }
  if (/invalid_full_name|invalid full name/.test(message)) {
    return { field: 'fullName', code: 'invalid_full_name', message: PROFILE_COMPLETION_MESSAGES.fullNameRequired };
  }
  if (code === '22023' || /invalid_username|invalid username/.test(message)) {
    return { field: 'username', code: 'invalid_username', message: USERNAME_MESSAGES.invalidCharacters };
  }
  if (code === '42501' || message.includes('permission')) {
    return { field: 'username', code: 'blocked', message: USERNAME_MESSAGES.blocked };
  }
  return { field: 'save', code: 'failed', message: PROFILE_COMPLETION_MESSAGES.saveFailed };
}

/**
 * يحفظ إكمال التسجيل عبر الدالة الذرية الوحيدة. لا نداء شبكي إذا كان النموذج
 * غير صالح، ولا نجاح مزعوم إذا فشل الخادم.
 */
export async function completeOnboarding(
  draft: ProfileDraft,
  client?: ProfileRpcClient,
  today: Date = new Date(),
): Promise<CompleteOnboardingResult> {
  const validation = validateProfileDraft(draft, today);
  if (!validation.ok) {
    return { ok: false, field: validation.field, code: 'invalid_draft', message: validation.message };
  }

  const rpc = client?.rpc ?? supabaseRpc;

  try {
    const { data, error } = await rpc('aani_complete_onboarding', {
      p_username: validation.value.username,
      p_full_name: validation.value.fullName,
      p_birth_date: validation.value.birthDate,
      p_gender: validation.value.gender,
      p_terms_version: validation.value.termsVersion,
    });
    if (error) return { ok: false, ...describeCompleteError(error) };

    const returned = typeof data === 'string' ? normalizeUsernameInput(data) : '';
    return { ok: true, username: returned || validation.value.username };
  } catch (error) {
    console.warn('[onboarding] فشل حفظ إكمال التسجيل:', error);
    return { ok: false, field: 'save', code: 'failed', message: PROFILE_COMPLETION_MESSAGES.saveFailed };
  }
}
