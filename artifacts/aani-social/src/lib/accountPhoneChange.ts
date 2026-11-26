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
 * - القراءة تفرّق بين: لا سجل (`absent`)، سجل صالح (`valid`)، وتعذر قراءة
 *   أو سجل تالف (`unreadable`). السجل غير القابل للتحقق لا يُقرأ كأنه لا سجل،
 *   ولا يُكتب فوقه، ويبقى مانعاً لبدء رقم جديد — لأنه قد يكون طلباً قائماً.
 * - الحالة تُقرأ من التخزين عند كل عملية (لا React state): قد يبدأ تبويب آخر
 *   طلباً بعد تحميل الشاشة، وسجل أحدث من الحالة المعروضة يمنع الطلب.
 * - عملية واحدة في المرة عبر قفل بين التبويبات (Web Locks). إن لم يوفّره
 *   المتصفح أو كان مشغولاً لا تبدأ العملية (fail-closed).
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

/** سبب تعذر التحقق من السجل المحفوظ. */
export type PendingPhoneChangeUnreadableReason = 'storage-unavailable' | 'invalid-record';

/**
 * نتيجة قراءة السجل. `unreadable` ليست `absent`: السجل الذي تعذّرت قراءته أو
 * كان تالفاً قد يكون طلباً قائماً، فلا يُعامَل كما لو لم يكن هناك طلب.
 */
export type PendingPhoneChangeRead =
  | { status: 'absent' }
  | { status: 'valid'; pending: PendingPhoneChange }
  | { status: 'unreadable'; reason: PendingPhoneChangeUnreadableReason };

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

/**
 * يقرأ السجل المحفوظ بلا استنتاج: يتعذر الوصول إلى التخزين أو قراءته →
 * `unreadable`، وقيمة لا تُفهم (قيمة فارغة، JSON تالف، رقم غير صالح، وقت غير
 * صالح، حالة غير معروفة) → `unreadable`، ولا سجل (`getItem` يُعيد null) →
 * `absent`. لا يُعيد أي سجل لا يمكن التحقق منه كأنه غائب، ولا يُصحح قيمه.
 */
export function readPendingPhoneChange(
  userId: string,
  storage?: StorageLike | null,
): PendingPhoneChangeRead {
  const target = resolveStorage(storage);
  if (!target || !userId) return { status: 'unreadable', reason: 'storage-unavailable' };
  let raw: string | null = null;
  try {
    raw = target.getItem(pendingPhoneChangeKey(userId));
  } catch {
    return { status: 'unreadable', reason: 'storage-unavailable' };
  }
  // null فقط تعني عدم وجود سجل. القيمة الفارغة سجل موجود لا يمكن التحقق منه،
  // ولا تُعامَل كأن لا طلب — فلا يبدأ طلب جديد ولا يُكتب فوقها.
  if (raw === null) return { status: 'absent' };
  if (raw.trim() === '') return { status: 'unreadable', reason: 'invalid-record' };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: 'unreadable', reason: 'invalid-record' };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'unreadable', reason: 'invalid-record' };
  const phone = (parsed as { phone?: unknown }).phone;
  const requestedAt = (parsed as { requestedAt?: unknown }).requestedAt;
  const state = (parsed as { state?: unknown }).state;
  if (typeof phone !== 'string' || !isE164Phone(phone)) {
    return { status: 'unreadable', reason: 'invalid-record' };
  }
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) {
    return { status: 'unreadable', reason: 'invalid-record' };
  }
  // سجل قديم بلا حقل الحالة: الرقم والوقت صالحان، والحالة غير المحسومة هي
  // `requesting`. أما حقل حالة موجود بقيمة غير معروفة فسجل لا يمكن تفسيره.
  if (state !== undefined && state !== 'requesting' && state !== 'pending') {
    return { status: 'unreadable', reason: 'invalid-record' };
  }
  return { status: 'valid', pending: { phone, requestedAt, state: normalizeState(state) } };
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
 *
 * يعيد false إن تعذّر المسح (تخزين غير متاح أو رفض `removeItem`): عندئذ يبقى
 * السجل على الجهاز ويبقى منع الرقم الجديد، ولا يُقال إنه مُسح.
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

/**
 * مطابقة السجل المحفوظ بحالة الحساب المؤكدة: بعد تأكيد الرقم من جهاز أو جلسة
 * أخرى يصبح السجل طلباً منتهياً لا طلباً قائماً، فيُمسح.
 *
 * لا يُمسح سجل لرقم آخر، ولا سجل لرقم غير مؤكد، ولا سجل لا يمكن التحقق منه.
 * `cleared: true` تعني أنه لا يبقى سجل يناقض الرقم الحالي المؤكد. عند فشل
 * المسح يبقى السجل على الجهاز ويبقى منعه.
 */
