export interface ThreadMessageLike {
  id: string;
  created_at: string;
}

export interface OlderMessagesCursor {
  createdAt: string;
  id: string;
}

/** ترتيب ثابت: created_at ثم id، كما في الاستعلام (created_at, id). */
export function sortThreadRows<T extends ThreadMessageLike>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const timeDifference = (Date.parse(left.created_at) || 0) - (Date.parse(right.created_at) || 0);
    if (timeDifference !== 0) return timeDifference;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

/** دمج بلا تكرار (Map بالمعرّف) مع الحفاظ على الترتيب الثابت. */
export function mergeThreadRows<T extends ThreadMessageLike>(existing: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>(existing.map(row => [row.id, row]));
  incoming.forEach(row => byId.set(row.id, row));
  return sortThreadRows([...byId.values()]);
}

/**
 * مؤشر الصفحة الأقدم يُشتق من الصفوف الخام كما أعادتها قاعدة البيانات
 * (مرتّبة تنازلياً)، لا من الصفوف بعد تصفية المخفي/المحذوف، حتى يتقدّم
 * المؤشر دائماً ولا تتوقف الدفعات قبل نهاية السجل.
 */
export function olderCursorFromRows<T extends ThreadMessageLike>(rawDescendingRows: T[]): OlderMessagesCursor | null {
  const oldest = rawDescendingRows[rawDescendingRows.length - 1];
  if (!oldest) return null;
  return { createdAt: oldest.created_at, id: oldest.id };
}

/** توجد دفعات أقدم فقط إذا أعادت القاعدة صفحة كاملة. */
export function hasOlderPage(rawRowsCount: number, pageSize: number): boolean {
  return rawRowsCount === pageSize;
}

export interface OlderRequestGuard {
  requestedConversationId: string;
  requestedThreadRequestId: number;
  currentConversationId: string | null;
  currentThreadRequestId: number;
}

/** هل ما زال طلب الدفعة الأقدم يخص المحادثة المفتوحة والطلب الحالي؟ */
export function canApplyOlderPage(guard: OlderRequestGuard): boolean {
  return guard.currentConversationId === guard.requestedConversationId
    && guard.currentThreadRequestId === guard.requestedThreadRequestId;
}
