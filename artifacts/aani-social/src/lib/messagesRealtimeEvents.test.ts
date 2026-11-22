import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRealtimeInboxDelete,
  applyRealtimeInboxInsert,
  compareInboxMessageRecency,
  mergeInboxConversationsWithRealtime,
  mergeMessageSnapshot,
  messagesInboxContactId,
} from './messagesInbox';
import {
  createMessagesPurgeScheduler,
  expiredMessageIds,
  isMissingMessagesPurgeRpc,
  removeExpiredMessageRows,
} from './messagesPurge';
import {
  createMessagesRealtimeEventDedupe,
  createMessagesRealtimeEventDispatcher,
  createMessagesRealtimeEventHub,
  messagesRealtimeEventFromPayload,
  messagesRealtimeEventSignature,
} from './messagesRealtimeEvents';
import { mergeThreadRows, removeThreadRow } from './messagesThread';

interface MessageLike {
  id: string;
  sender_id: string;
  recipient_id: string;
  created_at: string;
  read_at: string | null;
  delivered_at: string | null;
  content?: string;
}

interface InboxConversationLike {
  profile: { id: string };
  lastMessage: MessageLike | null;
  isRequest: boolean;
}

function normalizeMessage(value: unknown): MessageLike | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.created_at !== 'string') return null;
  return {
    id: row.id,
    sender_id: typeof row.sender_id === 'string' ? row.sender_id : '',
    recipient_id: typeof row.recipient_id === 'string' ? row.recipient_id : '',
    created_at: row.created_at,
    read_at: typeof row.read_at === 'string' ? row.read_at : null,
    delivered_at: typeof row.delivered_at === 'string' ? row.delivered_at : null,
    content: typeof row.content === 'string' ? row.content : '',
  };
}

function message(
  id: string,
  senderId: string,
  recipientId: string,
  createdAt: string,
  content = id,
): MessageLike {
  return {
    id,
    sender_id: senderId,
    recipient_id: recipientId,
    created_at: createdAt,
    read_at: null,
    delivered_at: null,
    content,
  };
}

function inboxConversation(profileId: string, lastMessage: MessageLike | null): InboxConversationLike {
  return { profile: { id: profileId }, lastMessage, isRequest: false };
}

function groupConversations(
  conversations: InboxConversationLike[],
  contactId: string,
  lastMessage: MessageLike,
): InboxConversationLike[] {
  return applyRealtimeInboxInsert(conversations, lastMessage, 'me', () => inboxConversation(contactId, null));
}

function flushTasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 25));
}

/**
 * محاكاة المسار الذي يستخدمه MessagesPage: نفس الموزّع المشترك، ونفس دوال
 * الدمج التي يستخدمها معالجا INSERT/UPDATE/DELETE في الصفحة.
 */
function createPageState() {
  const state = {
    conversations: [] as InboxConversationLike[],
    thread: [] as MessageLike[],
    applied: [] as string[],
  };

  const dispatcher = createMessagesRealtimeEventDispatcher({
    insert: row => {
      const incoming = normalizeMessage(row);
      if (!incoming) return;
      state.applied.push(`${incoming.id}:INSERT`);
      state.conversations = applyRealtimeInboxInsert(
        state.conversations,
        incoming,
        'me',
        (contactId, lastMessage) => inboxConversation(contactId, lastMessage),
      );
      state.thread = mergeThreadRows(state.thread, [incoming]);
    },
    update: row => {
      const incoming = normalizeMessage(row);
      if (!incoming) return;
      state.applied.push(`${incoming.id}:UPDATE`);
      const contactId = messagesInboxContactId(incoming, 'me');
      if (!contactId) return;
      for (const rowIndex of state.thread.keys()) {
        if (state.thread[rowIndex].id === incoming.id) {
          state.thread[rowIndex] = mergeMessageSnapshot(state.thread[rowIndex], incoming);
        }
      }
      const conversation = state.conversations.find(item => item.profile.id === contactId);
      const currentLast = conversation?.lastMessage;
      if (conversation && currentLast?.id === incoming.id) {
        state.conversations = state.conversations.map(item => (
          item.profile.id === contactId
            ? { ...item, lastMessage: mergeMessageSnapshot(currentLast, incoming) }
            : item
        ));
        return;
      }
      // رسالة INSERT قد تكون فاتت: لا تُترك المعاينة أقدم من رسالة مؤكدة.
      if (!currentLast || compareInboxMessageRecency(incoming, currentLast) > 0) {
        state.conversations = applyRealtimeInboxInsert(
          state.conversations,
          incoming,
          'me',
          (newContactId, lastMessage) => inboxConversation(newContactId, lastMessage),
        );
      }
    },
    delete: messageId => {
      state.applied.push(`${messageId}:DELETE`);
      state.thread = removeThreadRow(state.thread, messageId);
      state.conversations = applyRealtimeInboxDelete(state.conversations, messageId);
    },
  });

  return { state, dispatcher };
}