export function reconcileCompletedPhoneChange({
  userId,
  record,
  currentPhone,
  currentPhoneConfirmed,
  storage,
}: {
  userId: string;
  record: PendingPhoneChangeRead;
  currentPhone: string;
  currentPhoneConfirmed: boolean;
  storage?: StorageLike | null;
}): { cleared: boolean } {
  if (record.status === 'absent') return { cleared: true };
  if (record.status === 'unreadable') return { cleared: false };
  if (!currentPhoneConfirmed || record.pending.phone !== currentPhone) return { cleared: false };
  return { cleared: clearPendingPhoneChange(userId, storage) };
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
  | { canStart: false; reason: 'unchanged' }
  | { canStart: false; reason: 'storage' }
  | { canStart: false; reason: 'unreadable'; read: PendingPhoneChangeUnreadableReason }
  | { canStart: false; reason: 'resend'; pending: PendingPhoneChange }
  | { canStart: false; reason: 'pending-other'; pending: PendingPhoneChange };

/**
 * خطة بدء الطلب في خطوة واحدة، بقراءة جديدة من التخزين (لا React state): قد
 * يبدأ تبويب آخر طلباً بعد تحميل الشاشة، وسجل أحدث من الحالة المعروضة يمنع.
 *
 * لا تُعيد canStart إلا ومعه سجل محفوظ قابل للاسترجاع بعد إعادة التحميل.
 * السجل غير القابل للتحقق يمنع بدء أي طلب ولا يُكتب فوقه، وطلب قائم لرقم آخر
 * يمنع بدء رقم جديد، وطلب قائم للرقم نفسه يعني إعادة إرساله لا بدء طلب.
 */
export function planPhoneChangeStart({
  userId,
  record,
  nextPhone,
  currentPhone,
  now = Date.now(),
  storage,
}: {
  userId: string;
  record: PendingPhoneChangeRead;
  nextPhone: string;
  currentPhone: string;
  now?: number;
  storage?: StorageLike | null;
}): PhoneChangeStartPlan {
  if (record.status === 'unreadable') {
    return { canStart: false, reason: 'unreadable', read: record.reason };
  }
  // السجل الموجود للرقم نفسه: إعادة إرسال موثّقة، بلا كتابة وبلا طلب جديد.
  if (record.status === 'valid' && record.pending.phone === nextPhone) {
    return { canStart: false, reason: 'resend', pending: record.pending };
  }
  const decision = decidePhoneChangeRequest({
    pending: record.status === 'valid' ? record.pending : null,
    nextPhone,
    currentPhone,
  });
  if (!decision.allowed) {
    return decision.reason === 'unchanged'
      ? { canStart: false, reason: 'unchanged' }
      : { canStart: false, reason: 'pending-other', pending: decision.pending };
  }
  const newRecord: PendingPhoneChange = { phone: nextPhone, requestedAt: now, state: 'requesting' };
  if (!beginPendingPhoneChange(userId, newRecord, storage)) {
    return { canStart: false, reason: 'storage' };
  }
  return { canStart: true, record: newRecord };
}

/**
 * واجهة ضيقة لما يوفّره المتصفح في `navigator.locks`، ليمكن اختبار القفل.
 */
export type PhoneChangeLockManager = {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
};

export type PhoneChangeLockResult<T> =
  | { status: 'ran'; value: T }
  | { status: 'busy' }
  | { status: 'unavailable' };

function resolveLockManager(lockManager?: PhoneChangeLockManager | null): PhoneChangeLockManager | null {
  if (lockManager === null) return null;
  if (lockManager) return lockManager;
  try {
    if (typeof navigator === 'undefined') return null;
    const locks = (navigator as unknown as { locks?: PhoneChangeLockManager }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/**
 * قفل بين تبويبات المتصفح قبل قراءة السجل وبدء الطلب أو تأكيده أو إعادة إرساله:
 * - لا يبدأ العمل إن لم يوفّر المتصفح Web Locks أو كان القفل مشغولاً بتبويب
 *   آخر (fail-closed)، لأن عمليتين متزامنتين قد تربطا رقماً غير مقصود.
 * - المهمة تُنفَّذ داخل القفل، فتقرأ السجل من التخزين في وقت التنفيذ لا من
 *   حالة محمّلة سابقاً.
 * - خطأ المهمة يُعاد كما هو إلى المستدعي (لا يُحوَّل إلى تعذر قفل).
 */
export async function runWithPhoneChangeLock<T>(
  userId: string,
  task: () => Promise<T>,
  lockManager?: PhoneChangeLockManager | null,
): Promise<PhoneChangeLockResult<T>> {
  const manager = resolveLockManager(lockManager);
  if (!manager || !userId) return { status: 'unavailable' };

  let taskFailed = false;
  let taskError: unknown = null;
  let outcome: unknown = null;
  try {
    outcome = await manager.request(
      `aani:phone-change:${userId}`,
      { ifAvailable: true },
      async lock => {
        if (!lock) return { granted: false };
        try {
          return { granted: true, value: await task() };
        } catch (error) {
          taskFailed = true;
          taskError = error;
          return { granted: false };
        }
      },
    );
  } catch {
    return { status: 'unavailable' };
  }

  // خطأ الطلب نفسه لا يعني تعذر القفل: يُعاد كما هو.
  if (taskFailed) throw taskError;
  if (!outcome || typeof outcome !== 'object') return { status: 'busy' };
  const result = outcome as { granted?: unknown; value?: unknown };
  if (result.granted !== true) return { status: 'busy' };
  return { status: 'ran', value: result.value as T };
}
