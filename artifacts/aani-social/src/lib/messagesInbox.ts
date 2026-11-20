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

export async function fetchMessagesInboxSummaries<TMessage>(
  request: (args: MessagesInboxRpcArguments) => Promise<{ data: unknown; error: unknown | null }>,
  readAtByContact: Record<string, string>,
  requestTabReadAt: string | null,
  normalizeMessage: (value: unknown) => TMessage | null,
): Promise<{ data: Map<string, MessagesInboxSummary<TMessage>>; error: unknown | null }> {
  const result = await request(messagesInboxRpcArguments(readAtByContact, requestTabReadAt));
  if (result.error) return { data: new Map(), error: result.error };
  return { data: normalizeMessagesInboxSummaries(result.data, normalizeMessage), error: null };
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
