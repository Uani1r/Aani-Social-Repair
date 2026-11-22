// تأكيد استلام الرسائل الواردة (delivered_at) من قناة Shell.
//
// الرسالة تصبح «مستلمة» بمجرد وصولها إلى تطبيق المستلم، وليس عند فتح واجهة
// الرسائل. هنا يُرسل التأكيد بلا انتظار، فلا يؤخر تحديث الشارة ولا نشر الحدث
// الداخلي، ثم تُغطى الرسائل التي فاتت أثناء انقطاع Realtime بمزامنة تعويضية
// عند الاشتراك الناجح أو التعافي. غير المقروء لا يتغير: الرسالة تبقى غير
// مقروءة حتى تحديث read_at.

import { messagesRealtimeMessageId } from './messagesRealtimeEvents';

export const MARK_MESSAGES_DELIVERED_RPC = 'aani_mark_messages_delivered';
export const MARK_INBOX_MESSAGES_DELIVERED_RPC = 'aani_mark_inbox_messages_delivered';

export type MessagesReceiptRpc = 'messages' | 'inbox';

export interface MessagesReceiptResult {
  error: unknown | null;
}

export interface MessagesDeliveryReceiptsOptions {
  userId: string;
  /** aani_mark_messages_delivered: تأكيد رسالة واحدة أو أكثر بالمعرّف. */
  markDelivered: (messageIds: string[]) => Promise<MessagesReceiptResult>;
  /** aani_mark_inbox_messages_delivered: مزامنة تعويضية للرسائل الفائتة. */
  markInboxDelivered: () => Promise<MessagesReceiptResult>;
  onError?: (rpc: MessagesReceiptRpc, error: unknown) => void;
}

export interface MessagesDeliveryReceipts {
  /** تأكيد فوري لرسالة واردة، بلا انتظار النتيجة. */
  confirmIncoming(row: unknown): void;
  /** تأكيد تعويضي لما فات أثناء انقطاع الاشتراك. */
  confirmMissed(): void;
}

export const MESSAGES_DELIVERY_DEDUPE_LIMIT = 2000;

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

export function createMessagesDeliveryReceipts(
  options: MessagesDeliveryReceiptsOptions,
): MessagesDeliveryReceipts {
  const confirmedIds = new Set<string>();
  const missingRpcs = new Set<MessagesReceiptRpc>();

  function report(rpc: MessagesReceiptRpc, error: unknown): void {
    if (isMissingMessagesReceiptRpc(error, rpc === 'messages'
      ? MARK_MESSAGES_DELIVERED_RPC
      : MARK_INBOX_MESSAGES_DELIVERED_RPC)) {
      // الدالة غير مثبتة في هذا المشروع: لا نعيد الطلب الفاشل مع كل رسالة.
      missingRpcs.add(rpc);
    }
    options.onError?.(rpc, error);
  }

  function run(rpc: MessagesReceiptRpc, request: () => Promise<MessagesReceiptResult>): void {
    if (missingRpcs.has(rpc)) return;
    // لا يُنتظر التأكيد: فشله لا يمس نشر الحدث ولا شارة غير المقروء.
    void Promise.resolve()
      .then(request)
      .then(result => {
        if (result?.error) report(rpc, result.error);
      })
      .catch((error: unknown) => report(rpc, error));
  }

  return {
    confirmIncoming(row: unknown): void {
      const messageId = incomingMessageIdForDelivery(row, options.userId);
      if (!messageId || confirmedIds.has(messageId)) return;

      confirmedIds.add(messageId);
      if (confirmedIds.size > MESSAGES_DELIVERY_DEDUPE_LIMIT) {
        const oldest = confirmedIds.values().next().value;
        if (oldest !== undefined) confirmedIds.delete(oldest);
      }
      run('messages', () => options.markDelivered([messageId]));
    },

    confirmMissed(): void {
      run('inbox', () => options.markInboxDelivered());
    },
  };
}
