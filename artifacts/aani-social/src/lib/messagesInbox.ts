export interface MessagesInboxSummary<TMessage> {
  lastMessage: TMessage | null;
  unreadCount: number;
}

export interface MessagesInboxRpcArguments {
  p_read_at_by_contact: Record<string, string>;
  p_request_tab_read_at: string;
}

export interface InboxRequestTracker {
  begin(): number;
  invalidate(): void;
  isCurrent(requestId: number): boolean;
}

export interface LegacyInboxMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  created_at: string;
  content?: unknown;
  read_at?: string | null;
  delivered_at?: string | null;
}

export interface InboxSummaryResult<TMessage> {
  data: Map<string, MessagesInboxSummary<TMessage>>;
  error: unknown | null;
  usedFallback: boolean;
  deliveryMessageIds: string[];
}

export interface MessagesInboxRpcAvailability {
  summaryMissing: boolean;
}

export interface RealtimeMessageSnapshot<TMessage> {
  message: TMessage;
}

export interface RealtimeInboxConversation<TMessage extends LegacyInboxMessage> {
  profile: { id: string };
  lastMessage: TMessage | null;
}

export function messagesInboxContactId(message: Pick<LegacyInboxMessage, 'sender_id' | 'recipient_id'>, userId: string): string | null {
  if (message.sender_id === userId && message.recipient_id !== userId) return message.recipient_id || null;
  if (message.recipient_id === userId && message.sender_id !== userId) return message.sender_id || null;
  return null;
}

export function messageBelongsToInboxThread(
  message: Pick<LegacyInboxMessage, 'sender_id' | 'recipient_id'>,
  userId: string,
  contactId: string | undefined,
): boolean {
  return Boolean(contactId) && messagesInboxContactId(message, userId) === contactId;
}

/** Positive means left is newer; ties follow the inbox's created_at, id order. */
export function compareInboxMessageRecency(
  left: Pick<LegacyInboxMessage, 'id' | 'created_at'>,
  right: Pick<LegacyInboxMessage, 'id' | 'created_at'>,
): number {
  const leftTime = Date.parse(left.created_at) || 0;
  const rightTime = Date.parse(right.created_at) || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.id === right.id) return 0;
  return left.id > right.id ? 1 : -1;
}

export function isInboxMessageAtLeastAsNew(
  candidate: Pick<LegacyInboxMessage, 'id' | 'created_at'> | null | undefined,
  reference: Pick<LegacyInboxMessage, 'id' | 'created_at'>,
): boolean {
  return candidate != null && compareInboxMessageRecency(candidate, reference) >= 0;
}

function sortInboxConversations<
  TMessage extends LegacyInboxMessage,
  TConversation extends RealtimeInboxConversation<TMessage>,
>(conversations: TConversation[]): TConversation[] {
  return conversations.sort((left, right) => {
    const leftMessage = left.lastMessage;
    const rightMessage = right.lastMessage;
    if (!leftMessage) return rightMessage ? 1 : 0;
    if (!rightMessage) return -1;
    return compareInboxMessageRecency(rightMessage, leftMessage);
  });
}

export function mergeMessageSnapshot<TMessage extends LegacyInboxMessage>(
  existing: TMessage | null | undefined,
  incoming: TMessage,
): TMessage {
  if (!existing || existing.id !== incoming.id) return incoming;

  const merged = { ...existing, ...incoming } as TMessage;
  // إيصالات الرسالة غير قابلة للتراجع أو إعادة الكتابة بعد تثبيتها محلياً.
  if (existing.delivered_at) merged.delivered_at = existing.delivered_at;
  if (existing.read_at) merged.read_at = existing.read_at;
  return merged;
}

export function applyRealtimeInboxInsert<
  TMessage extends LegacyInboxMessage,
  TConversation extends RealtimeInboxConversation<TMessage>,
