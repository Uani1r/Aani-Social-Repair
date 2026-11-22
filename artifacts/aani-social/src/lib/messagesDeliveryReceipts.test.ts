import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeMessageSnapshot } from './messagesInbox';
import { createMessagesRealtimeEventHub, messagesRealtimeEventFromPayload } from './messagesRealtimeEvents';
import {
  MARK_INBOX_MESSAGES_DELIVERED_RPC,
  MARK_MESSAGES_DELIVERED_RPC,
  createMessagesDeliveryReceipts,
  incomingMessageIdForDelivery,
  isMissingMessagesReceiptRpc,
} from './messagesDeliveryReceipts';
import { createRealtimeChannelLifecycle, createRealtimeChannelSupervisor } from './realtimeChannelHealth';

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

interface DeliveryCalls {
  delivered: string[][];
  inbox: number;
  errors: Array<[string, unknown]>;
}

function createReceiptsHarness(options: {
  deliveredError?: unknown;
  inboxError?: unknown;
  thrownDelivery?: unknown;
} = {}) {
  const calls: DeliveryCalls = { delivered: [], inbox: 0, errors: [] };
  const receipts = createMessagesDeliveryReceipts({
    userId: 'me',
    markDelivered: async messageIds => {
      calls.delivered.push(messageIds);
      if (options.thrownDelivery) throw options.thrownDelivery;
      return { error: options.deliveredError ?? null };
    },
    markInboxDelivered: async () => {
      calls.inbox += 1;
      return { error: options.inboxError ?? null };
    },
    onError: (rpc, error) => calls.errors.push([rpc, error]),
  });
  return { calls, receipts };
}

function createTimerStub() {
  let nextHandle = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (handler: () => void) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, handler);
      return handle;
    },
    clearTimer: (handle: number) => {
      timers.delete(handle);
    },
    pendingCount: () => timers.size,
  };
}

test('an incoming INSERT for the current user requests delivery confirmation', async () => {
  const { calls, receipts } = createReceiptsHarness();
  const messageId = incomingMessageIdForDelivery({ id: 'm1', recipient_id: 'me' }, 'me');

  assert.equal(messageId, 'm1');
  receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' });
  await flushMicrotasks();

  assert.deepEqual(calls.delivered, [['m1']]);
  assert.equal(calls.inbox, 0);
  assert.deepEqual(calls.errors, []);
});

test('a message that is not addressed to the current user is never confirmed', async () => {
  const { calls, receipts } = createReceiptsHarness();

  assert.equal(incomingMessageIdForDelivery({ id: 'm1', recipient_id: 'other' }, 'me'), null);
  receipts.confirmIncoming({ id: 'm1', recipient_id: 'other' });
  receipts.confirmIncoming({ id: 'm2' });
  receipts.confirmIncoming({ id: '', recipient_id: 'me' });
  receipts.confirmIncoming(null);
  receipts.confirmIncoming('m3');
  await flushMicrotasks();

  assert.deepEqual(calls.delivered, []);
});

test('the same incoming message is confirmed only once', async () => {
  const { calls, receipts } = createReceiptsHarness();

  receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' });
  receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' });
  await flushMicrotasks();

  assert.deepEqual(calls.delivered, [['m1']]);
});

test('an RPC error result is logged and never blocks the event or the badge', async () => {
  const error = new Error('rpc failed');
  const { calls, receipts } = createReceiptsHarness({ deliveredError: error });
  const hub = createMessagesRealtimeEventHub();
  const published: string[] = [];
  hub.subscribe(event => published.push(event.type));
  let badgeRefreshes = 0;

  // ترتيب معالج Shell: نشر الحدث ثم تحديث الشارة ثم التأكيد بلا انتظار.
  hub.publish(messagesRealtimeEventFromPayload('INSERT', { new: { id: 'm1', recipient_id: 'me' } }));
  badgeRefreshes += 1;
  receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' });

  await flushMicrotasks();

  assert.deepEqual(published, ['INSERT']);
  assert.equal(badgeRefreshes, 1);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], 'messages');
  assert.equal(calls.errors[0][1], error);
});

test('a throwing delivery request is caught and logged', async () => {
  const thrown = new Error('network down');
  const { calls, receipts } = createReceiptsHarness({ thrownDelivery: thrown });

  assert.doesNotThrow(() => receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' }));
  await flushMicrotasks();

  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][1], thrown);
});

