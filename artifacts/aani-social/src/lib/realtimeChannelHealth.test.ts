import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REALTIME_CHANNEL_HEALTHY_AFTER_MS,
  REALTIME_CHANNEL_IDS,
  REALTIME_CHANNEL_RESUBSCRIBE_MAX_DELAY_MS,
  createRealtimeChannelSupervisor,
  realtimeChannelResubscribeDelay,
} from './realtimeChannelHealth';

const NO_ACTION = { resync: false, retryAt: null };

test('the first SUBSCRIBED confirmation resyncs once, then stays quiet while healthy', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('inbox');
  assert.deepEqual(supervisor.handleStatus('inbox', token, 'SUBSCRIBED', 1000), {
    resync: true,
    retryAt: null,
  });
  assert.deepEqual(supervisor.handleStatus('inbox', token, 'SUBSCRIBED', 1100), NO_ACTION);
  assert.equal(supervisor.snapshot('inbox').status, 'SUBSCRIBED');
  assert.equal(supervisor.snapshot('inbox').subscribedAt, 1000);
});

test('a recovered subscription confirms readiness and requests a gap-filling resync', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('thread');
  supervisor.handleStatus('thread', token, 'CHANNEL_ERROR', 1000);
  assert.deepEqual(supervisor.handleStatus('thread', token, 'SUBSCRIBED', 1500), {
    resync: true,
    retryAt: null,
  });
  assert.equal(supervisor.snapshot('thread').retryAt, null);
});

test('a channel error or timeout resyncs and schedules a resubscription', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('thread');
  assert.deepEqual(supervisor.handleStatus('thread', token, 'CHANNEL_ERROR', 1000), {
    resync: true,
    retryAt: 2000,
  });
  assert.deepEqual(supervisor.handleStatus('thread', token, 'TIMED_OUT', 2000), {
    resync: true,
    retryAt: 2000,
  });
});

test('a closed channel is treated as dead and must be recreated', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('inbox');
  const decision = supervisor.handleStatus('inbox', token, 'CLOSED', 1000);
  assert.equal(decision.resync, true);
  assert.equal(decision.retryAt, 1000 + realtimeChannelResubscribeDelay(0));
});

test('the delay grows per channel while it keeps failing and stops at the ceiling', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const delays: number[] = [];
  let token = supervisor.beginChannel('inbox');
  let now = 1000;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const decision = supervisor.handleStatus('inbox', token, 'CHANNEL_ERROR', now);
    assert.notEqual(decision.retryAt, null);
    delays.push((decision.retryAt as number) - now);
    now = decision.retryAt as number;
    // إعادة الإنشاء الفعلية تبدأ جيلاً جديداً للقناة.
    supervisor.claimDueChannels(now);
    token = supervisor.beginChannel('inbox');
  }

  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(realtimeChannelResubscribeDelay(50), REALTIME_CHANNEL_RESUBSCRIBE_MAX_DELAY_MS);
});

test('a subscription that stayed healthy resets the backoff before the next failure', () => {
  const supervisor = createRealtimeChannelSupervisor();
  let token = supervisor.beginChannel('thread');
  supervisor.handleStatus('thread', token, 'CHANNEL_ERROR', 1000);
  supervisor.handleStatus('thread', token, 'CHANNEL_ERROR', 2000);

  // بقيت مشتركة مدة كافية بعد إعادة الإنشاء: الاشتراك كان سليماً فعلاً.
  supervisor.claimDueChannels(3000);
  token = supervisor.beginChannel('thread');
  supervisor.handleStatus('thread', token, 'SUBSCRIBED', 4000);

  const decision = supervisor.handleStatus('thread', token, 'CLOSED', 4000 + REALTIME_CHANNEL_HEALTHY_AFTER_MS);
  assert.equal(decision.retryAt, 4000 + REALTIME_CHANNEL_HEALTHY_AFTER_MS + 1000);
});

test('a subscription that fails again immediately keeps escalating', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('thread');
  supervisor.handleStatus('thread', token, 'SUBSCRIBED', 1000);
  const first = supervisor.handleStatus('thread', token, 'CLOSED', 1500);
  assert.equal(first.retryAt, 2500);

  supervisor.claimDueChannels(2500);
  const secondToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('thread', secondToken, 'SUBSCRIBED', 2600);
  const second = supervisor.handleStatus('thread', secondToken, 'CLOSED', 2700);
  assert.equal(second.retryAt, 2700 + 2000);
});

