import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

/** صفحة واحدة من الهدايا المستلمة عند العرض في النافذة السفلية. */
export const GIFT_PAGE_SIZE = 20;

export type Gift = {
  id: string;
  name: string;
  /** تكلفة الهدية بعملات المرسل. */
  price: number;
  /** نقاط الشعبية التي تُضاف إلى رصيد المستلم الشعبي عند الاستلام. */
  popularity_points: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
};

export type GiftTransaction = {
  id: string;
  gift_id: string;
  sender_id: string;
  recipient_id: string;
  price_paid: number;
  popularity_points: number;
  created_at: string;
};

export type ReceivedGift = GiftTransaction & {
  gift: Pick<Gift, 'id' | 'name' | 'image_url' | 'popularity_points'> | null;
  sender: Pick<
    Profile,
    'id' | 'username' | 'full_name' | 'display_name' | 'avatar_url'
  > | null;
};

export type SendGiftResult = {
  ok: boolean;
  duplicate?: boolean;
  transaction_id?: string;
  balance?: number;
  price_paid?: number;
  popularity_points?: number;
  error?: string;
  /**
   * نتيجة غير محسومة: خطأ نقل/اتصال/مهلة زمنية/انقطاع شبكة، لا رفض نهائي من
   * الخادم. بهذه الحالة تُحفظ المحاولة (نفس idempotencyKey) وتُعرض إعادة المحاولة،
   * ولا يُعتبر الطلب مرفوضاً ولا ناجحاً.
   */
  inconclusive?: boolean;
};

/**
 * محاولة إرسال معلّقة.
 * - المفتاح (key) يُولّد مرة واحدة لكل عملية ويُعاد استخدامه عند إعادة المحاولة
 *   بعد نتيجة غير محسومة (خطأ نقل/شبكة) لضمان عدم خصم الرصيد مرتين.
 * - مرتبطة بالمستلم والهدية، فلا يُعاد استخدام مفتاح قديم مع مستلم أو هدية أخرى.
 * - `status`:
 *     'sending'     → الطلب جارٍ، الاختيار مقفل.
 *     'inconclusive'→ نتيجة غير محسومة، نُبقي المفتاح ونقفل الاختيار حتى إعادة المحاولة.
 */
export type SendAttempt = {
  key: string;
  recipientId: string;
  giftId: string;
  status: 'sending' | 'inconclusive';
};

export type SendErrorKind = 'inconclusive' | 'definitive';

/**
 * قائمة محددة بأكواد SQL/business التي تثبت أن المعاملة لم تُنفَّذ (رفض مؤكد):
 *   - 42501  insufficient_privilege  (غير مسجّل / ممنوع / نيابة عن مستخدم آخر)
 *   - 42001  insufficient_privilege  (الرصيد غير كافٍ — كما تستخدمه الدالة)
 *   - 42704  undefined_object       (الهدية غير متاحة)
 *   - 22023  invalid_parameter_value(إرسال لنفسك / مفتاح idempotency مفقود)
 * هذه هي الأكواد التي ترفعها الدالة aani_send_gift صراحةً، وكلها تعني أن
 * العملية لم تُنفَّذ. أي كود آخر (مجهول أو من طبقة API مثل PGRST*) لا يثبت
 * أن المعاملة لم تُنفَّذ، فيُعامَل كغير محسوم.
 */
const DEFINITIVE_SEND_ERROR_CODES = new Set<string>([
  '42501',
  '42001',
  '42704',
  '22023',
]);

/**
 * تصنيف خطأ الإرسال:
 * - 'definitive'  → رفض مؤكد من الخادم بكود معروف ضمن القائمة أعلاه، فالطلب
 *   محسوم كفشل ويمكن تحرير المحاولة.
 * - 'inconclusive'→ خطأ نقل/اتصال/مهلة/انقطاع، أو كود غير معروف، أو خطأ من
 *   طبقة API لا يثبت أن المعاملة لم تُنفَّذ؛ فيجب الاحتفاظ بنفس المفتاح
 *   وإعادة المحاولة.
 */
export function classifySendError(error: unknown): SendErrorKind {
  if (!error || typeof error !== 'object') return 'inconclusive';
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return 'inconclusive';
  return DEFINITIVE_SEND_ERROR_CODES.has(code.trim()) ? 'definitive' : 'inconclusive';
}

/**
 * تفسير استجابة RPC بشكل نقي (قابل للاختبار):
 * - خطأ معروف (code ضمن القائمة) → رفض مؤكد (inconclusive:false).
 * - خطأ غير معروف/نقل/شبكة → inconclusive:true.
 * - استجابة فارغة أو غير صالحة أو بلا `ok` boolean → inconclusive:true
 *   (لا نجاح ولا رفض مؤكد، فلا يجوز مسح المحاولة).
 * - `ok:true` → نجاح مؤكد.  `ok:false` → رفض مؤكد من الدالة.
 */
