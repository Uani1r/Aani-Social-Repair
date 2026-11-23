// تجهيز عضوية المحادثة قبل الاشتراك في قناتها الخاصة.
//
// سبب وجودها: جدول العضوية aani_message_conversation_members يُكتب عبر trigger
// عند أول رسالة، ومحادثة فُتحت قبل إرسال أي رسالة لا سجل لها — فيُرفض الانضمام
// إلى موضوعها الخاص (Unauthorized) ولا يصل مؤشر الكتابة. هنا نستدعي RPC يتحقق
// من هوية الطرفين وقاعدة الحجب نفسها المطبَّقة في سياسة إرسال الرسائل، ويكتب
// السجل مرة واحدة (idempotent).
//
// الشبكة قد تنقطع لحظة الفتح، وكان فشل واحد يُعطّل المؤشر حتى مغادرة الصفحة.
// لذلك تُعاد المحاولة عند أخطاء الاتصال المؤقتة فقط، بثلاث محاولات إضافية
// وتأخيرات متدرجة. أخطاء الصلاحيات والحجب والدالة غير المثبّتة لا تُعاد أبداً:
// تكرارها لا ينجح وقد يُغرق الطلبات.
//
// لا تُخزَّن أي حالة في قاعدة البيانات هنا غير سجل العضوية نفسه، ولا تُوسَّع
// صلاحيات: القناة تبقى private: true والسياسات كما هي.

import { supabase, supabaseConfigured } from '@/lib/supabase';

/** مفتاح ثنائي مستقر بصرف النظر عن ترتيب الطرفين. */
export function messagesConversationMembershipKey(userId: string, contactId: string): string {
  return userId < contactId ? `${userId}:${contactId}` : `${contactId}:${userId}`;
}

/** تأخيرات إعادة محاولة الاشتراك: ثلاث محاولات محدودة ثم توقف. */
export const MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

/** مهلة المحاولة التالية، أو null عند استنفاد المحاولات (لا حلقة لا نهائية). */
export function nextMessagesConversationChannelRetryDelay(
  attempt: number,
  delaysMs: readonly number[] = MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return attempt < delaysMs.length ? delaysMs[attempt] : null;
}

/**
 * لا تُعاد المحاولة إلا على أخطاء اتصال قابلة للتعافي. `CLOSED` إغلاق مقصود،
 * و`Unauthorized` يصل كـ`CHANNEL_ERROR` فتُعاد المحاولة بعده محدوداً.
 */
export function isRetryableMessagesConversationChannelStatus(status: string): boolean {
  return status === 'CHANNEL_ERROR' || status === 'TIMED_OUT';
}

// ===== إعادة محاولة تجهيز العضوية =====

/**
 * تأخيرات إعادة محاولة استدعاء العضوية: ثلاث محاولات إضافية بعد الأولى كحد
 * أقصى، ثم توقف نهائي (المؤشر يبقى مخفياً والرسائل تعمل عبر REST).
 */
export const MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS = [600, 1_500, 3_500] as const;

/** نتيجة محاولة واحدة لتجهيز العضوية. */
export type MessagesMembershipOutcome = 'ready' | 'transient' | 'permanent';

/** أخطاء لا يُجدي تكرارها: صلاحيات، حجب، دالة غير مثبّتة، معامل غير صالح. */
const PERMANENT_ERROR_CODES = new Set([
  '42501', // insufficient_privilege
  '42883', // undefined_function — الدالة غير مثبتة
  '42P01', // undefined_table
  '42703', // undefined_column
  '22023', // invalid_parameter_value
  '28000', // invalid_authorization_specification
  'PGRST202', // الدالة غير موجودة في schema cache
  'PGRST203', // توقيع غامض
  'PGRST204',
  'PGRST205',
]);

/** أخطاء اتصال مؤقتة يُستحق بعدها إعادة محاولة. */
const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ETIME',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'PGRST000', // تعذر الاتصال بقاعدة البيانات
  'PGRST001',
  'PGRST002',
  'PGRST003', // انتهت مهلة الحصول على اتصال
]);

/** أعراض الصلاحيات/الحجب/غياب الدالة في رسالة الخطأ. */
const PERMANENT_ERROR_PATTERN =
  /permission denied|not authorized|unauthorized|jwt|row-level security|row level security|does not exist|could not find the function|schema cache|invalid input syntax|invalid parameter/i;

/** أعراض انقطاع الشبكة أو تعثر الخادم في رسالة الخطأ. */
const TRANSIENT_ERROR_PATTERN =
  /failed to fetch|fetch failed|networkerror|network error|network request failed|load failed|timed out|timeout|econn|etimedout|socket hang up|temporarily unavailable|bad gateway|service unavailable|gateway timeout|http 50[234]\b/i;

