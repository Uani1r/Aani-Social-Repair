import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRealtimeInboxInsert,
  buildLegacyMessagesInboxSummaries,
  createInboxRequestTracker,
  fetchMessagesInboxSummaries,
  isInboxMessageAtLeastAsNew,
  legacyInboxDeliveryMessageIds,
  mergeInboxConversationsWithRealtime,
  mergeRealtimeThreadMessages,
  messagesInboxContactId,
  messagesInboxRealtimeInsertFilters,
  messagesInboxRpcArguments,
  normalizeMessagesInboxSummaries,
  requestUnreadCounts,
  shouldRefreshInboxForSentMessage,
  writeMessagesInboxCache,
} from './messagesInbox';
import { mergeThreadRows } from './messagesThread';

test('inbox realtime filters cover both message directions and suppress duplicate self-send refreshes', () => {
  const filters = messagesInboxRealtimeInsertFilters('me');

  assert.deepEqual(filters, {
    recipient: 'recipient_id=eq.me',
    sender: 'sender_id=eq.me',
  });
  assert.notEqual(filters.recipient, filters.sender);
  assert.equal(shouldRefreshInboxForSentMessage({ sender_id: 'me', recipient_id: 'contact-a' }, 'me'), true);
  assert.equal(shouldRefreshInboxForSentMessage({ sender_id: 'me', recipient_id: 'me' }, 'me'), false);
  assert.equal(shouldRefreshInboxForSentMessage({ sender_id: 'contact-a', recipient_id: 'me' }, 'me'), false);
  assert.equal(shouldRefreshInboxForSentMessage(null, 'me'), false);
});

interface MessageLike {
  id: string;
  sender_id: string;
  recipient_id: string;
  created_at: string;
  read_at: string | null;
  delivered_at: string | null;
  content?: string;
}

function normalizeMessage(value: unknown): MessageLike | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.created_at !== 'string') return null;
  return {
    id: row.id,
    sender_id: typeof row.sender_id === 'string' ? row.sender_id : '',
    recipient_id: typeof row.recipient_id === 'string' ? row.recipient_id : '',
    created_at: row.created_at,
    read_at: typeof row.read_at === 'string' ? row.read_at : null,
    delivered_at: typeof row.delivered_at === 'string' ? row.delivered_at : null,
  };
}

const missingRpcError = {
  code: 'PGRST202',
  message: 'Could not find the public.aani_get_messages_inbox_summaries(p_read_at_by_contact, p_request_tab_read_at) function in the schema cache',
  details: 'Searched for the function with the supplied parameters, but no matches were found in the schema cache.',
  hint: null,
};

const confirmedMissingRpcError = {
  code: 'PGRST202',
  message: 'Could not find the public.aani_get_messages_inbox_summaries() function in the schema cache',
  details: 'Searched for the function public.aani_get_messages_inbox_summaries with no parameters and no matches were found in the schema cache.',
  hint: null,
};

const emptyFallback = async () => ({ data: new Map(), error: null });

interface InboxConversationLike {
  profile: { id: string };
  lastMessage: MessageLike | null;
  isRequest: boolean;
}

function inboxMessage(
  id: string,
  senderId: string,
  recipientId: string,
  createdAt: string,
  content = id,
): MessageLike {
  return {
    id,
    sender_id: senderId,
    recipient_id: recipientId,
    created_at: createdAt,
    read_at: null,
    delivered_at: null,
    content,
  };
}

function inboxConversation(profileId: string, lastMessage: MessageLike | null): InboxConversationLike {
  return { profile: { id: profileId }, lastMessage, isRequest: false };
}

