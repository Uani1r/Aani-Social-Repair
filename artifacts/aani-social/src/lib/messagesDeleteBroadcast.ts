// بث آمن لأحداث حذف الرسائل والتفاعلات بدل استقبال صفوف DELETE عبر
// postgres_changes العامة.
//
// أحداث DELETE في Realtime لا توفر ضمانات تصفية RLS نفسها التي توفرها القراءة
// والتحديث، وقد يحمل الصف المحذوف (خصوصاً مع REPLICA IDENTITY FULL) محتوى
// الرسالة إلى مشتركين غير مشاركين. لذلك:
// - لا نشترك في DELETE على messages أو message_reactions في القنوات العامة.
// - يُبث حدث على قناة خاصة واحدة لكل محادثة، حمولته معرّفات فقط (لا محتوى).
// - قناة المحادثة خاصة (private) ويُقيّد الوصول إليها بسياسات Realtime
//   Authorization على realtime.messages.
// - المزامنة التعويضية REST تبقى شبكة الأمان إن لم يصل الحدث.

export const MESSAGES_CONVERSATION_TOPIC_PREFIX = 'aani-conversation:';

export const MESSAGES_MESSAGE_DELETED_EVENT = 'message_deleted';
export const MESSAGES_REACTION_DELETED_EVENT = 'reaction_deleted';

export interface MessageDeletedBroadcast {
  messageId: string;
  senderId: string;
  recipientId: string;
}

