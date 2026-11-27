import { supabase, supabaseConfigured } from '@/lib/supabase';

/* ------------------------------------------------------------------ */
/* أنواع نظام Sandbox المالي التجريبي (معزول عن الإنتاج)             */
/* ------------------------------------------------------------------ */

export type SandboxTopUpPackage = {
  id: string;
  name: string;
  coins: number;
  price_usd: number;
  is_active: boolean;
  created_at: string;
};

export type SandboxSubscriptionPackage = {
  id: string;
  name: string;
  coins_price: number;
  duration_days: number;
  is_active: boolean;
  created_at: string;
};

export type SandboxPromotionPackage = {
  id: string;
  name: string;
  target_type: 'post' | 'reel';
  coins_price: number;
  duration_days: number;
  is_active: boolean;
  created_at: string;
};

export type SandboxLedgerEntry = {
  id: string;
  user_id: string;
  type: 'credit' | 'debit';
  amount: number;
  reference: string;
  idempotency_key: string;
  related_id: string | null;
  created_at: string;
};

export type SandboxTopUp = {
  id: string;
  user_id: string;
  package_id: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  idempotency_key: string;
  simulated: boolean;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
};

export type SandboxRefund = {
  id: string;
  top_up_id: string;
  user_id: string;
  amount: number;
  reason: string;
  created_at: string;
};

export type SandboxSubscription = {
  id: string;
  user_id: string;
  package_id: string;
  status: 'active' | 'expired' | 'cancelled';
  started_at: string;
  ended_at: string | null;
  renewed_at: string | null;
  cancelled_at: string | null;
  auto_renew: boolean;
  coins_charged: number;
};

export type SandboxPromotion = {
  id: string;
  user_id: string;
  package_id: string;
  target_type: 'post' | 'reel';
  target_id: string;
  status: 'active' | 'ended' | 'failed';
  started_at: string;
  ends_at: string | null;
  coins_deducted: number;
  failure_reason: string | null;
  created_at: string;
};

export type SandboxAdminAction = {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  reason: string;
  result: 'ok' | 'error';
  created_at: string;
};

export type SandboxGiftTransaction = {
  id: string;
  gift_id: string;
  sender_id: string;
  recipient_id: string;
  price_paid: number;
  popularity_points: number; // دائمًا 0 في Sandbox
  created_at: string;
  idempotency_key: string;
  is_sandbox: boolean;
};

/* ------------------------------------------------------------------ */
/* نتيجة عملية reading/writing صريحة: لا تُخفي الأخطاء بصمت.         */
/* ------------------------------------------------------------------ */

export type SandboxReadResult<T> = {
  data: T | null;
  error: Error | null;
};

export type SandboxListResult<T> = SandboxReadResult<T[]> & { hasMore: boolean };

export type SandboxMutationResult = {
  ok: boolean;
  duplicate?: boolean;
  error: Error | null;
  [key: string]: unknown;
};

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

async function rpc<T = unknown>(
  name: string,
  params: Record<string, unknown>
): Promise<{ data: T | null; error: Error | null }> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  try {
    const { data, error } = await supabase.rpc(name, params);
    if (error) return { data: null, error };
    return { data: data as T | null, error: null };
  } catch (error) {
    return { data: null, error: error as Error };
  }
}

