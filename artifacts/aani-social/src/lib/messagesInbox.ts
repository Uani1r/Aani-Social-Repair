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
  read_at?: string | null;
  delivered_at?: string | null;
}

export interface InboxSummaryResult<TMessage> {
  data: Map<string, MessagesInboxSummary<TMessage>>;
  error: unknown | null;
  usedFallback: boolean;
  deliveryMessageIds: string[];
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
 * call before falling back; the inbox RPC's arguments have defaults. A
 * signature mismatch with useful PostgREST details, PGRST203, permission
 * failures, and transport failures must never trigger the legacy path.
 */
export function isConfirmedMissingMessagesInboxRpc(error: unknown): boolean {
  const message = errorField(error, 'message');
  const details = errorField(error, 'details');
  if (errorField(error, 'code') !== 'PGRST202' || typeof message !== 'string') return false;
  const functionName = `(?:public\\.)?${INBOX_SUMMARY_RPC}\\(\\)`;
  const missingFunctionMessage = new RegExp(`Could not find the function\\s+${functionName}\\s+in the schema cache`, 'i').test(message)
    || new RegExp(`Could not find\\s+${functionName}\\s+function\\s+in the schema cache`, 'i').test(message);
  return missingFunctionMessage && (details == null || details === '');
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
): Promise<InboxSummaryResult<TMessage>> {
  const emptyResult = (error: unknown | null): InboxSummaryResult<TMessage> => ({
    data: new Map(),
    error,
    usedFallback: false,
    deliveryMessageIds: [],
  });

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

  try {
    const fallbackResult = await fallback();
    if (fallbackResult.error) return emptyResult(fallbackResult.error);
    return {
      data: fallbackResult.data,
      error: null,
      usedFallback: true,
      deliveryMessageIds: fallbackResult.deliveryMessageIds || [],
    };
  } catch (error) {
    return emptyResult(error);
  }
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