export function interpretSendResponse(error: unknown, data: unknown): SendGiftResult {
  if (error) {
    const message =
      (error as { message?: unknown }).message;
    const text = typeof message === 'string' && message.length > 0
      ? message
      : undefined;
    if (classifySendError(error) === 'definitive') {
      return { ok: false, inconclusive: false, error: text || 'فشل إرسال الهدية.' };
    }
    return {
      ok: false,
      inconclusive: true,
      error: text || 'تعذّر تأكيد الإرسال. أعد المحاولة.',
    };
  }

  if (!data || typeof data !== 'object' || typeof (data as { ok?: unknown }).ok !== 'boolean') {
    // استجابة فارغة/غير صالحة: لا نجاح ولا رفض مؤكد → غير محسوم.
    return { ok: false, inconclusive: true, error: 'استجابة غير صالحة من الخادم. أعد المحاولة.' };
  }

  const result = data as SendGiftResult;
  if (result.ok) return result;
  // ok === false: رفض مؤكد صادر عن الدالة نفسها.
  return { ...result, ok: false, inconclusive: false };
}

/**
 * تحديد المحاولة التي ستُستخدم للإرسال، بشكل نقي (قابل للاختبار):
 * - إن وُجدت محاولة معلّقة (inconclusive) بنفس المستلم والهدية: تُعاد بنفس
 *   المفتاح (لا يُولَّد مفتاح جديد) وتتحول إلى 'sending'.
 * - غير ذلك (لا محاولة سابقة، أو تغيّر المستلم/الهدية): تُنشأ محاولة جديدة
 *   بمفتاح جديد من `generateKey`.
 */
export function resolveSendAttempt(
  previous: SendAttempt | null,
  params: { recipientId: string; giftId: string; generateKey: () => string }
): SendAttempt {
  if (
    previous &&
    previous.status === 'inconclusive' &&
    previous.recipientId === params.recipientId &&
    previous.giftId === params.giftId
  ) {
    return { ...previous, status: 'sending' };
  }
  return {
    key: params.generateKey(),
    recipientId: params.recipientId,
    giftId: params.giftId,
    status: 'sending',
  };
}

/**
 * تنسيق رقم الشعبية للعرض في الكبسولة والنافذة.
 * الأمثلة المستهدفة: 0 ، 125 ، 1.2K ، 15.8K
 */
