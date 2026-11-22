// حدث داخلي موحّد لتغييرات جدول messages.
//
// Shell يشترك في messages لشارة الرسائل غير المقروءة، وMessagesPage يشترك فيه
// لقائمة المحادثات والخيط. القناة التي يفتحها Shell كانت تحدّث الشارة فقط، فلا
// تعرف MessagesPage عن الرسالة الواردة إن كانت قنواتها غير مشتركة أو فاتتها
// الأحداث. هنا يمرّ الحدث نفسه عبر ناقل داخلي واحد، فيصل إلى القائمة والخيط من
// payload نفسه فوراً، وتبقى مزامنة REST التعويضية كما هي.

export type MessagesRealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface MessagesRealtimePayloadLike {
  new?: unknown;
  old?: unknown;
}

export interface MessagesRealtimeEvent {
  type: MessagesRealtimeEventType;
  /** صف الرسالة كما وصل من Realtime عند INSERT/UPDATE، أو null عند DELETE. */
  row: unknown | null;
  /** معرّف الرسالة، أو null إن كان الـpayload بلا معرّف. */
  messageId: string | null;
}

export type MessagesRealtimeEventListener = (event: MessagesRealtimeEvent) => void;

export interface MessagesRealtimeEventHub {
  publish(event: MessagesRealtimeEvent): void;
  subscribe(listener: MessagesRealtimeEventListener): () => void;
  listenerCount(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function messagesRealtimeMessageId(value: unknown): string | null {
  const id = isRecord(value) ? value.id : null;
  return typeof id === 'string' && id ? id : null;
}

/**
 * يحوّل payload قناة messages إلى الحدث الداخلي.
 * DELETE يحمل معرّف الصف في old فقط (replica identity الافتراضي هو المفتاح).
 */
export function messagesRealtimeEventFromPayload(
  type: MessagesRealtimeEventType,
  payload: MessagesRealtimePayloadLike | null | undefined,
): MessagesRealtimeEvent {
  const row = type === 'DELETE' ? null : payload?.new ?? null;
  return {
    type,
    row,
    messageId: messagesRealtimeMessageId(row) ?? messagesRealtimeMessageId(payload?.old),
  };
}

export function createMessagesRealtimeEventHub(): MessagesRealtimeEventHub {
  const listeners = new Set<MessagesRealtimeEventListener>();

  return {
    publish(event: MessagesRealtimeEvent): void {
      if (!event.messageId) return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          console.error('[messages] تعذر تطبيق حدث Realtime داخلي:', error);
        }
      }
    },

    subscribe(listener: MessagesRealtimeEventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    listenerCount(): number {
      return listeners.size;
    },
  };
}

/** الناقل الوحيد المشترك: Shell يكتب وMessagesPage يقرأ. */
export const messagesRealtimeEvents = createMessagesRealtimeEventHub();

/** نشر حدث من قناة Realtime إلى الناقل الداخلي. */
export function publishMessagesRealtimeEvent(event: MessagesRealtimeEvent): void {
  messagesRealtimeEvents.publish(event);
}

function rowText(row: Record<string, unknown> | null, key: string): string {
  const value = row ? row[key] : null;
  return typeof value === 'string' ? value : '';
}

/**
 * توقيع الحدث يكفي لتمييز تغيير حقيقي عن وصول الحدث نفسه من أكثر من مسار.
 * UPDATE يتضمن الإيصالات والمحتوى، لأن تسليم الرسالة ثم قراءتها تغييران
 * مختلفان على الصف نفسه.
 */
export function messagesRealtimeEventSignature(event: MessagesRealtimeEvent): string {
  if (!event.messageId) return '';
  if (event.type !== 'UPDATE') return `${event.type}:${event.messageId}`;
  const row = isRecord(event.row) ? event.row : null;
  return [
    'UPDATE',
    event.messageId,
    rowText(row, 'delivered_at'),
    rowText(row, 'read_at'),
    rowText(row, 'content'),
  ].join(':');
}

export const MESSAGES_REALTIME_DEDUPE_WINDOW_MS = 5000;
export const MESSAGES_REALTIME_DEDUPE_LIMIT = 500;

export interface MessagesRealtimeEventDedupe {
  /** true إن كان الحدث نفسه قد طُبّق داخل نافذة التكرار. */
  isDuplicate(event: MessagesRealtimeEvent, now?: number): boolean;
  clear(): void;
}

export function createMessagesRealtimeEventDedupe(
  windowMs = MESSAGES_REALTIME_DEDUPE_WINDOW_MS,
  limit = MESSAGES_REALTIME_DEDUPE_LIMIT,
): MessagesRealtimeEventDedupe {
  const seen = new Map<string, number>();

  return {
    isDuplicate(event: MessagesRealtimeEvent, now = Date.now()): boolean {
      const signature = messagesRealtimeEventSignature(event);
      if (!signature) return false;

      const seenAt = seen.get(signature);
      if (seenAt !== undefined && now - seenAt < windowMs) return true;

      // حجم محدود: تُحذف أقدم بصمة كي لا تنمو الذاكرة بلا حد.
      seen.delete(signature);
      seen.set(signature, now);
      if (seen.size > limit) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return false;
    },

    clear(): void {
      seen.clear();
    },
  };
}

export interface MessagesRealtimeEventHandlers {
  insert(row: unknown): void;
  update(row: unknown): void;
  delete(messageId: string): void;
}

/**
 * مسار واحد لتطبيق أحداث messages: قنوات MessagesPage نفسها والحدث الداخلي
 * القادم من Shell. الحدث نفسه قد يصل من المسارين، فلا يُطبَّق مرتين.
 */
export function createMessagesRealtimeEventDispatcher(
  handlers: MessagesRealtimeEventHandlers,
  dedupe: MessagesRealtimeEventDedupe = createMessagesRealtimeEventDedupe(),
): (event: MessagesRealtimeEvent) => void {
  return event => {
    if (!event.messageId) return;
    if (dedupe.isDuplicate(event)) return;

    if (event.type === 'INSERT') {
      handlers.insert(event.row);
      return;
    }
    if (event.type === 'UPDATE') {
      handlers.update(event.row);
      return;
    }
    handlers.delete(event.messageId);
  };
}
