export interface HiddenMessageRow {
  message_id?: unknown;
}

export interface HiddenMessageQueryResult {
  data: readonly HiddenMessageRow[] | null;
  error: unknown | null;
}

export async function loadHiddenMessageIds(
  query: () => Promise<HiddenMessageQueryResult>,
): Promise<Set<string>> {
  const { data, error } = await query();
  if (error) throw error;

  return new Set((data || []).flatMap(row => typeof row.message_id === 'string' ? [row.message_id] : []));
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