export function generateIdempotencyKey(prefix: string): string {
  const key =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${key}`;
}

/** احسب الرصيد التجريبي من إدخالات السجل المستقل (ائتمان - مدينة). لا محفظة مكررة. */
export function computeSandboxBalance(entries: Array<{ type: 'credit' | 'debit'; amount: number }>): number {
  return entries.reduce((sum, e) => (e.type === 'credit' ? sum + e.amount : sum - e.amount), 0);
}

/**
 * إجماليات السجل المالي (ائتمان/مدينة/صافي) من مجموعة إدخالات.
 * دالة نقية تُختبر مباشرة، ولا تغيّر مصدر الرصيد (السجل المستقل).
 */
export function computeSandboxTotals(entries: Array<{ type: 'credit' | 'debit'; amount: number }>): {
  credit: number;
  debit: number;
  net: number;
} {
  let credit = 0;
  let debit = 0;
  for (const e of entries) {
    if (e.type === 'credit') credit += e.amount;
    else if (e.type === 'debit') debit += e.amount;
  }
  return { credit, debit, net: credit - debit };
}

/**
 * ملخّص الإجماليات مع علامة اكتمال صريحة.
 * عند `complete=false` (البيانات مقتصرة على حد أقصى للتحميل) لا تُعرض الإجماليات
 * كإجمالي كامل — بل كحد أدنى/جزئي — حتى لا يُفهم الرقم على أنه الإجمالي الكلي.
 */
export function summarizeSandboxTotals(
  entries: Array<{ type: 'credit' | 'debit'; amount: number }>,
  complete: boolean,
): { credit: number; debit: number; net: number; complete: boolean; partial: boolean } {
  const t = computeSandboxTotals(entries);
  return { ...t, complete, partial: !complete };
}

/** إجماليات Sandbox المالية (ائتمان/مدينة/صافي) — دالة خادمية تجميعية (مؤسس فقط). */
export type SandboxTotals = { credit: number; debit: number; net: number };

/**
 * اجلب الإجماليات المالية من دالة PostgreSQL التجميعية `aani_sandbox_totals`.
 * استعلام تجميعي واحد (SUM) ⇒ لا تحميل صفحات، ولا تكرار/تجاوز عند الإدراج
 * المتزامن، ولا اعتماد على ترتيب created_at. التحقق من المؤسس خادمجي داخل الدالة.
 */
export async function fetchSandboxTotals(): Promise<SandboxReadResult<SandboxTotals>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  return rpc<SandboxTotals>('aani_sandbox_totals', {});
}

/* ------------------------------------------------------------------ */
/* المؤسس / التحقق من الخادم                                          */
/* ------------------------------------------------------------------ */

/** هل الجلسة الحالية تخص مؤسس Sandbox؟ التحقق من جهة الخادم فقط. */
export async function isSandboxFounder(): Promise<SandboxReadResult<boolean>> {
  return rpc<boolean>('aani_sandbox_is_founder', {});
}

/** الرصيد التجريبي لمستخدم (يُحسب من السجل، لا محفظة مكررة). */
export async function fetchSandboxBalance(userId: string): Promise<SandboxReadResult<number>> {
  if (!supabaseConfigured || !userId) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح أو معرف المستخدم ناقص') };
  }
  return rpc<number>('aani_sandbox_balance', { p_user_id: userId });
}

/* ------------------------------------------------------------------ */
/* كتالوجات العرض (تُقرأ عبر PostgREST من مخطط sandbox)               */
/* ملاحظة: يتطلب كشف مخطط sandbox عبر PostgREST صلاحية USAGE على
  المخطط للمستخدمين المصادقين (تُمنح في الترحيل SQL عبر
  grant usage on schema sandbox to authenticated). */
/* ------------------------------------------------------------------ */

export async function fetchSandboxTopUpPackages(): Promise<SandboxReadResult<SandboxTopUpPackage[]>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  const { data, error } = await supabase
    .schema('sandbox').from('top_up_packages')
    .select('id, name, coins, price_usd, is_active, created_at')
    .eq('is_active', true)
    .order('coins', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data ?? []) as SandboxTopUpPackage[], error: null };
}

export async function fetchSandboxSubscriptionPackages(): Promise<SandboxReadResult<SandboxSubscriptionPackage[]>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  const { data, error } = await supabase
    .schema('sandbox').from('subscription_packages')
    .select('id, name, coins_price, duration_days, is_active, created_at')
    .eq('is_active', true)
    .order('duration_days', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data ?? []) as SandboxSubscriptionPackage[], error: null };
}

export async function fetchSandboxPromotionPackages(): Promise<SandboxReadResult<SandboxPromotionPackage[]>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  const { data, error } = await supabase
    .schema('sandbox').from('promotion_packages')
    .select('id, name, target_type, coins_price, duration_days, is_active, created_at')
    .eq('is_active', true)
    .order('target_type', { ascending: true })
    .order('coins_price', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data ?? []) as SandboxPromotionPackage[], error: null };
}

/* ------------------------------------------------------------------ */
/* الهدايا التجريبية                                                 */
/* ------------------------------------------------------------------ */

/** إرسال هدية تجريبية: يُخصم من رصيد Sandbox فقط، لا نقاط شعبية حقيقية. */
export async function sendSandboxGift(params: {
  senderId: string;
  recipientId: string;
  giftId: string;
  idempotencyKey?: string;
}): Promise<SandboxMutationResult & { transactionId?: string; pricePaid?: number; balance?: number }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const key = params.idempotencyKey ?? generateIdempotencyKey('sandbox-gift');
  const { data, error } = await supabase.rpc('aani_sandbox_send_gift', {
    p_sender_id: params.senderId,
    p_recipient_id: params.recipientId,
    p_gift_id: params.giftId,
    p_idempotency_key: key,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as {
    ok: boolean;
    duplicate?: boolean;
    transaction_id?: string;
    price_paid?: number;
    balance?: number;
    popularity_points?: number;
    sandbox?: boolean;
  } | null;
  return {
    ok: result?.ok ?? false,
    duplicate: result?.duplicate,
    transactionId: result?.transaction_id,
    pricePaid: result?.price_paid,
    balance: result?.balance,
    error: null,
  };
}

/** الهدايا التجريبية التي أرسلها أو استلمها المستخدم (مع إشارة صريحة "تجريبي"). */
export async function fetchSandboxGifts(params: {
  userId: string;
  page: number;
  pageSize?: number;
}): Promise<SandboxListResult<SandboxGiftTransaction>> {
  if (!supabaseConfigured || !params.userId) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح أو معرف المستخدم ناقص'), hasMore: false };
  }
  const pageSize = params.pageSize ?? 20;
  const from = params.page * pageSize;
  const { data, error } = await supabase
    .schema('sandbox').from('gift_transactions')
    .select('id, gift_id, sender_id, recipient_id, price_paid, popularity_points, created_at, idempotency_key, is_sandbox')
    .or(`sender_id.eq.${params.userId},recipient_id.eq.${params.userId}`)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);
  if (error) return { data: null, error, hasMore: false };
  const rows = (data ?? []) as SandboxGiftTransaction[];
  const hasMore = rows.length > pageSize;
  return { data: hasMore ? rows.slice(0, -1) : rows, error: null, hasMore };
}

/* ------------------------------------------------------------------ */
/* السجل المالي والتشغيل                                              */
/* ------------------------------------------------------------------ */

/** إدخالات السجل المالي لمستخدم. pass `all: true` (مسؤول فقط عبر RLS) للعرض من دون تصفية المستخدم. */
export async function fetchSandboxLedger(params: {
  userId: string;
  page: number;
  pageSize?: number;
  all?: boolean;
}): Promise<SandboxListResult<SandboxLedgerEntry>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح'), hasMore: false };
  }
  const pageSize = params.pageSize ?? 50;
  const from = params.page * pageSize;
  let q = supabase
    .schema('sandbox').from('ledger')
    .select('id, user_id, type, amount, reference, idempotency_key, related_id, created_at')
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);
  if (!params.all) q = q.eq('user_id', params.userId);
  const { data, error } = await q;
  if (error) return { data: null, error, hasMore: false };
  const rows = (data ?? []) as SandboxLedgerEntry[];
  const hasMore = rows.length > pageSize;
  return { data: hasMore ? rows.slice(0, -1) : rows, error: null, hasMore };
}

/** عمليات الشحن التجريبي للمستخدم. pass `all: true` للمسؤول عبر RLS. */
export async function fetchSandboxTopUps(params: {
  userId: string;
  page: number;
  pageSize?: number;
  all?: boolean;
}): Promise<SandboxListResult<SandboxTopUp>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح'), hasMore: false };
  }
  const pageSize = params.pageSize ?? 50;
  const from = params.page * pageSize;
  let q = supabase
    .schema('sandbox').from('top_ups')
    .select('id, user_id, package_id, amount, status, idempotency_key, simulated, failure_reason, created_at, completed_at')
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);
  if (!params.all) q = q.eq('user_id', params.userId);
  const { data, error } = await q;
  if (error) return { data: null, error, hasMore: false };
  const rows = (data ?? []) as SandboxTopUp[];
  const hasMore = rows.length > pageSize;
  return { data: hasMore ? rows.slice(0, -1) : rows, error: null, hasMore };
}

/** شحن تجريبي (محاكاة ناجح/فاشل): يُضاف الرصيد فقط عند النجاح. */
export async function topUpSandbox(params: {
  userId: string;
  packageId: string;
  simulateSuccess?: boolean;
  idempotencyKey?: string;
}): Promise<SandboxMutationResult & { status?: string; amount?: number; balance?: number; simulated?: boolean }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const key = params.idempotencyKey ?? generateIdempotencyKey('sandbox-topup');
  const { data, error } = await supabase.rpc('aani_sandbox_top_up', {
    p_user_id: params.userId,
    p_package_id: params.packageId,
    p_idempotency_key: key,
    p_simulate_success: params.simulateSuccess ?? true,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as {
    ok: boolean;
    duplicate?: boolean;
    status?: string;
    amount?: number;
    balance?: number;
    simulated?: boolean;
  } | null;
  return {
    ok: result?.ok ?? false,
    duplicate: result?.duplicate,
    status: result?.status,
    amount: result?.amount,
    balance: result?.balance,
    simulated: result?.simulated,
    error: null,
  };
}

/** استرداد تجريبي (مؤسس فقط). */
export async function refundSandboxTopUp(params: {
  topUpId: string;
  reason: string;
}): Promise<SandboxMutationResult & { status?: string; amount?: number; userId?: string }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const { data, error } = await supabase.rpc('aani_sandbox_refund_top_up', {
    p_top_up_id: params.topUpId,
    p_reason: params.reason,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as { ok: boolean; status?: string; amount?: number; user_id?: string } | null;
  return {
    ok: result?.ok ?? false,
    status: result?.status,
    amount: result?.amount,
    userId: result?.user_id,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/* الاشتراكات التجريبية                                              */
/* ------------------------------------------------------------------ */

/** اشتراكات المستخدم التجريبية. pass `all: true` للمسؤول عبر RLS. */
export async function fetchSandboxSubscriptions(params: {
  userId: string;
  all?: boolean;
}): Promise<SandboxReadResult<SandboxSubscription[]>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  let q = supabase
    .schema('sandbox').from('subscriptions')
    .select('id, user_id, package_id, status, started_at, ended_at, renewed_at, cancelled_at, auto_renew, coins_charged')
    .order('started_at', { ascending: false });
  if (!params.all) q = q.eq('user_id', params.userId);
  const { data, error } = await q;
  if (error) return { data: null, error };
  return { data: (data ?? []) as SandboxSubscription[], error: null };
}

/** تفعيل اشتراك تجريبي (خصم عملات تجريبية). */
export async function activateSandboxSubscription(params: {
  userId: string;
  packageId: string;
  idempotencyKey?: string;
}): Promise<SandboxMutationResult & { coinsCharged?: number; balance?: number }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const key = params.idempotencyKey ?? generateIdempotencyKey('sandbox-sub');
  const { data, error } = await supabase.rpc('aani_sandbox_activate_subscription', {
    p_user_id: params.userId,
    p_package_id: params.packageId,
    p_idempotency_key: key,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as { ok: boolean; coins_charged?: number; balance?: number } | null;
  return {
    ok: result?.ok ?? false,
    coinsCharged: result?.coins_charged,
    balance: result?.balance,
    error: null,
  };
}

/** إلغاء اشتراك تجريبي. */
export async function cancelSandboxSubscription(params: {
  subscriptionId: string;
}): Promise<SandboxMutationResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const { data, error } = await supabase.rpc('aani_sandbox_cancel_subscription', {
    p_subscription_id: params.subscriptionId,
  });
  if (error) {
    return { ok: false, error };
  }
  return { ok: Boolean((data as { ok?: boolean } | null)?.ok), error: null };
}

/** تجديد اشتراك تجريبي. */
export async function renewSandboxSubscription(params: {
  subscriptionId: string;
  idempotencyKey?: string;
}): Promise<SandboxMutationResult & { coinsCharged?: number; balance?: number }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const key = params.idempotencyKey ?? generateIdempotencyKey('sandbox-renew');
  const { data, error } = await supabase.rpc('aani_sandbox_renew_subscription', {
    p_subscription_id: params.subscriptionId,
    p_idempotency_key: key,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as { ok: boolean; coins_charged?: number; balance?: number } | null;
  return {
    ok: result?.ok ?? false,
    coinsCharged: result?.coins_charged,
    balance: result?.balance,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/* الترويج التجريبي                                                   */
/* ------------------------------------------------------------------ */

/** حملات الترويج التجريبية للمستخدم. pass `all: true` للمسؤول عبر RLS. */
export async function fetchSandboxPromotions(params: {
  userId: string;
  all?: boolean;
}): Promise<SandboxReadResult<SandboxPromotion[]>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  let q = supabase
    .schema('sandbox').from('promotions')
    .select('id, user_id, package_id, target_type, target_id, status, started_at, ends_at, coins_deducted, failure_reason, created_at')
    .order('created_at', { ascending: false });
  if (!params.all) q = q.eq('user_id', params.userId);
  const { data, error } = await q;
  if (error) return { data: null, error };
  return { data: (data ?? []) as SandboxPromotion[], error: null };
}

/** إنشاء حملة ترويج تجريبية (خصم عملات تجريبية). */
export async function createSandboxPromotion(params: {
  userId: string;
  packageId: string;
  targetType: 'post' | 'reel';
  targetId: string;
  idempotencyKey?: string;
}): Promise<SandboxMutationResult & { coinsDeducted?: number; balance?: number }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const key = params.idempotencyKey ?? generateIdempotencyKey('sandbox-promo');
  const { data, error } = await supabase.rpc('aani_sandbox_create_promotion', {
    p_user_id: params.userId,
    p_package_id: params.packageId,
    p_target_type: params.targetType,
    p_target_id: params.targetId,
    p_idempotency_key: key,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as { ok: boolean; coins_deducted?: number; balance?: number } | null;
  return {
    ok: result?.ok ?? false,
    coinsDeducted: result?.coins_deducted,
    balance: result?.balance,
    error: null,
  };
}

/** إنهاء / فشل حملة ترويج تجريبية. */
export async function endSandboxPromotion(params: {
  promotionId: string;
  success?: boolean;
  failureReason?: string;
}): Promise<SandboxMutationResult & { status?: string }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const { data, error } = await supabase.rpc('aani_sandbox_end_promotion', {
    p_promotion_id: params.promotionId,
    p_success: params.success ?? true,
    p_failure_reason: params.failureReason ?? null,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as { ok: boolean; status?: string } | null;
  return { ok: result?.ok ?? false, status: result?.status, error: null };
}

/* ------------------------------------------------------------------ */
/* الإشراف والتدقيق (مؤسس)                                           */
/* ------------------------------------------------------------------ */

/** منح عملات تجريبية لمستخدم (مؤسس فقط، يُسجّل الإجراء في التدقيق). */
export async function grantSandboxCoins(params: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey?: string;
}): Promise<SandboxMutationResult & { amount?: number; balance?: number }> {
  if (!supabaseConfigured) {
    return { ok: false, error: new Error('اتصال قاعدة البيانات غير متاح.') };
  }
  const key = params.idempotencyKey ?? generateIdempotencyKey('sandbox-grant');
  const { data, error } = await supabase.rpc('aani_sandbox_grant_coins', {
    p_user_id: params.userId,
    p_amount: params.amount,
    p_idempotency_key: key,
    p_reason: params.reason,
  });
  if (error) {
    return { ok: false, error };
  }
  const result = data as { ok: boolean; duplicate?: boolean; amount?: number; balance?: number } | null;
  return {
    ok: result?.ok ?? false,
    duplicate: result?.duplicate,
    amount: result?.amount,
    balance: result?.balance,
    error: null,
  };
}

/** سجل إجراءات المسؤول (تدقيق). pass `all: true` للمسؤول عبر RLS. */
export async function fetchSandboxAdminActions(params: {
  page: number;
  pageSize?: number;
  actorId?: string;
  all?: boolean;
}): Promise<SandboxListResult<SandboxAdminAction>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح'), hasMore: false };
  }
  const pageSize = params.pageSize ?? 50;
  const from = params.page * pageSize;
  let q = supabase
    .schema('sandbox').from('admin_actions')
    .select('id, actor_user_id, action, target_type, target_id, reason, result, created_at')
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);
  if (params.actorId) q = q.eq('actor_user_id', params.actorId);
  if (!params.all && !params.actorId) {
    return { data: [], error: null, hasMore: false };
  }
  const { data, error } = await q;
  if (error) return { data: null, error, hasMore: false };
  const rows = (data ?? []) as SandboxAdminAction[];
  const hasMore = rows.length > pageSize;
  return { data: hasMore ? rows.slice(0, -1) : rows, error: null, hasMore };
}

/** استردادات المستخدم (للعرض). pass `all: true` للمسؤول عبر RLS. */
export async function fetchSandboxRefunds(params: {
  userId: string;
  all?: boolean;
}): Promise<SandboxReadResult<SandboxRefund[]>> {
  if (!supabaseConfigured) {
    return { data: null, error: new Error('اتصال قاعدة البيانات غير متاح') };
  }
  let q = supabase
    .schema('sandbox').from('refunds')
    .select('id, top_up_id, user_id, amount, reason, created_at')
    .order('created_at', { ascending: false });
  if (!params.all) q = q.eq('user_id', params.userId);
  const { data, error } = await q;
  if (error) return { data: null, error };
  return { data: (data ?? []) as SandboxRefund[], error: null };
}