export function formatPopularity(value?: number | null): string {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}K`;
}

/** إجماليpopularity مستخدم (مستعلم خفيف من دالة RPC آمنة في الخادم). */
export async function fetchPopularity(userId: string): Promise<number | null> {
  if (!supabaseConfigured || !userId) return null;
  const { data, error } = await supabase.rpc('aani_user_popularity', {
    p_user_id: userId,
  });
  if (error) {
    console.warn('[gifts] تعذر جلب الشعبية:', error);
    return null;
  }
  return typeof data === 'number' ? data : 0;
}

/** رصيد العملات الخاص بالمستخدم الحالي (صف المحفظة خاص به عبر RLS). */
export async function fetchMyBalance(userId: string): Promise<number> {
  if (!supabaseConfigured || !userId) return 0;
  const { data, error } = await supabase
    .from('user_wallets')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[gifts] تعذر جلب الرصيد:', error);
    return 0;
  }
  return typeof data?.balance === 'number' ? data.balance : 0;
}

/** كتالوج الهدايا النشطة للعرض عند اختيار هدية للإرسال. */
export async function fetchGiftCatalog(): Promise<Gift[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('gifts')
    .select('id, name, price, popularity_points, image_url, is_active, created_at')
    .eq('is_active', true)
    .order('price', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[gifts] تعذر جلب كتالوج الهدايا:', error);
    return [];
  }
  return (data ?? []) as Gift[];
}

/**
 * الهدايا المستلمة لمستخدم مع ترحيل (pagination).
 * تُجلب فقط عند فتح النافذة السفلية، وليس عند فتح صفحة الملف الشخصي.
 */
export async function fetchReceivedGifts({
  userId,
  page,
  pageSize = GIFT_PAGE_SIZE,
}: {
  userId: string;
  page: number;
  pageSize?: number;
}): Promise<{ items: ReceivedGift[]; hasMore: boolean }> {
  if (!supabaseConfigured || !userId) return { items: [], hasMore: false };

  const from = page * pageSize;
  // جلب عنصر إضافي لمعرفة وجود صفحة تالية
  const { data, error } = await supabase
    .from('gift_transactions')
    .select(
      'id, gift_id, sender_id, recipient_id, price_paid, popularity_points, created_at'
    )
    .eq('recipient_id', userId)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);

  if (error) {
    console.warn('[gifts] تعذر جلب الهدايا المستلمة:', error);
    return { items: [], hasMore: false };
  }

  const rows = (data ?? []) as GiftTransaction[];
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, -1) : rows;

  const giftIds = Array.from(new Set(pageRows.map(row => row.gift_id)));
  const senderIds = Array.from(new Set(pageRows.map(row => row.sender_id)));

  const [giftsResult, sendersResult] = await Promise.all([
    giftIds.length
      ? supabase
          .from('gifts')
          .select('id, name, image_url, popularity_points')
          .in('id', giftIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    senderIds.length
      ? supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url')
          .in('id', senderIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  const giftsById = new Map(
    ((giftsResult.data ?? []) as Gift[]).map(gift => [gift.id, gift])
  );
  const sendersById = new Map(
    ((sendersResult.data ?? []) as Profile[]).map(sender => [sender.id, sender])
  );

  const items: ReceivedGift[] = pageRows.map(row => ({
    ...row,
    gift: giftsById.get(row.gift_id) ?? null,
    sender: sendersById.get(row.sender_id) ?? null,
  }));

  return { items, hasMore };
}

/** إرسال هدية عبر دالة RPC آمنة في الخادم (التحقق من الرصيد والصلاحية والخصم ضمن معاملة واحدة). */
export async function sendGift(
  senderId: string,
  recipientId: string,
  giftId: string,
  idempotencyKey?: string
): Promise<SendGiftResult> {
  if (!supabaseConfigured) {
    // لا اتصال بقاعدة البيانات: نتيجة غير محسومة (لا رفض نهائي).
    return { ok: false, inconclusive: true, error: 'اتصال قاعدة البيانات غير متاح.' };
  }
  const key =
    idempotencyKey ??
    (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);
  try {
    const { data, error } = await supabase.rpc('aani_send_gift', {
      p_sender_id: senderId,
      p_recipient_id: recipientId,
      p_gift_id: giftId,
      p_idempotency_key: key,
    });
    // interpretSendResponse يميّز الرفض المؤكد (كود معروف) عن الخطأ غير المحسوم
    // (نقل/شبكة/كود مجهول/استجابة فارغة أو غير صالحة).
    return interpretSendResponse(error, data);
  } catch (error) {
    // خطأ نقل/اتصال/مهلة زمنية/انقطاع شبكة (الطلب رُفض قبل وصوله للخادم غالباً):
    // النتيجة غير محسومة، نحتفظ بنفس المفتاح لإعادة المحاولة دون خصم مزدوج.
    return {
      ok: false,
      inconclusive: true,
      error: error instanceof Error ? error.message : 'تعذّر الاتصال بالخادم. أعد المحاولة.',
    };
  }
}

/** نتيجة عملية شحن المحفظة عبر الدالة aani_wallet_top_up. */
export type TopUpResult = {
  ok: boolean;
  duplicate?: boolean;
  transaction_id?: string;
  amount?: number;
  balance?: number;
  payment_reference?: string;
  payment_provider?: string;
  error?: string;
  /**
   * نتيجة غير محسومة (نقل/شبكة/مهلة): لا تُعتبر رفضاً نهائياً ولا نجاحاً مؤكداً،
   * وتُحتفظ بمرجع الدفع لإعادة المحاولة بدون إضافة رصيد مكررة.
   */
  inconclusive?: boolean;
};

/** شحن رصيد المحفظة بعد التحقق من نجاح الدفع من جهة الخادم.
 *
 * ملاحظة التكامل (مطلوبة قبل النشر على الإنتاج):
 *   يجب على caller التأكد من نجاح الدفع مع مزود الدفع المحدد (paymentProvider)
 *   باستخدام مرجع الدفع (paymentReference) قبل استدعاء هذه الدالة. هذه الدالة
 *   هي المدخل الآمن للخادم لإضافة الرصيد فقط؛ فهي لا تتصل بمزود دفع ولا تنشئ
 *   عملية دفع وهمية. إذا لم يكن مزود دفع متكاملاً، لا يُستدعى هذه الدالة ولا
 *   يُضاف رصيد وهمي.
 */
export async function topUpWallet(
  userId: string,
  amount: number,
  paymentReference: string,
  paymentProvider: string
): Promise<TopUpResult> {
  if (!supabaseConfigured) {
    return {
      ok: false,
      inconclusive: true,
      error: 'اتصال قاعدة البيانات غير متاح.',
    };
  }
  try {
    const { data, error } = await supabase.rpc('aani_wallet_top_up', {
      p_amount: amount,
      p_payment_reference: paymentReference,
      p_payment_provider: paymentProvider,
    });
    if (error) {
      const message =
        (error as { message?: unknown }).message;
      const text = typeof message === 'string' && message.length > 0
        ? message
        : undefined;
      if (classifySendError(error) === 'definitive') {
        return { ok: false, inconclusive: false, error: text || 'فشل شحن الرصيد.' };
      }
      return {
        ok: false,
        inconclusive: true,
        error: text || 'تعذّر تأكيد الشحن. أعد المحاولة.',
      };
    }
    if (!data || typeof data !== 'object' || typeof (data as { ok?: unknown }).ok !== 'boolean') {
      return {
        ok: false,
        inconclusive: true,
        error: 'استجابة غير صالحة من الخادم. أعد المحاولة.',
      };
    }
    return data as TopUpResult;
  } catch (error) {
    return {
      ok: false,
      inconclusive: true,
      error: error instanceof Error ? error.message : 'تعذّر الاتصال بالخادم. أعد المحاولة.',
    };
  }
}
