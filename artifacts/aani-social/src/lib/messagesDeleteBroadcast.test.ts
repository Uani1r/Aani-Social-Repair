import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createMessagesDeleteBroadcastDedupe,
  isMessagesConversationTopicFor,
  messageDeletedBroadcastKey,
  messageDeletedContactId,
  messageDeletedEventMatchesConversation,
  messagesConversationTopic,
  messagesConversationTopicMembers,
  normalizeMessageDeletedBroadcast,
  normalizeReactionDeletedBroadcast,
  reactionDeletedBroadcastKey,
  shouldBroadcastMessageDeletion,
} from './messagesDeleteBroadcast';

const userA = '00000000-0000-0000-0000-00000000000a';
const userB = '00000000-0000-0000-0000-00000000000b';
const userC = '00000000-0000-0000-0000-00000000000c';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('the conversation topic is stable regardless of member order', () => {
  const topic = messagesConversationTopic(userA, userB);
  assert.equal(messagesConversationTopic(userB, userA), topic);
  assert.deepEqual(messagesConversationTopicMembers(topic), [userA, userB]);
  assert.equal(isMessagesConversationTopicFor(topic, userA, userB), true);
  assert.equal(isMessagesConversationTopicFor(topic, userB, userA), true);
});

test('the topic never includes a user who is not one of the two members', () => {
  const topic = messagesConversationTopic(userA, userB);
  assert.equal(isMessagesConversationTopicFor(topic, userC, userA), false);
  assert.equal(isMessagesConversationTopicFor(messagesConversationTopic(userA, userC), userA, userB), false);
  assert.equal(messagesConversationTopicMembers('aani-conversation:not-a-pair'), null);
  assert.equal(messagesConversationTopicMembers(`${topic}:extra`), null);
  assert.equal(messagesConversationTopicMembers('other-topic'), null);
});

test('a delete broadcast carries ids only and rejects malformed payloads', () => {
  const event = normalizeMessageDeletedBroadcast({
    messageId: 'm1',
    senderId: userA,
    recipientId: userB,
    // حقول غير متوقعة لا تدخل الحدث المطبّق.
    content: 'secret text',
    emoji: '🔥',
  });
  assert.deepEqual(event, { messageId: 'm1', senderId: userA, recipientId: userB });
  assert.equal('content' in (event as object), false);

  assert.equal(normalizeMessageDeletedBroadcast(null), null);
  assert.equal(normalizeMessageDeletedBroadcast({ senderId: userA, recipientId: userB }), null);
  assert.equal(normalizeMessageDeletedBroadcast({ messageId: '', senderId: userA, recipientId: userB }), null);
  assert.equal(normalizeMessageDeletedBroadcast({ messageId: 7, senderId: userA, recipientId: userB }), null);
  assert.equal(normalizeMessageDeletedBroadcast('m1'), null);

  const reaction = normalizeReactionDeletedBroadcast({ messageId: 'm1', userId: userA, emoji: '🔥' });
  assert.deepEqual(reaction, { messageId: 'm1', userId: userA });
  assert.equal(normalizeReactionDeletedBroadcast({ messageId: 'm1' }), null);
  assert.equal(normalizeReactionDeletedBroadcast({ messageId: 'm1', userId: '' }), null);
});

test('a deleted message resolves the contact of the current participant', () => {
  const fromA = normalizeMessageDeletedBroadcast({ messageId: 'm1', senderId: userA, recipientId: userB });
  assert.ok(fromA);
  assert.equal(messageDeletedContactId(fromA, userA), userB);
  assert.equal(messageDeletedContactId(fromA, userB), userA);
  assert.equal(messageDeletedContactId(fromA, userC), null);

  const selfMessage = normalizeMessageDeletedBroadcast({ messageId: 'm2', senderId: userA, recipientId: userA });
  assert.ok(selfMessage);
  assert.equal(messageDeletedContactId(selfMessage, userA), null);
});

