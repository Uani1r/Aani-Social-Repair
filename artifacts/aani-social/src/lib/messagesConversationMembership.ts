// تجهيز عضوية المحادثة قبل الاشتراك في قناتها الخاصة.
//
// سبب وجودها: جدول العضوية aani_message_conversation_members يُكتب عبر trigger
// عند أول رسالة، ومحادثة فُتحت قبل إرسال أي رسالة لا سجل لها — فيُرفض الانضمام
// إلى موضوعها الخاص (Unauthorized) ولا يصل مؤشر الكتابة. هنا نستدعي RPC يتحقق
// من هوية الطرفين وقاعدة الحجب نفسها المطبَّقة في سياسة إرسال الرسائل، ويكتب
// السجل مرة واحدة (idempotent).
//
// الشبكة قد تنقطع لحظة الفتح، فكان فشل واحد يُعطّل المؤشر حتى مغادرة الصفحة.
// لذلك تُعاد المحاولة عند أخطاء الاتصال المؤقتة فقط، بثلاث محاولات إضافية
// وتأخيرات متدرجة. أخطاء الصلاحيات والحجب والدالة غير المثبّتة لا تُعاد أبداً:
// تكرارها لا ينجح وقد يُغرق الطلبات.
//
// الإلغاء (مغادرة المحادثة أو تسجيل الخروج) يقطع الانتظار فوراً — لا ينتظر
// انتهاء تأخير المحاولة ولا نتيجة RPC التي بدأت قبل الإلغاء. ونتيجة أي طلب
// تابع لجلسة سابقة لا تُخزَّن ولا تمسّ الجلسة الجديدة.
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

/**
 * انتظار مهلة المحاولة، لكنه ينتهي فوراً عند إلغاء الإشارة بدل انتظار انتهاء
 * الـ600/1500/3500ms كاملة.
 */
function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise<void>(resolve => {
      setTimeout(resolve, delayMs);
    });
  }
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * استدعاء RPC مع إمكانية التخلي عنه فوراً عند الإلغاء: الوعد المُعاد يتحول إلى
 * 'aborted' مباشرة، ونتيجة الطلب الأصلي تُهمَل عند وصولها (لا تُخزَّن ولا تُطبَّق).
 */
function callUntilAborted(
  call: () => Promise<MessagesMembershipOutcome>,
  signal?: AbortSignal,
): Promise<MessagesMembershipOutcome | 'aborted'> {
  if (!signal) {
    return call().catch(() => 'permanent' as const);
  }
  if (signal.aborted) return Promise.resolve('aborted');

  return new Promise<MessagesMembershipOutcome | 'aborted'>(resolve => {
    let settled = false;
    const settle = (value: MessagesMembershipOutcome | 'aborted') => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => settle('aborted');

    signal.addEventListener('abort', onAbort, { once: true });
    call().then(
      outcome => settle(outcome),
      () => settle('permanent'),
    );
  });
}

export interface MessagesMembershipRetryOptions {
  /** إلغاء الجلسة (مغادرة الصفحة/تبديل المحادثة/الخروج). */
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
  onGiveUp?: () => void;
  /** حقن الاستدعاء في الاختبارات؛ الإنتاج يستخدم RPC أدناه. */
  call?: () => Promise<MessagesMembershipOutcome>;
}

/**
 * محاولة واحدة ثم إعادات محدودة عند الأخطاء المؤقتة فقط. بلا حلقة لا نهائية:
 * بعد استنفاد التأخيرات تتوقف المحاولات. الإلغاء يقطع الانتظار أو الطلب الجاري
 * فوراً ويتحول إلى نتيجة سلبية دون أي محاولة إضافية.
 */
