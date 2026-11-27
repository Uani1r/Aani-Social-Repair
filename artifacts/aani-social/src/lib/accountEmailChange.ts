/**
 * تغيير بريد الحساب — منطق واحد قابل للاختبار، ولا يتغيّر البريد المعتمد قبل
 * التأكيد.
 *
 * القواعد:
 * - الطلب يمر عبر `supabase.auth.updateUser({ email })` وحدها، فيرسل Supabase
 *   رابط تأكيد إلى البريد القديم والجديد (Secure email change) ولا يُطبَّق
 *   التغيير قبل فتح الرابطين. لا يُعطَّل هذا السلوك ولا يُتجاوز.
 * - البريد المعروض في الإعدادات يبقى بريد الجلسة الحالي حتى يؤكده Supabase؛
 *   هذا الملف لا يكتب بريداً في أي حالة محلية.
 * - رسائل الفشل عامة: لا تكشف أن بريداً يخص حساباً آخر.
 */

export const ACCOUNT_EMAIL_INVALID_MESSAGE = 'أدخل بريدًا إلكترونيًا صحيحًا.';
export const ACCOUNT_EMAIL_SAME_MESSAGE = 'هذا هو بريد حسابك الحالي. أدخل بريدًا مختلفًا.';
export const ACCOUNT_EMAIL_TAKEN_MESSAGE = 'تعذر استخدام هذا البريد. جرّب بريدًا آخر.';
export const ACCOUNT_EMAIL_RATE_LIMITED_MESSAGE =
  'تجاوزت عدد المحاولات المسموح. انتظر قليلًا ثم أعد المحاولة.';
export const ACCOUNT_EMAIL_UNAVAILABLE_MESSAGE =
  'تعذر إرسال طلب تغيير البريد الآن. حاول مجددًا.';
export const ACCOUNT_EMAIL_PENDING_MESSAGE =
  'أرسلنا رابط تأكيد إلى بريدك الحالي وإلى البريد الجديد. لن يتغيّر بريد الحساب قبل فتح الرابطين.';
/** العودة من رابط التأكيد بعد انتهاء صلاحيته أو استعماله مرتين. */
export const ACCOUNT_EMAIL_LINK_EXPIRED_MESSAGE =
  'انتهت صلاحية رابط تأكيد البريد أو استُخدم سابقاً. اطلب رابطاً جديداً.';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export type EmailChangePlan =
  | { ok: true; email: string }
  | { ok: false; message: string };

/** يتحقق من البريد الجديد قبل أي طلب: صيغة، وطول، وألا يكون البريد نفسه. */
export function planEmailChange(currentEmail: string, nextEmail: string): EmailChangePlan {
  const current = String(currentEmail ?? '').trim().toLowerCase();
  const next = String(nextEmail ?? '').trim().toLowerCase();
  if (!next || next.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(next)) {
    return { ok: false, message: ACCOUNT_EMAIL_INVALID_MESSAGE };
  }
  if (current && next === current) return { ok: false, message: ACCOUNT_EMAIL_SAME_MESSAGE };
  return { ok: true, email: next };
}

function readErrorMessage(error: unknown): string {
  const value = (error as { message?: unknown })?.message;
  return typeof value === 'string' ? value : '';
}

/** يحوّل خطأ Supabase إلى رسالة عربية عامة واحدة لكل حالة. */
export function readEmailChangeFailure(error: unknown): string {
  const message = readErrorMessage(error);
  if (/expired|invalid.*token|token.*invalid|otp_expired/i.test(message)) {
    return ACCOUNT_EMAIL_LINK_EXPIRED_MESSAGE;
  }
  if (/already|registered|exists|in use|taken|duplicate/i.test(message)) {
    return ACCOUNT_EMAIL_TAKEN_MESSAGE;
  }
  if (/rate limit|too many|for security purposes|over_email_send_rate_limit/i.test(message)) {
    return ACCOUNT_EMAIL_RATE_LIMITED_MESSAGE;
  }
  if (/invalid.*email|email.*invalid|unable to validate|email address.*not/i.test(message)) {
    return ACCOUNT_EMAIL_INVALID_MESSAGE;
  }
  return ACCOUNT_EMAIL_UNAVAILABLE_MESSAGE;
}

export type EmailChangeDeps = {
  /** `supabase.auth.updateUser` كما هو في supabase-js. */
  updateUser: (payload: { email: string }) => Promise<{ error: unknown }>;
};

export type EmailChangeOutcome =
  | { ok: true; email: string; pending: true; message: string }
  | { ok: false; message: string };

/**
 * يطلب تغيير البريد: لا كتابة محلية، والنتيجة «معلّق» فقط. البريد لا يُعدّ
 * مغيَّراً حتى يؤكد المستخدم الرابطين.
 */
export async function requestEmailChange(
  currentEmail: string,
  nextEmail: string,
  deps: EmailChangeDeps,
): Promise<EmailChangeOutcome> {
  const plan = planEmailChange(currentEmail, nextEmail);
  if (!plan.ok) return plan;

  const { error } = await deps.updateUser({ email: plan.email });
  if (error) return { ok: false, message: readEmailChangeFailure(error) };

  return { ok: true, email: plan.email, pending: true, message: ACCOUNT_EMAIL_PENDING_MESSAGE };
}

/** وصف حالة الطلب المعلّق للعرض فقط: لا يغيّر البريد المعروض. */
export function describeEmailChangeState(input: {
  currentEmail: string;
  pendingEmail: string | null;
}): { currentEmail: string; pendingEmail: string | null; hasPending: boolean } {
  const pending = input.pendingEmail && input.pendingEmail !== input.currentEmail
    ? input.pendingEmail
    : null;
  return { currentEmail: input.currentEmail, pendingEmail: pending, hasPending: pending !== null };
}