test('Realtime INSERT immediately refreshes inbox preview, timestamp, order, and serialized cache', () => {
  const oldA = inboxMessage('old-a', 'me', 'contact-a', '2027-01-01T10:00:00Z', 'old preview');
  const lastB = inboxMessage('last-b', 'contact-b', 'me', '2027-01-01T10:30:00Z');
  const conversations = [inboxConversation('contact-b', lastB), inboxConversation('contact-a', oldA)];
  const incoming = inboxMessage('new-a', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'instant preview');
  const updated = applyRealtimeInboxInsert(conversations, incoming, 'me');

  assert.deepEqual(updated.map(conversation => conversation.profile.id), ['contact-a', 'contact-b']);
  assert.equal(updated[0]?.lastMessage?.content, 'instant preview');
  assert.equal(updated[0]?.lastMessage?.created_at, '2027-01-01T11:00:00Z');
  assert.equal(messagesInboxContactId(incoming, 'me'), 'contact-a');
  assert.strictEqual(applyRealtimeInboxInsert(updated, incoming, 'me'), updated);

  let cachedValue = '';
  writeMessagesInboxCache({ setItem: (_key, value) => { cachedValue = value; } }, 'inbox', updated);
  const cached = JSON.parse(cachedValue) as InboxConversationLike[];
  assert.equal(cached[0].lastMessage?.content, 'instant preview');
  assert.equal(cached[0].lastMessage?.created_at, '2027-01-01T11:00:00Z');
});

test('Realtime INSERT can immediately add a new contact conversation', () => {
  const incoming = inboxMessage('new-contact', 'contact-c', 'me', '2027-01-01T11:00:00Z');
  const updated = applyRealtimeInboxInsert([], incoming, 'me', contactId => inboxConversation(contactId, null));

  assert.equal(updated.length, 1);
  assert.equal(updated[0].profile.id, 'contact-c');
  assert.equal(updated[0].lastMessage?.id, 'new-contact');
});

test('late inbox and thread fetches merge Realtime inserts once without losing the latest message', () => {
  const stale = inboxMessage('stale-a', 'me', 'contact-a', '2027-01-01T10:00:00Z', 'stale');
  const live = inboxMessage('live-a', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'live');
  const fetched = [inboxConversation('contact-a', stale)];
  const current = [inboxConversation('contact-a', live)];
  const realtime = new Map([['contact-a', { message: live }]]);
  const mergedInbox = mergeInboxConversationsWithRealtime(fetched, current, realtime, 'me');
  const mergedThread = mergeRealtimeThreadMessages(
    [live],
    [stale, live],
    [live, live],
    'me',
    'contact-a',
    mergeThreadRows,
  );

  assert.equal(mergedInbox.length, 1);
  assert.equal(mergedInbox[0]?.lastMessage?.id, 'live-a');
  assert.deepEqual(mergedThread.map(message => message.id), ['stale-a', 'live-a']);
  assert.equal(mergedThread.filter(message => message.id === 'live-a').length, 1);
  assert.equal(mergedThread[1].content, 'live');
});

test('a stale inbox response cannot replace a newer current preview after its Realtime marker is consumed', () => {
  const stale = inboxMessage('stale-a', 'me', 'contact-a', '2027-01-01T10:00:00Z', 'stale');
  const live = inboxMessage('live-a', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'live');
  const merged = mergeInboxConversationsWithRealtime(
    [inboxConversation('contact-a', stale)],
    [inboxConversation('contact-a', live)],
    new Map(),
    'me',
  );

  assert.equal(isInboxMessageAtLeastAsNew(live, stale), true);
  assert.equal(merged[0].lastMessage?.id, 'live-a');
  assert.equal(merged[0].lastMessage?.content, 'live');
});

test('thread Realtime inserts from another contact are rejected', () => {
  const foreign = inboxMessage('foreign', 'contact-b', 'me', '2027-01-01T11:00:00Z');
  const merged = mergeRealtimeThreadMessages([], [], [foreign], 'me', 'contact-a', mergeThreadRows);

  assert.deepEqual(merged, []);
});

