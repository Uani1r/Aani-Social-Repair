import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeMessageSnapshot } from './messagesInbox';
import { createMessagesRealtimeEventHub, messagesRealtimeEventFromPayload } from './messagesRealtimeEvents';
import {
  MESSAGES_DELIVERY_MAX_ATTEMPTS,
  MARK_INBOX_MESSAGES_DELIVERED_RPC,
  MARK_MESSAGES_DELIVERED_RPC,
  createMessagesDeliveryReceipts,
  incomingMessageIdForDelivery,
  isMissingMessagesReceiptRpc,
  messagesDeliveryRetryDelay,
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

interface ReceiptTimer {
  handler: () => void;
  timeout: number;
}

function createTimerHarness() {
  let nextHandle = 1;
  const timers = new Map<number, ReceiptTimer>();
  return {
    setTimer: (handler: () => void, timeout: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { handler, timeout });
      return handle;
    },
    clearTimer: (handle: number) => {
      timers.delete(handle);
    },
    pendingCount: () => timers.size,
    timeouts: () => [...timers.values()].map(timer => timer.timeout),
    runNext(): boolean {
      const next = [...timers.entries()][0];
      if (!next) return false;
      timers.delete(next[0]);
      next[1].handler();
      return true;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createReceiptsHarness(options: {
  /** نتيجة كل نداء: العنصر i هو الخطأ في النداء i (null = نجاح). */
  deliveredResults?: Array<unknown | null>;
  inboxError?: unknown;
  thrownDelivery?: unknown;
  deferredDelivery?: Promise<{ error: unknown | null }>;
} = {}) {
  const calls: DeliveryCalls = { delivered: [], inbox: 0, errors: [] };
  const timers = createTimerHarness();
  let callIndex = 0;

  const receipts = createMessagesDeliveryReceipts({
    userId: 'me',
    markDelivered: async messageIds => {
      calls.delivered.push(messageIds);
      if (options.thrownDelivery) throw options.thrownDelivery;
      if (options.deferredDelivery) return options.deferredDelivery;
      const error = options.deliveredResults?.[callIndex] ?? null;
      callIndex += 1;
      return { error };
    },
    markInboxDelivered: async () => {
      calls.inbox += 1;
      return { error: options.inboxError ?? null };
    },
    onError: (rpc, error) => calls.errors.push([rpc, error]),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  return { calls, receipts, timers };
}

const incomingRow = { id: 'm1', recipient_id: 'me' };

test('an incoming INSERT for the current user requests delivery confirmation', async () => {
  const { calls, receipts } = createReceiptsHarness();

  assert.equal(incomingMessageIdForDelivery(incomingRow, 'me'), 'm1');
  receipts.confirmIncoming(incomingRow);
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

  receipts.confirmIncoming(incomingRow);
  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();

  assert.deepEqual(calls.delivered, [['m1']]);
});

test('a transient failure is retried once and the message is confirmed on success', async () => {
  const transient = new Error('network down');
  const { calls, receipts, timers } = createReceiptsHarness({ deliveredResults: [transient, null] });

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();

  // فشل مؤقت: المعرّف خرج من التنفيذ، وليس مؤكداً، وهناك محاولة مجدولة واحدة.
  assert.equal(calls.delivered.length, 1);
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.timeouts(), [messagesDeliveryRetryDelay(1)]);
  assert.deepEqual(calls.errors, [['messages', transient]]);

  assert.equal(timers.runNext(), true);
  await flushMicrotasks();

  assert.equal(calls.delivered.length, 2);
  assert.deepEqual(calls.delivered[1], ['m1']);
  assert.equal(timers.pendingCount(), 0);
  assert.equal(calls.errors.length, 1);

  // بعد نجاح التأكيد لا يُعاد الطلب لهذه الرسالة.
  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();
  assert.equal(calls.delivered.length, 2);
});

test('duplicate requests for the same message while in flight are ignored', async () => {
  const deferred = createDeferred<{ error: unknown | null }>();
  const { calls, receipts } = createReceiptsHarness({ deferredDelivery: deferred.promise });

  receipts.confirmIncoming(incomingRow);
  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();

  assert.equal(calls.delivered.length, 1);

  deferred.resolve({ error: null });
  await flushMicrotasks();

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();
  assert.equal(calls.delivered.length, 1);
});

test('an INSERT that arrives while a retry is pending does not schedule another request', async () => {
  const transient = new Error('temporary');
  const { calls, receipts, timers } = createReceiptsHarness({ deliveredResults: [transient] });

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();
  assert.equal(timers.pendingCount(), 1);

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();

  assert.equal(calls.delivered.length, 1);
  assert.equal(timers.pendingCount(), 1);
});

test('retries are bounded so a failing RPC cannot loop forever', async () => {
  const failure = new Error('still failing');
  const { calls, receipts, timers } = createReceiptsHarness({
    deliveredResults: [failure, failure, failure, failure],
  });

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();

  while (timers.runNext()) {
    await flushMicrotasks();
  }

  assert.equal(calls.delivered.length, MESSAGES_DELIVERY_MAX_ATTEMPTS);
  assert.equal(timers.pendingCount(), 0);

  // المحاولات استُهلكت: لا طلب جديد حتى لو وصل INSERT آخر.
  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();
  assert.equal(calls.delivered.length, MESSAGES_DELIVERY_MAX_ATTEMPTS);
});

test('the retry delay grows and stops at its ceiling', () => {
  assert.equal(messagesDeliveryRetryDelay(1), 1000);
  assert.equal(messagesDeliveryRetryDelay(2), 2000);
  assert.equal(messagesDeliveryRetryDelay(4), 8000);
  assert.equal(messagesDeliveryRetryDelay(9), 10000);
});

test('an RPC error result is logged and never blocks the event or the badge', async () => {
  const error = new Error('rpc failed');
  const { calls, receipts } = createReceiptsHarness({ deliveredResults: [error] });
  const hub = createMessagesRealtimeEventHub();
  const published: string[] = [];
  hub.subscribe(event => published.push(event.type));
  let badgeRefreshes = 0;

  // ترتيب معالج Shell: نشر الحدث ثم تحديث الشارة ثم التأكيد بلا انتظار.
  hub.publish(messagesRealtimeEventFromPayload('INSERT', { new: incomingRow }));
  badgeRefreshes += 1;
  receipts.confirmIncoming(incomingRow);

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

  assert.doesNotThrow(() => receipts.confirmIncoming(incomingRow));
  await flushMicrotasks();

  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][1], thrown);
});

test('a confirmed missing delivery RPC is not called again and cancels retries', async () => {
  const missing = {
    code: 'PGRST202',
    message: 'Could not find the public.aani_mark_messages_delivered(p_message_ids) function in the schema cache',
  };
  const { calls, receipts, timers } = createReceiptsHarness({ deliveredResults: [missing] });

  assert.equal(isMissingMessagesReceiptRpc(missing, MARK_MESSAGES_DELIVERED_RPC), true);
  assert.equal(isMissingMessagesReceiptRpc({ code: '42501', message: 'permission denied' }, MARK_MESSAGES_DELIVERED_RPC), false);

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();
  assert.equal(timers.pendingCount(), 0);

  receipts.confirmIncoming({ id: 'm2', recipient_id: 'me' });
  await flushMicrotasks();

  assert.equal(calls.delivered.length, 1);
});

test('permission errors are not treated as a missing RPC and keep retrying', async () => {
  const permission = {
    code: '42501',
    message: 'permission denied for function aani_mark_messages_delivered',
  };
  const { calls, receipts, timers } = createReceiptsHarness({ deliveredResults: [permission, null] });

  assert.equal(isMissingMessagesReceiptRpc(permission, MARK_MESSAGES_DELIVERED_RPC), false);

  receipts.confirmIncoming(incomingRow);
  await flushMicrotasks();
  assert.equal(timers.pendingCount(), 1);

  assert.equal(timers.runNext(), true);
  await flushMicrotasks();
  assert.equal(calls.delivered.length, 2);
});

test('a confirmed subscription asks for one compensating inbox confirmation', async () => {
  const { calls, receipts } = createReceiptsHarness();
  const supervisor = createRealtimeChannelSupervisor();
  const timers = createTimerHarness();
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
  const timers = createTimerHarness();
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
  const timers = createTimerHarness();
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
  const { calls, receipts, timers } = createReceiptsHarness();

  receipts.confirmIncoming(incomingRow);
  receipts.confirmMissed();
  await flushMicrotasks();

  // نداءان فقط: تأكيد التسليم الفردي ثم التعويضي. لا تحديث read_at ولا تفاعلات.
  assert.deepEqual(calls.delivered, [['m1']]);
  assert.equal(calls.inbox, 1);
  assert.deepEqual(calls.errors, []);
  assert.equal(timers.pendingCount(), 0);
});