>(
  conversations: TConversation[],
  message: TMessage,
  userId: string,
  createConversation?: (contactId: string, message: TMessage) => TConversation,
): TConversation[] {
  const contactId = messagesInboxContactId(message, userId);
  if (!contactId) return conversations;

  const index = conversations.findIndex(conversation => conversation.profile.id === contactId);
  const next = [...conversations];
  if (index < 0) {
    const created = createConversation?.(contactId, message);
    if (!created) return conversations;
    next.push({ ...created, lastMessage: message } as TConversation);
  } else {
    const current = conversations[index];
    if (isInboxMessageAtLeastAsNew(current.lastMessage, message)) {
      if (current.lastMessage?.id !== message.id) return conversations;
      const lastMessage = mergeMessageSnapshot(current.lastMessage, message);
      if (lastMessage === current.lastMessage
        || (lastMessage.delivered_at === current.lastMessage.delivered_at
          && lastMessage.read_at === current.lastMessage.read_at
          && lastMessage.content === current.lastMessage.content)) return conversations;
      next[index] = { ...current, lastMessage } as TConversation;
    } else {
      next[index] = { ...current, lastMessage: message } as TConversation;
    }
  }

  return sortInboxConversations(next);
}

/**
 * حذف رسالة أُكّد حذفها من الخادم: تختفي من معاينة المحادثة فوراً بدل انتظار
 * REST، ويبقى صف المحادثة نفسه في القائمة حتى تعيد المزامنة آخر رسالة متبقية.
 */
export function applyRealtimeInboxDelete<
  TMessage extends LegacyInboxMessage,
  TConversation extends RealtimeInboxConversation<TMessage>,
>(
  conversations: TConversation[],
  messageId: string,
): TConversation[] {
  if (!conversations.some(conversation => conversation.lastMessage?.id === messageId)) {
    return conversations;
  }

  const next = conversations.map(conversation => (
    conversation.lastMessage?.id === messageId
      ? { ...conversation, lastMessage: null } as TConversation
      : conversation
  ));
  return sortInboxConversations(next);
}

export function mergeInboxConversationsWithRealtime<
  TMessage extends LegacyInboxMessage,
  TConversation extends RealtimeInboxConversation<TMessage>,
>(
  fetched: TConversation[],
  current: TConversation[],
  realtimeMessages: ReadonlyMap<string, RealtimeMessageSnapshot<TMessage>>,
  userId: string,
  createConversation?: (contactId: string, message: TMessage) => TConversation,
): TConversation[] {
  let merged = fetched.map(conversation => {
    const currentConversation = current.find(item => item.profile.id === conversation.profile.id);
    const currentMessage = currentConversation?.lastMessage;
    const fetchedMessage = conversation.lastMessage;
    if (!currentMessage || !fetchedMessage) return conversation;
    const recency = compareInboxMessageRecency(currentMessage, fetchedMessage);
    if (recency > 0) return { ...conversation, lastMessage: currentMessage };
    if (recency === 0) {
      return {
        ...conversation,
        lastMessage: mergeMessageSnapshot(currentMessage, fetchedMessage),
      };
    }
    return conversation;
  });
  realtimeMessages.forEach(({ message }, contactId) => {
    if (messagesInboxContactId(message, userId) !== contactId) return;
    if (!merged.some(conversation => conversation.profile.id === contactId)) {
      const currentConversation = current.find(conversation => conversation.profile.id === contactId);
      if (currentConversation) merged = [...merged, currentConversation];
    }
    merged = applyRealtimeInboxInsert(merged, message, userId, createConversation);
  });
  return sortInboxConversations(merged);
}

export function mergeRealtimeThreadMessages<TMessage extends LegacyInboxMessage>(
  existing: TMessage[],
  fetched: TMessage[],
  realtimeMessages: readonly TMessage[],
  userId: string,
  contactId: string,
  mergeRows: (existing: TMessage[], incoming: TMessage[]) => TMessage[],
): TMessage[] {
  const merged = mergeRows(existing, fetched);
  const matchingRealtimeMessages = realtimeMessages.filter(message => messageBelongsToInboxThread(message, userId, contactId));
  return matchingRealtimeMessages.length ? mergeRows(merged, matchingRealtimeMessages) : merged;
}

export function writeMessagesInboxCache<TValue>(
  storage: { setItem(key: string, value: string): void },
  key: string,
  value: TValue,
): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* Local storage may be unavailable or full. */
  }
}

export function messagesInboxRealtimeInsertFilters(userId: string): { recipient: string; sender: string } {
  return {
    recipient: `recipient_id=eq.${userId}`,
    sender: `sender_id=eq.${userId}`,
  };
}

export function shouldRefreshInboxForSentMessage(
  message: { sender_id?: unknown; recipient_id?: unknown } | null,
  userId: string,
): boolean {
  return message?.sender_id === userId && message.recipient_id !== userId;
}

