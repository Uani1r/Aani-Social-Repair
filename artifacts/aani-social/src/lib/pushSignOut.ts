/**
 * تسجيل الخروج مع إلغاء رمز جهاز هذا المتصفح.
 *
 * الثغرة التي يغلقها هذا الملف: كان تسجيل الخروج ينهي جلسة Supabase وحدها،
 * فيبقى صف الجهاز نشطاً في `public.device_tokens` (`revoked_at is null`)
 * بعد الخروج، ويستمر عامل الإرسال في دفع إشعارات الحساب السابق إلى هذا
 * الجهاز — حتى بعد خروج المستخدم أو دخول حساب آخر عليه.
 *
 * القواعد:
 *   * الإلغاء أولاً على الخادم (`aani_revoke_device_token` → `revoked_at`)،
 *     ثم إنهاء الجلسة: بعد إنهاء الجلسة يصبح `auth.uid()` فارغاً ولا يمكن
 *     استدعاء الدالة المحمية، فيبقى الرمز نشطاً بلا وسيلة لإلغائه.
 *   * الإلغاء بمعرّف تثبيت هذا المتصفح وحده: لا رمز آخر ولا جهاز آخر،
 *     فالأجهزة الأخرى لا تفقد إشعاراتها عند خروج هذا الجهاز.
 *   * فشل الإلغاء لا يُعرض أبداً كنجاح: الجلسة تبقى قائمة كي تُعاد المحاولة،
 *     والحالة المحلية (معرّف التثبيت) تبقى كما هي — لا ادّعاء خروج ولا مسح.
 *   * الدالة غير منشورة في القاعدة (الترحيلات غير مطبقة) ليست فشلاً: لا صف
 *     جهاز أصلاً، فيكتمل الخروج بلا ادّعاء إلغاء.
 *   * لا شيء هنا يلامس Firebase أو الشبكة مباشرة: كل نداء يُحقن، فالاختبار
 *     يثبت الترتيب والفشل بلا شبكة ولا أسرار.
 */

export const PUSH_SIGN_OUT_REVOKE_FAILED_MESSAGE =
  'تعذر إلغاء تسجيل هذا الجهاز من الإشعارات، فلم تُنهَ الجلسة. تحقق من الاتصال وأعد المحاولة.';

export const PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE =
  'أُلغي تسجيل هذا الجهاز، لكن تعذر إنهاء الجلسة. أعد المحاولة أو أعد تحميل الصفحة.';

export const PUSH_SIGN_OUT_SESSION_CHECK_FAILED_MESSAGE =
  'تعذر التحقق من الجلسة الحالية، فلم يُنهَ تسجيل هذا الجهاز ولم تُنهَ الجلسة. تحقق من الاتصال وأعد المحاولة.';

export const PUSH_SIGN_OUT_DONE_WITH_DEVICE_MESSAGE =
  'تم إلغاء تسجيل هذا الجهاز من الإشعارات وتسجيل الخروج.';

export const PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE =
  'تم تسجيل الخروج. لم يكن هذا الجهاز مسجلاً للإشعارات.';

/** الخطوة التي فشلت: إلغاء رمز الجهاز، أو إنهاء الجلسة بعده. */
export type DeviceSignOutStep = 'revoke' | 'session';

export type DeviceSignOutOutcome =
  | { ok: true; revoked: boolean; message: string }
  | { ok: false; step: DeviceSignOutStep; message: string };

export type DeviceSignOutDeps = {
  /** معرّف المستخدم النشط الآن، أو null حين لا جلسة (لا شيء لإلغائه). */
  readUserId: () => Promise<string | null>;
  /** معرّف تثبيت هذا المتصفح المحفوظ، أو null حين لم يُسجَّل جهاز. */
  readInstallationId: () => string | null;
  /**
   * الإلغاء على الخادم بمعرّف التثبيت وحده.
   * `missing` تعني أن الدالة غير منشورة في هذه القاعدة (الترحيلات غير مطبقة):
   * لا صف جهاز أصلاً، فلا شيء يُلغى.
   */
  revokeDeviceToken: (installationId: string) => Promise<{ error: unknown; missing?: boolean }>;
  /** إنهاء الجلسة — لا يُستدعى إلا بعد نجاح الإلغاء. */
  endSession: () => Promise<{ error: unknown }>;
};

/**
 * تسجيل خروج هذا الجهاز: إلغاء رمز جهازه أولاً، ثم إنهاء الجلسة.
 *
 * - لا جلسة أو لا جهاز مسجّل محلياً → لا استدعاء لدالة الإلغاء، وإنهاء الجلسة
 *   وحده (لا يوجد ما يُلغى).
 * - تعذّر التحقق من الجلسة → لا إلغاء ولا إنهاء، ولا نجاح.
 * - فشل الإلغاء → `ok: false` مع `step: 'revoke'`، والجلسة تبقى قائمة.
 * - فشل إنهاء الجلسة → `ok: false` مع `step: 'session'` (الرمز أُلغي فعلاً).
 */
export async function signOutThisDevice(deps: DeviceSignOutDeps): Promise<DeviceSignOutOutcome> {
  let userId: string | null;
  try {
    userId = await deps.readUserId();
  } catch {
    // بلا معرفة الجلسة لا يُنهى شيء: لا ادّعاء خروج ولا إلغاء أعمى.
    return { ok: false, step: 'session', message: PUSH_SIGN_OUT_SESSION_CHECK_FAILED_MESSAGE };
  }

  const installationId = deps.readInstallationId();
  let revoked = false;

  // لا إلغاء بلا جلسة (الدالة المحمية تحتاج auth.uid) ولا بلا جهاز مسجّل.
  if (userId && installationId) {
    try {
      const { error, missing } = await deps.revokeDeviceToken(installationId);
      if (error) {
        // الجلسة باقية عمداً: الإلغاء شرط لإنهاء الجلسة، وإلا بقي الرمز
        // نشطاً بلا وسيلة لإلغائه بعد الخروج.
        return { ok: false, step: 'revoke', message: PUSH_SIGN_OUT_REVOKE_FAILED_MESSAGE };
      }
      // الدالة غير منشورة في هذه القاعدة → لا صف جهاز، فلا ادّعاء إلغاء.
      revoked = missing !== true;
    } catch {
      return { ok: false, step: 'revoke', message: PUSH_SIGN_OUT_REVOKE_FAILED_MESSAGE };
    }
  }

  try {
    const { error: sessionError } = await deps.endSession();
    if (sessionError) {
      return { ok: false, step: 'session', message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE };
    }
  } catch {
    return { ok: false, step: 'session', message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE };
  }

  return {
    ok: true,
    revoked,
    message: revoked ? PUSH_SIGN_OUT_DONE_WITH_DEVICE_MESSAGE : PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE,
  };
}

/**
 * بعد حذف الحساب نهائياً: صفوف أجهزته حُذفت بالتسلسل مع صف الملف الشخصي
 * (`device_tokens.user_id ... on delete cascade`)، فلا إلغاء هنا — ولا نداء
 * لدالة محمية بجلسة انتهت. إنهاء الجلسة المحلية وحدها.
 */
export async function endSessionAfterAccountDeletion(
  deps: { endSession: () => Promise<{ error: unknown }> },
): Promise<{ ok: boolean; message: string }> {
  try {
    const { error } = await deps.endSession();
    if (error) return { ok: false, message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE };
  } catch {
    return { ok: false, message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE };
  }
  return { ok: true, message: '' };
}
