export interface ThreadMessageLike {
  id: string;
  created_at: string;
  delivered_at?: string | null;
  read_at?: string | null;
}

export interface OlderMessagesCursor {
  createdAt: string;
  id: string;
}

export type ThreadLoadStatus = 'loading' | 'loaded' | 'error';

export function messagesThreadFilter(currentUserId: string, contactId: string): string {
  return `and(sender_id.eq.${currentUserId},recipient_id.eq.${contactId}),and(sender_id.eq.${contactId},recipient_id.eq.${currentUserId})`;
}

export function shouldShowEmptyThreadMessage(
  messageCount: number,
  loadStatus: ThreadLoadStatus,
  hasOlderMessages = false,
): boolean {
  return messageCount === 0 && loadStatus === 'loaded' && !hasOlderMessages;
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

/** إزالة رسالة محذوفة من الخيط مع الحفاظ على هوية المصفوفة إن لم تكن فيه. */
export function removeThreadRow<T extends ThreadMessageLike>(rows: T[], messageId: string | null): T[] {
  if (!messageId) return rows;
  const remaining = rows.filter(row => row.id !== messageId);
  return remaining.length === rows.length ? rows : remaining;
}

/** دمج بلا تكرار (Map بالمعرّف) مع الحفاظ على الترتيب الثابت. */
export function mergeThreadRows<T extends ThreadMessageLike>(existing: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>(existing.map(row => [row.id, row]));
  incoming.forEach(row => {
    const current = byId.get(row.id);
    if (!current) {
      byId.set(row.id, row);
      return;
    }

    // إيصالات التسليم والقراءة انتقال أحادي الاتجاه. استجابة HTTP بدأت قبل
    // حدث Realtime لا يجوز أن تعيدها إلى null عند دمج الرسالة نفسها.
    const merged = { ...current, ...row } as T;
    if (current.delivered_at) merged.delivered_at = current.delivered_at;
    if (current.read_at) merged.read_at = current.read_at;
    byId.set(row.id, merged);
  });
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

export interface OlderPageProgress {
  /** أقدم صف معروف؛ الدفعة التالية تُجلب قبله. */
  cursor: OlderMessagesCursor | null;
  /** عدد الدفعات الأقدم التي حُمّلت (٠ = لم يُحمَّل شيء بعد). */
  olderPagesLoaded: number;
  /** هل قد توجد رسائل أقدم؟ */
  hasOlder: boolean;
}

export function initialOlderPageProgress(): OlderPageProgress {
  return { cursor: null, olderPagesLoaded: 0, hasOlder: false };
}

/**
 * بعد جلب أحدث صفحة (Realtime أو إعادة اتصال): لا نمسّ التقدّم إن كانت هناك
 * دفعات أقدم محمّلة، وإلا لعدنا إلى مؤشر أحدث صفحة وأعدنا جلب ما حُمّل.
 */
export function progressAfterLatestPage<T extends ThreadMessageLike>(
  progress: OlderPageProgress,
  rawLatestRowsDescending: T[],
  pageSize: number,
): OlderPageProgress {
  if (progress.olderPagesLoaded > 0) return progress;
  return {
    cursor: olderCursorFromRows(rawLatestRowsDescending),
    olderPagesLoaded: 0,
    hasOlder: hasOlderPage(rawLatestRowsDescending.length, pageSize),
  };
}

/**
 * بعد جلب دفعة أقدم: المؤشر يتقدّم دائماً من الصفوف الخام (قبل تصفية المخفي
 * والمحذوف) حتى لا تتوقف الدفعات قبل نهاية السجل.
 */
export function progressAfterOlderPage<T extends ThreadMessageLike>(
  progress: OlderPageProgress,
  rawOlderRowsDescending: T[],
  pageSize: number,
): OlderPageProgress {
  return {
    cursor: olderCursorFromRows(rawOlderRowsDescending) ?? progress.cursor,
    olderPagesLoaded: progress.olderPagesLoaded + 1,
    hasOlder: hasOlderPage(rawOlderRowsDescending.length, pageSize),
  };
}

export interface ThreadReactionRow {
  message_id: string;
  user_id: string;
  emoji: string;
}

export interface ThreadMessageReaction {
  user_id: string;
  emoji: string;
}

export type ThreadReactionsByMessage = Record<string, ThreadMessageReaction[]>;

export interface LocalReactionOverlayOptions {
  actorId: string;
  visibleMessageIds: ReadonlySet<string>;
  /** كل نسخ تعديل التفاعل المحلية حتى الآن. */
  mutationVersions: ReadonlyMap<string, number>;
  /** نسخ تعديلات التفاعل عند بدء طلب التفاعلات. */
  versionsAtRequestStart: ReadonlyMap<string, number>;
  /** تفاعلات الحالة المحلية، وتشمل تعديلات المستخدم. */
  currentReactions: ThreadReactionsByMessage;
  /** انتظارات لم تُكتب على الخادم بعد. */
  pendingReactions: ReadonlyMap<string, { emoji: string | null }>;
}

/**
 * صفوف message_reactions إلى خريطة بالرسالة. الصفوف غير الصالحة أو الخارجة عن
 * الرسائل المعروضة تُهمل، فلا تظهر تفاعلات رسالة غير موجودة.
 */
export function reactionsFromThreadRows(
  rows: readonly ThreadReactionRow[] | null | undefined,
  visibleMessageIds: ReadonlySet<string>,
): ThreadReactionsByMessage {
  const reactions: ThreadReactionsByMessage = {};
  (rows || []).forEach(row => {
    if (typeof row.message_id !== 'string'
      || typeof row.user_id !== 'string'
      || typeof row.emoji !== 'string'
      || !visibleMessageIds.has(row.message_id)) return;
    (reactions[row.message_id] ||= []).push({ user_id: row.user_id, emoji: row.emoji });
  });
  return reactions;
}

/**
 * عند فشل استعلام التفاعلات: تبقى تفاعلات الرسائل المعروضة كما هي في الحالة
 * المحلية، بدل مسحها أو تحويل المحادثة إلى خطأ.
 */
export function reactionsForVisibleMessages(
  current: ThreadReactionsByMessage,
  visibleMessageIds: ReadonlySet<string>,
): ThreadReactionsByMessage {
  const reactions: ThreadReactionsByMessage = {};
  Object.entries(current).forEach(([messageId, rows]) => {
    if (!visibleMessageIds.has(messageId) || rows.length === 0) return;
    reactions[messageId] = rows;
  });
  return reactions;
}

/**
 * تعديلات المستخدم بعد بدء الطلب تعلو على نتيجة الخادم، وكذلك الانتظارات
 * المعلّقة، فلا تُعيد نتيجة قديمة تفاعلاً حُذف أو تغيّر.
 */
export function overlayLocalReactions(
  fetched: ThreadReactionsByMessage,
  options: LocalReactionOverlayOptions,
): ThreadReactionsByMessage {
  const next: ThreadReactionsByMessage = {};
  Object.entries(fetched).forEach(([messageId, rows]) => {
    if (rows.length) next[messageId] = [...rows];
  });

  options.mutationVersions.forEach((version, messageId) => {
    if (version <= (options.versionsAtRequestStart.get(messageId) || 0)) return;
    const localReaction = options.currentReactions[messageId]
      ?.find(reaction => reaction.user_id === options.actorId);
    const rows = (next[messageId] || []).filter(reaction => reaction.user_id !== options.actorId);
    if (localReaction) rows.push(localReaction);
    if (rows.length) next[messageId] = rows;
    else delete next[messageId];
  });

  options.pendingReactions.forEach(({ emoji }, messageId) => {
    if (!options.visibleMessageIds.has(messageId)) return;
    const rows = (next[messageId] || []).filter(reaction => reaction.user_id !== options.actorId);
    if (emoji) rows.push({ user_id: options.actorId, emoji });
    if (rows.length) next[messageId] = rows;
    else delete next[messageId];
  });

  return next;
}

export interface ThreadFirstPaintPlan<TResult> {
  /** جلب الرسائل والتحقق من الإخفاء؛ لا يُعرض شيء إن فشل. */
  load(): Promise<TResult>;
  /** عرض الرسائل بعد نجاح التحقق فقط. */
  show(result: TResult): void;
  /** التفاعلات بعد العرض؛ لا تُنتظر ولا تؤثر في نجاح الرسائل. */
  loadReactions(result: TResult): Promise<void>;
  /** فشل مسار الرسائل: حالة الخطأ كما هي. */
  onLoadError(error: unknown): void;
  onReactionsError?(error: unknown): void;
}

/**
 * ترتيب أول عرض للمحادثة: الرسائل أولاً، ثم التفاعلات في الخلفية.
 * لا يُنتظر وعد التفاعلات، وفشلها لا يُفشل تحميل المحادثة.
 */
export async function runThreadFirstPaint<TResult>(
  plan: ThreadFirstPaintPlan<TResult>,
): Promise<void> {
  let result: TResult;
  try {
    result = await plan.load();
  } catch (error) {
    plan.onLoadError(error);
    return;
  }

  try {
    plan.show(result);
  } catch (error) {
    plan.onLoadError(error);
    return;
  }

  void Promise.resolve()
    .then(() => plan.loadReactions(result))
    .catch(error => plan.onReactionsError?.(error));
}

export interface OlderRequestTracker {
  /** يبدأ طلباً جديداً، ويُبطل ما قبله، ويُرجع معرّف الطلب. */
  begin(conversationId: string): number;
  /** تحميل كامل جديد للمحادثة يُبطل الطلب الجاري ويحرّر راية التحميل. */
  invalidate(): void;
  /** هل ما زال الطلب هو الجاري لنفس المحادثة؟ تُستخدم قبل تطبيق أي بيانات. */
  isCurrent(requestId: number, conversationId: string | null | undefined): boolean;
  /** يُنهي الطلب ويحرّر التحميل، فقط إن كان هو الطلب الجاري. */
  finish(requestId: number): boolean;
  /** هل هناك دفعة أقدم قيد التحميل الآن؟ */
  isLoading(): boolean;
}

/**
 * متتبّع طلبات الدفعات الأقدم.
 *
 * معرّفه منفصل عن `threadRequestRef`: تحديث المحادثة (Realtime أو إعادة
 * اتصال) يُبطل طلب الدفعة الأقدم ويحرّر حالته، لكنه لا يترك طلباً قديماً
 * يعلّق راية التحميل إلى الأبد، ولا يسمح له بلمس حالة طلب أحدث.
 */
export function createOlderRequestTracker(): OlderRequestTracker {
  let sequence = 0;
  let current: number | null = null;
  let currentConversationId: string | null = null;
  let loading = false;

  return {
    begin(conversationId: string): number {
      sequence += 1;
      current = sequence;
      currentConversationId = conversationId;
      loading = true;
      return sequence;
    },
    invalidate(): void {
      current = null;
      currentConversationId = null;
      loading = false;
    },
    isCurrent(requestId: number, conversationId: string | null | undefined): boolean {
      // المحادثة تُقارَن هنا كي لا يُطبَّق طلب محادثة سابقة على المفتوحة الآن.
      return current === requestId
        && conversationId != null
        && currentConversationId === conversationId;
    },
    finish(requestId: number): boolean {
      // طلب غير جارٍ (أبطله تحميل كامل) لا يملك الحالة فلا يحرّرها،
      // والطلب الجاري يُحرّرها دائماً حتى لو صار تحميل المحادثة أحدث منه.
      if (current !== requestId) return false;
      current = null;
      currentConversationId = null;
      loading = false;
      return true;
    },
    isLoading(): boolean {
      return loading;
    },
  };
}
