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
 *   عن حالته أو عن مهلة انتهاء صلاحيته لدى الخادم.
 *
 * لذلك:
 * - يُحفظ سجل الطلب في localStorage — لا React state وحدها — قبل بدء الطلب
 *   (سجل نية بحالة `requesting`)، ثم يُرقّى إلى `pending` بعد نجاح الطلب.
 *   إن تعذّر حفظ السجل لا يبدأ الطلب أصلاً.
 * - مهلة انتهاء صلاحية OTP (ساعة افتراضياً وقابلة للتغيير في المشروع) لا
 *   تُرفع بها الحماية: العميل لا يعرف إعداد المشروع، وانتهاء الصلاحية لا
 *   يُثبت إلغاء سجل phone_change لدى الخادم. لا يوجد هنا أي حد زمني.
 * - يمنع بدء رقم جديد حتى يُحل الطلب: إمّا بتأكيد الرمز بنجاح، أو بمعالجة
 *   موثّقة من جهة Supabase/الإدارة. لا يُسمح بطلب جديد لمجرد مرور الوقت.
 *
 * لا تُحفظ هنا أي كلمة مرور أو رمز OTP: رقم الهدف ووقت الطلب وحالته فقط.
 */
import { isE164Phone } from '@/lib/accountAuth';

/** `requesting`: سجل نية/طلب غير محسوم. `pending`: طلب بدأ بنجاح. */
export type PendingPhoneChangeState = 'requesting' | 'pending';

export type PendingPhoneChange = {
  /** الرقم الجديد المعلّق بصيغة E.164 — لا يُحفظ أي رمز معه. */
  phone: string;
  /** وقت طلب الرمز (ms since epoch) للعرض فقط، ولا يرفع الحجب. */
  requestedAt: number;
  state: PendingPhoneChangeState;
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

function normalizeState(value: unknown): PendingPhoneChangeState {
  return value === 'pending' ? 'pending' : 'requesting';
}

function writeRecord(userId: string, pending: PendingPhoneChange, storage?: StorageLike | null): boolean {
  const target = resolveStorage(storage);
  if (!target || !userId || !isE164Phone(pending.phone)) return false;
  try {
    target.setItem(pendingPhoneChangeKey(userId), JSON.stringify({
      phone: pending.phone,
      requestedAt: pending.requestedAt,
      state: pending.state,
    }));
    return true;
  } catch {
    return false;
  }
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
    const state = (parsed as { state?: unknown }).state;
    if (typeof phone !== 'string' || !isE164Phone(phone)) return null;
    if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return null;
    return { phone, requestedAt, state: normalizeState(state) };
  } catch {
    return null;
  }
}

/**
 * سجل النية قبل بدء الطلب: شرط ضروري لبدء `updateUser({ phone })`، فلا يبدأ
 * طلب خادمي بلا سجل محلي قابل للاسترجاع بعد إعادة التحميل. يعيد false إذا
 * كان التخزين غير متاح أو فشلت الكتابة.
 */
export function beginPendingPhoneChange(
  userId: string,
  pending: PendingPhoneChange,
  storage?: StorageLike | null,
): boolean {
  return writeRecord(userId, { ...pending, state: 'requesting' }, storage);
}

/** بعد نجاح الطلب: يُرقّى السجل إلى `pending`. فشله يُبقي النية غير محسومة. */
export function promotePendingPhoneChange(
  userId: string,
  pending: PendingPhoneChange,
  storage?: StorageLike | null,
): boolean {
  return writeRecord(userId, { ...pending, state: 'pending' }, storage);
}

/**
 * يمسح السجل المحلي بعد تأكيد Supabase للرقم فقط، أو بعد معالجة موثّقة من
 * جهة الإدارة. لا يُستدعى بسبب مرور الوقت ولا بعد فشل طلب، لأن فشل الطلب
 * لا يُثبت أن الخادم لم يُنشئ سجل phone_change.
 */
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

export type PhoneChangeDecision =
  | { allowed: true; reason: 'new' | 'resend' }
  | { allowed: false; reason: 'unchanged' }
  | { allowed: false; reason: 'pending-other'; pending: PendingPhoneChange };

/**
 * قرار بدء طلب رقم جديد — بلا أي حد زمني:
 * - طلب معلّق للرقم نفسه → إعادة إرسال موثّقة (resend) بلا طلب جديد.
 * - طلب معلّق لرقم آخر (أي عمر) → ممنوع حتى يُحل الطلب.
 * - لا طلب → مسموح، إلا أن يكون الرقم هو الحالي.
 */
export function decidePhoneChangeRequest({
  pending,
  nextPhone,
  currentPhone,
}: {
  pending: PendingPhoneChange | null;
  nextPhone: string;
  currentPhone: string;
}): PhoneChangeDecision {
  if (pending && pending.phone === nextPhone) return { allowed: true, reason: 'resend' };
  if (pending) return { allowed: false, reason: 'pending-other', pending };
  if (nextPhone === currentPhone) return { allowed: false, reason: 'unchanged' };
  return { allowed: true, reason: 'new' };
}


export type PhoneChangeStartPlan =
  | { canStart: true; record: PendingPhoneChange }
  | { canStart: false; reason: 'unchanged' | 'storage' }
  | { canStart: false; reason: 'pending-other'; pending: PendingPhoneChange };

/**
 * خطة بدء الطلب في خطوة واحدة: التحقق من الطلب المعلّق ورقم المستخدم، ثم
 * حفظ سجل النية قبل أي استدعاء للخادم. لا تُعيد canStart إلا ومعه سجل محفوظ
 * قابل للاسترجاع بعد إعادة التحميل — فبدون حفظ الحالة لا يبدأ أي طلب.
 */
export function planPhoneChangeStart({
  userId,
  pending,
  nextPhone,
  currentPhone,
  now = Date.now(),
  storage,
}: {
  userId: string;
  pending: PendingPhoneChange | null;
  nextPhone: string;
  currentPhone: string;
  now?: number;
  storage?: StorageLike | null;
}): PhoneChangeStartPlan {
  const decision = decidePhoneChangeRequest({ pending, nextPhone, currentPhone });
  if (!decision.allowed) {
    return decision.reason === 'unchanged'
      ? { canStart: false, reason: 'unchanged' }
      : { canStart: false, reason: 'pending-other', pending: decision.pending };
  }
  const record: PendingPhoneChange = { phone: nextPhone, requestedAt: now, state: 'requesting' };
  if (!beginPendingPhoneChange(userId, record, storage)) {
    return { canStart: false, reason: 'storage' };
  }
  return { canStart: true, record };
}