test('a Shell messages INSERT reflects immediately in the inbox list and open thread', () => {
  const hub = createMessagesRealtimeEventHub();
  const { state, dispatcher } = createPageState();
  state.conversations = [
    inboxConversation('contact-b', message('b-last', 'contact-b', 'me', '2027-01-01T10:30:00Z', 'from b')),
    inboxConversation('contact-a', message('a-old', 'me', 'contact-a', '2027-01-01T10:00:00Z', 'old a')),
  ];
  const unsubscribe = hub.subscribe(dispatcher);

  const incoming = message('a-live', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'وصلت الآن');
  hub.publish(messagesRealtimeEventFromPayload('INSERT', { new: incoming }));

  assert.deepEqual(state.applied, ['a-live:INSERT']);
  assert.deepEqual(state.conversations.map(conversation => conversation.profile.id), ['contact-a', 'contact-b']);
  assert.equal(state.conversations[0]?.lastMessage?.id, 'a-live');
  assert.equal(state.conversations[0]?.lastMessage?.content, 'وصلت الآن');
  assert.deepEqual(state.thread.map(row => row.id), ['a-live']);
  assert.equal(hub.listenerCount(), 1);

  unsubscribe();
  assert.equal(hub.listenerCount(), 0);
  hub.publish(messagesRealtimeEventFromPayload('INSERT', {
    new: message('a-later', 'contact-a', 'me', '2027-01-01T11:05:00Z', 'بعد إلغاء الاشتراك'),
  }));
  assert.deepEqual(state.applied, ['a-live:INSERT']);
});

test('the same event from the page channel and the Shell relay applies once', () => {
  const hub = createMessagesRealtimeEventHub();
  const { state, dispatcher } = createPageState();
  const unsubscribe = hub.subscribe(dispatcher);
  const incoming = message('same-1', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'مرة واحدة');

  // قناة MessagesPage ثم الحدث الداخلي القادم من Shell: الحدث نفسه.
  dispatcher(messagesRealtimeEventFromPayload('INSERT', { new: incoming }));
  hub.publish(messagesRealtimeEventFromPayload('INSERT', { new: incoming }));

  assert.deepEqual(state.applied, ['same-1:INSERT']);
  assert.deepEqual(state.thread.map(row => row.id), ['same-1']);
  assert.equal(state.conversations[0]?.lastMessage?.id, 'same-1');

  unsubscribe();
});

test('a newer message is never replaced by an older fetch response or by a duplicate event', () => {
  const older = message('older', 'me', 'contact-a', '2027-01-01T09:00:00Z', 'قديمة');
  const newer = message('newer', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'الأحدث');

  // استجابة جلب بدأت قبل وصول الأحدث ثم عادت بعده.
  const mergedInbox = mergeInboxConversationsWithRealtime(
    [inboxConversation('contact-a', older)],
    [inboxConversation('contact-a', newer)],
    new Map(),
    'me',
  );
  assert.equal(mergedInbox[0]?.lastMessage?.id, 'newer');
  assert.equal(mergedInbox[0]?.lastMessage?.content, 'الأحدث');

  // الخيط لا يفقد الأحدث عند دمج استجابة أقدم.
  const mergedThread = mergeThreadRows([newer], [older]);
  assert.deepEqual(mergedThread.map(row => row.id), ['older', 'newer']);

  // إعادة الحدث نفسه خارج نافذة التكرار لا تضيف صفاً ثانياً.
  const dedupe = createMessagesRealtimeEventDedupe(0);
  const event = messagesRealtimeEventFromPayload('INSERT', { new: newer });
  assert.equal(dedupe.isDuplicate(event), false);
  assert.equal(dedupe.isDuplicate(event), false);
  const reapplied = mergeThreadRows([newer], [normalizeMessage(event.row) as MessageLike]);
  assert.deepEqual(reapplied.map(row => row.id), ['newer']);
});

