import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MESSAGES_TYPING_EVENT,
  MESSAGES_TYPING_HEARTBEAT_MS,
  MESSAGES_TYPING_IDLE_MS,
  MESSAGES_TYPING_TTL_MS,
  createTypingContactsTracker,
  createTypingPublisher,
  normalizeTypingBroadcast,
  typingConversationIdsKey,
  typingEventMatchesConversation,
} from './messagesTypingIndicator';

const userA = '00000000-0000-0000-0000-00000000000a';
const userB = '00000000-0000-0000-0000-00000000000b';
const userC = '00000000-0000-0000-0000-00000000000c';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

// مؤقت وهمي: الاستدعاءات المجدولة تُخزَّن، وتُنفَّذ يدوياً مع تقدّم الزمن.
function createFakeClock() {
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
    pendingCount(): number {
      return timers.size;
    },
    advance(ms: number): void {
      now += ms;
      // تنفيذ المؤقتات المستحقة بترتيب زمنها.
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

function createRecordingPublisher() {
  const clock = createFakeClock();
  const sent: boolean[] = [];
  const publisher = createTypingPublisher({
    send: isTyping => sent.push(isTyping),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, sent, publisher };
}

test('typing start is sent once, then heartbeats are rate limited', () => {
  const { clock, sent, publisher } = createRecordingPublisher();

  publisher.notifyTyping();
  assert.deepEqual(sent, [true]);

  // ضغطات متتالية داخل نافذة الإبقاء لا تُرسل شيئاً إضافياً.
  for (let i = 0; i < 20; i += 1) {
    clock.advance(50);
    publisher.notifyTyping();
  }
  assert.deepEqual(sent, [true]);
});

test('a heartbeat is sent only after the rate-limit window', () => {
  const { clock, sent, publisher } = createRecordingPublisher();

  publisher.notifyTyping();
  clock.advance(MESSAGES_TYPING_HEARTBEAT_MS - 100);
  publisher.notifyTyping();
  assert.deepEqual(sent, [true]);

  clock.advance(100);
  publisher.notifyTyping();
  assert.deepEqual(sent, [true, true]);
});

test('typing stops once the user is idle, and the stop is sent exactly once', () => {
  const { clock, sent, publisher } = createRecordingPublisher();

  publisher.notifyTyping();
  clock.advance(MESSAGES_TYPING_IDLE_MS - 1);
  assert.deepEqual(sent, [true]);

  clock.advance(1);
  assert.deepEqual(sent, [true, false]);
  assert.equal(publisher.isTyping(), false);

  // لا إيقاف مكرراً بعد إيقاف سابق.
  clock.advance(MESSAGES_TYPING_IDLE_MS * 2);
  assert.deepEqual(sent, [true, false]);
});

test('continued typing keeps the indicator alive without ever stopping', () => {
  const { clock, sent, publisher } = createRecordingPublisher();

  publisher.notifyTyping();
  for (let i = 0; i < 6; i += 1) {
    clock.advance(MESSAGES_TYPING_IDLE_MS - 500);
    publisher.notifyTyping();
  }
  assert.equal(sent.includes(false), false);
  assert.equal(sent[0], true);
});

test('stop after typing sends a single stop, and stop before typing sends nothing', () => {
  const idle = createRecordingPublisher();
  idle.publisher.stop();
  assert.deepEqual(idle.sent, []);

  const typing = createRecordingPublisher();
  typing.publisher.notifyTyping();
  typing.publisher.stop();
  typing.publisher.stop();
  assert.deepEqual(typing.sent, [true, false]);
  assert.equal(typing.clock.pendingCount(), 0);
});

test('stop cancels the pending idle timer so no late stop is sent', () => {
  const { clock, sent, publisher } = createRecordingPublisher();

  publisher.notifyTyping();
  publisher.stop();
  clock.advance(MESSAGES_TYPING_IDLE_MS * 3);
  assert.deepEqual(sent, [true, false]);
  assert.equal(clock.pendingCount(), 0);
});

test('a new typing session after stop starts again with a single start', () => {
  const { clock, sent, publisher } = createRecordingPublisher();

  publisher.notifyTyping();
  publisher.stop();
  clock.advance(MESSAGES_TYPING_HEARTBEAT_MS + 1);
  publisher.notifyTyping();
  assert.deepEqual(sent, [true, false, true]);
});

test('the typing payload normalizes to userId and isTyping only', () => {
  assert.deepEqual(
    normalizeTypingBroadcast({ userId: userA, isTyping: true, content: 'secret text' }),
    { userId: userA, isTyping: true },
  );
  assert.deepEqual(normalizeTypingBroadcast({ userId: userA, isTyping: false }), { userId: userA, isTyping: false });
});

test('malformed typing payloads are rejected', () => {
  assert.equal(normalizeTypingBroadcast(null), null);
  assert.equal(normalizeTypingBroadcast('typing'), null);
  assert.equal(normalizeTypingBroadcast({ isTyping: true }), null);
  assert.equal(normalizeTypingBroadcast({ userId: '', isTyping: true }), null);
  assert.equal(normalizeTypingBroadcast({ userId: userA }), null);
  assert.equal(normalizeTypingBroadcast({ userId: userA, isTyping: 'yes' }), null);
  assert.equal(normalizeTypingBroadcast({ userId: 7, isTyping: true }), null);
});

test('typing shows only for the other participant of the open conversation', () => {
  const fromB = normalizeTypingBroadcast({ userId: userB, isTyping: true });
  assert.ok(fromB);

  // الطرف الآخر في المحادثة المفتوحة فقط.
  assert.equal(typingEventMatchesConversation(fromB, userA, userB), true);

  // لا يظهر مؤشر المستخدم نفسه أبداً.
  const own = normalizeTypingBroadcast({ userId: userA, isTyping: true });
  assert.ok(own);
  assert.equal(typingEventMatchesConversation(own, userA, userA), false);
  assert.equal(typingEventMatchesConversation(own, userA, userB), false);

  // مستخدم من محادثة أخرى، أو لا توجد محادثة مفتوحة: مرفوض.
  assert.equal(typingEventMatchesConversation(fromB, userA, userC), false);
  assert.equal(typingEventMatchesConversation(fromB, userA, null), false);
  assert.equal(typingEventMatchesConversation(fromB, userA, undefined), false);
});

test('the typing event name and the TTL keep the indicator bounded', () => {
  assert.equal(MESSAGES_TYPING_EVENT, 'typing');
  // المؤشر المعروض يختفي بعد مهلة أطول من فترة الإبقاء، فلا يبقى عالقاً إن انقطعت الإشارة.
  assert.ok(MESSAGES_TYPING_TTL_MS > MESSAGES_TYPING_HEARTBEAT_MS);
  assert.ok(MESSAGES_TYPING_TTL_MS > MESSAGES_TYPING_IDLE_MS - MESSAGES_TYPING_HEARTBEAT_MS);
});

test('the page wires typing to the composer, send, and channel lifecycle', () => {
  const messagesPage = readSource('../pages/MessagesPage.tsx');

  // الكتابة تُعلن فقط بنص غير فارغ، ومسح النص أو فقدان التركيز يوقفها.
  assert.equal(messagesPage.includes('notifyTyping()'), true);
  assert.equal(messagesPage.includes('onBlur={() => typingPublisherRef.current?.stop()}'), true);
  // الإرسال يوقف الكتابة قبل أي انتظار للشبكة.
  assert.equal(/typingPublisherRef\.current\?\.stop\(\);\s*if \(editingMessage\)/.test(messagesPage), true);
  // لا تُعرض إشارات المستخدم نفسه.
  assert.equal(messagesPage.includes('typingEventMatchesConversation(event, currentUserId, conversationId)'), true);
});

test('a non-subscribed channel state resets typing and the send path', () => {
  const messagesPage = readSource('../pages/MessagesPage.tsx');

  // Anchor on the conversation channel's own comment, since the same
  // `if (status === 'SUBSCRIBED') {` appears in other channels earlier in the file.
  const anchor = 'الآن فقط نعتبر القناة جاهزة';
  const anchorIndex = messagesPage.indexOf(anchor);
  assert.ok(anchorIndex > 0, 'the conversation channel subscribe block must be found');
  const start = messagesPage.lastIndexOf("if (status === 'SUBSCRIBED') {", anchorIndex);
  const end = messagesPage.indexOf('conversationBroadcastChannelRef.current = channel;', anchorIndex);
  assert.ok(start > 0 && end > start, 'the subscribe callback must be bounded');

  const subscribeBlock = messagesPage.slice(start, end);
  // Everything after the SUBSCRIBED branch's closing `return;` is the non-subscribed path.
  const branchEnd = subscribeBlock.indexOf('return;');
  assert.ok(branchEnd > 0, 'the SUBSCRIBED branch must return early');
  const unsubscribedBranch = subscribeBlock.slice(branchEnd);
  assert.equal(unsubscribedBranch.includes('conversationBroadcastSubscribedRef.current = false;'), true);
  assert.equal(unsubscribedBranch.includes('clearTypingContact();'), true);
});

function createTrackerWithClock() {
  const clock = createFakeClock();
  const snapshots: string[][] = [];
  const tracker = createTypingContactsTracker({
    onChange: contacts => snapshots.push([...contacts].sort()),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, snapshots, tracker };
}

function lastSnapshot(snapshots: string[][]): string[] {
  return snapshots[snapshots.length - 1] ?? [];
}

test('the inbox typing key is stable, sorted and deduplicated', () => {
  assert.equal(typingConversationIdsKey([userB, userA, userB]), `${userA},${userB}`);
  // نفس المحادثات بترتيب مختلف تعطي المفتاح نفسه فلا يُعاد الاشتراك.
  assert.equal(
    typingConversationIdsKey([userA, userB]),
    typingConversationIdsKey([userB, userA]),
  );
  assert.equal(typingConversationIdsKey([]), '');
  assert.equal(typingConversationIdsKey(['', userA]), userA);
});

test('a conversation typing mark is reported once and refreshes on heartbeats', () => {
  const { clock, snapshots, tracker } = createTrackerWithClock();

  tracker.mark(userB);
  assert.deepEqual(snapshots, [[userB]]);

  // إشارة إبقاء من المحادثة نفسها تجدد المهلة دون إشعار جديد.
  clock.advance(MESSAGES_TYPING_HEARTBEAT_MS);
  tracker.mark(userB);
  assert.deepEqual(snapshots, [[userB]]);
  assert.equal(tracker.has(userB), true);
});

test('each conversation hides itself after the TTL without further signals', () => {
  const { clock, snapshots, tracker } = createTrackerWithClock();

  tracker.mark(userB);
  tracker.mark(userC);
  assert.deepEqual(lastSnapshot(snapshots), [userB, userC]);

  clock.advance(MESSAGES_TYPING_TTL_MS - 1);
  assert.equal(tracker.has(userB), true);
  assert.equal(tracker.has(userC), true);

  clock.advance(1);
  assert.equal(tracker.has(userB), false);
  assert.equal(tracker.has(userC), false);
  assert.deepEqual(lastSnapshot(snapshots), []);
});

test('a heartbeat renews the TTL so a typing conversation stays visible', () => {
  const { clock, tracker } = createTrackerWithClock();

  tracker.mark(userB);
  for (let i = 0; i < 4; i += 1) {
    clock.advance(MESSAGES_TYPING_TTL_MS - 1_000);
    tracker.mark(userB);
    assert.equal(tracker.has(userB), true);
  }

  clock.advance(MESSAGES_TYPING_TTL_MS);
  assert.equal(tracker.has(userB), false);
});

test('isTyping false hides only its own conversation immediately', () => {
  const { clock, snapshots, tracker } = createTrackerWithClock();

  tracker.mark(userB);
  tracker.mark(userC);
  tracker.clear(userB);

  assert.equal(tracker.has(userB), false);
  assert.equal(tracker.has(userC), true);

  clock.advance(MESSAGES_TYPING_TTL_MS);
  assert.deepEqual(lastSnapshot(snapshots), []);
  // لا مؤقتات متروكة بعد الإخفاء والإخفاء التلقائي.
  assert.equal(clock.pendingCount(), 0);
});

test('clearAll drops every timer so leaving the inbox leaves no work behind', () => {
  const { clock, tracker } = createTrackerWithClock();

  tracker.mark(userB);
  tracker.mark(userC);
  assert.equal(clock.pendingCount(), 2);

  tracker.clearAll();
  assert.equal(tracker.has(userB), false);
  assert.equal(tracker.has(userC), false);
  assert.equal(clock.pendingCount(), 0);

  // مؤقتات ملغاة لا تُحيي مؤشراً بعد الإخفاء.
  clock.advance(MESSAGES_TYPING_TTL_MS * 2);
  assert.equal(tracker.has(userB), false);
});

test('the inbox subscribes to each listed private conversation exactly once', () => {
  const messagesPage = readSource('../pages/MessagesPage.tsx');

  // مفتاح مستقر يمنع إعادة الاشتراك عند تحديث القائمة نفسه.
  assert.equal(messagesPage.includes('typingConversationIdsKey('), true);
  // المحادثة المفتوحة تُستثنى: قناة الخيط قائمة بالفعل.
  assert.equal(messagesPage.includes('contactId === selectedId) continue;'), true);
  // لا اشتراك ثانٍ لجهة اتصال مشتركة بالفعل.
  assert.equal(messagesPage.includes('if (sessions.has(contactId)) continue;'), true);
  // لا يُقبل حدث إلا من طرف المحادثة نفسه.
  assert.equal(
    messagesPage.includes('typingEventMatchesConversation(event, currentUserId, contactId)'),
    true,
  );
  // القناة غير الجاهزة أو المنقطعة تُخفي المؤشر بدل إبقائه عالقاً.
  assert.equal(messagesPage.includes('onNotSubscribed: () => tracker?.clear(contactId)'), true);
  // مغادرة الصفحة تُغلق اشتراكات القائمة.
  assert.equal(
    messagesPage.includes('inboxTypingSessionsRef.current.forEach(session => session.cancel());'),
    true,
  );
});

test('the conversation card shows typing in place of the last-message preview', () => {
  const messagesPage = readSource('../pages/MessagesPage.tsx');

  assert.equal(messagesPage.includes('messages-chat-preview is-typing'), true);
  assert.equal(messagesPage.includes('جاري الكتابة...'), true);
  assert.equal(messagesPage.includes('typingInboxContacts.has(conversation.profile.id)'), true);
  // نقطة غير المقروءة تبقى خارج شرط المعاينة.
  assert.equal(messagesPage.includes('messages-unread-dot'), true);
});

test('the typing indicator adds no database dependency', () => {
  const lib = readSource('./messagesTypingIndicator.ts');

  assert.equal(lib.includes('supabase'), false);
  assert.equal(lib.includes(".from('"), false);
  assert.equal(lib.includes('.rpc('), false);
});
