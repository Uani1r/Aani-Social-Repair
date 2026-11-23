// فتح قناة محادثة خاصة: عضوية أولاً، ثم اشتراك، ثم إعادة محاولة محدودة.
//
// القناة الخاصة لا تُنشأ قبل تأكيد العضوية، فلا اشتراك مرفوض ولا طابور أحداث
// يُرسل بعد فواته. وإذا رفض الخادم الاشتراك (CHANNEL_ERROR/TIMED_OUT) تُزال
// القناة الفاشلة وتُعاد المحاولة بعد تأخير متزايد منتهٍ — لا حلقة لا نهائية.

import {
  MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS,
  isRetryableMessagesConversationChannelStatus,
  nextMessagesConversationChannelRetryDelay,
} from '@/lib/messagesConversationMembership';

export interface MessagesConversationChannelOptions<TChannel extends object> {
  /** يتحقق من العضوية (RPC) قبل إنشاء القناة. */
  ensureMembership: () => Promise<boolean>;
  /** ينشئ القناة ويربط مستمعيها ثم يشترك، ويبلّغ onStatus بحالة الاشتراك. */
  createChannel: (onStatus: (status: string, error?: unknown) => void) => TChannel;
  onSubscribed: (channel: TChannel) => void;
  onNotSubscribed: (channel: TChannel, status: string, error?: unknown) => void;
  /** لا عضوية أو استُنفدت المحاولات: لا قناة، والمؤشر يبقى مخفياً. */
  onUnavailable?: (reason: 'membership' | 'gave-up') => void;
  removeChannel: (channel: TChannel) => void;
  isCancelled?: () => boolean;
  retryDelaysMs?: readonly number[];
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface MessagesConversationChannelSession {
  cancel(): void;
  isSubscribed(): boolean;
}

export function openMessagesConversationChannel<TChannel extends object>(
  options: MessagesConversationChannelOptions<TChannel>,
): MessagesConversationChannelSession {
  const {
    ensureMembership,
    createChannel,
    onSubscribed,
    onNotSubscribed,
    onUnavailable,
    removeChannel,
    isCancelled = () => false,
    retryDelaysMs = MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS,
    setTimer = (callback: () => void, delayMs: number) =>
      window.setTimeout(callback, delayMs) as unknown,
    clearTimer = (handle: unknown) => window.clearTimeout(handle as number),
  } = options;

  let cancelled = false;
  let subscribed = false;
  let attempt = 0;
  let current: TChannel | null = null;
  let retryTimer: unknown = null;

  const dropCurrent = () => {
    const channel = current;
    current = null;
    subscribed = false;
    if (channel) removeChannel(channel);
  };

  const scheduleRetry = () => {
    const delayMs = nextMessagesConversationChannelRetryDelay(attempt, retryDelaysMs);
    if (delayMs === null) {
      onUnavailable?.('gave-up');
      return;
    }
    attempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async (): Promise<void> => {
    if (cancelled || subscribed || current) return;

    let ready = false;
    try {
      ready = await ensureMembership();
    } catch {
      ready = false;
    }
    if (cancelled) return;
    if (!ready) {
      onUnavailable?.('membership');
      return;
    }

    let channel: TChannel;
    try {
      channel = createChannel((status, error) => {
        if (cancelled || current !== channel) return;
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          attempt = 0;
          onSubscribed(channel);
          return;
        }
        subscribed = false;
        onNotSubscribed(channel, status, error);
        if (!isRetryableMessagesConversationChannelStatus(status)) return;
        dropCurrent();
        scheduleRetry();
      });
    } catch {
      onUnavailable?.('gave-up');
      return;
    }

    if (cancelled) {
      removeChannel(channel);
      return;
    }
    current = channel;
  };

  void connect();

  return {
    cancel() {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      dropCurrent();
    },
    isSubscribed() {
      return subscribed;
    },
  };
}
