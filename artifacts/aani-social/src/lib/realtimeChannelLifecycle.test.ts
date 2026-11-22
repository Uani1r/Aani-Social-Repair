import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessagesRealtimeEventHub, messagesRealtimeEventFromPayload } from './messagesRealtimeEvents';
import {
  createRealtimeChannelLifecycle,
  createRealtimeChannelSupervisor,
} from './realtimeChannelHealth';

/**
 * مؤقتات وهمية: تُنفَّذ يدوياً حتى نثبت الإلغاء وإعادة الإنشاء المؤجلة دون
 * انتظار حقيقي.
 */
function createTimerHarness(start = 1000) {
  let now = start;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();

  return {
    now: () => now,
    setTimer: (handler: () => void, timeout: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: now + timeout, handler });
      return handle;
    },
    clearTimer: (handle: number) => {
      timers.delete(handle);
    },
    advanceTo(target: number) {
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;

        const [handle, timer] = due[0];
        timers.delete(handle);
        now = timer.at;
        timer.handler();
      }
      now = target;
    },
    pendingCount: () => timers.size,
  };
}

function createUnreadLifecycleHarness(options: { onStatusError?: (status: string, error: unknown) => void } = {}) {
  const supervisor = createRealtimeChannelSupervisor();
  const timers = createTimerHarness();
  const state = { resyncs: 0, recreations: 0 };

  const lifecycle = createRealtimeChannelLifecycle({
    id: 'unread',
    supervisor,
    onResync: () => { state.resyncs += 1; },
    onRecreate: () => { state.recreations += 1; },
    onStatusError: options.onStatusError,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  return { supervisor, timers, state, lifecycle };
}

test('a successful unread subscription resyncs once and a failure never resyncs', () => {
  const { supervisor, timers, state, lifecycle } = createUnreadLifecycleHarness();
  const token = lifecycle.begin();

  lifecycle.handleStatus(token, 'CHANNEL_ERROR', new Error('channel failed'));
  // فشل الاشتراك لا يُطلق مزامنة تعويضية؛ الرسائل لم تصل.
  assert.equal(state.resyncs, 0);
  assert.equal(supervisor.snapshot('unread').retryAt, 2000);

  timers.advanceTo(2000);
  assert.equal(state.recreations, 1);
  assert.equal(state.resyncs, 0);

  const newToken = lifecycle.begin();
  assert.notEqual(newToken, token);
  lifecycle.handleStatus(newToken, 'SUBSCRIBED');
  assert.equal(state.resyncs, 1);

  // تكرار SUBSCRIBED أثناء الاشتراك السليم لا يكرر المزامنة.
  lifecycle.handleStatus(newToken, 'SUBSCRIBED');
  assert.equal(state.resyncs, 1);
});

test('a failure logs its status and schedules one delayed recreation', () => {
  const logged: Array<[string, unknown]> = [];
  const { timers, state, lifecycle } = createUnreadLifecycleHarness({
    onStatusError: (status, error) => logged.push([status, error]),
  });
  const token = lifecycle.begin();
  const error = new Error('timed out');
  lifecycle.handleStatus(token, 'TIMED_OUT', error);

  assert.deepEqual(logged, [['TIMED_OUT', error]]);
  assert.equal(lifecycle.pendingRetryAt(), 2000);
  assert.equal(timers.pendingCount(), 1);

  // إشارة ثانية متزامنة لا تضيف مؤقتاً ثانياً ولا إعادة إنشاء ثانية.
  lifecycle.handleStatus(token, 'CLOSED');
  assert.equal(timers.pendingCount(), 1);
  timers.advanceTo(10_000);
  assert.equal(state.recreations, 1);
});

test('a channel that recovers by itself cancels the pending recreate timer', () => {
  const { timers, state, lifecycle } = createUnreadLifecycleHarness();
  const token = lifecycle.begin();

  lifecycle.handleStatus(token, 'CHANNEL_ERROR');
  assert.equal(timers.pendingCount(), 1);

  lifecycle.handleStatus(token, 'SUBSCRIBED');
  assert.equal(timers.pendingCount(), 0);
  assert.equal(state.resyncs, 1);

  timers.advanceTo(10_000);
  assert.equal(state.recreations, 0);
});

test('a stale callback from a previous generation cannot resync the new channel', () => {
  const { timers, state, lifecycle } = createUnreadLifecycleHarness();
  const oldToken = lifecycle.begin();
  lifecycle.handleStatus(oldToken, 'CHANNEL_ERROR');
  timers.advanceTo(2000);

  const newToken = lifecycle.begin();
  const staleDecision = lifecycle.handleStatus(oldToken, 'SUBSCRIBED');
  assert.equal(staleDecision.resync, false);
  assert.equal(state.resyncs, 0);

  lifecycle.handleStatus(newToken, 'SUBSCRIBED');
  assert.equal(state.resyncs, 1);
});

test('cleaning up cancels the pending timer and prevents recreation after leaving Shell', () => {
  const { timers, state, lifecycle } = createUnreadLifecycleHarness();
  const token = lifecycle.begin();
  lifecycle.handleStatus(token, 'CHANNEL_ERROR');
  assert.equal(timers.pendingCount(), 1);

  lifecycle.finish(token);
  assert.equal(timers.pendingCount(), 0);
  assert.equal(lifecycle.pendingRetryAt(), null);

  timers.advanceTo(100_000);
  assert.equal(state.recreations, 0);

  // نداء متأخر من القناة القديمة بعد التنظيف لا يعيد الجدولة ولا يزامن.
  const late = lifecycle.handleStatus(token, 'SUBSCRIBED');
  assert.equal(late.resync, false);
  assert.equal(late.retryAt, null);
  assert.equal(state.resyncs, 0);
  assert.equal(timers.pendingCount(), 0);
});

test('ensureHealthy after a reconnect reuses the pending retry without duplicating timers', () => {
  const { timers, lifecycle } = createUnreadLifecycleHarness();
  const token = lifecycle.begin();
  lifecycle.handleStatus(token, 'CLOSED');

  const pending = lifecycle.pendingRetryAt();
  assert.notEqual(pending, null);

  const decision = lifecycle.ensureHealthy();
  assert.equal(decision.retryAt, pending);
  assert.equal(timers.pendingCount(), 1);
});

test('INSERT, UPDATE and DELETE events still reach the internal messages bus', () => {
  const hub = createMessagesRealtimeEventHub();
  const seen: Array<{ type: string; id: string | null }> = [];
  const unsubscribe = hub.subscribe(event => seen.push({ type: event.type, id: event.messageId }));

  // نفس نداءات معالج قناة الشارة في Shell، دون تغيير.
  hub.publish(messagesRealtimeEventFromPayload('INSERT', { new: { id: 'm1' } }));
  hub.publish(messagesRealtimeEventFromPayload('UPDATE', { new: { id: 'm1' } }));
  hub.publish(messagesRealtimeEventFromPayload('DELETE', { old: { id: 'm1' } }));

  unsubscribe();

  assert.deepEqual(seen, [
    { type: 'INSERT', id: 'm1' },
    { type: 'UPDATE', id: 'm1' },
    { type: 'DELETE', id: 'm1' },
  ]);
});
