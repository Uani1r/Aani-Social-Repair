/**
 * خدمات المؤسس السرية.
 *
 * مبدأ التصميم: لا يُdupلى جدول sandbox.founders ولا دوال RPC المالية القائمة
 * (aani_sandbox_is_founder / aani_sandbox_grant_coins / aani_sandbox_refund_top_up
 * ...). كل منها مؤمن بالفعل من جانب الخادم ويتحقق من sandbox.founders كمصدر
 * حقيقة لصلاحيات المؤسس المالية. تُضيف هذه الطبقة:
 *  1. تحقق العميل من الدور قبل إرسال الطلب (واجهة الغرض منها التوجيه فقط، ليست حماية).
 *  2. تسجيل تدقيق لكل عملية مالية حساسة عبر logCoreAudit.
 *  3. رفض فوري إن لم يكن الدور مؤسسًا (fail-closed).
 *
 * العمليات المالية تُنفّذ عبر دوال RPC security-definer الموجودة في Supabase
 * (من ترحيل 20270306000001_aani_sandbox_financial.sql)، التي تفرض صلاحية المؤسس
 * من جهة الخادم نفسها —所以 فإن مسؤولاً أو حساباً رسمياً لا يستطيع تنفيذها حتى
 * لو تجاوزgué guard العميل.
 */

import type { CoreAccountRole } from '../types/account';
import { assertFounder } from './guard';
import { auditAdminAction } from '../services/audit';
import {
  isSandboxFounder,
  grantSandboxCoins as libGrantSandboxCoins,
  refundSandboxTopUp as libRefundSandboxTopUp,
  fetchSandboxBalance as libFetchSandboxBalance,
  type SandboxReadResult,
  type SandboxMutationResult,
} from '@/lib/sandbox';

/** هل الجلسة الحالية مؤسس Sandbox وفقًا لجدول sandbox.founders (خادم فقط). */
export async function isCoreFounder(): Promise<SandboxReadResult<boolean>> {
  return isSandboxFounder();
}

/** الرصيد التجريبي لمستخدم (مؤسس فقط، يُقرأ من الخادم عبر aani_sandbox_balance). */
export async function coreGetSandboxBalance(userId: string): Promise<SandboxReadResult<number>> {
  return libFetchSandboxBalance(userId);
}

/** التحقق المسبق من دور المؤسس قبل أي عملية مؤسسية. */
export function requireFounderRole(role: CoreAccountRole | null): { allowed: boolean; reason?: string } {
  return assertFounder(role);
}

type GrantCoinsFn = (params: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey?: string;
}) => Promise<SandboxMutationResult & { amount?: number; balance?: number }>;

type RefundFn = (params: {
  topUpId: string;
  reason: string;
}) => Promise<SandboxMutationResult & { status?: string; amount?: number; userId?: string }>;

/** منح عملات تجريبية لمستخدم (مؤسس فقط). يُعتمد على RPC الخادم الذي يفحص sandbox.founders. */
export async function coreGrantSandboxCoins(params: {
  userId: string;
  amount: number;
  reason: string;
  actorRole: CoreAccountRole | null;
  /** مفكّرة للحقن في الاختبارات (الإنتاج يستخدم الدالة من '@/lib/sandbox'). */
  _grantCoinsFn?: GrantCoinsFn;
}): Promise<SandboxMutationResult & { audit?: { ok: boolean; error?: Error | null } }> {
  const roleCheck = requireFounderRole(params.actorRole);
  if (!roleCheck.allowed) {
    await auditAdminAction({
      action: 'grant_coins',
      targetType: 'user',
      targetId: params.userId,
      reason: 'محاولة منح غير مصرح بها: ' + (roleCheck.reason ?? ''),
      ok: false,
    });
    return { ok: false, error: new Error(roleCheck.reason ?? 'غير مصرح') };
  }

  const grantCoins = params._grantCoinsFn ?? libGrantSandboxCoins;
  const result = await grantCoins({
    userId: params.userId,
    amount: params.amount,
    reason: params.reason,
  });

  await auditAdminAction({
    action: 'grant_coins',
    targetType: 'user',
    targetId: params.userId,
    reason: params.reason,
    ok: result.ok,
  });

  return { ...result, audit: { ok: result.ok, error: result.error ?? null } };
}

/** استرداد شحن تجريبي (مؤسس فقط). */
export async function coreRefundSandboxTopUp(params: {
  topUpId: string;
  reason: string;
  actorRole: CoreAccountRole | null;
  /** مفكّرة للحقن في الاختبارات (الإنتاج يستخدم الدالة من '@/lib/sandbox'). */
  _refundFn?: RefundFn;
}): Promise<SandboxMutationResult & { audit?: { ok: boolean; error?: Error | null } }> {
  const roleCheck = requireFounderRole(params.actorRole);
  if (!roleCheck.allowed) {
    await auditAdminAction({
      action: 'refund_top_up',
      targetType: 'top_up',
      targetId: params.topUpId,
      reason: 'محاولة استرداد غير مصرح بها: ' + (roleCheck.reason ?? ''),
      ok: false,
    });
    return { ok: false, error: new Error(roleCheck.reason ?? 'غير مصرح') };
  }

  const refund = params._refundFn ?? libRefundSandboxTopUp;
  const result = await refund({ topUpId: params.topUpId, reason: params.reason });

  await auditAdminAction({
    action: 'refund_top_up',
    targetType: 'top_up',
    targetId: params.topUpId,
    reason: params.reason,
    ok: result.ok,
  });

  return { ...result, audit: { ok: result.ok, error: result.error ?? null } };
}