test('a delete event only applies to its own conversation and participants', () => {
  const fromA = normalizeMessageDeletedBroadcast({ messageId: 'm1', senderId: userA, recipientId: userB });
  assert.ok(fromA);

  // الطرفان يطابقان المحادثة المفتوحة نفسها.
  assert.equal(messageDeletedEventMatchesConversation(fromA, userA, userB), true);
  assert.equal(messageDeletedEventMatchesConversation(fromA, userB, userA), true);

  // محادثة أخرى، أو مستخدم ثالث، أو حدث مُلفّق باسم المستخدم فقط: مرفوض.
  assert.equal(messageDeletedEventMatchesConversation(fromA, userA, userC), false);
  assert.equal(messageDeletedEventMatchesConversation(fromA, userC, userA), false);

  const forged = normalizeMessageDeletedBroadcast({ messageId: 'm2', senderId: userB, recipientId: userC });
  assert.ok(forged);
  assert.equal(messageDeletedEventMatchesConversation(forged, userA, userB), false);

  const selfMessage = normalizeMessageDeletedBroadcast({ messageId: 'm3', senderId: userA, recipientId: userA });
  assert.ok(selfMessage);
  assert.equal(messageDeletedEventMatchesConversation(selfMessage, userA, userB), false);
});

test('only a delete-for-everyone is broadcast to the other participant', () => {
  assert.equal(shouldBroadcastMessageDeletion('everyone'), true);
  assert.equal(shouldBroadcastMessageDeletion('me'), false);
});

test('duplicate delete broadcasts are applied once', () => {
  const dedupe = createMessagesDeleteBroadcastDedupe();
  const messageKey = messageDeletedBroadcastKey({ messageId: 'm1', senderId: userA, recipientId: userB });
  const reactionKey = reactionDeletedBroadcastKey({ messageId: 'm1', userId: userA });

  assert.equal(dedupe.isDuplicate(messageKey), false);
  assert.equal(dedupe.isDuplicate(messageKey), true);
  assert.equal(dedupe.isDuplicate(reactionKey), false);
  assert.equal(dedupe.isDuplicate(reactionKey), true);

  // مفتاح التفاعل يخص المستخدم نفسه فقط: تفاعل مستخدم آخر حدث مستقل.
  assert.equal(dedupe.isDuplicate(reactionDeletedBroadcastKey({ messageId: 'm1', userId: userB })), false);

  dedupe.clear();
  assert.equal(dedupe.isDuplicate(messageKey), false);
});

test('the dedupe tracker stays bounded', () => {
  const dedupe = createMessagesDeleteBroadcastDedupe(2);
  assert.equal(dedupe.isDuplicate('a'), false);
  assert.equal(dedupe.isDuplicate('b'), false);
  assert.equal(dedupe.isDuplicate('c'), false);
  // أقدم مفتاح خرج من النافذة، فيُعد جديداً بدل نمو الذاكرة بلا حد.
  assert.equal(dedupe.isDuplicate('a'), false);
  assert.equal(dedupe.isDuplicate('c'), true);
});

test('no public postgres_changes DELETE subscription remains for messages or reactions', () => {
  const messagesPage = readSource('../pages/MessagesPage.tsx');
  const shell = readSource('../components/shell/Shell.tsx');

  for (const source of [messagesPage, shell]) {
    assert.equal(
      /event:\s*'DELETE'/.test(source),
      false,
      'public DELETE subscriptions must not be used for message rows',
    );
    assert.equal(
      /table:\s*'message_reactions'[\s\S]{0,120}event:\s*'\*'|event:\s*'\*'[\s\S]{0,120}table:\s*'message_reactions'/.test(source),
      false,
      'message_reactions must not be subscribed with a wildcard event',
    );
  }
});

test('the page subscribes to private conversation broadcast channels only', () => {
  const messagesPage = readSource('../pages/MessagesPage.tsx');

  assert.equal(/private:\s*true/.test(messagesPage), true);
  assert.equal(/messagesConversationTopic\(/.test(messagesPage), true);
  assert.equal(/messageDeletedEventMatchesConversation\(/.test(messagesPage), true);
  assert.equal(/shouldBroadcastMessageDeletion\(/.test(messagesPage), true);
  assert.equal(messagesPage.includes('MESSAGES_MESSAGE_DELETED_EVENT'), true);
  assert.equal(messagesPage.includes('MESSAGES_REACTION_DELETED_EVENT'), true);
});
