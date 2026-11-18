// طابور الدفعات المعلّقة للريلز — منطق خالص بلا React وبلا شبكة، قابل للاختبار.
//
// القاعدة: ترتيب الريلز يأتي من الخادم (get_personalized_reels). عندما يصل
// ترتيب جديد بينما المستخدم يشاهد الدفعة الحالية، لا يُستبدل ما يراه: تُحفظ
// النتيجة الجديدة كدفعة معلّقة لمفتاحها (الاستعلام + المستخدم)، وتُطبَّق عند
// بداية جلسة عرض جديدة (تركيب الشاشة من جديد)، فتبدأ من أعلى القائمة.
//
// هذا لا يمنع الوصول إلى الترتيب الجديد؛ يمنع فقط تبديل ما يُعرض في منتصف
// المشاهدة. المفاتيح مستقلة لكل مستخدم ولكل سطح، فلا تتسرب دفعة حساب إلى آخر
// ولا دفعة الـFeed إلى الريلز.

/** أقل وصف يحتاجه الطابور من المنشور: معرّف فريد يكفي للتمييز بين الدفعات. */
export type ReelBatchPost = { id: string };

const pendingBatches = new Map<string, ReelBatchPost[]>();

/**
 * هل تُحفظ النتيجة الجديدة كدفعة معلّقة بدل تطبيقها الآن؟
 *
 * تُطبَّق فوراً فقط عندما لا توجد دفعة ظاهرة للمستخدم. وجود دفعة ظاهرة يعني أن
 * المستخدم يشاهدها أو قد يشاهدها بعد لحظة، فلا يجوز إعادة ترتيبها تحت يده.
 */
export function shouldDeferReelsBatch(hasVisibleBatch: boolean): boolean {
  return hasVisibleBatch === true;
}

/** يخزّن دفعة جديدة لمفتاحها، ويستبدل أي دفعة معلّقة أقدم لنفس المفتاح. */
export function setPendingReelsBatch<T extends ReelBatchPost>(key: string, posts: T[]): void {
  if (!key || posts.length === 0) return;
  pendingBatches.set(key, posts);
}

/** هل توجد دفعة معلّقة لهذا المفتاح؟ قراءة فقط بلا أي أثر جانبي. */
export function hasPendingReelsBatch(key: string): boolean {
  return pendingBatches.has(key);
}

/**
 * الدفعة المعلّقة لهذا المفتاح (أو undefined) دون حذفها.
 *
 * النوع يُحدَّد عند الاستدعاء (getPendingReelsBatch<Post>(key)) لأن الطابور لا
 * يعرف إلا أن العنصر يحمل `id`؛ المستدعي يعرف نوعه الحقيقي.
 */
export function getPendingReelsBatch<T extends ReelBatchPost>(key: string): T[] | undefined {
  return pendingBatches.get(key) as T[] | undefined;
}

/** تُحذف الدفعة المعلّقة بعد أن تصبح هي الدفعة المعروضة. */
export function clearPendingReelsBatch(key: string): void {
  pendingBatches.delete(key);
}