test('inbox loading uses one successful summary request and normalizes its response', async () => {
  let requestCount = 0;
  let receivedArguments: ReturnType<typeof messagesInboxRpcArguments> | null = null;
  let confirmationCount = 0;
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async args => {
    requestCount += 1;
    receivedArguments = args;
    return {
      data: [
        {
          contact_id: 'contact-a',
          last_message: { id: 'message-a', created_at: '2027-01-01T10:00:00.000Z' },
          unread_count: '3',
        },
        {
          contact_id: 'contact-a',
          last_message: { id: 'duplicate', created_at: '2027-01-01T11:00:00.000Z' },
          unread_count: 99,
        },
        { contact_id: 'contact-b', last_message: null, unread_count: -4 },
        { contact_id: 12, last_message: { id: 'invalid', created_at: 'now' }, unread_count: 1 },
      ],
      error: null,
    };
  }, {
    'contact-a': '2027-01-01T09:00:00Z',
    'contact-b': 'not-a-date',
  }, null, normalizeMessage, async () => {
    confirmationCount += 1;
    return { data: null, error: confirmedMissingRpcError };
  }, async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(requestCount, 1);
  assert.equal(confirmationCount, 0);
  assert.equal(fallbackCount, 0);
  assert.deepEqual(receivedArguments, {
    p_read_at_by_contact: {
      'contact-a': '2027-01-01T09:00:00.000Z',
      'contact-b': '1970-01-01T00:00:00.000Z',
    },
    p_request_tab_read_at: '1970-01-01T00:00:00.000Z',
  });
  assert.equal(result.error, null);
  assert.equal(result.usedFallback, false);
  assert.deepEqual([...result.data.entries()], [
    ['contact-a', {
      lastMessage: {
        id: 'message-a',
        sender_id: '',
        recipient_id: '',
        created_at: '2027-01-01T10:00:00.000Z',
        read_at: null,
        delivered_at: null,
      },
      unreadCount: 3,
    }],
    ['contact-b', { lastMessage: null, unreadCount: 0 }],
  ]);
});

test('legacy fallback runs only after an empty-argument probe confirms the RPC is absent', async () => {
  let requestCount = 0;
  let confirmationCount = 0;
  let fallbackCount = 0;
  const fallbackData = new Map([
    ['contact-a', {
      lastMessage: {
        id: 'legacy-message',
        sender_id: 'contact-a',
        recipient_id: 'me',
        created_at: '2027-01-01T10:00:00Z',
        read_at: null,
        delivered_at: null,
      },
      unreadCount: 0,
    }],
  ]);
  const result = await fetchMessagesInboxSummaries(async () => {
    requestCount += 1;
    return { data: null, error: missingRpcError };
  }, {}, null, normalizeMessage, async () => {
    confirmationCount += 1;
    return { data: null, error: confirmedMissingRpcError };
  }, async () => {
    fallbackCount += 1;
    return { data: fallbackData, error: null, deliveryMessageIds: ['incoming-1'] };
  });

  assert.equal(requestCount, 1);
  assert.equal(confirmationCount, 1);
  assert.equal(fallbackCount, 1);
  assert.equal(result.error, null);
  assert.equal(result.usedFallback, true);
  assert.equal(result.data.get('contact-a')?.lastMessage?.id, 'legacy-message');
  assert.deepEqual(result.deliveryMessageIds, ['incoming-1']);
});

test('permission errors never probe for or use the legacy fallback', async () => {
  const error = { code: '42501', message: 'permission denied for function aani_get_messages_inbox_summaries' };
  let confirmationCount = 0;
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error }), {}, null, normalizeMessage, async () => {
    confirmationCount += 1;
    return { data: null, error: confirmedMissingRpcError };
  }, async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, error);
  assert.equal(result.usedFallback, false);
  assert.equal(confirmationCount, 0);
  assert.equal(fallbackCount, 0);
});

test('connection errors never probe for or use the legacy fallback', async () => {
  const error = new TypeError('Failed to fetch');
  let confirmationCount = 0;
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error }), {}, null, normalizeMessage, async () => {
    confirmationCount += 1;
    return { data: null, error: confirmedMissingRpcError };
  }, async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, error);
  assert.equal(result.usedFallback, false);
  assert.equal(confirmationCount, 0);
  assert.equal(fallbackCount, 0);
});