const INBOX_SUMMARY_RPC = 'aani_get_messages_inbox_summaries';
const UNIX_EPOCH = '1970-01-01T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedCutoff(value: string | null | undefined): string {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : UNIX_EPOCH;
}

export function messagesInboxRpcArguments(
  readAtByContact: Record<string, string>,
  requestTabReadAt: string | null,
): MessagesInboxRpcArguments {
  return {
    p_read_at_by_contact: Object.fromEntries(
      Object.entries(readAtByContact).map(([contactId, value]) => [contactId, normalizedCutoff(value)]),
    ),
    p_request_tab_read_at: normalizedCutoff(requestTabReadAt),
  };
}

export function normalizeMessagesInboxSummaries<TMessage>(
  value: unknown,
  normalizeMessage: (value: unknown) => TMessage | null,
): Map<string, MessagesInboxSummary<TMessage>> {
  const summaries = new Map<string, MessagesInboxSummary<TMessage>>();
  if (!Array.isArray(value)) return summaries;

  value.forEach((item: unknown) => {
    if (!isRecord(item) || typeof item.contact_id !== 'string' || !item.contact_id || summaries.has(item.contact_id)) return;
    const parsedCount = typeof item.unread_count === 'number' || typeof item.unread_count === 'string'
      ? Number(item.unread_count)
      : 0;
    summaries.set(item.contact_id, {
      lastMessage: item.last_message == null ? null : normalizeMessage(item.last_message),
      unreadCount: Number.isSafeInteger(parsedCount) && parsedCount > 0 ? parsedCount : 0,
    });
  });

  return summaries;
}

export function requestUnreadCounts<TMessage>(
  summaries: ReadonlyMap<string, MessagesInboxSummary<TMessage>>,
  requestContactIds: ReadonlySet<string>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  summaries.forEach((summary, contactId) => {
    if (requestContactIds.has(contactId) && summary.unreadCount > 0) {
      counts[contactId] = summary.unreadCount;
    }
  });
  return counts;
}

function errorField(error: unknown, key: 'code' | 'message' | 'details' | 'hint'): unknown {
  return isRecord(error) ? error[key] : null;
}

function isPotentialMissingInboxSummaryRpc(error: unknown): boolean {
  const code = errorField(error, 'code');
  const message = errorField(error, 'message');
  return code === 'PGRST202'
    && typeof message === 'string'
    && message.includes(INBOX_SUMMARY_RPC)
    && /schema cache/i.test(message);
}

/**
 * PGRST202 also covers stale function signatures. Confirm with a no-argument
 * call before falling back; the inbox RPC's arguments have defaults, so an
 * exposed function with a different named signature will still resolve. Ignore
 * details because PostgREST can include search details for a missing RPC, but
 * reject a hint that points to this RPC with a nonempty argument signature.
 * PGRST203, permission failures, and transport failures never trigger fallback.
 */
export function isConfirmedMissingMessagesInboxRpc(error: unknown): boolean {
  const message = errorField(error, 'message');
  const hint = errorField(error, 'hint');
  if (errorField(error, 'code') !== 'PGRST202' || typeof message !== 'string') return false;

  const functionName = `(?:public\\.)?${INBOX_SUMMARY_RPC}`;
  const hintedSignature = typeof hint === 'string'
    && new RegExp(`${functionName}\\s*\\(\\s*[^\\s)][^)]*\\)`, 'i').test(hint);
  if (hintedSignature) return false;

  return new RegExp(
    `Could not find\\s+(?:the\\s+)?(?:function\\s+)?${functionName}\\(\\)\\s+(?:function\\s+)?in the schema cache`,
    'i',
  ).test(message);
}