export async function ensureMessagesMembershipWithRetry(
  call: () => Promise<MessagesMembershipOutcome>,
  options: Omit<MessagesMembershipRetryOptions, 'call'> = {},
): Promise<boolean> {
  const {
    signal,
    retryDelaysMs = MESSAGES_MEMBERSHIP_RETRY_DELAYS_MS,
    onGiveUp,
  } = options;

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) return false;

    const outcome = await callUntilAborted(call, signal);
    if (outcome === 'aborted' || signal?.aborted) return false;

    if (outcome === 'ready') return true;
    // خطأ دائم: لا إعادة محاولة على الصلاحيات أو الحجب أو الدالة الغائبة.
    if (outcome !== 'transient') return false;

    if (attempt >= retryDelaysMs.length) {
      onGiveUp?.();
      return false;
    }

    await waitForRetry(retryDelaysMs[attempt], signal);
    if (signal?.aborted) return false;
  }
}

const knownMembers = new Set<string>();

interface InFlightEntry {
  /** الجيل الذي أنشأ الطلب: طلب جيل سابق لا يُعاد استخدامه لجلسة جديدة. */
  epoch: number;
  promise: Promise<boolean>;
}

const inFlight = new Map<string, InFlightEntry>();
let cacheOwner: string | null = null;
// جيل يزداد مع كل إفراغ: محاولة بدأت قبل الخروج أو تبديل الحساب تتوقف فوراً.
let membershipEpoch = 0;
// إشارة إلغاء واحدة لكل جيل: إفراغ الذاكرة يقطع كل الطلبات الجارية فوراً.
let epochController = new AbortController();

/** إفراغ الذاكرة المحلية للعضوية عند تبديل المستخدم أو الخروج. */
export function resetMessagesConversationMembershipCache(ownerId?: string | null): void {
  membershipEpoch += 1;
  cacheOwner = ownerId || null;
  knownMembers.clear();
  inFlight.clear();

  const previous = epochController;
  epochController = new AbortController();
  previous.abort();
}

/** دمج إشارتي إلغاء (الطلب والجيل) في إشارة واحدة، مع تنظيف المستمعين. */
function linkAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  const abort = () => controller.abort();

  for (const source of signals) {
    if (!source) continue;
    if (source.aborted) {
      abort();
      break;
    }
    source.addEventListener('abort', abort, { once: true });
    removers.push(() => source.removeEventListener('abort', abort));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of removers) remove();
    },
  };
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

  const epoch = membershipEpoch;
  const pending = inFlight.get(key);
  if (pending) {
    // طلب جارٍ للجيل نفسه: نشاركه بدل إرسال RPC ثانٍ.
    // طلب جيل سابق (جلسة أُلغيت) لا يُعاد استخدامه أبداً لجلسة جديدة.
    if (pending.epoch === epoch) return pending.promise;
    inFlight.delete(key);
  }

  const { signal, dispose } = linkAbortSignals([options.signal, epochController.signal]);
  if (signal.aborted) {
    dispose();
    return false;
  }

  const call = options.call ?? (() => callMembershipRpc(contactId));

  const run = async (): Promise<boolean> => {
    let gaveUp = false;
    const ready = await ensureMessagesMembershipWithRetry(call, {
      signal,
      retryDelaysMs: options.retryDelaysMs,
      onGiveUp: () => {
        gaveUp = true;
        options.onGiveUp?.();
      },
    });

    // إعادة فحص الإلغاء بعد عودة RPC وقبل أي تخزين: عضوية طلب أُلغي لا تُحفظ.
    if (signal.aborted || membershipEpoch !== epoch) return false;

    if (!ready) {
      if (gaveUp) {
        // بلا تفاصيل خطأ: قد تحمل معرّفات. القناة تبقى غير مشتركة بأمان.
        console.warn('[messages] تعذر تجهيز عضوية المحادثة قبل الاشتراك في قناتها.');
      }
      return false;
    }

    knownMembers.add(key);
    return true;
  };

  const promise = run();
  const entry: InFlightEntry = { epoch, promise };
  inFlight.set(key, entry);

  // الطلب الملغى يُزال فوراً من inFlight، فلا تعيد محادثة أُعيد فتحها استخدامه.
  const cleanup = () => {
    dispose();
    signal.removeEventListener('abort', cleanup);
    if (inFlight.get(key) === entry) inFlight.delete(key);
  };
  signal.addEventListener('abort', cleanup, { once: true });
  void promise.then(cleanup, cleanup);

  return promise;
}
