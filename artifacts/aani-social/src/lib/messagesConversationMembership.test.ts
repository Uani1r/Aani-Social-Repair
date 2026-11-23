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
  type MessagesMembershipOutcome,
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

const userKey = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;

test('membership retries are bounded to three extra attempts', () => {
  assert.deepEqual([...MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS], [600, 1_500, 3_500]);
  assert.equal(MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS.length, 3);
});

test('a ready RPC succeeds on the first attempt', async () => {
  let calls = 0;

  const ready = await ensureMessagesMembershipWithRetry(async () => {
    calls += 1;
    return 'ready';
  });

  assert.equal(ready, true);
  assert.equal(calls, 1);
});

test('a transient failure is retried and succeeds on the next attempt', async () => {
  const outcomes: Array<'transient' | 'ready'> = ['transient', 'ready'];
  let calls = 0;

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      const outcome = outcomes[calls] ?? 'ready';
      calls += 1;
      return outcome;
    },
    { retryDelaysMs: [1] },
  );

  assert.equal(ready, true);
  assert.equal(calls, 2);
});

test('persistent transient failures stop after the bounded attempts', async () => {
  let calls = 0;
  let gaveUp = 0;

  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'transient';
    },
    { retryDelaysMs: [1, 1, 1], onGiveUp: () => { gaveUp += 1; } },
  );

  assert.equal(ready, false);
  // المحاولة الأولى + ثلاث إعادات.
  assert.equal(calls, 4);
  assert.equal(gaveUp, 1);
});

test('a permanent failure is never retried', async () => {
  let calls = 0;

  const ready = await ensureMessagesMembershipWithRetry(async () => {
    calls += 1;
    return 'permanent';
  });

  assert.equal(ready, false);
  assert.equal(calls, 1);
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
  const ready = await ensureMessagesMembershipWithRetry(async () => {
    calls += 1;
    return classifyMessagesMembershipFailure({ code: 'XX000' });
  });
  assert.equal(ready, false);
  assert.equal(calls, 1);
});

test('a throwing RPC call is treated as a permanent failure, not an unhandled rejection', async () => {
  let calls = 0;
  const ready = await ensureMessagesMembershipWithRetry(async () => {
    calls += 1;
    throw new Error('unexpected');
  });
  assert.equal(ready, false);
  assert.equal(calls, 1);
});

test('concurrent membership requests for one conversation share a single RPC call', async () => {
  const user = userKey('d1');
  const contact = userKey('d2');
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
  const user = userKey('e1');
  const contact = userKey('e2');
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

test('an already-cancelled caller never starts a membership attempt', async () => {
  const controller = new AbortController();
  controller.abort();

  let calls = 0;
  const ready = await ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'ready';
    },
    { signal: controller.signal },
  );

  assert.equal(ready, false);
  assert.equal(calls, 0);
});

test('a pending retry wait is aborted immediately, not after the delay', async () => {
  const controller = new AbortController();
  let calls = 0;
  const startedAt = Date.now();

  const pending = ensureMessagesMembershipWithRetry(
    async () => {
      calls += 1;
      return 'transient';
    },
    { signal: controller.signal, retryDelaysMs: [60_000] },
  );
  setTimeout(() => controller.abort(), 5);

  assert.equal(await pending, false);
  assert.equal(calls, 1);
  // التأخير المُهيَّأ دقيقة كاملة: العودة السريعة تعني أن الانتظار قُطع فعلاً.
  assert.ok(Date.now() - startedAt < 2_000, 'the retry wait must resolve on abort');
});

test('cancelling during the RPC resolves at once and ignores the late result', async () => {
  const controller = new AbortController();
  let settle: ((outcome: MessagesMembershipOutcome) => void) | null = null;
  let calls = 0;

  const pending = ensureMessagesMembershipWithRetry(
    () => new Promise<MessagesMembershipOutcome>(resolve => {
      calls += 1;
      settle = resolve;
    }),
    { signal: controller.signal },
  );

  // ننتظر حتى يبدأ RPC فعلاً ثم نلغي.
  await Promise.resolve();
  controller.abort();

  assert.equal(await pending, false);
  assert.equal(calls, 1);

  // وصول النتيجة المتأخرة لا يغيّر أي شيء.
  settle!('ready');
  await Promise.resolve();
  assert.equal(calls, 1);
});

