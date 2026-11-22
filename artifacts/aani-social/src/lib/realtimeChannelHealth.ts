// صحة اشتراك قنوات Supabase Realtime.
//
// عودة الـWebSocket وحدها لا تعني أن الاشتراك سليم: القناة قد تبقى غير
// مشتركة، أو تفشل، أو تُغلق من الخادم. هنا نقرّر لكل حالة — على قناتين
// مستقلتين: قائمة المحادثات والقناة المفتوحة — هل نحتاج مزامنة تعويضية،
// ومتى نعيد إنشاء الاشتراك.
//
// ملاحظة مهمة عن realtime-js: القناة التي تُغلق (CLOSED) تُزال من قائمة
// قنوات العميل ولا تُعاد تلقائياً، فإعادة تشغيل الـsocket لا تكفي؛ يجب إنشاء
// قناة جديدة. كما أن إعادة الإنشاء المتتابعة بلا تأخير تصنع حلقة إعادة
// اتصال، لذلك نؤخّرها بتأخير متزايد.
//
// الاستقلال مقصود: لكل قناة حالتها وعداد محاولاتها ومؤقت تعافيها، ونجاح
// إحداهما لا يلغي إصلاح الأخرى. ما يُشترَك بينهما هو إعادة الإنشاء نفسها
// فقط لأنها تُعاد لكل القنوات معاً؛ ولذلك تُجمَّع الإشارات المتزامنة في
// إعادة إنشاء واحدة بدل إنشاء قنوات مكررة.

export type RealtimeChannelId = 'inbox' | 'thread';

export type RealtimeChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export const REALTIME_CHANNEL_IDS: readonly RealtimeChannelId[] = ['inbox', 'thread'];

export interface RealtimeChannelDecision {
  /** مزامنة تعويضية: قد تكون رسائل فاتت أثناء انقطاع الاشتراك. */
  resync: boolean;
  /** وقت إعادة الإنشاء المجدولة لهذه القناة بالمللي ثانية، أو null. */
  retryAt: number | null;
}