test('the inbox preview follows the newest message from either participant', () => {
  let conversations = [inboxConversation('contact-a', message('m1', 'me', 'contact-a', '2027-01-01T10:00:00Z'))];

  conversations = groupConversations(
    conversations,
    'contact-a',
    message('m2', 'contact-a', 'me', '2027-01-01T10:05:00Z', 'من الطرف الآخر'),
  );
  assert.equal(conversations[0]?.lastMessage?.id, 'm2');
  assert.equal(conversations[0]?.lastMessage?.content, 'من الطرف الآخر');

  conversations = groupConversations(
    conversations,
    'contact-a',
    message('m3', 'me', 'contact-a', '2027-01-01T10:06:00Z', 'من المستخدم الحالي'),
  );
  assert.equal(conversations[0]?.lastMessage?.id, 'm3');
  assert.equal(conversations[0]?.lastMessage?.content, 'من المستخدم الحالي');

  // رسالة أقدم من الطرف الآخر لا تُرجع المعاينة إلى الخلف.
  const unchanged = groupConversations(
    conversations,
    'contact-a',
    message('m0', 'contact-a', 'me', '2027-01-01T09:00:00Z', 'متأخرة الوصول'),
  );
  assert.strictEqual(unchanged, conversations);
  assert.equal(unchanged[0]?.lastMessage?.id, 'm3');
});

test('UPDATE refreshes delivery and read receipts immediately without reordering the thread', () => {
  const { state, dispatcher } = createPageState();
  state.thread = [message('receipt-1', 'me', 'contact-a', '2027-01-01T10:00:00Z', 'نص')];
  state.conversations = [inboxConversation('contact-a', state.thread[0])];

  const delivered = {
    ...state.thread[0],
    delivered_at: '2027-01-01T10:00:05Z',
  };
  dispatcher(messagesRealtimeEventFromPayload('UPDATE', { new: delivered }));
  assert.equal(state.applied[0], 'receipt-1:UPDATE');
  assert.equal(state.thread[0]?.delivered_at, '2027-01-01T10:00:05Z');
  assert.equal(state.thread[0]?.read_at, null);
  assert.equal(state.conversations[0]?.lastMessage?.delivered_at, '2027-01-01T10:00:05Z');

  const read = {
    ...state.thread[0],
    read_at: '2027-01-01T10:01:00Z',
  };
  dispatcher(messagesRealtimeEventFromPayload('UPDATE', { new: read }));
  assert.equal(state.applied.length, 2);
  assert.equal(state.thread[0]?.read_at, '2027-01-01T10:01:00Z');
  assert.equal(state.thread[0]?.delivered_at, '2027-01-01T10:00:05Z');
  assert.equal(state.conversations[0]?.lastMessage?.read_at, '2027-01-01T10:01:00Z');
  assert.deepEqual(state.thread.map(row => row.id), ['receipt-1']);
});

test('an UPDATE whose INSERT was missed still refreshes the inbox preview immediately', () => {
  const { state, dispatcher } = createPageState();
  state.conversations = [
    inboxConversation('contact-a', message('old', 'me', 'contact-a', '2027-01-01T09:00:00Z')),
  ];
  const missedInsert = {
    ...message('missed', 'contact-a', 'me', '2027-01-01T11:00:00Z', 'وصلت دون حدث إدراج'),
    delivered_at: '2027-01-01T11:00:02Z',
  };

  dispatcher(messagesRealtimeEventFromPayload('UPDATE', { new: missedInsert }));

  assert.deepEqual(state.applied, ['missed:UPDATE']);
  assert.equal(state.conversations[0]?.lastMessage?.id, 'missed');
  assert.equal(state.conversations[0]?.lastMessage?.content, 'وصلت دون حدث إدراج');
  assert.equal(state.conversations[0]?.lastMessage?.delivered_at, '2027-01-01T11:00:02Z');
});

test('DELETE removes the message from the thread and clears its inbox preview', () => {
  const { state, dispatcher } = createPageState();
  const kept = message('kept', 'me', 'contact-a', '2027-01-01T09:00:00Z');
  const removed = message('removed', 'contact-a', 'me', '2027-01-01T11:00:00Z');
  state.thread = [kept, removed];
  state.conversations = [inboxConversation('contact-a', removed)];

  dispatcher(messagesRealtimeEventFromPayload('DELETE', { old: { id: 'removed' } }));

  assert.deepEqual(state.applied, ['removed:DELETE']);
  assert.deepEqual(state.thread.map(row => row.id), ['kept']);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0]?.profile.id, 'contact-a');
  assert.equal(state.conversations[0]?.lastMessage, null);
  assert.strictEqual(removeThreadRow(state.thread, 'missing'), state.thread);
});

