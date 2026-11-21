export interface HiddenMessageRow {
  message_id?: unknown;
}

export interface HiddenMessageQueryResult {
  data: readonly HiddenMessageRow[] | null;
  error: unknown | null;
}

export class HiddenMessagesLookupError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super('Failed to load hidden message IDs');
    this.name = 'HiddenMessagesLookupError';
    this.originalError = originalError;
  }
}

export function handleHiddenMessagesLookupFailure(
  error: unknown,
  onFailure: (error: HiddenMessagesLookupError) => void,
): boolean {
  if (!(error instanceof HiddenMessagesLookupError)) return false;
  onFailure(error);
  return true;
}

export async function loadHiddenMessageIds(
  query: () => Promise<HiddenMessageQueryResult>,
): Promise<Set<string>> {
  let result: HiddenMessageQueryResult;
  try {
    result = await query();
  } catch (error) {
    throw new HiddenMessagesLookupError(error);
  }
  if (result.error) throw new HiddenMessagesLookupError(result.error);

  return new Set((result.data || []).flatMap(row => typeof row.message_id === 'string' ? [row.message_id] : []));
}

export async function loadVisibleMessagesWithHiddenIds<TMessage extends { id: string }>(
  messages: readonly TMessage[],
  query: () => Promise<Set<string>>,
): Promise<{ hiddenMessageIds: Set<string>; visibleMessages: TMessage[] }> {
  const hiddenMessageIds = await query();
  return {
    hiddenMessageIds,
    visibleMessages: messages.filter(message => !hiddenMessageIds.has(message.id)),
  };
}
