/**
 * إدارة طلبات تغيير رقم الهاتف المعلّقة على هذا الجهاز.
 *
 * ما يمكن إثباته فعلياً من العميل (موثّق في Supabase):
 * - `updateUser({ phone })` يبدأ طلب تغيير الهاتف ويُرسل رمز OTP إلى الرقم
 *   الجديد.
 * - `verifyOtp({ phone, token, type: 'phone_change' })` يؤكد الطلب القائم.
 * - `resend({ type: 'phone_change', phone })` يعيد إرسال رمز الطلب القائم
 *   من دون إنشاء طلب جديد.
 * - لا توجد واجهة في العميل لإلغاء طلب phone_change معلّق، ولا للاستعلام
 *   عن حالته لدى الخادم.
 *
 * لذلك:
 * - يُحفظ الرقم المعلّق ووقت الطلب في localStorage — لا React state وحدها —
 *   فيبقى الحجب بعد تحديث الصفحة أو إعادة فتح التطبيق.
 * - يمنع بدء رقم جديد ما دام الطلب قد يكون قائماً. رفع الحجب لا يحدث إلا
 *   بتأكيد الرمز بنجاح، أو بمرور مهلة انتهاء صلاحية OTP الموثّقة أدناه.
 * - مرور المهلة يوقف الحجب محلياً فقط، ولا يُثبت أن Supabase ألغى الطلب،
 *   ولا يُستخدم كدليل على الإلغاء في أي رسالة للمستخدم.
 *
 * لا تُحفظ هنا أي كلمة مرور أو رمز OTP: رقم الهدف ووقت الطلب فقط.
 */
import { isE164Phone } from '@/lib/accountAuth';

/**
 * أقصى مهلة موثّقة لصلاحية OTP في مرجع Supabase JavaScript: القيمة
 * الافتراضية للروابط و OTP هي 24 ساعة (وقابلة للتقليل في إعداد المشروع).
 * العميل لا يستطيع قراءة إعداد المشروع، فيستخدم هذا الحد الأعلى الموثّق،
 * وبعده فقط يرفع الحجب محلياً ويشرح أن ذلك ليس إثباتاً من الخادم.
 */
export const PENDING_PHONE_CHANGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PendingPhoneChange = {
  /** الرقم الجديد المعلّق بصيغة E.164 — لا يُحفظ أي رمز معه. */
  phone: string;
  /** وقت طلب الرمز (ms since epoch) لحساب المهلة المحلية. */
  requestedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  if (storage === null) return null;
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function pendingPhoneChangeKey(userId: string): string {
  return `aani:phone-change:${userId}`;
}

/** يقرأ الطلب المعلّق للمستخدم؛ يتجاهل أي قيمة تالفة أو رقم غير صالح. */
export function readPendingPhoneChange(
  userId: string,
  storage?: StorageLike | null,
): PendingPhoneChange | null {
  const target = resolveStorage(storage);
  if (!target || !userId) return null;
  try {
    const raw = target.getItem(pendingPhoneChangeKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const phone = (parsed as { phone?: unknown }).phone;
    const requestedAt = (parsed as { requestedAt?: unknown }).requestedAt;
    if (typeof phone !== 'string' || !isE164Phone(phone)) return null;
    if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return null;
    return { phone, requestedAt };
  } catch {
    return null;
  }
}

/** يحفظ الطلب المعلّق بعد نجاح طلب الرمز فقط. */
export function savePendingPhoneChange(
  userId: string,
  pending: PendingPhoneChange,
  storage?: StorageLike | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target || !userId || !isE164Phone(pending.phone)) return false;
  try {
    target.setItem(pendingPhoneChangeKey(userId), JSON.stringify({
      phone: pending.phone,
      requestedAt: pending.requestedAt,
    }));
    return true;
  } catch {
    return false;
  }
}

/** يمسح السجل المحلي بعد تأكيد Supabase للرقم فقط. */
export function clearPendingPhoneChange(userId: string, storage?: StorageLike | null): boolean {
  const target = resolveStorage(storage);
  if (!target || !userId) return false;
  try {
    target.removeItem(pendingPhoneChangeKey(userId));
    return true;
  } catch {
    return false;
  }
}

/** المدة المتبقية قبل أن يرفع العميل الحجب محلياً (0 بعد المهلة). */
export function pendingPhoneChangeRemainingMs(
  pending: PendingPhoneChange,
  now: number = Date.now(),
): number {
  const age = Math.max(0, now - pending.requestedAt);
  return Math.max(0, PENDING_PHONE_CHANGE_MAX_AGE_MS - age);
}

export type PhoneChangeDecision =
  | { allowed: true; reason: 'new' | 'resend' | 'previous-may-have-expired' }
  | { allowed: false; reason: 'unchanged' }
  | { allowed: false; reason: 'pending-other'; pending: PendingPhoneChange; remainingMs: number };

/**
 * قرار بدء طلب رقم جديد:
 * - طلب معلّق للرقم نفسه → إعادة إرسال موثّقة (resend) بلا طلب جديد.
 * - طلب معلّق لرقم آخر وما زالت مهلته → ممنوع.
 * - لا طلب، أو انتهت المهلة الموثّقة → مسموح، مع تمييز الحالة الأخيرة
 *   حتى تُعرض للمستخدم بوصفها مهلة محلية لا إثباتاً من الخادم.
 */
export function decidePhoneChangeRequest({
  pending,
  nextPhone,
  currentPhone,
  now = Date.now(),
}: {
  pending: PendingPhoneChange | null;
  nextPhone: string;
  currentPhone: string;
  now?: number;
}): PhoneChangeDecision {
  if (pending && pending.phone === nextPhone) return { allowed: true, reason: 'resend' };
  if (pending) {
    const remainingMs = pendingPhoneChangeRemainingMs(pending, now);
    if (remainingMs > 0) return { allowed: false, reason: 'pending-other', pending, remainingMs };
  }
  if (nextPhone === currentPhone) return { allowed: false, reason: 'unchanged' };
  return { allowed: true, reason: pending ? 'previous-may-have-expired' : 'new' };
}