export interface RealtimeChannelSnapshot {
  id: RealtimeChannelId;
  /** 'IDLE' يعني قناة أُنشئت للتو ولم تُبلّغ عن اشتراكها بعد. */
  status: RealtimeChannelStatus | 'IDLE';
  /** معرّف الجيل: يتغيّر مع كل إنشاء، فيُهمَل أي نداء من قناة قديمة. */
  token: number;
  /** آخر وقت اشتراك ناجح في هذا الجيل. */
  subscribedAt: number | null;
  /** عدد المحاولات المتتالية الفاشلة (يُصفَّر بعد اشتراك سليم طويل). */
  failureCount: number;
  /** مؤقت التعافي: الوقت الذي ستُعاد فيه إنشاء هذه القناة. */
  retryAt: number | null;
  /** إغلاق ناتج عن تنظيفنا نحن، وليس عطلاً. */
  intentionalClose: boolean;
  /** عملية إعادة إنشاء جارية لهذه القناة. */
  recreating: boolean;
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

export interface RealtimeChannelSupervisor {
  /** تسجيل جيل جديد للقناة (يُستدعى عند كل إنشاء). يُرجع معرّفه. */
  beginChannel(id: RealtimeChannelId): number;
  /** القناة أُغلقت بسبب تنظيفنا، فلا تُعدّ عطلاً ولا تُعيد جدولة. */
  markIntentionalClose(id: RealtimeChannelId, token: number): void;
  /** معالجة حالة اشتراك واردة من القناة. */
  handleStatus(id: RealtimeChannelId, token: number, status: string, now: number): RealtimeChannelDecision;
  /** عند استعادة الاتصال: قناة غير مشتركة تُجدوَل لإعادة الإنشاء. */
  ensureHealthy(id: RealtimeChannelId, now: number): RealtimeChannelDecision;
  /** أقرب وقت إعادة إنشاء مجدول بين كل القنوات. */
  earliestRetryAt(): number | null;
  /** القنوات المستحقة الآن؛ تُفرّغ مؤقتاتها وتعلّمها كقيد إعادة الإنشاء. */
  claimDueChannels(now: number): RealtimeChannelId[];
  snapshot(id: RealtimeChannelId): RealtimeChannelSnapshot;
  reset(): void;
}

interface ChannelState {
  status: RealtimeChannelStatus | 'IDLE';
  token: number;
  subscribedAt: number | null;
  failureCount: number;
  retryAt: number | null;
  intentionalClose: boolean;
  recreating: boolean;
}

const NO_ACTION: RealtimeChannelDecision = { resync: false, retryAt: null };

function normalizeStatus(status: string): RealtimeChannelStatus {
  if (status === 'SUBSCRIBED' || status === 'TIMED_OUT' || status === 'CLOSED') return status;
  // أي حالة غير معروفة تُعامَل كخطأ اشتراك، لا كصحة.
  return 'CHANNEL_ERROR';
}

function createState(): ChannelState {
  return {
    status: 'IDLE',
    token: 0,
    subscribedAt: null,
    failureCount: 0,
    retryAt: null,
    intentionalClose: false,
    recreating: false,
  };
}

export function createRealtimeChannelSupervisor(): RealtimeChannelSupervisor {
  const channels: Record<RealtimeChannelId, ChannelState> = {
    inbox: createState(),
    thread: createState(),
  };

  /** جدولة محاولة جديدة لهذه القناة وحدها، دون المساس بالقناة الأخرى. */
  function scheduleRetry(state: ChannelState, now: number): RealtimeChannelDecision {
    if (state.retryAt !== null) {
      // محاولة مجدولة أصلاً: لا نكرّر الجدولة ولا نزيد العداد.
      return { resync: true, retryAt: state.retryAt };
    }

    if (state.subscribedAt !== null && now - state.subscribedAt >= REALTIME_CHANNEL_HEALTHY_AFTER_MS) {
      state.failureCount = 0;
    }
    state.subscribedAt = null;

    const delay = realtimeChannelResubscribeDelay(state.failureCount);
    state.failureCount += 1;
    state.retryAt = now + delay;
    return { resync: true, retryAt: state.retryAt };
  }

  return {
    beginChannel(id: RealtimeChannelId): number {
      const state = channels[id];
      state.token += 1;
      state.status = 'IDLE';
      state.subscribedAt = null;
      state.retryAt = null;
      state.intentionalClose = false;
      state.recreating = false;
      return state.token;
    },

    markIntentionalClose(id: RealtimeChannelId, token: number): void {
      const state = channels[id];
      if (token !== state.token) return;
      state.intentionalClose = true;
      // إغلاقنا نحن يلغي أي محاولة مجدولة لهذه القناة.
      state.retryAt = null;
    },

    handleStatus(id: RealtimeChannelId, token: number, status: string, now: number): RealtimeChannelDecision {
      const state = channels[id];
      // نداء من قناة استُبدلت: لا يخصّ الحالة الحالية إطلاقاً.
      if (token !== state.token) return NO_ACTION;

      const wasSubscribed = state.status === 'SUBSCRIBED';
      const normalized = normalizeStatus(status);
      state.status = normalized;

      if (normalized === 'SUBSCRIBED') {
        if (!wasSubscribed) state.subscribedAt = now;
        // SUBSCRIBED يؤكد أن إعدادات postgres_changes قُبلت. أول تأكيد
        // وبعد كل انقطاع يستلزمان مزامنة لسد الفجوة التي لا يعيدها Realtime.
        // التكرارات أثناء الاشتراك السليم لا تطلق طلبات شبكة إضافية.
        state.retryAt = null;
        return wasSubscribed ? NO_ACTION : { resync: true, retryAt: null };
      }

      if (state.intentionalClose) return NO_ACTION;

      return scheduleRetry(state, now);
    },

    ensureHealthy(id: RealtimeChannelId, now: number): RealtimeChannelDecision {
      const state = channels[id];
      // قناة مشتركة أو لم تُبلّغ بعد: لا داعي لإعادة إنشائها.
      if (state.status === 'SUBSCRIBED' || state.status === 'IDLE') return NO_ACTION;
      if (state.intentionalClose) return NO_ACTION;
      return scheduleRetry(state, now);
    },

    earliestRetryAt(): number | null {
      let earliest: number | null = null;
      for (const id of REALTIME_CHANNEL_IDS) {
        const retryAt = channels[id].retryAt;
        if (retryAt === null) continue;
        if (earliest === null || retryAt < earliest) earliest = retryAt;
      }
      return earliest;
    },

    claimDueChannels(now: number): RealtimeChannelId[] {
      const due = REALTIME_CHANNEL_IDS.filter(id => {
        const retryAt = channels[id].retryAt;
        return retryAt !== null && retryAt <= now;
      });
      if (due.length === 0) return [];

      // إعادة الإنشاء تشمل كل القنوات (epoch واحد)، فلا نترك مؤقتاً قديماً
      // لقناة أخرى كي لا تُجدول إعادة إنشاء ثانية بعد الأولى.
      for (const id of REALTIME_CHANNEL_IDS) {
        const state = channels[id];
        if (state.retryAt === null) continue;
        state.retryAt = null;
        state.recreating = true;
      }
      return due;
    },

    snapshot(id: RealtimeChannelId): RealtimeChannelSnapshot {
      return { id, ...channels[id] };
    },

    reset(): void {
      channels.inbox = createState();
      channels.thread = createState();
    },
  };
}
