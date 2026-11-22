// تأكيد استلام الرسائل الواردة (delivered_at) من قناة Shell.
//
// الرسالة تصبح «مستلمة» بمجرد وصولها إلى تطبيق المستلم، وليس عند فتح واجهة
// الرسائل. هنا يُرسل التأكيد بلا انتظار، فلا يؤخر تحديث الشارة ولا نشر الحدث
// الداخلي، ثم تُغطى الرسائل التي فاتت أثناء انقطاع Realtime بمزامنة تعويضية
// عند الاشتراك الناجح أو التعافي. غير المقروء لا يتغير: الرسالة تبقى غير
// مقروءة حتى تحديث read_at.
//
// المعرّف ليس «مؤكداً» إلا بعد نجاح RPC فعلياً. لكل رسالة ثلاثة أوضاع:
// قيد التنفيذ، مؤكدة بنجاح، أو فشلت مؤقتاً وتنتظر إعادة محاولة محدودة
// (بلا polling ولا حلقات طلبات).

import { messagesRealtimeMessageId } from './messagesRealtimeEvents';

export const MARK_MESSAGES_DELIVERED_RPC = 'aani_mark_messages_delivered';
export const MARK_INBOX_MESSAGES_DELIVERED_RPC = 'aani_mark_inbox_messages_delivered';

export type MessagesReceiptRpc = 'messages' | 'inbox';

export interface MessagesReceiptResult {
  error: unknown | null;
}

export type MessagesReceiptTimerHandle = ReturnType<typeof setTimeout>;

export interface MessagesDeliveryReceiptsOptions {
  userId: string;
  /** aani_mark_messages_delivered: تأكيد رسالة واحدة أو أكثر بالمعرّف. */
  markDelivered: (messageIds: string[]) => Promise<MessagesReceiptResult>;
  /** aani_mark_inbox_messages_delivered: مزامنة تعويضية للرسائل الفائتة. */
  markInboxDelivered: () => Promise<MessagesReceiptResult>;
  onError?: (rpc: MessagesReceiptRpc, error: unknown) => void;
  /** للاختبار: مؤقت إعادة المحاولة المحدودة. */
  setTimer?: (handler: () => void, timeout: number) => MessagesReceiptTimerHandle;
  clearTimer?: (handle: MessagesReceiptTimerHandle) => void;
}

export interface MessagesDeliveryReceipts {
  /** تأكيد فوري لرسالة واردة، بلا انتظار النتيجة. */
  confirmIncoming(row: unknown): void;
  /** تأكيد تعويضي لما فات أثناء انقطاع الاشتراك. */
  confirmMissed(): void;
}

export const MESSAGES_DELIVERY_DEDUPE_LIMIT = 2000;
/** محاولات التأكيد لكل رسالة في عمر الصفحة: الأولى ثم إعادتان فقط. */
export const MESSAGES_DELIVERY_MAX_ATTEMPTS = 3;
export const MESSAGES_DELIVERY_RETRY_BASE_DELAY_MS = 1000;
export const MESSAGES_DELIVERY_RETRY_MAX_DELAY_MS = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PGRST202 يذكر اسم الدالة مع schema cache. أي خطأ آخر لا يُعد غياباً. */
export function isMissingMessagesReceiptRpc(error: unknown, rpcName: string): boolean {
  if (!isRecord(error) || error.code !== 'PGRST202') return false;
  const message = error.message;
  return typeof message === 'string'
    && message.includes(rpcName)
    && /schema cache/i.test(message);
}

/**
 * معرّف الرسالة التي يجب تأكيد استلامها، أو null إن كان الصف ليس رسالة واردة
 * للمستخدم الحالي.
 */
export function incomingMessageIdForDelivery(row: unknown, userId: string): string | null {
  if (!isRecord(row) || row.recipient_id !== userId) return null;
  return messagesRealtimeMessageId(row);
}

/** 1s ثم 2s ثم 4s… بحد أقصى 10s. */
export function messagesDeliveryRetryDelay(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 10));
  return Math.min(MESSAGES_DELIVERY_RETRY_BASE_DELAY_MS * 2 ** exponent, MESSAGES_DELIVERY_RETRY_MAX_DELAY_MS);
}

