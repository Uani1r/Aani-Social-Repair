// جلسة عرض الريلز: تفصل بين «إعادة تركيب المكوّن داخل الجلسة» و«زيارة جديدة».
//
// الزيارة الجديدة (تركيب صفحة الريلز من جديد) تبدأ جلسة جديدة، فيُسمح لها
// بترتيب جديد من الخادم بدل الالتزام بمدة التخزين المؤقت. أما إعادة تركيب
// المكوّن داخل الجلسة نفسها فلا تُكرّر طلب Supabase قبل انتهاء REELS_CACHE_TTL_MS.

/** بصمة آخر جلب ريلز ناجح لمفتاح ما: جلسة العرض التي جُلب فيها ووقته. */
export type ReelsFetchMark = { session: number; at: number };

let currentSession = 0;

/** يبدأ جلسة عرض جديدة ويُعيد رقمها. يُستدعى مرة عند تركيب صفحة الريلز. */
export function startReelsViewingSession(): number {
  currentSession += 1;
  return currentSession;
}
/** رقم جلسة العرض الحالية (0 قبل أول زيارة). */
export function currentReelsViewingSession(): number {
  return currentSession;
}

/**
 * هل تُستخدم الدفعة المحفوظة بدل جلب جديد؟
 *
 * نعم فقط إذا كنا في الجلسة نفسها التي جُلب فيها المحتوى ولم تنتهِ المدة.
 * جلسة مختلفة تعني زيارة جديدة ومن حقها ترتيب جديد من الخادم.
 */
export function isReelsCacheFresh(input: {
  hasCachedBatch: boolean;
  cacheMark: CacheMarkInput;
  viewingSession: number;
  now: number;
  ttlMs: number;
}): boolean {
  if (!input.hasCachedBatch) return false;
  const mark = input.cacheMark;
  if (!mark) return false;
  // زيارة جديدة: المدة لا تُمنع الترتيب الجديد.
  if (mark.session !== input.viewingSession) return false;
  return input.now - mark.at < input.ttlMs;
}

type CacheMarkInput = ReelsFetchMark | undefined;