function readErrorField(error: unknown, field: string): string {
  if (typeof error === 'object' && error !== null && field in error) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * تصنيف فشل تجهيز العضوية: مؤقت (شبكة/مهلة/5xx) يُستحق إعادة المحاولة، أو دائم
 * (صلاحيات، حجب، دالة غير مثبّتة، معامل غير صالح) لا يُعاد أبداً. أي خطأ غير
 * معروف يُعامل كدائم: الحذر خير من إغراق الشبكة بمحاولات لا تنجح.
 */
export function classifyMessagesMembershipFailure(error: unknown): 'transient' | 'permanent' {
  const code = readErrorField(error, 'code').trim().toUpperCase();
  const text = [
    readErrorField(error, 'message'),
    readErrorField(error, 'details'),
    readErrorField(error, 'hint'),
    error instanceof Error ? error.message : '',
  ]
    .join(' ')
    .toLowerCase();

  if (PERMANENT_ERROR_CODES.has(code)) return 'permanent';
  if (PERMANENT_ERROR_PATTERN.test(text)) return 'permanent';
  if (TRANSIENT_ERROR_CODES.has(code)) return 'transient';
  if (TRANSIENT_ERROR_PATTERN.test(text)) return 'transient';
  return 'permanent';
}

function defaultDelay(delayMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

export interface MessagesMembershipRetryOptions {
  /** إلغاء الجلسة (مغادرة الصفحة/تبديل المحادثة): لا محاولة جديدة بعدها. */
  isCancelled?: () => boolean;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
  onGiveUp?: () => void;
  /** حقن الاستدعاء في الاختبارات؛ الإنتاج يستخدم RPC أدناه. */
  call?: () => Promise<MessagesMembershipOutcome>;
}

/**
 * محاولة واحدة ثم إعادات محدودة عند الأخطاء المؤقتة فقط. بلا حلقة لا نهائية:
 * بعد استنفاد التأخيرات تتوقف المحاولات. الإلغاء يُفحص قبل كل محاولة وبينها،
 * فيتوقف العمل فوراً عند الخروج أو تبديل الحساب.
 */
export async function ensureMessagesMembershipWithRetry(
  call: () => Promise<MessagesMembershipOutcome>,
  options: Omit<MessagesMembershipRetryOptions, 'call'> = {},
): Promise<boolean> {
  const {
    isCancelled = () => false,
    retryDelaysMs = MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS,
    sleep = defaultDelay,
    onGiveUp,
  } = options;

  for (let attempt = 0; ; attempt += 1) {
    if (isCancelled()) return false;

    let outcome: MessagesMembershipOutcome;
    try {
      outcome = await call();
    } catch {
      outcome = 'permanent';
    }

    if (outcome === 'ready') return true;
    // خطأ دائم: لا إعادة محاولة على الصلاحيات أو الحجب أو الدالة الغائبة.
    if (outcome !== 'transient') return false;

    if (attempt >= retryDelaysMs.length) {
      onGiveUp?.();
      return false;
    }

    if (isCancelled()) return false;
    await sleep(retryDelaysMs[attempt]);
  }
}

const knownMembers = new Set<string>();
const inFlight = new Map<string, Promise<boolean>>();
let cacheOwner: string | null = null;
// جيل يزداد مع كل إفراغ: محاولة بدأت قبل الخروج أو تبديل الحساب تتوقف فوراً.
let membershipEpoch = 0;

/** إفراغ الذاكرة المحلية للعضوية عند تبديل المستخدم أو الخروج. */
export function resetMessagesConversationMembershipCache(ownerId?: string | null): void {
  membershipEpoch += 1;
  cacheOwner = ownerId || null;
  knownMembers.clear();
  inFlight.clear();
}

/** استدعاء RPC العضوية مرة واحدة وتصنيف نتيجته. */
async function callMembershipRpc(contactId: string): Promise<MessagesMembershipOutcome> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.rpc('aani_ensure_message_conversation_member', {
      p_other_user_id: contactId,
    });
  } catch (error) {
    return classifyMessagesMembershipFailure(error);
  }

  if (result.error) return classifyMessagesMembershipFailure(result.error);
  // الدالة ترجع false للحجب أو الهدف غير الصالح: لا إعادة محاولة.
  return result.data === true ? 'ready' : 'permanent';
}

/**
 * هل سجل العضوية موجود ومؤكد لهذا الزوج؟ عند غيابه يستدعي RPC الكتابة الآمن،
 * ويعيد المحاولة عند أخطاء الشبكة المؤقتة فقط (ثلاث إعادات كحد أقصى). لا تُخزَّن
 * النتيجة في knownMembers إلا بعد نجاح حقيقي بإرجاع true، ولا اشتراك في القناة
 * قبل ذلك (الرسائل تبقى تعمل عبر REST).
 */
export async function ensureMessagesConversationMembership(
  userId: string,
  contactId: string,
  options: MessagesMembershipRetryOptions = {},
): Promise<boolean> {
  if (!supabaseConfigured || !userId || !contactId || userId === contactId) return false;

  if (cacheOwner !== userId) {
    resetMessagesConversationMembershipCache(userId);
  }

  const key = messagesConversationMembershipKey(userId, contactId);
  if (knownMembers.has(key)) return true;

  // طلب جارٍ للزوج نفسه: نشاركه بدل إرسال RPC ثانٍ.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const epoch = membershipEpoch;
  const callerCancelled = options.isCancelled ?? (() => false);
  const call = options.call ?? (() => callMembershipRpc(contactId));
  // الخروج أو تبديل الحساب يُبطل كل محاولة بدأت قبله.
  const isCancelled = () => callerCancelled() || membershipEpoch !== epoch;

  const run = async (): Promise<boolean> => {
    let gaveUp = false;
    const ready = await ensureMessagesMembershipWithRetry(call, {
      retryDelaysMs: options.retryDelaysMs,
      sleep: options.sleep,
      isCancelled,
      onGiveUp: () => {
        gaveUp = true;
        options.onGiveUp?.();
      },
    });

    if (!ready) {
      if (gaveUp && !isCancelled()) {
        // بلا تفاصيل خطأ: قد تحمل معرّفات. القناة تبقى غير مشتركة بأمان.
        console.warn('[messages] تعذر تجهيز عضوية المحادثة قبل الاشتراك في قناتها.');
      }
      return false;
    }

    knownMembers.add(key);
    return true;
  };

  const request = run();
  inFlight.set(key, request);
  // لا يبقى الوعد عالقاً في inFlight بعد النجاح أو الفشل أو الإلغاء.
  const cleanup = () => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  };
  void request.then(cleanup, cleanup);

  return request;
}