export function createMessagesDeliveryReceipts(
  options: MessagesDeliveryReceiptsOptions,
): MessagesDeliveryReceipts {
  // مؤكدة بنجاح فعلاً.
  const confirmed = new Set<string>();
  // قيد التنفيذ الآن: تمنع طلباً متزامناً مكرراً للرسالة نفسها.
  const inFlight = new Set<string>();
  // عدد المحاولات لكل رسالة (يحدّ إعادة المحاولة فلا حلقة طلبات).
  const attempts = new Map<string, number>();
  const retryTimers = new Map<string, MessagesReceiptTimerHandle>();
  const missingRpcs = new Set<MessagesReceiptRpc>();
  const setTimer = options.setTimer ?? ((handler, timeout) => setTimeout(handler, timeout));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));

  function pruneSet(ids: Set<string>): void {
    if (ids.size <= MESSAGES_DELIVERY_DEDUPE_LIMIT) return;
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }

  function pruneAttempts(): void {
    if (attempts.size <= MESSAGES_DELIVERY_DEDUPE_LIMIT) return;
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }

  function cancelRetry(messageId: string): void {
    const handle = retryTimers.get(messageId);
    if (handle === undefined) return;
    clearTimer(handle);
    retryTimers.delete(messageId);
  }

  function cancelAllRetries(): void {
    retryTimers.forEach(handle => clearTimer(handle));
    retryTimers.clear();
  }

  function report(rpc: MessagesReceiptRpc, error: unknown): void {
    const rpcName = rpc === 'messages' ? MARK_MESSAGES_DELIVERED_RPC : MARK_INBOX_MESSAGES_DELIVERED_RPC;
    if (isMissingMessagesReceiptRpc(error, rpcName)) {
      // الدالة غير مثبتة في هذا المشروع: لا نعيد الطلب الفاشل مع كل رسالة.
      missingRpcs.add(rpc);
      if (rpc === 'messages') cancelAllRetries();
    }
    options.onError?.(rpc, error);
  }

  function confirmSuccess(messageId: string): void {
    cancelRetry(messageId);
    attempts.delete(messageId);
    confirmed.add(messageId);
    pruneSet(confirmed);
  }

  function scheduleRetry(messageId: string, attemptCount: number): void {
    if (retryTimers.has(messageId) || missingRpcs.has('messages') || confirmed.has(messageId)) return;

    const handle = setTimer(() => {
      retryTimers.delete(messageId);
      send(messageId);
    }, messagesDeliveryRetryDelay(attemptCount));
    retryTimers.set(messageId, handle);
  }

  function send(messageId: string): void {
    if (confirmed.has(messageId) || inFlight.has(messageId) || missingRpcs.has('messages')) return;

    const usedAttempts = attempts.get(messageId) ?? 0;
    if (usedAttempts >= MESSAGES_DELIVERY_MAX_ATTEMPTS) return;

    const attemptCount = usedAttempts + 1;
    attempts.set(messageId, attemptCount);
    pruneAttempts();
    inFlight.add(messageId);

    // لا يُنتظر التأكيد: فشله لا يمس نشر الحدث ولا شارة غير المقروء.
    void Promise.resolve()
      .then(() => options.markDelivered([messageId]))
      .then(result => {
        inFlight.delete(messageId);
        if (result?.error) {
          report('messages', result.error);
          if (!missingRpcs.has('messages') && attemptCount < MESSAGES_DELIVERY_MAX_ATTEMPTS) {
            scheduleRetry(messageId, attemptCount);
          }
          return;
        }
        confirmSuccess(messageId);
      })
      .catch((error: unknown) => {
        inFlight.delete(messageId);
        report('messages', error);
        if (!missingRpcs.has('messages') && attemptCount < MESSAGES_DELIVERY_MAX_ATTEMPTS) {
          scheduleRetry(messageId, attemptCount);
        }
      });
  }

  function confirmMissed(): void {
    if (missingRpcs.has('inbox')) return;
    void Promise.resolve()
      .then(() => options.markInboxDelivered())
      .then(result => {
        if (result?.error) report('inbox', result.error);
      })
      .catch((error: unknown) => report('inbox', error));
  }

  return {
    confirmIncoming(row: unknown): void {
      const messageId = incomingMessageIdForDelivery(row, options.userId);
      // معرّف قيد التنفيذ أو مؤكدة أو لها محاولة مجدولة: لا طلب مكرر.
      if (!messageId || confirmed.has(messageId) || inFlight.has(messageId) || retryTimers.has(messageId)) return;
      send(messageId);
    },

    confirmMissed,
  };
}
