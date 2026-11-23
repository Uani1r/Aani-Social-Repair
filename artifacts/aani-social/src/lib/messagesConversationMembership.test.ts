import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS,
  isRetryableMessagesConversationChannelStatus,
  messagesConversationMembershipKey,
  nextMessagesConversationChannelRetryDelay,
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
  const opens = messagesPage.split('openMessagesConversationChannel({').length - 1;
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
