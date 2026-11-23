import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS,
  MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS,
  classifyMessagesMembershipFailure,
  ensureMessagesConversationMembership,
  ensureMessagesMembershipWithRetry,
  isRetryableMessagesConversationChannelStatus,
  messagesConversationMembershipKey,
  nextMessagesConversationChannelRetryDelay,
  resetMessagesConversationMembershipCache,
} from './messagesConversationMembership';

const srcRoot = new URL('..', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(fileURLToPath(new URL(relativePath, srcRoot)));
}

test('the membership key is stable regardless of who opens the conversation', () => {
  const userA = '00000000-0000-0000-0000-00000000000a';
  const userB = '00000000-0000-0000-0000-00000000000b';

  assert.equal(messagesConversationMembershipKey(userA, userB), `${userA}:${userB}`);
  assert.equal(
    messagesConversationMembershipKey(userA, userB),
    messagesConversationMembershipKey(userB, userA),
  );
});

test('channel retries are bounded and never loop forever', () => {
  assert.deepEqual([...MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS], [1_000, 3_000, 9_000]);
  assert.equal(nextMessagesConversationChannelRetryDelay(0), 1_000);
  assert.equal(nextMessagesConversationChannelRetryDelay(1), 3_000);
  assert.equal(nextMessagesConversationChannelRetryDelay(2), 9_000);
  // بعد استنفاد المحاولات: null، لا تأخير جديد.
  assert.equal(nextMessagesConversationChannelRetryDelay(3), null);
  assert.equal(nextMessagesConversationChannelRetryDelay(99), null);
  assert.equal(nextMessagesConversationChannelRetryDelay(-1), null);
});

test('only connection failures are retried, not a deliberate close', () => {
  assert.equal(isRetryableMessagesConversationChannelStatus('CHANNEL_ERROR'), true);
  assert.equal(isRetryableMessagesConversationChannelStatus('TIMED_OUT'), true);
  assert.equal(isRetryableMessagesConversationChannelStatus('CLOSED'), false);
  assert.equal(isRetryableMessagesConversationChannelStatus('SUBSCRIBED'), false);
});

test('the membership RPC reuses the existing message-send rule', () => {
  const migration = read('../supabase/migrations/20270304000000_aani_ensure_message_conversation_membership.sql');

  assert.equal(migration.includes('security definer'), true);
  // idempotent: نفس الزوج يُكتب مرة واحدة
  assert.equal(migration.includes('on conflict (user_a, user_b) do nothing'), true);
  // ترتيب ثابت للطرفين كما في بقية المشروع
  assert.equal(migration.includes('least(caller_id, p_other_user_id)'), true);
  assert.equal(migration.includes('greatest(caller_id, p_other_user_id)'), true);
  // نفس شرط سياسة إرسال الرسائل: لا حظر بين الطرفين
  assert.equal(migration.includes('public.aani_is_user_blocked(caller_id, p_other_user_id)'), true);
  // لا تنفيذ لغير المسجلين
  assert.equal(migration.includes('from public, anon'), true);
  assert.equal(migration.includes('to authenticated'), true);
  // لا تلمس السياسات نفسها
  assert.equal(migration.includes('create policy'), false);
  assert.equal(migration.includes('alter table'), false);
});

test('both the open conversation and the inbox prepare membership first', () => {
  const messagesPage = read('./pages/MessagesPage.tsx');

  // المسار نفسه للقناتين
  const opens = messagesPage.split('openMessagesConversationChannel<').length - 1;
  assert.equal(opens, 2);
  const ensures = messagesPage.split('ensureMessagesConversationMembership(currentUserId,').length - 1;
  assert.equal(ensures, 2);
  // القناة تبقى خاصة ولم تُحوَّل إلى عامة
  assert.equal(messagesPage.split('private: true').length - 1, 2);
  // لا تُحجز إشارة كتابة في طابور الأحداث القديمة
  assert.equal(messagesPage.includes('if (event === MESSAGES_TYPING_EVENT) return;'), true);
  // إعادة إعلان الكتابة بعد الاشتراك بدل إرسال حدث قديم
  assert.equal(messagesPage.includes('typingPublisherRef.current?.isTyping()'), true);
});

