import assert from 'node:assert/strict';
import test from 'node:test';

import { openMessagesConversationChannel } from './messagesConversationChannel';

const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => now,
    setTimer(callback: () => void, delayMs: number): unknown {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    pending(): number {
      return timers.size;
    },
    advance(ms: number): void {
      now += ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= now && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        timer.callback();
      }
    },
  };
}

type FakeChannel = { id: number; removed: boolean };

test('no private channel is created before the membership is ready', async () => {
  const scheduler = createScheduler();
  let ensured = 0;
  let created = 0;
  let unavailable: string | null = null;

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async () => { ensured += 1; return false; },
    createChannel: () => { created += 1; return { id: created, removed: false }; },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    onUnavailable: reason => { unavailable = reason; },
    removeChannel: () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  assert.equal(ensured, 1);
  assert.equal(created, 0);
  assert.equal(unavailable, 'membership');
  assert.equal(scheduler.pending(), 0);
  session.cancel();
});

test('a subscribed channel is reported once and schedules no retries', async () => {
  const scheduler = createScheduler();
  let created = 0;
  let subscribed = 0;
  let status: ((status: string, error?: unknown) => void) | null = null;

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async () => true,
    createChannel: onStatus => {
      created += 1;
      status = onStatus;
      return { id: created, removed: false };
    },
    onSubscribed: () => { subscribed += 1; },
    onNotSubscribed: () => undefined,
    removeChannel: () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  assert.equal(created, 1);
  status!('SUBSCRIBED');
  assert.equal(subscribed, 1);
  assert.equal(scheduler.pending(), 0);
  assert.equal(session.isSubscribed(), true);
  session.cancel();
});

test('a rejected join is removed and retried after the bounded delay', async () => {
  const scheduler = createScheduler();
  let created = 0;
  let removed = 0;
  let ensured = 0;
  const statuses: Array<(status: string, error?: unknown) => void> = [];

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async () => { ensured += 1; return true; },
    createChannel: onStatus => {
      created += 1;
      statuses.push(onStatus);
      return { id: created, removed: false };
    },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    removeChannel: () => { removed += 1; },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  statuses[0]('CHANNEL_ERROR', new Error('Unauthorized'));
  assert.equal(removed, 1);
  assert.equal(scheduler.pending(), 1);

  scheduler.advance(1_000);
  await tick();
  // العضوية تُعاد التحقق منها قبل المحاولة التالية، والقناة تُنشأ من جديد.
  assert.equal(ensured, 2);
  assert.equal(created, 2);

  statuses[1]('SUBSCRIBED');
  assert.equal(scheduler.pending(), 0);
  session.cancel();
});

test('retries stop after the configured attempts instead of looping', async () => {
  const scheduler = createScheduler();
  let created = 0;
  let unavailable: string | null = null;
  const statuses: Array<(status: string, error?: unknown) => void> = [];

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async () => true,
    createChannel: onStatus => {
      created += 1;
      statuses.push(onStatus);
      return { id: created, removed: false };
    },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    onUnavailable: reason => { unavailable = reason; },
    removeChannel: () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  // المحاولة الأولى + ثلاث إعادات = أربع قنوات كحد أقصى.
  const delays = [1_000, 3_000, 9_000];
  for (const delay of delays) {
    statuses[statuses.length - 1]('TIMED_OUT');
    assert.equal(scheduler.pending(), 1);
    scheduler.advance(delay);
    await tick();
  }
  assert.equal(created, 4);

  statuses[statuses.length - 1]('TIMED_OUT');
  assert.equal(unavailable, 'gave-up');
  assert.equal(scheduler.pending(), 0);
  assert.equal(created, 4);
  session.cancel();
});

test('a deliberate close is not retried', async () => {
  const scheduler = createScheduler();
  let created = 0;
  const statuses: Array<(status: string, error?: unknown) => void> = [];

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async () => true,
    createChannel: onStatus => {
      created += 1;
      statuses.push(onStatus);
      return { id: created, removed: false };
    },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    removeChannel: () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  statuses[0]('CLOSED');
  assert.equal(scheduler.pending(), 0);
  assert.equal(created, 1);
  session.cancel();
});

test('cancelling clears a pending retry and removes the live channel', async () => {
  const scheduler = createScheduler();
  const removed: number[] = [];
  let created = 0;
  const statuses: Array<(status: string, error?: unknown) => void> = [];

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async () => true,
    createChannel: onStatus => {
      created += 1;
      statuses.push(onStatus);
      return { id: created, removed: false };
    },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    removeChannel: channel => { removed.push(channel.id); },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  statuses[0]('CHANNEL_ERROR');
  assert.equal(scheduler.pending(), 1);

  session.cancel();
  assert.equal(scheduler.pending(), 0);
  scheduler.advance(60_000);
  await tick();
  assert.equal(created, 1);
  assert.deepEqual(removed, [1]);
});



test('the membership step receives the session cancellation signal', async () => {
  const scheduler = createScheduler();
  let probe: AbortSignal | null = null;
  let ensured = 0;
  let created = 0;

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: async signal => {
      ensured += 1;
      probe = signal;
      return true;
    },
    createChannel: () => {
      created += 1;
      return { id: created, removed: false };
    },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    removeChannel: () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  assert.equal(ensured, 1);
  assert.equal(created, 1);
  assert.ok(probe, 'the cancellation signal must be handed to the membership step');
  assert.equal(probe!.aborted, false);

  session.cancel();
  // بعد الإلغاء ترى إشارة العضوية أنه أُلغي، فلا يُستأنف أي انتظار لإعادة المحاولة.
  assert.equal(probe!.aborted, true);
});

test('no private channel exists while the membership is still unresolved', async () => {
  const scheduler = createScheduler();
  let created = 0;
  let unavailable: string | null = null;
  let resolveReady: ((ready: boolean) => void) | null = null;

  const session = openMessagesConversationChannel<FakeChannel>({
    ensureMembership: () => new Promise<boolean>(resolve => { resolveReady = resolve; }),
    createChannel: () => {
      created += 1;
      return { id: created, removed: false };
    },
    onSubscribed: () => undefined,
    onNotSubscribed: () => undefined,
    onUnavailable: reason => { unavailable = reason; },
    removeChannel: () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  await tick();
  assert.equal(created, 0);

  resolveReady!(false);
  await tick();
  assert.equal(created, 0);
  assert.equal(unavailable, 'membership');
  session.cancel();
});