export interface ReactionDeletedBroadcast {
  messageId: string;
  userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * موضوع قناة المحادثة: معرّفا الطرفين بترتيب ثابت، فلا تختلف القناة باختلاف
 * من يفتحها.
 */
export function messagesConversationTopic(userA: string, userB: string): string {
  const first = userA < userB ? userA : userB;
  const second = userA < userB ? userB : userA;
  return `${MESSAGES_CONVERSATION_TOPIC_PREFIX}${first}:${second}`;
}

/** طرفا الموضوع، أو null إن لم يكن الموضوع موضوع محادثة صالحاً. */
export function messagesConversationTopicMembers(topic: unknown): readonly [string, string] | null {
  if (typeof topic !== 'string' || !topic.startsWith(MESSAGES_CONVERSATION_TOPIC_PREFIX)) return null;
  const rest = topic.slice(MESSAGES_CONVERSATION_TOPIC_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  const [first, second] = parts;
  if (!trimmedId(first) || !trimmedId(second) || first >= second) return null;
  return [first, second];
}

/** هل الموضوع محادثة بين المستخدم والطرف الآخر? */
export function isMessagesConversationTopicFor(topic: unknown, userId: string, contactId: string): boolean {
  return topic === messagesConversationTopic(userId, contactId);
}

export function normalizeMessageDeletedBroadcast(payload: unknown): MessageDeletedBroadcast | null {
  if (!isRecord(payload)) return null;
  const messageId = trimmedId(payload.messageId);
  const senderId = trimmedId(payload.senderId);
  const recipientId = trimmedId(payload.recipientId);
  if (!messageId || !senderId || !recipientId) return null;
  // الحمولة معرّفات فقط. أي محتوى إضافي في الحدث يُتجاهل ولا يصل إلى الحالة.
  return { messageId, senderId, recipientId };
}

export function normalizeReactionDeletedBroadcast(payload: unknown): ReactionDeletedBroadcast | null {
  if (!isRecord(payload)) return null;
  const messageId = trimmedId(payload.messageId);
  const userId = trimmedId(payload.userId);
  if (!messageId || !userId) return null;
  return { messageId, userId };
}

export interface MessagesDeleteBroadcastDedupe {
  isDuplicate(key: string): boolean;
  clear(): void;
}

export const MESSAGES_DELETE_BROADCAST_DEDUPE_LIMIT = 500;

/** الحدث الواحد قد يصل من أكثر من مسار؛ يُطبَّق مرة واحدة. */
export function createMessagesDeleteBroadcastDedupe(
  limit = MESSAGES_DELETE_BROADCAST_DEDUPE_LIMIT,
): MessagesDeleteBroadcastDedupe {
  const seen = new Set<string>();
  return {
    isDuplicate(key: string): boolean {
      if (seen.has(key)) return true;
      seen.add(key);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return false;
    },
    clear(): void {
      seen.clear();
    },
  };
}

export function messageDeletedBroadcastKey(event: MessageDeletedBroadcast): string {
  return `message:${event.messageId}`;
}

export function reactionDeletedBroadcastKey(event: ReactionDeletedBroadcast): string {
  return `reaction:${event.messageId}:${event.userId}`;
}

export interface MessageDeletedDeletionTarget {
  messageId: string;
  contactId: string | null;
}

/** الطرف الآخر في الرسالة المحذوفة، أو null إن كانت الرسالة ليست بين طرفين. */
export function messageDeletedContactId(event: MessageDeletedBroadcast, userId: string): string | null {
  if (event.senderId === userId && event.recipientId !== userId) return event.recipientId;
  if (event.recipientId === userId && event.senderId !== userId) return event.senderId;
  return null;
}

/**
 * هل يخص حدث الحذف المحادثة المفتوحة والمستخدم الحالي؟ يُتحقق من هوية أطراف
 * الحدث قبل أي تعديل على الحالة المحلية، فلا يمس حدثٌ مُلفّق محادثة أخرى.
 */
export function messageDeletedEventMatchesConversation(
  event: MessageDeletedBroadcast,
  userId: string,
  contactId: string | null | undefined,
): boolean {
  if (!contactId || event.senderId === event.recipientId) return false;
  if (event.senderId !== userId && event.recipientId !== userId) return false;
  return messageDeletedContactId(event, userId) === contactId;
}

export type MessageDeletionScope = 'me' | 'everyone';

/**
 * الحذف الشخصي (إخفاء لدى المستخدم) لا يُبث للطرف الآخر. فقط الحذف للطرفين
 * يغيّر ما يراه المشارك الآخر.
 */
export function shouldBroadcastMessageDeletion(scope: MessageDeletionScope): boolean {
  return scope === 'everyone';
}


// حذف المحادثة كاملة لدى الجميع: حدث واحد يحمل معرّف من طلبه فقط. تُحذف
// الرسائل فعلياً من قاعدة البيانات عبر RPC المحادثة، وهذا الحدث يجعل الطرف
// الآخر يفرّغ المحادثة المفتوحة فوراً بدل انتظار المزامنة.
export const MESSAGES_CONVERSATION_DELETED_EVENT = 'conversation_deleted';

export interface ConversationDeletedBroadcast {
  userId: string;
}

export function normalizeConversationDeletedBroadcast(payload: unknown): ConversationDeletedBroadcast | null {
  if (!isRecord(payload)) return null;
  const userId = trimmedId(payload.userId);
  return userId ? { userId } : null;
}

export function conversationDeletedBroadcastKey(event: ConversationDeletedBroadcast): string {
  return `conversation:${event.userId}`;
}

/** هل يخص حذف المحادثة المحادثة المفتوحة مع هذا الطرف؟ */
export function conversationDeletedEventMatchesConversation(
  event: ConversationDeletedBroadcast,
  userId: string,
  contactId: string | null | undefined,
): boolean {
  return Boolean(contactId) && event.userId === contactId && contactId !== userId;
}

// بث ينتظر اكتمال الاشتراك في قناة المحادثة: لا نُسقط الأحداث ولا نُكرّرها.
export const MESSAGES_CONVERSATION_BROADCAST_QUEUE_LIMIT = 32;

export interface QueuedConversationBroadcast {
  key: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * إضافة حدث إلى الطابور قبل اكتمال الاشتراك. المفتاح نفسه يُستبدل (أحدث حالة
 * تكفي: مؤشر الكتابة مثلاً)، والطابور محدود الطول.
 */
export function enqueueConversationBroadcast(
  queue: QueuedConversationBroadcast[],
  next: QueuedConversationBroadcast,
  limit = MESSAGES_CONVERSATION_BROADCAST_QUEUE_LIMIT,
): QueuedConversationBroadcast[] {
  const existing = queue.findIndex(item => item.key === next.key);
  if (existing >= 0) {
    const updated = queue.slice();
    updated[existing] = next;
    return updated;
  }
  if (queue.length >= limit) return [...queue.slice(queue.length - limit + 1), next];
  return [...queue, next];
}
