import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REALTIME_CHANNEL_HEALTHY_AFTER_MS,
  REALTIME_CHANNEL_RESUBSCRIBE_MAX_DELAY_MS,
  createRealtimeChannelHealthTracker,
  realtimeChannelResubscribeDelay,
} from './realtimeChannelHealth';

test('a subscribed channel asks for neither resync nor resubscription', () => {
  const tracker = createRealtimeChannelHealthTracker();
  assert.deepEqual(tracker.handleStatus('SUBSCRIBED', 1000), { resync: false, resubscribeAfterMs: null });
});

test('a channel error or timeout resyncs and schedules a resubscription', () => {
  const tracker = createRealtimeChannelHealthTracker();
  assert.deepEqual(tracker.handleStatus('CHANNEL_ERROR', 1000), { resync: true, resubscribeAfterMs: 1000 });
  assert.deepEqual(tracker.handleStatus('TIMED_OUT', 2000), { resync: true, resubscribeAfterMs: 2000 });
});

test('a closed channel is treated as dead and must be recreated', () => {
  const tracker = createRealtimeChannelHealthTracker();
  const decision = tracker.handleStatus('CLOSED', 1000);
  assert.equal(decision.resync, true);
  assert.equal(decision.resubscribeAfterMs, 1000);
});

test('the delay grows while the subscription keeps failing and stops at the ceiling', () => {
  const tracker = createRealtimeChannelHealthTracker();
  const delays = [0, 1, 2, 3, 4, 5, 6, 7].map(index => {
    const decision = tracker.handleStatus('CHANNEL_ERROR', 1000 + index);
    assert.notEqual(decision.resubscribeAfterMs, null);
    return decision.resubscribeAfterMs as number;
  });

  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(realtimeChannelResubscribeDelay(50), REALTIME_CHANNEL_RESUBSCRIBE_MAX_DELAY_MS);
});

test('a subscription that stayed healthy resets the backoff before the next failure', () => {
  const tracker = createRealtimeChannelHealthTracker();
  tracker.handleStatus('CHANNEL_ERROR', 1000);
  tracker.handleStatus('CHANNEL_ERROR', 2000);

  // بقيت مشتركة مدة كافية: الاشتراك كان سليماً فعلاً.
  tracker.handleStatus('SUBSCRIBED', 3000);
  const decision = tracker.handleStatus('CLOSED', 3000 + REALTIME_CHANNEL_HEALTHY_AFTER_MS);
  assert.equal(decision.resync, true);
  assert.equal(decision.resubscribeAfterMs, 1000);
});

test('a subscription that fails again immediately keeps escalating', () => {
  const tracker = createRealtimeChannelHealthTracker();
  tracker.handleStatus('SUBSCRIBED', 1000);
  tracker.handleStatus('CLOSED', 1500);
  const decision = tracker.handleStatus('CLOSED', 2500);
  assert.equal(decision.resubscribeAfterMs, 2000);
});

test('an unknown status is treated as an unhealthy subscription', () => {
  const tracker = createRealtimeChannelHealthTracker();
  const decision = tracker.handleStatus('SOMETHING_ELSE', 1000);
  assert.equal(decision.resync, true);
  assert.notEqual(decision.resubscribeAfterMs, null);
});

test('reset clears the backoff', () => {
  const tracker = createRealtimeChannelHealthTracker();
  tracker.handleStatus('CHANNEL_ERROR', 1000);
  tracker.reset();
  assert.equal(tracker.handleStatus('CLOSED', 2000).resubscribeAfterMs, 1000);
});
