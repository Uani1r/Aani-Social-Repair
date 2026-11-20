// صحة اشتراك قنوات Supabase Realtime.
//
// عودة الـWebSocket وحدها لا تعني أن الاشتراك سليم: القناة قد تبقى غير
// مشتركة، أو تفشل، أو تُغلق من الخادم. هنا نقرّر لكل حالة — على القناتين:
// قائمة المحادثات والقناة المفتوحة — هل نحتاج مزامنة تعويضية، ومتى نعيد
// إنشاء الاشتراك.
//
// ملاحظة مهمة عن realtime-js: القناة التي تُغلق (CLOSED) تُزال من قائمة
// قنوات العميل ولا تُعاد تلقائياً، فإعادة تشغيل الـsocket لا تكفي؛ يجب إنشاء
// قناة جديدة. كما أن إعادة الإنشاء المتتابعة بلا تأخير تصنع حلقة إعادة
// اتصال، لذلك نؤخّرها بتأخير متزايد.

export type RealtimeChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface RealtimeChannelHealthDecision {
  /** مزامنة تعويضية: قد تكون رسائل فاتت أثناء انقطاع الاشتراك. */
  resync: boolean;
  /** تأخير إعادة إنشاء الاشتراك بالمللي ثانية، أو null إن كانت القناة سليمة. */
  resubscribeAfterMs: number | null;
}

export const REALTIME_CHANNEL_RESUBSCRIBE_MIN_DELAY_MS = 1000;
export const REALTIME_CHANNEL_RESUBSCRIBE_MAX_DELAY_MS = 30000;
// قناة بقيت مشتركة هذه المدة تعني أن الاشتراك كان سليماً فعلاً، فتُصفَّر
// عدّاد المحاولات قبل حساب التأخير التالي بدل معاقبة الجلسة كلها.
export const REALTIME_CHANNEL_HEALTHY_AFTER_MS = 10000;

/** تأخير متزايد: ثانية، ثانيتان، ٤، ٨، ١٦ ثم ٣٠ ثانية كحد أقصى. */
export function realtimeChannelResubscribeDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures, 5));
  return Math.min(
    REALTIME_CHANNEL_RESUBSCRIBE_MIN_DELAY_MS * 2 ** exponent,
    REALTIME_CHANNEL_RESUBSCRIBE_MAX_DELAY_MS,
  );
}

export interface RealtimeChannelHealthTracker {
  handleStatus(status: string, now: number): RealtimeChannelHealthDecision;
  reset(): void;
}

export function createRealtimeChannelHealthTracker(): RealtimeChannelHealthTracker {
  let consecutiveFailures = 0;
  let subscribedAt: number | null = null;

  return {
    handleStatus(status: string, now: number): RealtimeChannelHealthDecision {
      if (status === 'SUBSCRIBED') {
        subscribedAt = now;
        return { resync: false, resubscribeAfterMs: null };
      }

      if (subscribedAt !== null && now - subscribedAt >= REALTIME_CHANNEL_HEALTHY_AFTER_MS) {
        consecutiveFailures = 0;
      }
      subscribedAt = null;

      const delay = realtimeChannelResubscribeDelay(consecutiveFailures);
      consecutiveFailures += 1;
      // أي حالة غير SUBSCRIBED تعني اشتراكاً غير موثوق: نزامن ونعيد الإنشاء.
      return { resync: true, resubscribeAfterMs: delay };
    },
    reset(): void {
      consecutiveFailures = 0;
      subscribedAt = null;
    },
  };
}