test('connection failure during the missing-RPC probe does not use the legacy fallback', async () => {
  const probeError = new TypeError('Failed to fetch');
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error: missingRpcError }), {}, null, normalizeMessage, async () => ({
    data: null,
    error: probeError,
  }), async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, probeError);
  assert.equal(result.usedFallback, false);
  assert.equal(fallbackCount, 0);
});

test('ambiguous overload errors do not probe for or use the legacy fallback', async () => {
  const error = {
    code: 'PGRST203',
    message: 'Could not choose the best candidate function between overloaded functions',
  };
  let confirmationCount = 0;
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error }), {}, null, normalizeMessage, async () => {
    confirmationCount += 1;
    return { data: null, error: confirmedMissingRpcError };
  }, async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, error);
  assert.equal(result.usedFallback, false);
  assert.equal(confirmationCount, 0);
  assert.equal(fallbackCount, 0);
});

test('a signature mismatch that succeeds without named arguments does not fall back', async () => {
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error: missingRpcError }), {}, null, normalizeMessage, async () => ({
    data: [],
    error: null,
  }), async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, missingRpcError);
  assert.equal(result.usedFallback, false);
  assert.equal(fallbackCount, 0);
});

test('a no-argument probe hinting at a required RPC signature does not fall back', async () => {
  const signatureError = {
    code: 'PGRST202',
    message: 'Could not find the public.aani_get_messages_inbox_summaries() function in the schema cache',
    details: 'Searched for the function with no parameters, but no match was found in the schema cache.',
    hint: 'Perhaps you meant to call the function public.aani_get_messages_inbox_summaries(p_account_id uuid)',
  };
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error: missingRpcError }), {}, null, normalizeMessage, async () => ({
    data: null,
    error: signatureError,
  }), async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, signatureError);
  assert.equal(result.usedFallback, false);
  assert.equal(fallbackCount, 0);
});

test('stale function-signature errors do not use the legacy fallback', async () => {
  const signatureError = {
    code: 'PGRST202',
    message: 'Could not find the public.aani_get_messages_inbox_summaries(p_read_at_by_contact) function in the schema cache',
    details: 'Searched for the function with the supplied parameter but no matching signature was found in the schema cache.',
    hint: null,
  };
  let fallbackCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error: missingRpcError }), {}, null, normalizeMessage, async () => ({
    data: null,
    error: signatureError,
  }), async () => {
    fallbackCount += 1;
    return emptyFallback();
  });

  assert.equal(result.error, signatureError);
  assert.equal(result.usedFallback, false);
  assert.equal(fallbackCount, 0);
});

test('a failed legacy fallback is returned as an error rather than an empty conversation list', async () => {
  const hideQueryError = { code: '42501', message: 'permission denied for message_hides' };
  const result = await fetchMessagesInboxSummaries(async () => ({ data: null, error: missingRpcError }), {}, null, normalizeMessage, async () => ({
    data: null,
    error: confirmedMissingRpcError,
  }), async () => ({
    data: new Map(),
    error: hideQueryError,
  }));

  assert.equal(result.error, hideQueryError);
  assert.equal(result.usedFallback, false);
  assert.equal(result.data.size, 0);
});