test('an unknown status is treated as an unhealthy subscription', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('inbox');
  const decision = supervisor.handleStatus('inbox', token, 'SOMETHING_ELSE', 1000);
  assert.equal(decision.resync, true);
  assert.notEqual(decision.retryAt, null);
  assert.equal(supervisor.snapshot('inbox').status, 'CHANNEL_ERROR');
});

test('inbox failure is not cancelled by the thread channel subscribing', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('inbox', inboxToken, 'SUBSCRIBED', 0);
  supervisor.handleStatus('thread', threadToken, 'SUBSCRIBED', 0);

  const inboxDecision = supervisor.handleStatus('inbox', inboxToken, 'CHANNEL_ERROR', 1000);
  assert.deepEqual(inboxDecision, { resync: true, retryAt: 2000 });

  // نجاح القناة الأخرى (حتى لو تكرر) لا يمس محاولة إصلاح هذه القناة.
  assert.deepEqual(supervisor.handleStatus('thread', threadToken, 'SUBSCRIBED', 1100), NO_ACTION);
  assert.equal(supervisor.snapshot('inbox').retryAt, 2000);
  assert.equal(supervisor.snapshot('thread').retryAt, null);

  assert.deepEqual(supervisor.claimDueChannels(1999), []);
  assert.deepEqual(supervisor.claimDueChannels(2000), ['inbox']);
});

test('thread failure is not cancelled by the inbox channel subscribing', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('inbox', inboxToken, 'SUBSCRIBED', 0);

  const threadDecision = supervisor.handleStatus('thread', threadToken, 'TIMED_OUT', 1000);
  assert.deepEqual(threadDecision, { resync: true, retryAt: 2000 });

  assert.deepEqual(supervisor.handleStatus('inbox', inboxToken, 'SUBSCRIBED', 1200), NO_ACTION);
  assert.equal(supervisor.snapshot('thread').retryAt, 2000);
  assert.equal(supervisor.snapshot('inbox').retryAt, null);
});

test('simultaneous failures schedule a single recreation with no duplicate channels', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');

  supervisor.handleStatus('inbox', inboxToken, 'CHANNEL_ERROR', 1000);
  const threadDecision = supervisor.handleStatus('thread', threadToken, 'CHANNEL_ERROR', 1000);

  // إشارتان متزامنتان: محاولة لكل قناة، لكن وقت واحد.
  assert.equal(supervisor.snapshot('inbox').retryAt, 2000);
  assert.equal(threadDecision.retryAt, 2000);
  assert.equal(supervisor.earliestRetryAt(), 2000);

  // لا محاولة ثانية عند وصول إشارة أخرى في أثناء الانتظار.
  const repeated = supervisor.handleStatus('thread', threadToken, 'CLOSED', 1500);
  assert.equal(repeated.retryAt, 2000);
  assert.equal(supervisor.snapshot('thread').failureCount, 1);

  assert.deepEqual(supervisor.claimDueChannels(1999), []);
  assert.deepEqual(supervisor.claimDueChannels(2000), ['inbox', 'thread']);
  // بعد الاستحقاق لا تبقى مؤقتات، فلا إعادة إنشاء ثانية.
  assert.deepEqual(supervisor.claimDueChannels(2000), []);
  assert.equal(supervisor.earliestRetryAt(), null);
});

test('channels keep independent backoff counters', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const firstInbox = supervisor.beginChannel('inbox');
  supervisor.handleStatus('inbox', firstInbox, 'CHANNEL_ERROR', 0);
  supervisor.claimDueChannels(1000);
  const secondInbox = supervisor.beginChannel('inbox');
  // المحاولة الثانية للقائمة: تأخير ٢٠٠٠ بدل ١٠٠٠.
  assert.equal(supervisor.handleStatus('inbox', secondInbox, 'CHANNEL_ERROR', 1000).retryAt, 3000);

  const threadToken = supervisor.beginChannel('thread');
  // القناة الأخرى ما زالت في محاولتها الأولى: تأخير ١٠٠٠.
  assert.equal(supervisor.handleStatus('thread', threadToken, 'CHANNEL_ERROR', 1000).retryAt, 2000);

  assert.equal(supervisor.earliestRetryAt(), 2000);
});

