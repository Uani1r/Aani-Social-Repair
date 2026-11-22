import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MESSAGES_TYPING_EVENT,
  MESSAGES_TYPING_HEARTBEAT_MS,
  MESSAGES_TYPING_IDLE_MS,
  MESSAGES_TYPING_TTL_MS,
  createTypingPublisher,
  normalizeTypingBroadcast,
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