test('the retry helper is not wired to an unbounded loop', () => {
  const channel = read('./lib/messagesConversationChannel.ts');
  assert.equal(channel.includes('nextMessagesConversationChannelRetryDelay'), true);
  assert.equal(channel.includes('onUnavailable?.'), true);
  // لا حلقة تكرار بلا حد: المدة تُطلب من الدالة المحدودة لا من ثابت متكرر
  assert.equal(channel.includes('while ('), false);
});

test('the migration file is present for review but not required by the build', () => {
  assert.equal(exists('../supabase/migrations/20270304000000_aani_ensure_message_conversation_membership.sql'), true);
});



// ===== إعادة محاولة تجهيز العضوية =====

const noSleep = async (): Promise<void> => undefined;

test('membership retries are bounded to three extra attempts', () => {
  assert.deepEqual([...MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS], [600, 1_500, 3_500]);
  assert.equal(MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS.length, 3);
});

test('a ready RPC succeeds on the first attempt without sleeping', async () => {
  let calls = 0;
  let slept = 0;

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'ready';
    },
    { sleep: async () => { slept += 1; } },
  );

  assert.equal(ready, true);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('a transient failure is retried and succeeds on the next attempt', async () => {
  const outcomes: Array<'transient' | 'ready'> = ['transient', 'ready'];
  const delays: number[] = [];
  let calls = 0;

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      const outcome = outcomes[calls] ?? 'ready';
      calls += 1;
      return outcome;
    },
    { sleep: async delayMs => { delays.push(delayMs); } },
  );

  assert.equal(ready, true);
  assert.equal(calls, 2);
  // أول تأخير فقط، ثم نجحت المحاولة.
  assert.deepEqual(delays, [600]);
});

test('persistent transient failures stop after the bounded attempts', async () => {
  let calls = 0;
  let gaveUp = 0;
  const delays: number[] = [];

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'transient';
    },
    {
      sleep: async delayMs => { delays.push(delayMs); },
      onGiveUp: () => { gaveUp += 1; },
    },
  );

  assert.equal(ready, false);
  // المحاولة الأولى + ثلاث إعادات.
  assert.equal(calls, 4);
  assert.deepEqual(delays, [600, 1_500, 3_500]);
  assert.equal(gaveUp, 1);
});

test('a permanent failure is never retried', async () => {
  let calls = 0;
  let slept = 0;

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'permanent';
    },
    { sleep: async () => { slept += 1; } },
  );

  assert.equal(ready, false);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('permission, block and missing-RPC errors are classified as permanent', () => {
  // صلاحيات
  assert.equal(classifyMessagesMembershipFailure({ code: '42501', message: 'permission denied' }), 'permanent');
  assert.equal(classifyMessagesMembershipFailure({ code: '42501' }), 'permanent');
  // الدالة غير مثبتة بعد
  assert.equal(classifyMessagesMembershipFailure({ code: '42883' }), 'permanent');
  assert.equal(
    classifyMessagesMembershipFailure({
      code: 'PGRST202',
      message: 'Could not find the public.aani_ensure_message_conversation_member(uuid) function in the schema cache',
    }),
    'permanent',
  );
  // حجب: الدالة ترجع false فيُصنَّف دائم في مسار الاستدعاء، وهنا رسالة الحجب الصريحة.
  assert.equal(classifyMessagesMembershipFailure({ message: 'not authorized' }), 'permanent');
  // جلسة منتهية
  assert.equal(classifyMessagesMembershipFailure({ message: 'JWT expired' }), 'permanent');
});

test('network and gateway failures are classified as transient', () => {
  assert.equal(classifyMessagesMembershipFailure(new TypeError('Failed to fetch')), 'transient');
  assert.equal(classifyMessagesMembershipFailure({ message: 'NetworkError when attempting to fetch resource.' }), 'transient');
  assert.equal(classifyMessagesMembershipFailure({ code: 'PGRST003' }), 'transient');
  assert.equal(classifyMessagesMembershipFailure({ code: 'ETIMEDOUT' }), 'transient');
  assert.equal(classifyMessagesMembershipFailure({ message: 'upstream returned HTTP 503' }), 'transient');
});

