// مؤشر «جاري الكتابة» عبر قناة المحادثة الخاصة نفسها: حدث بث بحمولة معرّفات
// فقط. لا صفوف جديدة في قاعدة البيانات، ولا استعلامات متكررة، ولا قناة لكل
// حرف.
//
// يبث المرسل إشارة بداية واحدة، ثم إشارات إبقاء محدودة المعدل (لا أكثر من
// واحدة كل MESSAGES_TYPING_HEARTBEAT_MS) كي يبقى المؤشر ظاهراً خلال كتابة
// طويلة، ويبث إيقافاً واحداً عند المهلة أو عند الطلب. يخفي المستقبل المؤشر
// بعد MESSAGES_TYPING_TTL_MS من آخر إشارة، فيختفي تلقائياً عند انقطاع
// الاتصال أو مغادرة الطرف الآخر.

export const MESSAGES_TYPING_EVENT = 'typing';

export const MESSAGES_TYPING_HEARTBEAT_MS = 2000;
export const MESSAGES_TYPING_IDLE_MS = 3500;
export const MESSAGES_TYPING_TTL_MS = 6000;

export interface TypingBroadcast {
  userId: string;
  isTyping: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizeTypingBroadcast(payload: unknown): TypingBroadcast | null {
  if (!isRecord(payload)) return null;
  const userId = trimmedId(payload.userId);
  if (!userId || typeof payload.isTyping !== 'boolean') return null;
  return { userId, isTyping: payload.isTyping };
}

/**
 * هل يخص الحدث الطرف الآخر في المحادثة المفتوحة؟ لا نُظهر مؤشر المستخدم نفسه
 * أبداً، ولا مؤشر مستخدم من محادثة أخرى.
 */
export function typingEventMatchesConversation(
  event: TypingBroadcast,
  userId: string,
  contactId: string | null | undefined,
): boolean {
  return Boolean(contactId) && event.userId === contactId && contactId !== userId;
}

export interface TypingPublisherOptions {
  send: (isTyping: boolean) => void;
  heartbeatMs?: number;
  idleMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TypingPublisher {
  notifyTyping(): void;
  stop(): void;
  isTyping(): boolean;
}

/**
 * ناشر إشارات الكتابة: إشارة بداية واحدة، إبقاء محدود المعدل، ثم إيقاف واحد
 * عند المهلة أو عند الطلب. لا يرسل إيقافاً إن لم يكن قد بدأ.
 */
export function createTypingPublisher(options: TypingPublisherOptions): TypingPublisher {
  const {
    send,
    heartbeatMs = MESSAGES_TYPING_HEARTBEAT_MS,
    idleMs = MESSAGES_TYPING_IDLE_MS,
    now = Date.now,
    setTimer = (callback: () => void, delayMs: number) =>
      window.setTimeout(callback, delayMs) as unknown,
    clearTimer = (handle: unknown) => window.clearTimeout(handle as number),
  } = options;

  let typing = false;
  let lastSentAt = 0;
  let idleTimer: unknown = null;

  const clearIdle = () => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  };

  const scheduleIdle = () => {
    clearIdle();
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (!typing) return;
      typing = false;
      send(false);
    }, idleMs);
  };

  return {
    notifyTyping() {
      scheduleIdle();
      const at = now();
      if (typing && at - lastSentAt < heartbeatMs) return;
      typing = true;
      lastSentAt = at;
      send(true);
    },

    stop() {
      clearIdle();
      if (!typing) return;
      typing = false;
      send(false);
    },

    isTyping() {
      return typing;
    },
  };
}

/**
 * مفتاح مستقرّ لقائمة محادثات القائمة الرئيسية: ترتيب ثابت وإزالة التكرار،
 * فإعادة رسم القائمة لا تُعيد إنشاء اشتراكات القنوات ما دامت المحادثات نفسها.
 */
export function typingConversationIdsKey(ids: Iterable<string>): string {
  return [...new Set(ids)].filter(Boolean).sort().join(',');
}

export interface TypingContactsTrackerOptions {
  /** مهلة إخفاء مؤشر جهة الاتصال بعد آخر إشارة صحيحة. */
  ttlMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange: (contacts: ReadonlySet<string>) => void;
}

export interface TypingContactsTracker {
  /** إشارة `isTyping: true`: إظهار المؤشر وتجديد مهلته. */
  mark(contactId: string): void;
  /** إشارة `isTyping: false`: إخفاء المؤشر فوراً وإلغاء مهلته. */
  clear(contactId: string): void;
  /** مغادرة القائمة أو تبديل الحساب: إخفاء الكل وإلغاء كل المؤقتات. */
  clearAll(): void;
  has(contactId: string): boolean;
}

/**
 * مؤشرات الكتابة لعدة محادثات في آن واحد (بطاقات قائمة المحادثات): حالة لكل
 * جهة اتصال ومهلة مستقلة تُجدَّد مع كل إشارة، فإشارة إبقاء واحدة تُبقي مؤشر
 * جهة اتصالها حياً ولا تمسّ غيرها. كل الإخفاءات تُبلَّغ إلى onChange واحدة.
 */
export function createTypingContactsTracker(options: TypingContactsTrackerOptions): TypingContactsTracker {
  const {
    ttlMs = MESSAGES_TYPING_TTL_MS,
    setTimer = (callback: () => void, delayMs: number) =>
      window.setTimeout(callback, delayMs) as unknown,
    clearTimer = (handle: unknown) => window.clearTimeout(handle as number),
    onChange,
  } = options;

  const contacts = new Set<string>();
  const timers = new Map<string, unknown>();

  const emit = () => onChange(new Set(contacts));

  const clearTimerFor = (contactId: string) => {
    const handle = timers.get(contactId);
    if (handle === undefined) return;
    clearTimer(handle);
    timers.delete(contactId);
  };

  return {
    mark(contactId) {
      if (!contactId) return;
      clearTimerFor(contactId);
      timers.set(contactId, setTimer(() => {
        timers.delete(contactId);
        if (!contacts.delete(contactId)) return;
        emit();
      }, ttlMs));
      if (contacts.has(contactId)) return;
      contacts.add(contactId);
      emit();
    },

    clear(contactId) {
      clearTimerFor(contactId);
      if (!contacts.delete(contactId)) return;
      emit();
    },

    clearAll() {
      timers.forEach(handle => clearTimer(handle));
      timers.clear();
      if (contacts.size === 0) return;
      contacts.clear();
      emit();
    },

    has(contactId) {
      return contacts.has(contactId);
    },
  };
}