test('legacy summaries retain visible conversations, deduplicate rows, and honor both read cutoffs', () => {
  const actorId = 'me';
  const messages: MessageLike[] = [
    { id: 'hidden-latest', sender_id: 'contact-b', recipient_id: actorId, created_at: '2027-01-01T14:00:00Z', read_at: null, delivered_at: null },
    { id: 'latest-a', sender_id: actorId, recipient_id: 'contact-a', created_at: '2027-01-01T12:00:00Z', read_at: null, delivered_at: null },
    { id: 'latest-a', sender_id: actorId, recipient_id: 'contact-a', created_at: '2027-01-01T12:00:00Z', read_at: null, delivered_at: null },
    { id: 'unread-a', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T11:00:00Z', read_at: null, delivered_at: null },
    { id: 'unread-a', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T11:00:00Z', read_at: null, delivered_at: null },
    { id: 'cutoff-a', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T10:30:00Z', read_at: null, delivered_at: null },
    { id: 'read-a', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T10:45:00Z', read_at: '2027-01-01T10:46:00Z', delivered_at: null },
    { id: 'unread-b', sender_id: 'contact-b', recipient_id: actorId, created_at: '2027-01-01T09:31:00Z', read_at: null, delivered_at: null },
    { id: 'old-b', sender_id: 'contact-b', recipient_id: actorId, created_at: '2027-01-01T08:00:00Z', read_at: null, delivered_at: null },
  ];
  const summaries = buildLegacyMessagesInboxSummaries(
    messages,
    new Set(['hidden-latest']),
    actorId,
    { 'contact-a': '2027-01-01T10:30:00Z' },
    '2027-01-01T09:30:00Z',
  );

  assert.deepEqual([...summaries.keys()], ['contact-a', 'contact-b']);
  assert.equal(summaries.get('contact-a')?.lastMessage?.id, 'latest-a');
  assert.equal(summaries.get('contact-a')?.unreadCount, 1);
  assert.equal(summaries.get('contact-b')?.lastMessage?.id, 'unread-b');
  assert.equal(summaries.get('contact-b')?.unreadCount, 1);
  assert.deepEqual(requestUnreadCounts(summaries, new Set(['contact-a', 'contact-b'])), {
    'contact-a': 1,
    'contact-b': 1,
  });
});

test('legacy delivery acknowledgements include only visible incoming undelivered messages', () => {
  const actorId = 'me';
  const messages: MessageLike[] = [
    { id: 'incoming', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T10:00:00Z', read_at: null, delivered_at: null },
    { id: 'outgoing', sender_id: actorId, recipient_id: 'contact-a', created_at: '2027-01-01T10:01:00Z', read_at: null, delivered_at: null },
    { id: 'already-delivered', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T10:02:00Z', read_at: null, delivered_at: '2027-01-01T10:03:00Z' },
    { id: 'hidden', sender_id: 'contact-a', recipient_id: actorId, created_at: '2027-01-01T10:04:00Z', read_at: null, delivered_at: null },
  ];

  assert.deepEqual(legacyInboxDeliveryMessageIds(messages, new Set(['hidden']), actorId), ['incoming']);
});

test('request badges use summary counts only for request contacts', () => {
  const summaries = normalizeMessagesInboxSummaries([
    { contact_id: 'request-a', last_message: null, unread_count: 2 },
    { contact_id: 'regular-b', last_message: null, unread_count: 4 },
    { contact_id: 'request-c', last_message: null, unread_count: 0 },
  ], normalizeMessage);

  assert.deepEqual(requestUnreadCounts(summaries, new Set(['request-a', 'request-c'])), {
    'request-a': 2,
  });
});

test('an older legacy fallback response stays stale after a newer load or invalidation', async () => {
  const tracker = createInboxRequestTracker();
  const firstRequest = tracker.begin();
  let resolveFallback!: (value: {
    data: Map<string, { lastMessage: MessageLike | null; unreadCount: number }>;
    error: unknown | null;
  }) => void;
  const pendingFallback = new Promise<{
    data: Map<string, { lastMessage: MessageLike | null; unreadCount: number }>;
    error: unknown | null;
  }>(resolve => {
    resolveFallback = resolve;
  });
  const resultPromise = fetchMessagesInboxSummaries(async () => ({ data: null, error: missingRpcError }), {}, null, normalizeMessage, async () => ({
    data: null,
    error: confirmedMissingRpcError,
  }), async () => await pendingFallback);
  const secondRequest = tracker.begin();
  resolveFallback({ data: new Map(), error: null });

  const result = await resultPromise;
  let applied = false;
  if (tracker.isCurrent(firstRequest)) applied = true;

  assert.equal(result.usedFallback, true);
  assert.equal(applied, false);
  assert.equal(tracker.isCurrent(firstRequest), false);
  assert.equal(tracker.isCurrent(secondRequest), true);

  tracker.invalidate();
  assert.equal(tracker.isCurrent(secondRequest), false);
});