test('an unknown failure is treated as permanent instead of being retried', async () => {
  assert.equal(classifyMessagesMembershipFailure({ code: 'XX000' }), 'permanent');

  let calls = 0;
  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return classifyMessagesMembershipFailure({ code: 'XX000' });
    },
    { sleep: noSleep },
  );
  assert.equal(ready, false);
  assert.equal(calls, 1);
});

test('a throwing RPC call is treated as a permanent failure, not an unhandled rejection', async () => {
  let calls = 0;
  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      throw new Error('unexpected');
    },
    { sleep: noSleep },
  );
  assert.equal(ready, false);
  assert.equal(calls, 1);
});

test('concurrent membership requests for one conversation share a single RPC call', async () => {
  const user = '00000000-0000-0000-0000-0000000000d1';
  const contact = '00000000-0000-0000-0000-0000000000d2';
  let calls = 0;
  const call = async (): Promise<'ready'> => {
    calls += 1;
    return 'ready';
  };

  const [first, second] = await Promise.all([
    ensureMessagesConversationMembership(user, contact, { call }),
    ensureMessagesConversationMembership(user, contact, { call }),
  ]);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls, 1);

  // النجاح يُخزَّن، فلا استدعاء ثالث.
  const third = await ensureMessagesConversationMembership(user, contact, { call });
  assert.equal(third, true);
  assert.equal(calls, 1);
});

test('a failed membership is not cached and leaves nothing pending', async () => {
  const user = '00000000-0000-0000-0000-0000000000e1';
  const contact = '00000000-0000-0000-0000-0000000000e2';
  let calls = 0;
  const call = async (): Promise<'permanent'> => {
    calls += 1;
    return 'permanent';
  };

  assert.equal(await ensureMessagesConversationMembership(user, contact, { call }), false);
  assert.equal(calls, 1);

  // inFlight نُظِّف: المحاولة التالية تستدعي RPC من جديد بدل إعادة وعد فاشل.
  assert.equal(await ensureMessagesConversationMembership(user, contact, { call }), false);
  assert.equal(calls, 2);
});

test('membership retries stop as soon as the caller cancels', async () => {
  let calls = 0;
  let cancelled = false;

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'transient';
    },
    {
      isCancelled: () => cancelled,
      sleep: async () => {
        // المستخدم غادر أثناء انتظار المحاولة التالية.
        cancelled = true;
      },
    },
  );

  assert.equal(ready, false);
  assert.equal(calls, 1);
});

test('logging out during a retry wait stops the in-flight attempt', async () => {
  const user = '00000000-0000-0000-0000-0000000000f1';
  const contact = '00000000-0000-0000-0000-0000000000f2';
  let calls = 0;

  const ready = await ensureMessagesConversationMembership(user, contact, {
    call: async () => {
      calls += 1;
      return 'transient';
    },
    sleep: async () => {
      // خروج/تبديل حساب أثناء الانتظار: الجيل يتغيّر فوراً.
      resetMessagesConversationMembershipCache(null);
    },
  });

  assert.equal(ready, false);
  assert.equal(calls, 1);
});

test('a cancelled caller never starts a membership attempt', async () => {
  let calls = 0;
  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'ready';
    },
    { isCancelled: () => true, sleep: noSleep },
  );
  assert.equal(ready, false);
  assert.equal(calls, 0);
});

test('the page forwards its cancellation probe into the membership retries', () => {
  const messagesPage = read('./pages/MessagesPage.tsx');
  // القناتان (الخيط والقائمة) تمرران مسبار الإلغاء نفسه.
  assert.equal(
    messagesPage.split('ensureMessagesConversationMembership(currentUserId,').length - 1,
    2,
  );
  assert.equal(messagesPage.split('{ isCancelled }').length - 1, 2);
});