test('a confirmed missing delivery RPC is not called again', async () => {
  const missing = {
    code: 'PGRST202',
    message: 'Could not find the public.aani_mark_messages_delivered(p_message_ids) function in the schema cache',
  };
  const { calls, receipts } = createReceiptsHarness({ deliveredError: missing });

  assert.equal(isMissingMessagesReceiptRpc(missing, MARK_MESSAGES_DELIVERED_RPC), true);
  assert.equal(isMissingMessagesReceiptRpc({ code: '42501', message: 'permission denied' }, MARK_MESSAGES_DELIVERED_RPC), false);

  receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' });
  await flushMicrotasks();
  receipts.confirmIncoming({ id: 'm2', recipient_id: 'me' });
  await flushMicrotasks();

  assert.equal(calls.delivered.length, 1);
});

test('a confirmed subscription asks for one compensating inbox confirmation', async () => {
  const { calls, receipts } = createReceiptsHarness();
  const supervisor = createRealtimeChannelSupervisor();
  const timers = createTimerStub();
  const lifecycle = createRealtimeChannelLifecycle({
    id: 'unread',
    supervisor,
    onResync: () => receipts.confirmMissed(),
    onRecreate: () => undefined,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const token = lifecycle.begin();
  lifecycle.handleStatus(token, 'SUBSCRIBED');
  await flushMicrotasks();

  assert.equal(calls.inbox, 1);
  assert.equal(supervisor.snapshot('unread').status, 'SUBSCRIBED');

  // تكرار التأكيد أثناء الاشتراك السليم لا يكرر المزامنة التعويضية.
  lifecycle.handleStatus(token, 'SUBSCRIBED');
  await flushMicrotasks();
  assert.equal(calls.inbox, 1);
});

test('a recovery after a channel failure also asks for a compensating confirmation', async () => {
  const { calls, receipts } = createReceiptsHarness();
  const supervisor = createRealtimeChannelSupervisor();
  const timers = createTimerStub();
  const lifecycle = createRealtimeChannelLifecycle({
    id: 'unread',
    supervisor,
    onResync: () => receipts.confirmMissed(),
    onRecreate: () => undefined,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const token = lifecycle.begin();
  lifecycle.handleStatus(token, 'CHANNEL_ERROR');
  // فشل الاشتراك نفسه لا يؤكد شيئاً.
  await flushMicrotasks();
  assert.equal(calls.inbox, 0);

  lifecycle.handleStatus(token, 'SUBSCRIBED');
  await flushMicrotasks();
  assert.equal(calls.inbox, 1);
});

test('a failing compensating confirmation does not block realtime or the badge', async () => {
  const error = new Error('inbox rpc failed');
  const { calls, receipts } = createReceiptsHarness({ inboxError: error });
  const supervisor = createRealtimeChannelSupervisor();
  const timers = createTimerStub();
  let badgeRefreshes = 0;

  const lifecycle = createRealtimeChannelLifecycle({
    id: 'unread',
    supervisor,
    onResync: () => {
      badgeRefreshes += 1;
      receipts.confirmMissed();
    },
    onRecreate: () => undefined,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const token = lifecycle.begin();
  lifecycle.handleStatus(token, 'SUBSCRIBED');
  await flushMicrotasks();

  assert.equal(badgeRefreshes, 1);
  assert.equal(supervisor.snapshot('unread').status, 'SUBSCRIBED');
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], 'inbox');
  assert.equal(isMissingMessagesReceiptRpc({ code: '42501', message: 'denied' }, MARK_INBOX_MESSAGES_DELIVERED_RPC), false);
});

test('a stale snapshot cannot turn a delivered, read message back to undelivered', () => {
  const current = {
    id: 'm1',
    sender_id: 'contact',
    recipient_id: 'me',
    created_at: '2027-01-01T10:00:00Z',
    delivered_at: '2027-01-01T10:00:01Z',
    read_at: '2027-01-01T10:01:00Z',
  };
  const stale = { ...current, delivered_at: null, read_at: null };

  const merged = mergeMessageSnapshot(current, stale);

  assert.equal(merged.delivered_at, '2027-01-01T10:00:01Z');
  assert.equal(merged.read_at, '2027-01-01T10:01:00Z');
});

test('delivery confirmation never touches read state or reactions', async () => {
  const { calls, receipts } = createReceiptsHarness();

  receipts.confirmIncoming({ id: 'm1', recipient_id: 'me' });
  receipts.confirmMissed();
  await flushMicrotasks();

  // نداءان فقط: تأكيد التسليم الفردي ثم التعويضي. لا تحديث read_at ولا تفاعلات.
  assert.deepEqual(calls.delivered, [['m1']]);
  assert.equal(calls.inbox, 1);
  assert.deepEqual(calls.errors, []);
});
