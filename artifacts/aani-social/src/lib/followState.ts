/**
 * مخزن موحد لحالة المتابعة عبر التطبيق:
 * خريطة في الذاكرة (userId → {following, requestSent}) مع مشتركين.
 *
 * كل زر متابعة (FollowButton) يشترك في حالة هدفه، فيتزامن الضغط
 * في أي واجهة (قائمة معجبين، قائمة متابعين، ملف شخصي...) لحظياً
 * في كل الأزرار الأخرى لنفس الشخص داخل الجلسة.
 */

export type FollowState = {
  /** هل يتابع المستخدم الحالي هذا الشخص؟ */
  following: boolean;
  /** هل طلب متابعة مرسل وقيد الانتظار؟ */
  requestSent: boolean;
};

const EMPTY_STATE: FollowState = { following: false, requestSent: false };
const states = new Map<string, FollowState>();
const listeners = new Map<string, Set<(state: FollowState) => void>>();

export const getFollowState = (userId: string): FollowState | null =>
  states.get(userId) ?? null;

/** حدّث حالة شخص وبلّغ كل الأزرار المشتركة عليه فوراً */
export const setFollowState = (userId: string, patch: Partial<FollowState>): FollowState => {
  const current = states.get(userId) ?? EMPTY_STATE;
  const next = { ...current, ...patch };
  states.set(userId, next);
  listeners.get(userId)?.forEach(listener => listener(next));
  return next;
};

/** ازرع حالة من مستعلم مستضيف فقط إن كان المخزن خالياً لهذا الشخص */
export const seedFollowState = (userId: string, state: FollowState): void => {
  if (!states.has(userId)) setFollowState(userId, state);
};

export const subscribeToFollowState = (
  userId: string,
  listener: (state: FollowState) => void,
): (() => void) => {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
};
