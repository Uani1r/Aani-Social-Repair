// تنظيف الرسائل المؤقتة المنتهية.
//
// aani_purge_expired_messages غير موجودة في الإنتاج، فاستدعاؤها مع كل تحميل
// للقائمة أو المحادثة يعطّل الواجهة بانتظار RPC سيفشل دائماً. هنا يُنفَّذ
// التنظيف في الخلفية، بلا طلبات متزامنة مكررة، ويُحفظ غياب الدالة خلال جلسة
// الصفحة فلا يُعاد الطلب الفاشل.

export const MESSAGES_PURGE_RPC = 'aani_purge_expired_messages';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorField(error: unknown, key: 'code' | 'message'): unknown {
  return isRecord(error) ? error[key] : null;
}

/**
 * PGRST202 يغطي أيضاً توقيعاً قديماً، لكن الدالة هنا بلا وسائط، فيكفي أن يذكر
 * الخطأ اسمها مع schema cache. أي خطأ آخر (صلاحيات، شبكة، مهلة) لا يُعد غياباً
 * فلا يُعاد استخدامه لإسكات الطلب.
 */
export function isMissingMessagesPurgeRpc(error: unknown): boolean {
  const message = errorField(error, 'message');
  return errorField(error, 'code') === 'PGRST202'
    && typeof message === 'string'
    && message.includes(MESSAGES_PURGE_RPC)
    && /schema cache/i.test(message);
}

export interface MessagesPurgeRequestResult {
  data: unknown;
  error: unknown | null;
}

export interface MessagesPurgeScheduler {
  /** يبدأ التنظيف في الخلفية: لا ينتظر ولا يكرر طلباً جارياً. */
  run(): void;
  isRunning(): boolean;
  /** تأكد غياب RPC في هذه الجلسة، فلا يُعاد استدعاؤه. */
  isMissing(): boolean;
}

export function expiredMessageIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const ids = new Set<string>();
  data.forEach(value => {
    if (typeof value === 'string' && value.length > 0) ids.add(value);
  });
  return [...ids];
}

/** إزالة الرسائل المنتهية من الصفوف المعروضة، مع الحفاظ على هوية المصفوفة. */
export function removeExpiredMessageRows<T extends { id: string }>(
  rows: T[],
  expiredIds: ReadonlySet<string>,
): T[] {
  if (expiredIds.size === 0) return rows;
  const remaining = rows.filter(row => !expiredIds.has(row.id));
  return remaining.length === rows.length ? rows : remaining;
}

export function createMessagesPurgeScheduler(
  request: () => Promise<MessagesPurgeRequestResult>,
  onExpired: (messageIds: string[]) => void,
  onError?: (error: unknown) => void,
): MessagesPurgeScheduler {
  let running = false;
  let missing = false;

  return {
    run(): void {
      if (running || missing) return;
      running = true;
      void Promise.resolve()
        .then(request)
        .then(({ data, error }) => {
          if (error) {
            if (isMissingMessagesPurgeRpc(error)) {
              missing = true;
              return;
            }
            onError?.(error);
            return;
          }
          const messageIds = expiredMessageIds(data);
          if (messageIds.length) onExpired(messageIds);
        })
        .catch((error: unknown) => {
          if (isMissingMessagesPurgeRpc(error)) {
            missing = true;
            return;
          }
          onError?.(error);
        })
        .finally(() => {
          running = false;
        });
    },

    isRunning(): boolean {
      return running;
    },

    isMissing(): boolean {
      return missing;
    },
  };
}