test('a cancelled request is never cached for the next session', async () => {
  const user = userKey('b1');
  const contact = userKey('b2');
  let settleOld: ((outcome: MessagesMembershipOutcome) => void) | null = null;
  let oldCalls = 0;

  const old = ensureMessagesConversationMembership(user, contact, {
    call: () => new Promise<MessagesMembershipOutcome>(resolve => {
      oldCalls += 1;
      settleOld = resolve;
    }),
  });

  // تسجيل الخروج أثناء RPC الجاري.
  resetMessagesConversationMembershipCache(null);
  assert.equal(await old, false);

  // النتيجة القديمة تصل بعد الخروج: يجب ألا تُحفظ عضوية لها.
  settleOld!('ready');
  await Promise.resolve();

  // عودة المستخدم: RPC جديدة تُستدعى فعلاً (لو خُزِّنت القديمة لما استُدعيت).
  let freshCalls = 0;
  const fresh = await ensureMessagesConversationMembership(user, contact, {
    call: async () => {
      freshCalls += 1;
      return 'permanent';
    },
  });

  assert.equal(fresh, false);
  assert.equal(freshCalls, 1);
  assert.equal(oldCalls, 1);
});

test('reopening the conversation before the old RPC finishes starts a new request', async () => {
  const user = userKey('c1');
  const contact = userKey('c2');
  const firstSession = new AbortController();
  let settleOld: ((outcome: MessagesMembershipOutcome) => void) | null = null;
  let oldCalls = 0;

  const old = ensureMessagesConversationMembership(user, contact, {
    signal: firstSession.signal,
    call: () => new Promise<MessagesMembershipOutcome>(resolve => {
      oldCalls += 1;
      settleOld = resolve;
    }),
  });

  // إغلاق المحادثة (إلغاء الجلسة) ثم فتحها فوراً من جديد.
  firstSession.abort();
  assert.equal(await old, false);

  let newCalls = 0;
  const reopened = await ensureMessagesConversationMembership(user, contact, {
    call: async () => {
      newCalls += 1;
      return 'ready';
    },
  });

  assert.equal(reopened, true);
  // طلب جديد تماماً، لا إعادة استخدام لوعد مرتبط بالإشارة القديمة.
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);

  // النتيجة القديمة المتأخرة لا تمسّ العضوية المخزّنة من الجلسة الجديدة.
  settleOld!('ready');
  await Promise.resolve();

  let afterCalls = 0;
  const after = await ensureMessagesConversationMembership(user, contact, {
    call: async () => {
      afterCalls += 1;
      return 'permanent';
    },
  });
  assert.equal(after, true);
  assert.equal(afterCalls, 0);
});

test('logging out during a retry wait stops the in-flight attempt', async () => {
  const user = userKey('f1');
  const contact = userKey('f2');
  let calls = 0;

  const ready = ensureMessagesConversationMembership(user, contact, {
    call: async () => {
      calls += 1;
      return 'transient';
    },
    retryDelaysMs: [60_000],
  });

  // خروج/تبديل حساب أثناء الانتظار: الجيل يتغيّر فيُقطع الانتظار فوراً.
  setTimeout(() => resetMessagesConversationMembershipCache(null), 5);

  assert.equal(await ready, false);
  assert.equal(calls, 1);
});

test('the page forwards its cancellation signal into the membership retries', () => {
  const messagesPage = read('./pages/MessagesPage.tsx');
  // القناتان (الخيط والقائمة) تمرران إشارة الإلغاء نفسها.
  assert.equal(
    messagesPage.split('ensureMessagesConversationMembership(currentUserId,').length - 1,
    2,
  );
  assert.equal(messagesPage.split('{ signal }').length - 1, 2);
});

test('the auth lifecycle resets the membership cache on sign-out and account switch', () => {
  const appSession = read('./hooks/useAppSession.ts');
  assert.equal(appSession.includes('resetMessagesConversationMembershipCache'), true);
  // قبل تطبيق الجلسة الجديدة، وقبل مسح الجلسة عند الخروج.
  assert.equal(
    appSession.split('syncMembershipOwner(').length - 1 >= 4,
    true,
  );
});
