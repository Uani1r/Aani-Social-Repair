/**
 * تعطيل الحساب مؤقتاً وحذفه نهائياً — منطق العميل الوحيد.
 *
 * التعطيل:
 * - `aani_deactivate_account` على الخادم وحدها تعيّن `is_deactivated` (منع
 *   التحديث المباشر عبر مشغّل في قاعدة البيانات) وتنهي جلسات الأجهزة الأخرى.
 * - إعادة التفعيل عند الدخول مجدداً عبر `aani_reactivate_account` وحدها.
 *
 * الحذف:
 * - الهوية من رمز الجلسة على الخادم فقط: لا `user_id` من العميل، ولا حذف
 *   لملفات التخزين قبل حذف حساب Auth؛ الوسائط تدخل طابور
 *   `media_deletion_jobs` بمشغّلات قاعدة البيانات بعد الحذف، ويتحقق Worker من
 *   المراجع الحية قبل حذف أي ملف.
 * - لا نجاح معروض قبل تأكيد الخادم، ولا حالة حذف جزئي صامتة.
 */

export const ACCOUNT_DEACTIVATED_MESSAGE =
  'تم تعطيل الحساب مؤقتاً وإنهاء الجلسات الأخرى. سجّل الدخول مجدداً لإعادة تفعيله.';
export const ACCOUNT_DEACTIVATION_FAILED_MESSAGE =
  'تعذر تعطيل الحساب الآن. لم يتغيّر شيء؛ حاول مجددًا.';
export const ACCOUNT_REACTIVATED_MESSAGE = 'تمت إعادة تفعيل الحساب.';
export const ACCOUNT_DELETE_CONFIRM_WORD = 'حذف';
export const ACCOUNT_DELETE_FAILED_MESSAGE =
  'تعذر حذف الحساب. لم يُحذف الحساب ولم تُحذف وسائطه؛ حاول مجددًا أو تواصل مع الدعم.';
export const ACCOUNT_DELETED_MESSAGE = 'تم حذف الحساب نهائياً وإدراج وسائطه في طابور الحذف.';

export type DeactivateDeps = {
  deactivate: () => Promise<{ error: unknown }>;
  signOutLocal: () => Promise<{ error: unknown }>;
};

export type DeactivateOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * يعطّل الحساب: لا خروج محلي قبل نجاح الخادم، ثم إنهاء الجلسة المحلية فقط
 * (الخادم أنهى البقية). فشل الخروج المحلي لا يلغي نجاح التعطيل.
 */
export async function deactivateAccount(deps: DeactivateDeps): Promise<DeactivateOutcome> {
  const { error } = await deps.deactivate();
  if (error) return { ok: false, message: ACCOUNT_DEACTIVATION_FAILED_MESSAGE };
  await deps.signOutLocal();
  return { ok: true, message: ACCOUNT_DEACTIVATED_MESSAGE };
}

export type ReactivateDeps = {
  reactivate: () => Promise<{ error: unknown }>;
};

/** إعادة التفعيل بعد الدخول: لا تُعلَن النجاح قبل تأكيد الخادم. */
export async function reactivateAccount(
  deps: ReactivateDeps,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const { error } = await deps.reactivate();
  if (error) return { ok: false, message: ACCOUNT_DEACTIVATION_FAILED_MESSAGE };
  return { ok: true, message: ACCOUNT_REACTIVATED_MESSAGE };
}

export type DeleteAccountDeps = {
  /** نداء دالة `delete-account`، بلا هوية ولا مسار تخزين من العميل. */
  deleteAccount: () => Promise<{ data: unknown; error: unknown }>;
  signOutLocal: () => Promise<{ error: unknown }>;
};

export type DeleteOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };

function readServerError(error: unknown): string {
  const context = (error as { context?: unknown })?.context;
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : context instanceof Response ? '' : '';
}

/**
 * يحذف الحساب نهائياً: تأكيد الكلمة أولاً، ثم نداء واحد للخادم. لا حذف لأي
 * وسيط من العميل، ولا إظهار نجاح قبل رد الخادم.
 */
export async function deleteAccount(
  confirmation: string,
  deps: DeleteAccountDeps,
): Promise<DeleteOutcome> {
  if (String(confirmation ?? '').trim() !== ACCOUNT_DELETE_CONFIRM_WORD) {
    return { ok: false, message: `اكتب «${ACCOUNT_DELETE_CONFIRM_WORD}» للتأكيد.` };
  }

  const { data, error } = await deps.deleteAccount();
  if (error) {
    return { ok: false, message: readServerError(error) || ACCOUNT_DELETE_FAILED_MESSAGE };
  }
  const success = Boolean(data && typeof data === 'object' && (data as { success?: unknown }).success === true);
  if (!success) return { ok: false, message: ACCOUNT_DELETE_FAILED_MESSAGE };

  await deps.signOutLocal();
  return { ok: true, message: ACCOUNT_DELETED_MESSAGE };
}