export function isMissingMessagesInboxDeliveryRpc(error: unknown): boolean {
  const message = errorField(error, 'message');
  return errorField(error, 'code') === 'PGRST202'
    && typeof message === 'string'
    && /(?:public\.)?aani_mark_inbox_messages_delivered\s*\(/i.test(message)
    && /schema cache/i.test(message);
}

export function buildLegacyMessagesInboxSummaries<TMessage extends LegacyInboxMessage>(
  orderedMessages: readonly TMessage[],
  hiddenMessageIds: ReadonlySet<string>,
  actorId: string,
  readAtByContact: Record<string, string>,
  requestTabReadAt: string | null,
): Map<string, MessagesInboxSummary<TMessage>> {
  const summaries = new Map<string, MessagesInboxSummary<TMessage>>();
  const seenMessageIds = new Set<string>();
  const requestCutoff = Date.parse(requestTabReadAt || '') || 0;
  const contactCutoffs = new Map<string, number>(Object.entries(readAtByContact).map(([contactId, value]): [string, number] => (
    [contactId, Date.parse(value || '') || 0]
  )));

  orderedMessages.forEach(message => {
    if (hiddenMessageIds.has(message.id) || seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);

    const contactId = message.sender_id === actorId
      ? message.recipient_id
      : message.recipient_id === actorId
        ? message.sender_id
        : '';
    if (!contactId) return;

    const summary = summaries.get(contactId);
    if (!summary) summaries.set(contactId, { lastMessage: message, unreadCount: 0 });

    if (message.recipient_id !== actorId || message.read_at) return;
    const messageTime = Date.parse(message.created_at) || 0;
    const cutoff = Math.max(contactCutoffs.get(contactId) || 0, requestCutoff);
    if (messageTime > cutoff) {
      const current = summaries.get(contactId);
      if (current) current.unreadCount += 1;
    }
  });

  return summaries;
}

export function legacyInboxDeliveryMessageIds<TMessage extends LegacyInboxMessage>(
  messages: readonly TMessage[],
  hiddenMessageIds: ReadonlySet<string>,
  actorId: string,
): string[] {
  const messageIds = new Set<string>();
  messages.forEach(message => {
    if (message.recipient_id === actorId
      && !message.delivered_at
      && !hiddenMessageIds.has(message.id)) {
      messageIds.add(message.id);
    }
  });
  return [...messageIds];
}

export async function fetchMessagesInboxSummaries<TMessage>(
  request: (args: MessagesInboxRpcArguments) => Promise<{ data: unknown; error: unknown | null }>,
  readAtByContact: Record<string, string>,
  requestTabReadAt: string | null,
  normalizeMessage: (value: unknown) => TMessage | null,
  confirmMissingRpc?: () => Promise<{ data: unknown; error: unknown | null }>,
  fallback?: () => Promise<{
    data: Map<string, MessagesInboxSummary<TMessage>>;
    error: unknown | null;
    deliveryMessageIds?: string[];
  }>,
  availability?: MessagesInboxRpcAvailability,
): Promise<InboxSummaryResult<TMessage>> {
  const emptyResult = (error: unknown | null): InboxSummaryResult<TMessage> => ({
    data: new Map(),
    error,
    usedFallback: false,
    deliveryMessageIds: [],
  });
  const runFallback = async (error: unknown | null): Promise<InboxSummaryResult<TMessage>> => {
    if (!fallback) return emptyResult(error);
    try {
      const fallbackResult = await fallback();
      if (fallbackResult.error) return emptyResult(fallbackResult.error);
      return {
        data: fallbackResult.data,
        error: null,
        usedFallback: true,
        deliveryMessageIds: fallbackResult.deliveryMessageIds || [],
      };
    } catch (fallbackError) {
      return emptyResult(fallbackError);
    }
  };

  // Once the exact missing-function schema-cache error has been confirmed, do
  // not pay for another failing RPC plus an empty-argument probe on every refresh.
  if (availability?.summaryMissing) return runFallback(null);

  const result = await request(messagesInboxRpcArguments(readAtByContact, requestTabReadAt));
  if (!result.error) {
    return {
      data: normalizeMessagesInboxSummaries(result.data, normalizeMessage),
      error: null,
      usedFallback: false,
      deliveryMessageIds: [],
    };
  }
  if (!isPotentialMissingInboxSummaryRpc(result.error) || !confirmMissingRpc || !fallback) {
    return emptyResult(result.error);
  }

  let confirmation: { data: unknown; error: unknown | null };
  try {
    confirmation = await confirmMissingRpc();
  } catch (error) {
    return emptyResult(error);
  }
  if (!confirmation.error) return emptyResult(result.error);
  if (!isConfirmedMissingMessagesInboxRpc(confirmation.error)) {
    return emptyResult(confirmation.error);
  }

  if (availability) availability.summaryMissing = true;
  return runFallback(null);
}

export function createInboxRequestTracker(): InboxRequestTracker {
  let sequence = 0;

  return {
    begin(): number {
      sequence += 1;
      return sequence;
    },
    invalidate(): void {
      sequence += 1;
    },
    isCurrent(requestId: number): boolean {
      return requestId === sequence;
    },
  };
}
