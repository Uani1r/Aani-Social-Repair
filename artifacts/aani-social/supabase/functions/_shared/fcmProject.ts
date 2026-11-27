/**
 * معرّف مشروع Firebase لـFCM: حساب الخدمة هو المصدر الوحيد.
 *
 * القواعد:
 *   * `project_id` يُقرأ من حساب الخدمة، ولا يُنشأ ولا يُخمَّن ولا يُستنتج من
 *     رقم المشروع (742633618169).
 *   * إن ضُبط `FIREBASE_PROJECT_ID` وجب أن يطابق `project_id` تماماً؛ أي
 *     اختلاف يوقف التنفيذ قبل أي إرسال — المتغير تحقق لا تجاوز.
 *   * مشروع Firebase القديم `ani1-20bed` مرفوض في المتغير وفي حساب الخدمة.
 *   * رسائل الخطأ رموز ثابتة فقط: لا معرّفات ولا أسرار ولا أي قيمة من البيئة،
 *     فلا يكشف الخطأ ما رُفض.
 *
 * نقي بلا Deno ولا شبكة ولا مفاتيح، فتُختبر القرارات في الاختبارات وحدها.
 */

export const FORBIDDEN_FIREBASE_PROJECT = 'ani1-20bed';

export const FIREBASE_PROJECT_ERRORS = {
  missing: 'firebase_project_missing: the service account has no project_id',
  forbidden: 'firebase_project_forbidden: the legacy Firebase project is not allowed',
  mismatch: 'firebase_project_mismatch: FIREBASE_PROJECT_ID does not match the service account project_id',
} as const;

export type FirebaseProjectErrorCode = keyof typeof FIREBASE_PROJECT_ERRORS;

/** خطأ إعداد معرّف المشروع: يحمل الرمز وحده، بلا أي قيمة. */
export class FirebaseProjectError extends Error {
  readonly code: FirebaseProjectErrorCode;

  constructor(code: FirebaseProjectErrorCode) {
    super(FIREBASE_PROJECT_ERRORS[code]);
    this.name = 'FirebaseProjectError';
    this.code = code;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * المعرّف المعتمد للإرسال: `project_id` من حساب الخدمة.
 * إن ضُبط `FIREBASE_PROJECT_ID` فلا بد أن يطابق القيمة نفسها، وإلا فشل هنا.
 */
export function resolveFirebaseProjectId(accountProjectId: unknown, envProjectId: unknown): string {
  const fromAccount = text(accountProjectId);
  const fromEnv = text(envProjectId);

  // لا معرّف بلا مشروع في حساب الخدمة: لا يُنشأ ولا يُستنتج، ولو وُجد متغير.
  if (!fromAccount) throw new FirebaseProjectError('missing');
  if (fromAccount === FORBIDDEN_FIREBASE_PROJECT) throw new FirebaseProjectError('forbidden');

  // المتغير اختياري: غيابه يعني الاعتماد على حساب الخدمة وحده.
  if (!fromEnv) return fromAccount;

  if (fromEnv === FORBIDDEN_FIREBASE_PROJECT) throw new FirebaseProjectError('forbidden');
  if (fromEnv !== fromAccount) throw new FirebaseProjectError('mismatch');

  return fromAccount;
}