test('a channel that recovers by itself does not force a recreation', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('inbox', inboxToken, 'CHANNEL_ERROR', 1000);
  supervisor.handleStatus('thread', threadToken, 'CHANNEL_ERROR', 1000);

  // القناتان عادتا للاشتراك قبل انتهاء مؤقت التعافي.
  supervisor.handleStatus('inbox', inboxToken, 'SUBSCRIBED', 1500);
  supervisor.handleStatus('thread', threadToken, 'SUBSCRIBED', 1500);

  assert.deepEqual(supervisor.claimDueChannels(2000), []);
  assert.equal(supervisor.earliestRetryAt(), null);
});

test('a channel that recovered alone still lets the other one be recreated', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('inbox', inboxToken, 'CHANNEL_ERROR', 1000);
  supervisor.handleStatus('thread', threadToken, 'CHANNEL_ERROR', 1000);

  supervisor.handleStatus('inbox', inboxToken, 'SUBSCRIBED', 1500);
  assert.deepEqual(supervisor.claimDueChannels(2000), ['thread']);
});

test('an intentional close is not treated as a failure', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('inbox');
  supervisor.handleStatus('inbox', token, 'SUBSCRIBED', 1000);
  supervisor.markIntentionalClose('inbox', token);

  assert.deepEqual(supervisor.handleStatus('inbox', token, 'CLOSED', 1100), NO_ACTION);
  assert.equal(supervisor.snapshot('inbox').retryAt, null);
  assert.equal(supervisor.snapshot('inbox').intentionalClose, true);
  assert.deepEqual(supervisor.claimDueChannels(999999), []);
});

test('a late callback from a replaced channel is ignored', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const oldToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('thread', oldToken, 'CHANNEL_ERROR', 1000);
  assert.equal(supervisor.snapshot('thread').retryAt, 2000);

  // إعادة إنشاء: جيل جديد يلغي محاولة الجيل السابق.
  supervisor.claimDueChannels(2000);
  const newToken = supervisor.beginChannel('thread');
  assert.equal(supervisor.snapshot('thread').recreating, false);

  assert.deepEqual(supervisor.handleStatus('thread', oldToken, 'CLOSED', 2100), NO_ACTION);
  assert.equal(supervisor.snapshot('thread').retryAt, null);
  assert.equal(supervisor.snapshot('thread').token, newToken);
});

test('claiming due channels marks them as being recreated', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('inbox', inboxToken, 'CHANNEL_ERROR', 1000);
  supervisor.handleStatus('thread', threadToken, 'CHANNEL_ERROR', 1000);

  supervisor.claimDueChannels(2000);
  assert.equal(supervisor.snapshot('inbox').recreating, true);
  assert.equal(supervisor.snapshot('thread').recreating, true);

  supervisor.beginChannel('inbox');
  assert.equal(supervisor.snapshot('inbox').recreating, false);
  assert.equal(supervisor.snapshot('inbox').status, 'IDLE');
});

test('ensureHealthy reschedules only channels that are not subscribed', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  const threadToken = supervisor.beginChannel('thread');
  supervisor.handleStatus('inbox', inboxToken, 'SUBSCRIBED', 1000);
  supervisor.handleStatus('thread', threadToken, 'SUBSCRIBED', 1000);

  // عودة الـWebSocket وحدها: القناتان مشتركتان فعلاً.
  assert.deepEqual(supervisor.ensureHealthy('inbox', 5000), NO_ACTION);
  assert.deepEqual(supervisor.ensureHealthy('thread', 5000), NO_ACTION);
  assert.equal(supervisor.earliestRetryAt(), null);

  // قناة انقطعت فعلاً: تُجدوَل من جديد.
  supervisor.handleStatus('thread', threadToken, 'CLOSED', 6000);
  supervisor.claimDueChannels(7000);
  const decision = supervisor.ensureHealthy('thread', 8000);
  assert.equal(decision.resync, true);
  assert.equal(decision.retryAt, 8000 + 2000);
});

test('reset clears both channels', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const inboxToken = supervisor.beginChannel('inbox');
  supervisor.handleStatus('inbox', inboxToken, 'CHANNEL_ERROR', 1000);
  supervisor.reset();

  assert.equal(supervisor.snapshot('inbox').status, 'IDLE');
  assert.equal(supervisor.snapshot('inbox').retryAt, null);
  assert.equal(supervisor.snapshot('thread').retryAt, null);
  assert.equal(supervisor.earliestRetryAt(), null);
});


