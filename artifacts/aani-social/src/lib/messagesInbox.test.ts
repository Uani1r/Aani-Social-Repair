import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInboxRequestTracker,
  fetchMessagesInboxSummaries,
  messagesInboxRpcArguments,
  normalizeMessagesInboxSummaries,
  requestUnreadCounts,
} from './messagesInbox';

interface MessageLike {
  id: string;
  created_at: string;
}

function normalizeMessage(value: unknown): MessageLike | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.created_at !== 'string') return null;
  return { id: row.id, created_at: row.created_at };
}

test('inbox loading makes one summary request and normalizes its grouped response', async () => {
  let requestCount = 0;
  let receivedArguments: ReturnType<typeof messagesInboxRpcArguments> | null = null;
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
  }, null, normalizeMessage);

  assert.equal(requestCount, 1);
  assert.deepEqual(receivedArguments, {
    p_read_at_by_contact: {
      'contact-a': '2027-01-01T09:00:00.000Z',
      'contact-b': '1970-01-01T00:00:00.000Z',
    },
    p_request_tab_read_at: '1970-01-01T00:00:00.000Z',
  });
  assert.equal(result.error, null);
  assert.deepEqual([...result.data.entries()], [
    ['contact-a', {
      lastMessage: { id: 'message-a', created_at: '2027-01-01T10:00:00.000Z' },
      unreadCount: 3,
    }],
    ['contact-b', { lastMessage: null, unreadCount: 0 }],
  ]);
});

test('request badges use database counts only for request contacts', () => {
  const summaries = normalizeMessagesInboxSummaries([
    { contact_id: 'request-a', last_message: null, unread_count: 2 },
    { contact_id: 'regular-b', last_message: null, unread_count: 4 },
    { contact_id: 'request-c', last_message: null, unread_count: 0 },
  ], normalizeMessage);

  assert.deepEqual(requestUnreadCounts(summaries, new Set(['request-a', 'request-c'])), {
    'request-a': 2,
  });
});

test('an older inbox response is ignored after a newer load or invalidation', () => {
  const tracker = createInboxRequestTracker();
  const firstRequest = tracker.begin();
  const secondRequest = tracker.begin();

  assert.equal(tracker.isCurrent(firstRequest), false);
  assert.equal(tracker.isCurrent(secondRequest), true);

  tracker.invalidate();
  assert.equal(tracker.isCurrent(secondRequest), false);
});

test('summary RPC errors are returned without attempting another request', async () => {
  const error = new Error('missing summary function');
  let requestCount = 0;
  const result = await fetchMessagesInboxSummaries(async () => {
    requestCount += 1;
    return { data: null, error };
  }, {}, null, normalizeMessage);

  assert.equal(requestCount, 1);
  assert.equal(result.error, error);
  assert.equal(result.data.size, 0);
});