test('a missing purge RPC is remembered and never blocks message loading', async () => {
  const missingPurgeRpc = {
    code: 'PGRST202',
    message: 'Could not find the public.aani_purge_expired_messages() function in the schema cache',
    details: 'Searched for the function public.aani_purge_expired_messages with no parameters and no matches were found in the schema cache.',
    hint: null,
  };
  let calls = 0;
  const expired: string[][] = [];
  const scheduler = createMessagesPurgeScheduler(
    async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 0));
      return { data: null, error: missingPurgeRpc };
    },
    ids => expired.push(ids),
    () => {
      throw new Error('غياب الدالة المؤكد لا يُبلَّغ كخطأ تنظيف');
    },
  );

  // التنظيف في الخلفية: لا يُرجع وعداً ينتظره تحميل القائمة أو المحادثة.
  assert.equal(scheduler.run(), undefined);
  assert.equal(scheduler.isRunning(), true);
  scheduler.run();
  assert.equal(scheduler.isRunning(), true);

  // تحميل الرسائل مستقل تماماً عن نتيجة التنظيف.
  const loading = Promise.resolve(['older', 'newer']);
  assert.deepEqual(await loading, ['older', 'newer']);

  await flushTasks();
  assert.equal(calls, 1);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.isMissing(), true);
  assert.deepEqual(expired, []);

  // غياب مؤكد في هذه الصفحة: لا يُعاد الطلب الفاشل مع كل تحديث.
  scheduler.run();
  await flushTasks();
  assert.equal(calls, 1);

  assert.equal(isMissingMessagesPurgeRpc(missingPurgeRpc), true);
  assert.equal(isMissingMessagesPurgeRpc({ code: 'PGRST202', message: 'permission denied for function x' }), false);
  assert.equal(isMissingMessagesPurgeRpc({ code: '42501', message: 'permission denied' }), false);
});

test('expired messages disappear once cleanup completes', async () => {
  const expired: string[][] = [];
  const scheduler = createMessagesPurgeScheduler(
    async () => ({ data: ['m1', 'm1', 'm2', 7, ''], error: null }),
    ids => expired.push(ids),
  );

  scheduler.run();
  await flushTasks();

  assert.deepEqual(expired, [['m1', 'm2']]);
  assert.deepEqual(expiredMessageIds(['a', 'a', null, 3, 'b']), ['a', 'b']);

  const rows = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
  const expiredIdSet = new Set(expired[0] ?? []);
  assert.deepEqual(removeExpiredMessageRows(rows, expiredIdSet).map(row => row.id), ['m3']);
  assert.strictEqual(removeExpiredMessageRows(rows, new Set(['missing'])), rows);
});

test('an older cached preview never hides newer server data', () => {
  const cached = [inboxConversation('contact-a', message('cached', 'me', 'contact-a', '2027-01-01T08:00:00Z'))];
  const server = [inboxConversation('contact-a', message('server', 'me', 'contact-a', '2027-01-01T10:00:00Z'))];

  const merged = mergeInboxConversationsWithRealtime(server, cached, new Map(), 'me');
  assert.equal(merged[0]?.lastMessage?.id, 'server');

  // والعكس: وصول استجابة أقدم لا يُرجع آخر رسالة محلية إلى تاريخ أقدم.
  const keptNewer = mergeInboxConversationsWithRealtime(cached, server, new Map(), 'me');
  assert.equal(keptNewer[0]?.lastMessage?.id, 'server');
});

test('event signatures separate inserts from receipt updates on the same message', () => {
  const delivered = {
    ...message('same', 'contact-a', 'me', '2027-01-01T10:00:00Z'),
    delivered_at: '2027-01-01T10:00:05Z',
  };
  const read = { ...delivered, read_at: '2027-01-01T10:01:00Z' };

  assert.notEqual(
    messagesRealtimeEventSignature(messagesRealtimeEventFromPayload('UPDATE', { new: delivered })),
    messagesRealtimeEventSignature(messagesRealtimeEventFromPayload('UPDATE', { new: read })),
  );

  const dedupe = createMessagesRealtimeEventDedupe();
  const insert = messagesRealtimeEventFromPayload('INSERT', { new: delivered });
  assert.equal(dedupe.isDuplicate(insert), false);
  assert.equal(dedupe.isDuplicate(insert), true);
  assert.equal(dedupe.isDuplicate(messagesRealtimeEventFromPayload('UPDATE', { new: delivered })), false);
  assert.equal(dedupe.isDuplicate(messagesRealtimeEventFromPayload('UPDATE', { new: read })), false);
});