test('the unread badge channel registers SUBSCRIBED and resyncs exactly once', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('unread');

  assert.deepEqual(supervisor.handleStatus('unread', token, 'SUBSCRIBED', 1000), {
    resync: true,
    retryAt: null,
  });
  assert.equal(supervisor.snapshot('unread').status, 'SUBSCRIBED');
  assert.deepEqual(supervisor.handleStatus('unread', token, 'SUBSCRIBED', 1200), NO_ACTION);
});

test('an unread channel failure schedules one delayed recreation and a recreated channel is fresh', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const firstToken = supervisor.beginChannel('unread');

  assert.deepEqual(supervisor.handleStatus('unread', firstToken, 'CHANNEL_ERROR', 1000), {
    resync: true,
    retryAt: 2000,
  });
  // إشارة ثانية أثناء الانتظار لا تُجدول محاولة أخرى.
  assert.deepEqual(supervisor.handleStatus('unread', firstToken, 'CLOSED', 1500), {
    resync: true,
    retryAt: 2000,
  });
  assert.equal(supervisor.snapshot('unread').failureCount, 1);
  assert.equal(supervisor.earliestRetryAt(), 2000);

  assert.deepEqual(supervisor.claimDueChannels(2000), ['unread']);
  const secondToken = supervisor.beginChannel('unread');
  assert.notEqual(secondToken, firstToken);
  assert.equal(supervisor.snapshot('unread').status, 'IDLE');
  assert.equal(supervisor.snapshot('unread').recreating, false);

  // القناة الجديدة تعود للاشتراك: مزامنة تعويضية واحدة لسد فجوة الانقطاع.
  assert.deepEqual(supervisor.handleStatus('unread', secondToken, 'SUBSCRIBED', 2100), {
    resync: true,
    retryAt: null,
  });
});

test('a closed unread channel is recreated as a new channel, not just reconnected', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('unread');
  supervisor.handleStatus('unread', token, 'SUBSCRIBED', 500);

  const decision = supervisor.handleStatus('unread', token, 'CLOSED', 900);
  assert.notEqual(decision.retryAt, null);
  assert.equal(decision.retryAt, 900 + realtimeChannelResubscribeDelay(supervisor.snapshot('unread').failureCount - 1));
  assert.deepEqual(supervisor.claimDueChannels(decision.retryAt as number), ['unread']);

  const recreated = supervisor.beginChannel('unread');
  assert.notEqual(recreated, token);
  assert.equal(supervisor.snapshot('unread').intentionalClose, false);
});

test('a late callback from the previous unread channel generation is ignored', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const oldToken = supervisor.beginChannel('unread');
  supervisor.handleStatus('unread', oldToken, 'CHANNEL_ERROR', 1000);
  supervisor.claimDueChannels(2000);

  const newToken = supervisor.beginChannel('unread');
  assert.deepEqual(supervisor.handleStatus('unread', oldToken, 'CLOSED', 2100), NO_ACTION);
  assert.equal(supervisor.snapshot('unread').retryAt, null);
  assert.equal(supervisor.snapshot('unread').token, newToken);
});

test('an intentional unread close is not rescheduled', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('unread');
  supervisor.handleStatus('unread', token, 'SUBSCRIBED', 1000);
  supervisor.markIntentionalClose('unread', token);

  assert.deepEqual(supervisor.handleStatus('unread', token, 'CLOSED', 1100), NO_ACTION);
  assert.equal(supervisor.snapshot('unread').retryAt, null);
  assert.deepEqual(supervisor.claimDueChannels(999999), []);
});

test('reset clears the unread channel too', () => {
  const supervisor = createRealtimeChannelSupervisor();
  const token = supervisor.beginChannel('unread');
  supervisor.handleStatus('unread', token, 'CHANNEL_ERROR', 1000);
  supervisor.reset();

  assert.equal(supervisor.snapshot('unread').status, 'IDLE');
  assert.equal(supervisor.snapshot('unread').retryAt, null);
  assert.equal(supervisor.earliestRetryAt(), null);
});

test('the shared MessagesPage channel list stays inbox and thread only', () => {
  assert.deepEqual([...REALTIME_CHANNEL_IDS], ['inbox', 'thread']);
});
